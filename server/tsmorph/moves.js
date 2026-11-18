const fs = require("node:fs");
const path = require("node:path");
const { companions, assetConsumers, assetImports, referenceTarget } = require("./assets");
const { isCode, inside } = require("./files");
const { replaceLiterals } = require("./references");

function checkFile(session, file) {
  session.path(file);
  if (!session.exists(file)) throw new Error(`source file not found: ${session.rel(file)}`);
  if (
    /^(?:package\.json|(?:ts|js)config(?:\..+)?\.json|.*lock\.(?:json|yaml|lock)|\..*)$/i.test(
      path.basename(file),
    )
  ) {
    throw new Error(`Cannot move or delete project metadata: ${session.rel(file)}`);
  }
}

function destinations(session, moves, overwrite) {
  const targets = new Set();
  for (const [from, to] of moves) {
    checkFile(session, from);
    if (from === to) throw new Error("source and target are identical");
    if (targets.has(to) || moves.has(to)) throw new Error(`Overlapping move destination: ${session.rel(to)}`);
    targets.add(to);
    if (fs.statSync(to, { throwIfNoEntry: false })?.isDirectory())
      throw new Error(`target exists but is not a regular file: ${to}`);
    if (overwrite && session.exists(to)) {
      const owner = session.workspace.owner(to);
      const row = session.workspace.builtEntryRow(owner, to);
      if (row) throw new Error(`Cannot overwrite ${session.rel(to)}: built entry '${row}' in ${session.rel(owner.filename)} may depend on it. Update the build entry first.`);
    }
    if (session.exists(to) && !overwrite) throw new Error(`target already exists: ${session.rel(to)}`);
    if (isCode(from) && !isCode(to))
      throw new Error(`target must be a TypeScript/JavaScript source file: ${to}`);
    if (isCode(from) && /\.[cm]?tsx?$/.test(from) !== /\.[cm]?tsx?$/.test(to)) {
      throw new Error(`cannot move between language families: ${from} to ${to}`);
    }
    if (!isCode(from) && path.extname(from) !== path.extname(to))
      throw new Error("Asset moves must preserve the file extension");
    if (!isCode(to) && /^(?:package\.json|(?:ts|js)config(?:\..+)?\.json|\..*)$/i.test(path.basename(to))) {
      throw new Error(`Cannot overwrite project metadata: ${to}`);
    }
  }
}

function moveDependencyPolicy(session, args) {
  const ws = session.workspace;
  const source = session.path(args.source);
  const sourcePackage = ws.owner(source);
  const destinationPackage = ws.owner(session.path(args.target, source));
  if (!sourcePackage || sourcePackage === destinationPackage) return;

  // Walk re-exports before changing the graph. The public entry can itself
  // re-export from another barrel in the departing package.
  const barrels = new Set([source]);
  for (const file of barrels) {
    for (const ref of session.referencesTo(file)) {
      if (!ref.reexport || ws.owner(ref.file) !== sourcePackage || barrels.has(ref.file)) continue;
      if (ws.isEntryFile(sourcePackage, ref.file))
        return { sourcePackage, destinationPackage, rejectCycles: true };
      barrels.add(ref.file);
    }
  }
  return { sourcePackage, destinationPackage };
}

function moveModule(session, args) {
  const from = session.path(args.source),
    to = session.path(args.target, from);
  const moves = new Map([[from, to]]);
  for (const asset of companions(session, from, args.companions)) {
    const target = session.path(path.join(path.dirname(to), path.basename(asset)));
    if (asset !== target) moves.set(asset, target);
  }
  destinations(session, moves, args.overwrite === true);
  session.index.assertStaticReferences(moves);
  const previous = session.index.snapshotBindings();
  const rewritten = new Map();
  const changed = new Map();
  for (const [source, target] of moves) {
    if (isCode(source)) {
      session.assertReadableCode(source);
      changed.set(source, []);
    } else {
      for (const ref of assetImports(session, source)) {
        if ((moves.get(ref.to) || ref.to) !== path.resolve(path.dirname(target), ref.spec)) {
          throw new Error(`Moving ${session.rel(source)} would break its reference to '${ref.spec}'`);
        }
      }
      for (const ref of assetConsumers(session, source)) {
        if (!moves.has(ref.file))
          session.warnings.push(
            `Review '${ref.spec}' in ${session.rel(ref.file)}:${ref.line} after moving ${session.rel(source)}`,
          );
      }
    }
    for (const ref of session.referencesTo(source)) changed.set(ref.file, []);
    const finalTarget = session.batchImports ? session.batchImports.finalPath(target) : target;
    const transient = !args.exportAs && (!finalTarget ||
      session.workspace.owner(finalTarget) !== session.workspace.owner(target));
    session.workspace.moveExports(
      source,
      target,
      source === from ? args.exportAs : undefined,
      source !== from,
      transient,
    );
  }

  // Make destinations visible to alias round-trip checks. Source text and graph
  // edges still come from the old snapshot until every replacement is known.
  for (const target of moves.values()) {
    session.rememberDestination(target);
    session.paths.add(target);
    session.overlay.delete(target);
  }
  const problems = [];
  for (const [file, edits] of changed) {
    const newFile = moves.get(file) || file;
    for (const ref of session.index.byFile.get(file) || []) {
      if (!moves.has(file) && !moves.has(ref.to)) continue;
      const originalTarget = referenceTarget(ref);
      if (!originalTarget) {
        if (ref.kind !== "url" && !ref.spec.startsWith(".") && !path.isAbsolute(ref.spec) &&
            session.workspace.dependencies.carryExternal(file, newFile, session.origins.get(file) || file, ref)) {
          continue;
        }
        const scopedAlias =
          session.workspace.hasAlias(file, ref.spec) || session.workspace.hasAlias(newFile, ref.spec);
        if (
          ref.kind === "url" || ref.spec.startsWith(".") ||
          session.workspace.packageForSpecifier(ref.spec) ||
          (scopedAlias && session.workspace.owner(file) !== session.workspace.owner(newFile))
        ) {
          problems.push(`Cannot relocate unresolved '${ref.spec}' in ${session.rel(file)}`);
        }
        continue;
      }
      const target = moves.get(originalTarget) || originalTarget;
      if (!inside(session.root, target)) {
        problems.push(`Dependency outside the project root: ${session.rel(file)} -> ${target}`);
        continue;
      }
      try {
        const spec = session.specifier(newFile, target, ref.spec, ref);
        edits.push({ ref, spec });
        rewritten.set(ref, spec);
      } catch (error) {
        problems.push(`${session.rel(file)} -> ${session.rel(target)}: ${error.message}`);
      }
    }
  }
  if (problems.length) throw new Error([...new Set(problems)].join("\n"));

  const contents = new Map();
  for (const [file, edits] of changed) {
    if (!moves.has(file) && [...moves.values()].includes(file)) continue; // overwritten importer
    const text = session.project.getSourceFileOrThrow(file).getFullText();
    const updated = replaceLiterals(text, edits);
    if (moves.has(file) || updated !== text) contents.set(moves.get(file) || file, updated);
  }
  // Carry deferred delete checks along with an importer if its path or spelling changes.
  for (const pending of session.deletions) {
    for (const importer of [...pending.computed, ...pending.assets]) {
      if (moves.has(importer.file)) importer.file = moves.get(importer.file);
    }
    for (const importer of pending.importers) {
      const edit = changed.get(importer.file)?.find(({ ref }) => ref.spec === importer.spec && ref.kind === importer.kind);
      if (edit) importer.spec = edit.spec;
      if (moves.has(importer.file)) importer.file = moves.get(importer.file);
    }
  }
  for (const [source, target] of moves) {
    const mode = session.modes.get(source) ?? fs.statSync(source, { throwIfNoEntry: false })?.mode;
    session.modes.set(target, mode);
    if (session.boms.has(source)) session.boms.add(target);
    else session.boms.delete(target);
    if (!isCode(source)) session.overlay.set(target, session.bytes(source));
    const origin = session.origins.get(source);
    session.remove(source);
    if (origin) session.origins.set(target, origin);
    else session.origins.delete(target);
  }
  session.index.assertBindings(previous, moves, rewritten);
  if ([...moves.keys()].some((file) => !isCode(file))) session.assetIndex = null;
  for (const [file, text] of contents) session.addCode(file, text);
  // A public subpath can keep its spelling while its resolved file moves.
  // Update that edge as well, so the next step can move the same file again.
  const rescan = new Set([...contents.keys(), ...changed.keys()]);
  for (const file of rescan) {
    if (!moves.has(file)) session.index.scan(session.project.getSourceFileOrThrow(file));
  }
  return { source: args.source, target: args.target, preview: `Move ${args.source} to ${args.target}.` };
}

function deleteModule(session, args) {
  const source = session.path(args.source);
  const files = [source, ...companions(session, source, args.companions)];
  const previous = session.index.snapshotBindings();
  for (const file of files) checkFile(session, file);
  for (const file of files) {
    const importers = session.referencesTo(file).map(({ file, spec, kind, resolutionMode }) => ({ file, spec, kind, resolutionMode }));
    const computed = session.index.computedReferencesTo(file).map((ref) => ({
      ...ref, bindings: ref.values?.filter((spec) => session.resolve(ref.file, spec, ref.kind, true) === file),
    }));
    const assets = assetConsumers(session, file).map((ref) => ({ ...ref }));
    session.deletions.push({ file, index: session.operationIndex, importers, computed, assets });
    session.workspace.deleteExports(file);
    session.remove(file);
    if (!isCode(file)) session.assetIndex = null;
  }
  session.index.assertBindings(previous, undefined, undefined, new Set(files));
  return { source: args.source, preview: `Delete ${args.source}.` };
}

function checkDeletions(session) {
  const problems = [];
  let index;
  const blockedSites = new Map();
  for (const item of session.deletions) {
    const remaining = item.importers.filter(
      ({ file, spec, kind, resolutionMode }) =>
        session.exists(file) &&
        session.index.byFile.get(file)?.some((ref) => ref.spec === spec && ref.kind === kind) &&
        session.resolve(file, spec, resolutionMode ?? kind) !== item.file,
    );
    if (!session.exists(item.file)) remaining.push(...assetConsumers(session, item.file));
    for (const ref of item.assets) {
      if (session.exists(ref.file) &&
          assetImports(session, ref.file).some(current => current.spec === ref.spec && current.to !== item.file)) {
        remaining.push(ref);
      }
    }
    for (const ref of item.computed) {
      const survives = session.index.computed.get(ref.file)?.some(current => current.spec === ref.spec && current.kind === ref.kind);
      if (!survives) continue;
      // An enumerated package entry must still resolve after a path is
      // reused. A directory alternative can cover a descendant without
      // resolving to that descendant itself.
      if (!ref.bindings || !ref.bindings.length || ref.bindings.some(spec => session.resolve(ref.file, spec, ref.kind, true) !== item.file)) {
        blockedSites.set(JSON.stringify([ref.file, ref.start]), ref);
        index ??= item.index;
      }
    }
    if (remaining.length) {
      const files = [...new Set(remaining.map(({ file }) => session.rel(file)))];
      problems.push(`Cannot delete ${session.rel(item.file)}. Still imported by ${files.join(", ")}`);
      index ??= item.index;
    }
  }
  const computed = blockedSites.size && session.index.computedError(blockedSites.values());
  if (computed) problems.push(computed.message);
  if (problems.length) {
    const error = new Error(problems.join("\n"));
    error.computedSites = computed?.computedSites;
    error.index = index;
    throw error;
  }
}

module.exports = { moveModule, deleteModule, checkDeletions, moveDependencyPolicy };
