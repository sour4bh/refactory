// Narrow diagnostics use each config's roots and their compiler dependency closure.
// The broader refactoring project also holds unbuilt scripts, whose global declarations
// must not participate in type checking the configured program.
const path = require("node:path");
const { ts } = require("ts-morph");
const { createRequire } = require("node:module");
// ts-morph serves its bundled lib declarations from an in-memory directory.
const { getLibFolderPath } = createRequire(require.resolve("ts-morph"))("@ts-morph/common");
const { isCode } = require("./files");
const { resolveSourceURL } = require("./assets");

// Above this heap size, force a full collection after each member program.
const COLLECT_ABOVE_BYTES = 384 * 1024 * 1024;

function directoryEntries(paths, root) {
  const tree = new Map();
  function entry(dir) {
    if (!tree.has(dir)) tree.set(dir, { files: [], directories: new Set() });
    return tree.get(dir);
  }
  for (const file of paths) {
    let dir = path.dirname(file);
    entry(dir).files.push(path.basename(file));
    while (dir !== root) {
      const parent = path.dirname(dir);
      const children = entry(parent).directories;
      if (children.has(path.basename(dir))) break;
      children.add(path.basename(dir));
      dir = parent;
    }
  }
  return tree;
}

function validationFileSystem(session, tree) {
  const disk = session.project.getFileSystem();
  const managed = (file) => session.workspace.includes(file);
  const manifests = new Map(
    session.workspace.packages.filter((pkg) => pkg.filename).map((pkg) => [pkg.filename, pkg]),
  );
  const overrides = {
    fileExistsSync: (file) => (managed(file) ? session.exists(file) : disk.fileExistsSync(file)),
    directoryExistsSync: (dir) => tree.has(dir) || disk.directoryExistsSync(dir),
    realpathSync: (file) => (session.paths.has(file) || tree.has(file) ? file : disk.realpathSync(file)),
    readFileSync(file, encoding) {
      if (!managed(file)) return disk.readFileSync(file, encoding);
      if (!session.exists(file)) throw new Error(`File not found: ${file}`);
      return (
        manifests.get(file)?.text ??
        session.project.getSourceFile(file)?.getFullText() ??
        session.bytes(file).toString(encoding || "utf8")
      );
    },
    readDirSync(dir) {
      if (!tree.has(dir)) return disk.readDirSync(dir);
      const entries = disk.directoryExistsSync(dir)
        ? disk.readDirSync(dir).filter((e) => !managed(e.name))
        : [];
      const { files, directories } = tree.get(dir);
      for (const [names, isFile] of [
        [files, true],
        [directories, false],
      ]) {
        for (const name of names)
          entries.push({ name: path.join(dir, name), isFile, isDirectory: !isFile, isSymlink: false });
      }
      return entries;
    },
  };
  return new Proxy(disk, {
    get(host, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key];
      const value = host[key];
      return typeof value === "function" ? value.bind(host) : value;
    },
  });
}

async function* memberPrograms(session, extraRootsByMember) {
  const ws = session.workspace;
  const tree = directoryEntries(session.paths, ws.root);
  const host = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory(dir, extensions, excludes, includes, depth) {
      return ts.matchFiles(
        dir,
        extensions,
        excludes,
        includes,
        ts.sys.useCaseSensitiveFileNames,
        ws.root,
        depth,
        (folder) => {
          const entry = tree.get(folder);
          return entry
            ? { files: entry.files, directories: [...entry.directories] }
            : { files: [], directories: [] };
        },
        (file) => file,
      );
    },
  };
  const fileSystem = validationFileSystem(session, tree);
  const libDirectory = getLibFolderPath({});
  const registry = ts.createDocumentRegistry(true, ws.root);
  // Release the checker as soon as its diagnostics are consumed. Give just
  // the next member a chance to acquire the previous member's parsed files.
  // TypeScript keys these documents by compiler settings and module format.
  const releases = [];
  const adjacentDocuments = {
    ...registry,
    releaseDocumentWithKey(...args) { releases.push(args); },
  };
  function releasePreviousDocuments() {
    for (const args of releases) registry.releaseDocumentWithKey(...args);
    releases.length = 0;
  }

  let collector;
  try {
    for (const pkg of extraRootsByMember?.keys() ?? (ws.packages.length ? ws.packages : [null])) {
      const config = pkg?.config || ws.rootConfig;
      let files;
      if (config) {
        files = ts
          .getFileNamesFromConfigSpecs(config.specs, config.dir, config.options, host)
          .filter((file) => session.paths.has(file));
      } else {
        files = [...session.paths].filter((file) => isCode(file) && ws.owner(file) === pkg);
      }
      if (extraRootsByMember) files = [...new Set([...files, ...extraRootsByMember.get(pkg)])];
      if (!files.length) continue;
      const project = ws.makeProject(config?.options || ws.defaultOptions, fileSystem);
      const disk = project.getModuleResolutionHost();
      const service = ts.createLanguageService({
        ...disk,
        ...ws.resolutionHost(disk),
        getCompilationSettings: () => project.getCompilerOptions(),
        getScriptFileNames: () => files,
        getScriptVersion: () => "0",
        getScriptSnapshot(file) {
          const text = disk.fileExists(file) ? disk.readFile(file) : undefined;
          return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
        },
        getDefaultLibFileName: options => path.join(libDirectory, ts.getDefaultLibFileName(options)),
        getCurrentDirectory: () => config?.dir || ws.root,
      }, adjacentDocuments);
      try {
        const program = service.getProgram();
        releasePreviousDocuments();
        yield { member: pkg, program };
      } finally {
        service.dispose();
      }
      // V8 may defer a full collection until several members' unreachable
      // graphs fill the default heap. Reclaim those graphs at a member boundary.
      // SHORTCUT: a forced collection per member keeps 35 members with 3 MB of
      // declarations each at 0.7 GB instead of 2.1 GB, but adds 4 to 5 s to each
      // validation pass on that workspace. A worker per member with its own resourceLimits would bound
      // and free each heap without it, at the cost of sending the session overlay.
      if (process.memoryUsage().heapUsed > COLLECT_ABOVE_BYTES) {
        if (!collector) {
          const { Session } = require("node:inspector/promises");
          collector = new Session();
          collector.connect();
        }
        await collector.post("HeapProfiler.collectGarbage");
      }
    }
  } finally {
    releasePreviousDocuments();
    collector?.disconnect();
  }
}

async function diagnostics(session, codes, reportBuildWarnings) {
  const errors = [];
  const checked = new Set();
  const seen = new Set();
  const unavailable = new Map();
  const warned = new Map();
  const missingURLs = new Map();
  function unavailableBuilds(file) {
    if (!unavailable.has(file)) {
      const refs = (session.index.byFile.get(file) || []).filter(ref => {
        const pkg = ref.kind !== "url" && session.workspace.packageForSpecifier(ref.spec);
        if (!pkg) return false;
        const { missing } = session.workspace.packageEntry(pkg, ref.spec, undefined, file, ref.resolutionMode ?? ref.kind);
        if (!missing) return false;
        if (!warned.has(pkg)) warned.set(pkg, missing);
        return true;
      });
      unavailable.set(file, refs);
    }
    return unavailable.get(file);
  }
  for await (const { program } of memberPrograms(session)) {
    for (const file of program.getSourceFiles()) {
      if (!session.workspace.includes(file.fileName)) continue;
      checked.add(file.fileName);
      for (const d of program.getSemanticDiagnostics(file)) {
        if (!codes.has(d.code) || !d.file) continue;
        if ([2307, 2882].includes(d.code)) {
          const atError = ref => d.start >= ref.start && d.start < ref.end;
          if (unavailableBuilds(file.fileName).some(atError)) continue;
          const ref = session.index.byFile.get(file.fileName)?.find(atError);
          if (ref && session.workspace.dependencies.awaitingInstall(file.fileName, session.origins.get(file.fileName), ref.spec))
            continue;
        }
        const error = ts.flattenDiagnosticMessageText(d.messageText, " ");
        const line = d.file.getLineAndCharacterOfPosition(d.start).line + 1;
        const key = JSON.stringify([d.file.fileName, d.start, d.code, error]);
        if (seen.has(key)) continue;
        seen.add(key);
        errors.push({ file: session.rel(d.file.fileName), line, error, code: d.code, type: "import_error" });
      }
    }
  }
  for (const file of checked) {
    const unbuilt = unavailableBuilds(file);
    for (const ref of session.index.byFile.get(file) || []) {
      if (unbuilt.includes(ref)) continue;
      const pkg = ref.kind !== "url" && session.workspace.packageForSpecifier(ref.spec);
      const missingExport = !!pkg && !session.workspace.packageFile(pkg, ref.spec, undefined, file, ref.resolutionMode ?? ref.kind);
      const local = ref.kind === "url" || ref.spec.startsWith(".") || path.isAbsolute(ref.spec);
      if (!missingExport && (!local || session.resolve(file, ref.spec, ref.kind))) continue;
      const line = session.project.getSourceFile(file).getLineAndColumnAtPos(ref.start).line;
      const relative = session.rel(file);
      if (ref.kind === "url") {
        const target = resolveSourceURL(file, ref.spec);
        if (!target || !session.initialPaths.has(target)) {
          const owner = session.workspace.owner(file);
          if (!missingURLs.has(owner)) missingURLs.set(owner,
            `Missing source URL target '${ref.spec}' in ${relative}:${line}; check generated or runtime assets.`);
          continue;
        }
      }

      if (errors.some((e) => e.file === relative && e.line === line && e.error.includes(ref.spec))) continue;
      errors.push({
        file: relative,
        line,
        code: 2307,
        type: "import_error",
        error: missingExport
          ? `Workspace export '${ref.spec}' is missing in ${session.rel(pkg.filename)}`
          : `Unresolved ${ref.kind === "url" ? "source URL" : "module"} '${ref.spec}'`,
      });
    }
  }
  if (!reportBuildWarnings) return errors;
  for (const warning of missingURLs.values()) session.warnings.push(warning);
  for (const [pkg, missing] of warned) {
    const message = `Build ${pkg.data.name} to validate its exports: missing ${session.rel(missing)}`;
    if (!session.warnings.includes(message)) session.warnings.push(message);
  }
  return errors;
}

module.exports = { memberPrograms, diagnostics, directoryEntries, validationFileSystem };
