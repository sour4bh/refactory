const path = require("node:path");
const { ts } = require("ts-morph");

function parseDestination(session, input) {
  if (typeof input !== "string" || !input) throw new Error("target must be a file or package specifier");
  // An exported subpath may itself contain a skipped directory name. Only
  // interpret a public specifier as a filesystem path if that path exists.
  if (session.workspace.packageForSpecifier(input) && !session.exists(path.resolve(session.workspace.requestRoot, input))) {
    return { spec: input };
  }
  const destination = session.path(input);
  if (session.exists(destination)) return { file: destination };
  if (
    /^(?:@[^/\s]+\/)?[\w-][\w.-]*(?:\/[\w.-]+)*$/.test(input) &&
    !input.split("/").some((part) => part === "." || part === "..") &&
    (input.startsWith("@") || !/\.[cm]?[jt]sx?$/.test(input))
  ) return { spec: input };
  throw new Error("Replacement target not found: " + input);
}

function checkAugmentations(session, program, files, requested) {
  const checker = program.getTypeChecker();
  for (const source of program.getSourceFiles()) {
    for (const name of source.moduleAugmentations || []) {
      if (!ts.isStringLiteral(name)) continue;
      const symbol = checker.getSymbolAtLocation(name);
      if (name.text !== requested && !symbol?.declarations?.some(decl => files.has(decl.getSourceFile().fileName)))
        continue;
      throw new Error(
        `Cannot replace ${requested}: module augmentation '${name.text}' in ${session.rel(source.fileName)} ` +
        "may contribute types used by its consumers. Migrate the augmentation first.",
      );
    }
  }
}

function selectSource(session, input) {
  if (typeof input !== "string" || !input) throw new Error("source must be a file or workspace package specifier");
  const ws = session.workspace;
  const pkg = ws.packageForSpecifier(input);
  if (!pkg || session.exists(path.resolve(ws.requestRoot, input))) {
    const file = session.path(input);
    session.project.getSourceFileOrThrow(file);
    session.index.assertStaticReferences([[file]]);
    const sites = session.referencesTo(file).map(ref => ({ ref, source: file }));
    return { file, sites };
  }

  const selected = [];
  const identities = new Set();
  for (const refs of session.index.byFile.values()) {
    for (const ref of refs) {
      if (ref.kind === "url" || ref.spec !== input) continue;
      const entry = ws.packageEntry(pkg, input, undefined, ref.file, ref.resolutionMode ?? ref.kind);
      const expected = entry.file || entry.missing;
      if (!expected) {
        throw new Error(`${pkg.filename} does not export ${input}, imported by ${session.rel(ref.file)}; check the source subpath`);
      }
      if (expected !== ref.to) {
        throw new Error(`${input} in ${session.rel(ref.file)} resolves to ${ref.to || "no file"} instead of ${expected}; check the importer's path aliases`);
      }
      identities.add(expected);
      selected.push({ ref, source: entry.file, missingSource: entry.missing });
    }
  }
  // A require-only or import-only branch might have no literal caller. Include
  // its identity so a computed use cannot disappear behind the default mode.
  for (const entries of session.index.computed.values()) {
    for (const ref of entries) {
      if (ref.kind === "url" || !ref.values?.includes(input)) continue;
      const target = session.resolve(ref.file, input, ref.kind, true);
      if (target) identities.add(target);
    }
  }
  if (!identities.size) {
    const entry = ws.packageEntry(pkg, input);
    if (!entry.file && !entry.missing) throw new Error(`Workspace package does not export ${input} in ${pkg.filename}`);
    identities.add(entry.file || entry.missing);
  }
  session.index.assertStaticReferences([...identities].map(target => [target]));
  return { sites: selected };
}

function resolveDestination(session, dest, ref, source) {
  const ws = session.workspace;
  const pkg = dest.spec && ws.packageForSpecifier(dest.spec);
  const mode = ref.resolutionMode ?? ref.kind;
  let resolved;
  if (pkg) {
    resolved = ws.packageFile(pkg, dest.spec, undefined, ref.file, mode);
    if (!resolved) {
      throw new Error(
        `Workspace package does not export a readable file for ${dest.spec} in ${session.rel(pkg.filename)}, ` +
        `needed by ${session.rel(ref.file)}; build the package or choose a source export`,
      );
    }
  } else {
    resolved = dest.file || session.resolve(ref.file, dest.spec, mode) ||
      ws.resolveExternal(ref.file, dest.spec, ts.sys, ref.resolutionMode)?.resolvedFileName;
  }
  if (!resolved && ws.hasAlias(ref.file, dest.spec)) {
    throw new Error(`Cannot resolve replacement alias '${dest.spec}' in ${session.rel(ref.file)}`);
  }
  if (resolved && resolved === source) throw new Error("Replacement resolves to the original module in " + ref.file);
  if (resolved === ref.file) throw new Error("Replacement would import itself in " + ref.file);
  let spec = dest.spec;
  const keepPublic = pkg && ws.owner(ref.file) !== pkg && session.resolve(ref.file, spec, mode) === resolved;
  if (!keepPublic && resolved && ws.includes(resolved)) {
    spec = session.specifier(ref.file, resolved, ref.spec, ref);
  } else if (pkg && !keepPublic && session.resolve(ref.file, spec, mode) !== resolved) {
    throw new Error(`Replacement ${spec} binds elsewhere in ${session.rel(ref.file)}; check the importer's path aliases`);
  }
  return { input: dest.input, resolved, spec };
}

function checkExport(original, target, typeOnly, name, file, destination) {
  if (!target) return; // Collected with the other missing names for this target.
  if (!target.target.declarations?.length)
    throw new Error(`Cannot verify replacement export ${name} in ${destination} used by ${file}`);
  if (!original) return;
  if (!typeOnly && original.runtime && !target.runtime) {
    throw new Error(`${destination} does not provide a runtime value for ${name} used in ${file}`);
  }
  for (const [meaning, mask] of [
    ["type", ts.SymbolFlags.Type], ["namespace", ts.SymbolFlags.Namespace], ["value", ts.SymbolFlags.Value],
  ]) {
    if (original.target.flags & mask && !(target.target.flags & mask))
      throw new Error(`${destination} lacks the ${meaning} export ${name} used in ${file}`);
  }
}

module.exports = { parseDestination, selectSource, resolveDestination, checkExport, checkAugmentations };
