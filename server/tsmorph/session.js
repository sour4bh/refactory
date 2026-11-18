const fs = require("node:fs");
const path = require("node:path");
const { isUtf8 } = require("node:buffer");
const { ts } = require("ts-morph");
const { Workspace } = require("./workspace");
const { isCode, inside, inventory, guarded } = require("./files");
const { ReferenceIndex } = require("./references");
const { BatchImports } = require("./batch-imports");
const { resolveSourceURL, sourceURLSpecifier } = require("./assets");
const { diagnostics } = require("./validation");

const IMPORT_ERRORS = new Set([
  1192, 1259, 1361, 1362, 2304, 2305, 2306, 2307, 2308, 2613, 2693, 2724, 2749, 2882,
]);
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

class Session {
  constructor(projectRoot) {
    if (!projectRoot || !path.isAbsolute(projectRoot))
      throw new Error("project_root must be an absolute path");
    this.workspace = new Workspace(projectRoot);
    this.root = this.workspace.root;
    this.warnings = this.workspace.warnings;
    this.original = new Map();
    this.overlay = new Map(); // assets and tombstones
    this.linkedTargets = new Map();
    this.initialPaths = new Set(inventory(this.root, this.workspace, this.linkedTargets));
    this.paths = new Set(this.initialPaths);
    this.origins = new Map(Array.from(this.initialPaths, (file) => [file, file]));
    this.editedBy = new Map();
    this.observed = new WeakSet();
    this.invalid = new Map();
    for (const pkg of this.workspace.packages) {
      if (pkg.filename) this.original.set(pkg.filename, Buffer.from(pkg.original));
    }
    this.workspace.exists = (file) => this.exists(file);
    this.project = this.workspace.makeProject();
    this.modes = new Map();
    this.boms = new Set();
    this.deletions = [];
    for (const file of this.paths) {
      if (!isCode(file)) continue;
      const bytes = this.before(file);
      if (bytes.subarray(0, 3).equals(BOM)) this.boms.add(file);
      const source = this.project.addSourceFileAtPath(file);
      const diagnostic = source.compilerNode.parseDiagnostics[0];
      if (diagnostic || !isUtf8(bytes)) {
        this.invalid.set(
          file,
          diagnostic ? ts.flattenDiagnosticMessageText(diagnostic.messageText, " ") : "source is not UTF-8",
        );
      }
      this.observe(source);
    }
    this.index = new ReferenceIndex(this);
    this.usage = this.workspace.usage(this.index.edges());
  }

  // movedFrom marks a destination. The workspace root can own scripts, but a
  // file from a member must not make the root manifest its new owner.
  path(input, movedFrom) {
    if (typeof input !== "string" || !input) throw new Error("Expected a file path");
    const file = guarded(this.root, path.resolve(this.workspace.requestRoot, input), this.workspace);
    if (movedFrom && this.workspace.memberAncestors.size) {
      const owner = this.workspace.owner(file);
      const member = owner?.filename && owner.dir !== this.root && this.workspace.includes(file);
      if (!member && (!this.workspace.includes(file) || owner !== this.workspace.owner(movedFrom)))
        throw new Error(`Cannot move to ${this.rel(file)}: the destination must be in a workspace member. Create its package.json and include the member in the workspace first.`);
    }
    if (!this.workspace.includes(file)) throw new Error(`Path outside workspace members: ${input}`);
    if (this.workspace.resolutionInputs.has(file))
      throw new Error(`Cannot edit resolution config as a source or asset: ${this.rel(file)}`);
    for (const [target, link] of this.linkedTargets) {
      if (inside(target, file))
        throw new Error(`Cannot track importers through symlink ${this.rel(link)} to ${this.rel(target)}`);
    }
    if (file.toLowerCase().endsWith(".py"))
      throw new Error("This operation is not supported for Python files");
    return file;
  }

  rel(file) {
    return path.relative(this.root, file);
  }
  files() {
    return this.project.getSourceFiles().filter((s) => this.workspace.includes(s.getFilePath()));
  }
  resolve(file, spec, kind, includeUnbuilt = false) {
    if (kind === "url") {
      const to = resolveSourceURL(file, spec);
      if (!to || this.overlay.get(to) === null) return undefined;
      // URLs name physical entries (including directories and generated
      // artifacts). Honor a session tombstone before looking on disk.
      if (this.paths.has(to) || fs.existsSync(to)) return to;
      // A move may create the URL's directory only when the plan is committed.
      // A later deletion in the same batch can remove its last prospective file.
      for (const file of this.editedBy.keys()) {
        if (file.startsWith(to + path.sep) && this.paths.has(file)) return to;
      }
      return undefined;
    }
    return this.workspace.resolve(file, spec, undefined, kind, includeUnbuilt);
  }
  specifier(file, to, spec, ref) {
    if (ref?.kind === "url") return sourceURLSpecifier(this, file, to, ref);
    if (this.batchImports) return this.batchImports.specifier(file, to, spec, ref);
    return this.workspace.specifier(file, to, spec, ref?.resolutionMode ?? ref?.kind);
  }
  referencesTo(file) {
    return [...(this.index.byTarget.get(file) || [])];
  }

  exists(file) {
    if (this.overlay.has(file)) return this.overlay.get(file) !== null;
    return (
      this.paths.has(file) ||
      (!inside(this.root, file) && fs.statSync(file, { throwIfNoEntry: false })?.isFile())
    );
  }

  observe(source) {
    if (this.observed.has(source)) return;
    const file = source.getFilePath();
    source.onModified(() => this.editedBy.set(file, this.operationIndex));
    this.observed.add(source);
  }

  rememberDestination(file) {
    this.before(file);
    this.editedBy.set(file, this.operationIndex);
  }

  assertReadableCode(file) {
    if (this.invalid.has(file)) {
      throw new Error(
        `Cannot parse ${this.rel(file)} with TypeScript ${ts.version}: ${this.invalid.get(file)}`,
      );
    }
  }

  before(file) {
    if (!this.original.has(file)) {
      const bytes = this.initialPaths.has(file) ? fs.readFileSync(file) : null;
      this.original.set(file, bytes);
    }
    return this.original.get(file);
  }

  bytes(file) {
    return this.overlay.has(file) ? this.overlay.get(file) : this.before(file);
  }

  remove(file) {
    this.editedBy.set(file, this.operationIndex);
    this.index.drop(file);
    const source = this.project.getSourceFile(file);
    if (source) this.project.removeSourceFile(source);
    this.paths.delete(file);
    this.origins.delete(file);
    this.overlay.set(file, null);
  }

  addCode(file, text) {
    const previous = !this.exists(file) && this.index.snapshotBindings();
    this.paths.add(file);
    this.overlay.delete(file);
    const source = this.project.createSourceFile(file, text, { overwrite: true });
    this.editedBy.set(file, this.operationIndex);
    if (previous) this.index.assertBindings(previous);
    this.observe(source);
    return source;
  }

  assertBuiltSymbolScope(step) {
    const input = { rename_symbol: step.file, move_symbol: step.sourceFile, rewrite_props: step.module,
      replace_module: step.source }[step.operation];
    if (!input || typeof input !== "string") return;
    // Package-specifier replacements explicitly act on the published surface.
    if (step.operation === "replace_module" && !this.exists(path.resolve(this.workspace.requestRoot, input))) return;
    const selected = this.path(input);
    const pending = [selected];
    const seen = new Set();
    while (pending.length) {
      const file = pending.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      const pkg = this.workspace.owner(file);
      const row = this.workspace.builtEntryRow(pkg, file);
      if (row && this.index.hasBuildConsumers(pkg)) {
        const name = pkg.data.name + (row === "." ? "" : row.slice(1));
        throw new Error(`Cannot track ${step.operation} on ${this.rel(selected)} through built entry ${this.rel(file)} (${name}). ` +
          `Published declarations have separate symbol identities. Redirect package consumers with replace_module using source '${name}' first, or edit the source and declarations together.`);
      }
      // A file replacement redirects the statements in a retaining barrel. Only
      // selecting the entry file itself can miss its public package consumers.
      if (step.operation !== "replace_module") {
        for (const ref of this.referencesTo(file)) pending.push(ref.file);
      }
    }
  }

  finishOperation(rebuildIndex, movePolicy) {
    if (rebuildIndex) {
      // Only addCode can create a managed source. A compiler dependency read
      // from disk must never undo an earlier deletion in the virtual tree.
      for (const source of this.files()) {
        const file = source.getFilePath();
        if (!this.exists(file)) throw new Error(`Compiler loaded an absent workspace file: ${this.rel(file)}`);
      }
      this.index = new ReferenceIndex(this);
    } else {
      this.index.resolvePending();
    }
    const usage = this.workspace.usage(this.index.edges());
    this.workspace.reconcile(this.usage, usage, movePolicy, this.operationIndex);
    this.usage = usage;
  }

  // Imports, export rows and dependency rows of a batch follow its final state.
  startBatch(steps) {
    this.batchImports = new BatchImports(this, steps);
    this.batchStart = this.usage;
    this.workspace.startBatch();
  }

  finishBatch() {
    this.batchImports.finish();
    this.workspace.dependencies.prune(this);
    this.workspace.finishBatch(this.batchStart, this.usage);
  }

  diagnostics(reportBuildWarnings = true) {
    return diagnostics(this, IMPORT_ERRORS, reportBuildWarnings);
  }

  verifySnapshot() {
    this.workspace.verifyResolutionInputs();
    // Another process may have applied a whole plan while this one computed.
    // Verify the input graph under the shared commit lock, including new callers.
    const links = new Map();
    const files = inventory(this.root, this.workspace, links, []);
    if (
      files.length !== this.initialPaths.size ||
      files.some((file) => !this.initialPaths.has(file)) ||
      links.size !== this.linkedTargets.size ||
      [...links].some(([file, link]) => this.linkedTargets.get(file) !== link)
    ) {
      throw new Error("Workspace files changed during planning; retry the operation");
    }
    for (const [file, before] of this.original) {
      if (before !== null && !fs.readFileSync(file).equals(before)) {
        throw new Error(`File changed during planning: ${this.rel(file)}`);
      }
    }
  }

  plan() {
    this.index.assertBindings();
    const after = new Map(this.overlay);
    for (const source of this.project.getSourceFiles()) {
      if (source.isSaved()) continue;
      const file = this.path(source.getFilePath());
      let bytes = Buffer.from(source.getFullText());
      if (this.boms.has(file) && !bytes.subarray(0, 3).equals(BOM)) bytes = Buffer.concat([BOM, bytes]);
      after.set(file, bytes);
    }
    for (const write of this.workspace.manifestWrites())
      after.set(this.path(write.path), Buffer.from(write.text));
    const entries = [];
    for (const [file, data] of after) {
      const before = this.before(file);
      if (data === null ? before === null : before?.equals(data)) continue;
      if (isCode(file) && data !== null) {
        try {
          this.assertReadableCode(file);
        } catch (error) {
          error.index = this.editedBy.get(file);
          throw error;
        }
        const parsed = ts.createSourceFile(file, data.toString(), ts.ScriptTarget.Latest, false);
        if (parsed.parseDiagnostics.length) {
          const message = ts.flattenDiagnosticMessageText(parsed.parseDiagnostics[0].messageText, " ");
          const error = new Error(
            `Invalid syntax in ${this.rel(file)} (TypeScript ${ts.version}): ${message}`,
          );
          error.index = this.editedBy.get(file);
          throw error;
        }
      }
      entries.push({ path: file, before, after: data, mode: this.modes.get(file) });
    }
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }
}

module.exports = { Session };
