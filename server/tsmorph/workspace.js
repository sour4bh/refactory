// Workspace package boundaries and per-importer module resolution.
const fs = require("fs");
const { canonical, configuredPaths, reserved, conventional, commonOutputs } = require("./source-paths");
const { edit, inferExport, relativeFile } = require("./manifest");
const { DependencyEdits, dependencyFields, declared, packageName, installedAt } = require("./dependencies");
const path = require("path");
const { outputRoot, conditionTargets, conditionsFor, possibleEntry, allTargets, literalMode } = require("./package-exports");
const { Project, ts } = require("ts-morph");

const CODE_SUFFIX = /\.(tsx?|jsx?|[mc][tj]s)$/;
const TS_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".js", ".jsx"];
const within = (dir, file) => file === dir || file.startsWith(dir + path.sep);
const slash = (file) => file.split(path.sep).join("/");
const isFile = (file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile() || false;

function readManifest(dir) {
  const filename = path.join(dir, "package.json");
  if (!isFile(filename)) return null;
  const original = fs.readFileSync(filename, "utf8");
  try {
    const data = JSON.parse(original);
    if (!data || Array.isArray(data) || typeof data !== "object") throw new Error("expected a JSON object");
    if (data.name !== undefined && typeof data.name !== "string") throw new Error("expected a string package name");
    return { dir, filename, original, data, text: original };
  } catch (error) {
    throw new Error(`Invalid ${filename}: ${error.message}. Fix the manifest JSON and retry.`);
  }
}

function workspacePatterns(manifest) {
  if (!manifest || !("workspaces" in manifest.data)) return null;
  const value = manifest.data.workspaces;
  const entries = Array.isArray(value) ? value : value?.packages;
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
    throw new Error(`Invalid workspaces in ${manifest.filename}. Use a list of package directory patterns and retry.`);
  }
  return entries.map((entry) => {
    const parts = entry.replace(/^\.\//, "").replace(/\/$/, "").split("/");
    if (parts.some((part) => !part || part === ".." || /[!\[\]{}?\\]/.test(part))) {
      throw new Error(`Unsupported workspace pattern ${entry} in ${manifest.filename}. Use workspace-relative directories or * and ** globs and retry.`);
    }
    return parts;
  });
}

function pnpmPatterns(dir) {
  const filename = path.join(dir, "pnpm-workspace.yaml");
  if (!isFile(filename)) return null;
  const lines = fs.readFileSync(filename, "utf8").split(/\r?\n/);
  const start = lines.findIndex((line) => /^packages:\s*(?:#.*)?$/.test(line));
  if (start < 0) {
    if (lines.some((line) => /^packages\s*:/.test(line)))
      throw new Error(`Unsupported workspace list in ${filename}. Put each package pattern on its own list line and retry.`);
    return null;
  }
  const packages = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^[^\s-]/.test(line)) break;
    const match = /^\s*-\s+(?:"([^"]+)"|'([^']+)'|([^#\s]+))\s*(?:#.*)?$/.exec(line);
    if (!match) throw new Error(`Unsupported workspace list in ${filename}. Put each package pattern on its own list line and retry.`);
    packages.push(match[1] || match[2] || match[3]);
  }
  return workspacePatterns({ data: { workspaces: packages }, filename });
}

function memberDirectories(root, patterns, skipDirs, includeUnpackaged) {
  const result = new Set();
  function directories(dir) {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !skipDirs.has(canonical(entry.name)));
  }
  function visit(dir, parts) {
    if (!parts.length) {
      if (includeUnpackaged || isFile(path.join(dir, "package.json"))) result.add(dir);
      return;
    }
    const [head, ...tail] = parts;
    if (head === "**") {
      visit(dir, tail);
      for (const entry of directories(dir)) visit(path.join(dir, entry.name), parts);
    } else {
      const pattern = new RegExp(
        "^" +
          head
            .split("*")
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*") +
          "$",
      );
      for (const entry of directories(dir)) {
        if (pattern.test(entry.name)) visit(path.join(dir, entry.name), tail);
      }
    }
  }
  for (const parts of patterns) visit(root, parts);
  result.delete(root);
  return [...result];
}

function discover(requestRoot, skipDirs) {
  for (let dir = requestRoot; ; dir = path.dirname(dir)) {
    const manifest = readManifest(dir);
    const packagePatterns = workspacePatterns(manifest);
    const patterns = packagePatterns || pnpmPatterns(dir);
    if (patterns) {
      const dirs = memberDirectories(dir, patterns, skipDirs, !packagePatterns);
      if (dir === requestRoot || dirs.includes(requestRoot)) {
        return {
          root: dir,
          packages: [dir, ...dirs].map((member) => readManifest(member) || { dir: member, data: {} }),
          isWorkspace: true,
        };
      }
    }
    if (fs.existsSync(path.join(dir, ".git")) || dir === path.dirname(dir)) break;
  }
  return { root: requestRoot, packages: [readManifest(requestRoot)].filter(Boolean), isWorkspace: false };
}

function readConfig(dir, warnings, readFile) {
  const file = path.join(dir, "tsconfig.json");
  if (!isFile(file)) return null;
  const config = ts.readJsonConfigFile(file, readFile);
  const parsed = ts.parseJsonSourceFileConfigFileContent(
    config,
    { ...ts.sys, readFile, readDirectory: () => [] },
    dir,
    {},
    file,
  );
  for (const diagnostic of [...config.parseDiagnostics, ...parsed.errors]) {
    if ([18002, 18003].includes(diagnostic.code)) continue;
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    if ([5023, 5025, 5103, 6046].includes(diagnostic.code))
      warnings.push(`${file}: ${message} (TypeScript ${ts.version})`);
    else throw new Error(`${diagnostic.file?.fileName || file}: ${message}. Fix the TypeScript config and retry.`);
  }
  return { options: parsed.options, specs: config.configFileSpecs, paths: configuredPaths(dir, config.configFileSpecs), dir };
}

function exportRows(pkg) {
  const exports = pkg?.data.exports;
  if (exports === undefined) return [];
  if (typeof exports === "string" || exports === null || Array.isArray(exports)) return [[".", exports]];
  const keys = Object.keys(exports);
  if (keys.length && !keys.some((key) => key.startsWith("."))) return [[".", exports]];
  return Object.entries(exports);
}

const rowCache = new WeakMap();

function lookupExport(pkg, subpath) {
  const table = pkg.data.exports;
  if (table && typeof table === "object" && !Array.isArray(table) && Object.hasOwn(table, subpath)) {
    return [subpath, table[subpath]];
  }
  let entries = rowCache.get(pkg);
  if (!entries || entries.table !== table) {
    const rows = exportRows(pkg);
    entries = {
      table,
      root: rows.find(([key]) => key === "."),
      patterns: rows
        .filter(([key]) => key.includes("*"))
        .sort(([a], [b]) => b.split("*")[0].length - a.split("*")[0].length || b.length - a.length),
    };
    rowCache.set(pkg, entries);
  }
  if (subpath === ".") return entries.root;
  return entries.patterns.find(([key]) => capture(key, subpath) !== null);
}

function validSubpath(key) {
  if (key === ".") return true;
  return (
    typeof key === "string" &&
    key.startsWith("./") &&
    key
      .slice(2)
      .split("/")
      .every(
        (part) => part && part !== "." && part !== ".." && part !== "node_modules" && !/[\\*%?#]/.test(part),
      )
  );
}

function packageSubpath(pkg, specifier) {
  const name = pkg.data.name;
  return specifier === name ? "." : "." + specifier.slice(name.length);
}

// Refuse conditional maps where different conditions name different files. The
// editor cannot safely assume that an import and a require select the same row.
function flatTarget(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const targets = [...new Set(Object.values(value).map(flatTarget))];
  return targets.length === 1 ? targets[0] : null;
}

function capture(pattern, value) {
  const index = pattern.indexOf("*");
  if (index === -1) return pattern === value ? "" : null;
  if (pattern.indexOf("*", index + 1) !== -1) return null;
  const left = pattern.slice(0, index),
    right = pattern.slice(index + 1);
  if (value.length < left.length + right.length || !value.startsWith(left) || !value.endsWith(right))
    return null;
  return value.slice(left.length, value.length - right.length);
}

class PublicImportError extends Error {}

class Workspace {
  constructor(projectRoot, { exists = isFile } = {}) {
    this.requestRoot = fs.realpathSync.native(projectRoot);
    Object.assign(this, discover(this.requestRoot, reserved));
    this.exists = exists;
    this.warnings = [];
    this.packages.sort((a, b) => b.dir.length - a.dir.length);
    for (const pkg of this.packages) pkg.canonicalDir = canonical(pkg.dir);
    this.ownerCache = new Map();
    this.memberAncestors = new Set();
    for (const pkg of this.packages) {
      for (let dir = pkg.dir; dir !== this.root; dir = path.dirname(dir)) this.memberAncestors.add(dir);
    }
    this.byName = new Map();
    this.dependencies = new DependencyEdits(this);
    this.manifests = new Map(this.packages.filter((pkg) => pkg.filename).map((pkg) => [pkg.filename, pkg]));
    this.resolutionInputs = new Map();
    this.buildRows = new WeakMap();
    const readFile = (file) => this.readResolutionFile(file);
    this.includedDirectories = new Map();
    this.preferredExports = new Map();
    for (const pkg of this.packages) {
      const name = pkg.data.name;
      if (name && this.byName.has(name)) {
        throw new Error(`Duplicate workspace package name ${name} in ${pkg.filename} and ${this.byName.get(name).filename}. Give each package a unique name and retry.`);
      }
      if (name) this.byName.set(name, pkg);
      pkg.config = readConfig(pkg.dir, this.warnings, readFile);
      pkg.options = pkg.config?.options;
    }
    const rootPackage = this.packages.find((pkg) => pkg.dir === this.root);
    this.rootConfig = rootPackage ? rootPackage.config : readConfig(this.root, this.warnings, readFile);
    this.defaultOptions = this.rootConfig?.options || {};
    this.outputDirs = new Set();
    const configs = [this.rootConfig, ...this.packages.map(pkg => pkg.config)].filter(Boolean);
    for (const config of configs) {
      for (const dir of [config.options.outDir, config.options.declarationDir]) {
        if (dir && dir !== config.dir) this.outputDirs.add(canonical(dir));
      }
    }
    for (const pkg of this.packages) {
      // Published JS/declarations in a conventional output directory can be read
      // even when a member has no outDir. A direct .ts source export is editable.
      pkg.publishedOutputs = new Set();
      for (const raw of allTargets([pkg.data.exports, pkg.data.main, pkg.data.types, pkg.data.typings])) {
        const [first] = path.relative(pkg.dir, path.resolve(pkg.dir, raw)).split(path.sep);
        if (commonOutputs.has(canonical(first)) && /(?:\.[cm]?js|\.d\.[cm]?ts)$/.test(raw))
          pkg.publishedOutputs.add(canonical(first));
      }
    }
    // One checker shares declarations across members. In a rootless workspace
    // give it the compiler settings common to the members (e.g. strict, JSX).
    // Paths, moduleSuffixes, etc. are always resolved with the importer's options.
    const configured = this.packages.map((pkg) => pkg.options).filter(Boolean);
    this.checkerOptions = { ...this.defaultOptions };
    if (this.isWorkspace && configured.length) {
      for (const [key, value] of Object.entries(configured[0])) {
        if (!(key in this.checkerOptions) && configured.every((options) => options[key] === value)) {
          this.checkerOptions[key] = value;
        }
      }
    }
  }

  readResolutionFile(file) {
    const manifest = this.manifests.get(file);
    if (manifest) return manifest.text;
    if (!this.resolutionInputs.has(file)) this.resolutionInputs.set(file, ts.sys.readFile(file));
    return this.resolutionInputs.get(file);
  }

  verifyResolutionInputs() {
    for (const [file, original] of this.resolutionInputs) {
      if (ts.sys.readFile(file) !== original)
        throw new Error(`Resolution config changed during planning: ${file}`);
    }
  }

  owner(file) {
    if (!this.ownerCache.has(file)) {
      const spelling = canonical(file);
      this.ownerCache.set(file, this.packages.find((pkg) => within(pkg.canonicalDir, spelling)) || null);
    }
    return this.ownerCache.get(file);
  }

  outputDirectory(file, directory = false) {
    const spelling = canonical(file);
    for (const dir of this.outputDirs) if (within(dir, spelling)) return dir;
    return outputRoot(this.owner(file), file, directory);
  }

  skipReason(file, directory = false) {
    const relative = path.relative(this.root, file).split(path.sep);
    if (relative.some(part => reserved.has(canonical(part)))) return "skipped directory";
    if (this.outputDirectory(file, directory)) return "generated build output";
    const pkg = this.owner(file);
    const config = pkg?.config || this.rootConfig;
    if (config?.paths.excludes(file)) return "excluded by " + path.join(config.dir, "tsconfig.json");
    const parts = path.relative(pkg?.dir || this.root, file).split(path.sep);
    if (parts.some(part => conventional.has(canonical(part)))) {
      // Also discover assets beside included sources. Other project files keep
      // their broader mutation inventory, including unbuilt script consumers.
      const included = directory ? config?.paths.enters(file) :
        config?.paths.includes(file) || (!CODE_SUFFIX.test(file) && config?.paths.enters(path.dirname(file)));
      if (!included) return "skipped directory outside configured sources";
    }
  }

  includes(file) {
    if (!within(this.root, file) || this.skipReason(file)) return false;
    const pkg = this.owner(file);
    const parent = path.dirname(file);
    if (this.includedDirectories.has(parent)) return this.includedDirectories.get(parent);
    if (!this.isWorkspace) return true;
    if (!pkg) return false;
    // The root may own scripts and config files. An undeclared package below
    // it is a separate project; never edit it through this workspace.
    for (let dir = path.dirname(file); within(pkg.dir, dir) && dir !== pkg.dir; dir = path.dirname(dir)) {
      if (isFile(path.join(dir, "package.json"))) {
        this.includedDirectories.set(parent, false);
        return false;
      }
    }
    this.includedDirectories.set(parent, true);
    return true;
  }

  options(file) {
    return this.owner(file)?.options || this.defaultOptions;
  }

  // Directories that a specifier which starts with prefix can reach through
  // tsconfig paths or baseUrl. A directory can be wider than the mapping.
  mappedDirectories(from, prefix) {
    const options = this.options(from);
    const base = options.baseUrl || options.pathsBasePath || this.owner(from)?.dir || this.root;
    const directory = value => path.resolve(base, value.slice(0, value.lastIndexOf("/") + 1));
    const dirs = [];
    for (const [alias, patterns] of Object.entries(options.paths || {})) {
      const star = alias.indexOf("*");
      if (star < 0) {
        if (alias.startsWith(prefix)) dirs.push(...patterns.map(pattern => path.dirname(path.resolve(base, pattern))));
        continue;
      }
      const left = alias.slice(0, star);
      if (!prefix.startsWith(left) && !left.startsWith(prefix)) continue;
      const captured = prefix.startsWith(left) ? prefix.slice(left.length) : "";
      for (const pattern of patterns) dirs.push(directory(pattern.split("*")[0] + captured));
    }
    if (options.baseUrl) dirs.push(path.resolve(options.baseUrl, prefix.slice(0, prefix.lastIndexOf("/") + 1)));
    return dirs;
  }

  hasAlias(from, specifier) {
    return Object.keys(this.options(from).paths || {}).some((key) => capture(key, specifier) !== null);
  }

  packageForSpecifier(specifier) {
    if (specifier.startsWith(".")) return null;
    const count = specifier.startsWith("@") ? 2 : 1;
    return this.byName.get(specifier.split("/").slice(0, count).join("/")) || null;
  }

  // Generated files can be consulted through public package entries but are
  // excluded from the source inventory and checked for races under the lock.
  buildFileExists(file) {
    if (!this.resolutionInputs.has(file) && isFile(file) && fs.realpathSync(file) !== file)
      return false;
    return this.readResolutionFile(file) !== undefined;
  }

  fileAt(base, plannedTarget, build = false) {
    const ext = path.extname(base);
    const candidates = [];
    if ([".js", ".jsx"].includes(ext)) {
      const stub = base.slice(0, -ext.length);
      for (const suffix of [".ts", ".tsx", ".d.ts", ext]) candidates.push(stub + suffix);
    } else if ([".mjs", ".cjs"].includes(ext)) {
      const stub = base.slice(0, -ext.length);
      for (const suffix of [ext.replace("j", "t"), ".d" + ext.replace("j", "t"), ext])
        candidates.push(stub + suffix);
    } else {
      candidates.push(base);
      if (!ext) {
        for (const suffix of TS_EXTENSIONS) candidates.push(base + suffix);
        for (const suffix of TS_EXTENSIONS) candidates.push(path.join(base, "index" + suffix));
      }
    }
    return candidates.find((file) => file === plannedTarget || (build ? this.buildFileExists(file) : this.exists(file))) || null;
  }

  exportFile(pkg, base, plannedTarget) {
    const file = this.fileAt(base, plannedTarget);
    if (file && file !== base && (this.exists(base) || base === plannedTarget)) {
      throw new Error(
        `Ambiguous target in ${pkg.filename}: runtime file ${base} and TypeScript file ${file} differ`,
      );
    }
    return file;
  }

  packageEntry(pkg, specifier, plannedTarget, from = pkg.dir, kind) {
    const subpath = packageSubpath(pkg, specifier);
    if (!validSubpath(subpath)) return {};
    const match = lookupExport(pkg, subpath);
    if (!match && (pkg.data.exports !== undefined || subpath !== ".")) return {};
    const [key, row] = match || [".", null];
    const fallback = subpath === "." ? [pkg.data.types, pkg.data.main].filter(entry => typeof entry === "string") : [];
    const options = this.options(from);
    const targets = typeof row === "string" ? [row] :
      conditionTargets(row, conditionsFor(this.owner(from), from, options, kind));
    let missing;
    let attempted = false;
    function validBase(dir, raw) {
      if (raw.includes("*") && !key.includes("*")) return;
      const expanded = raw.replaceAll("*", () => capture(key, subpath));
      const base = path.resolve(dir, expanded);
      if (!within(dir, base) || expanded.split("/").includes("node_modules")) return;
      return base;
    }
    const find = (entries, isExport) => {
      for (const entry of entries) {
        if (isExport && !entry.startsWith("./")) continue;
        const base = validBase(pkg.dir, entry);
        if (!base) continue;
        attempted = true;
        const generated = !!outputRoot(pkg, base);
        const file = this.fileAt(base, plannedTarget, generated);
        if (file) return {file};
        if (generated) missing ??= base;
      }
    };
    const selected = find(targets, true);
    if (selected) return selected;
    if (!match || (attempted && subpath === ".")) {
      const entry = find(fallback.length ? fallback : !match ? ["./index"] : [], false);
      if (entry) return entry;
    }
    return {missing};
  }

  packageFile(pkg, specifier, plannedTarget, from, kind) {
    return this.packageEntry(pkg, specifier, plannedTarget, from, kind).file || null;
  }

  resolve(from, specifier, plannedTarget, kind, includeUnbuilt = false) {
    try {
      return this.resolveModule(from, specifier, plannedTarget, kind, includeUnbuilt);
    } catch (error) {
      throw new Error(`Cannot resolve '${specifier}' from ${from}: ${error.message}. Check the import and its configured target, then retry.`);
    }
  }

  resolveModule(from, specifier, plannedTarget, kind, includeUnbuilt) {
    const pkg = this.packageForSpecifier(specifier);
    const options = this.options(from);
    const fileSpecifier = specifier.startsWith(".") || path.isAbsolute(specifier);
    const base = fileSpecifier && path.resolve(path.dirname(from), specifier);
    const packageFallback = () => {
      if (!pkg) return null;
      const entry = this.packageEntry(pkg, specifier, plannedTarget, from, kind);
      return entry.file || (includeUnbuilt && entry.missing) || null;
    };
    if (pkg && !this.hasAlias(from, specifier) && !options.baseUrl) return packageFallback();
    if (
      fileSpecifier &&
      path.extname(specifier) &&
      !CODE_SUFFIX.test(specifier) &&
      (base === plannedTarget || this.exists(base))
    ) {
      return base;
    }
    // Leave installed dependencies to the compiler's normal resolution host.
    // Internal references also resolve against newly created paths in a batch.
    if (!fileSpecifier && !options.paths && !options.baseUrl && !specifier.startsWith("#")) return null;
    const builtImporter = outputRoot(this.owner(from), from);
    const host = {
      fileExists: (file) => file === plannedTarget || this.exists(file) ||
        (builtImporter && outputRoot(this.owner(file), file) && this.buildFileExists(file)),
      readFile: (file) => this.readResolutionFile(file),
      directoryExists: (dir) => within(this.root, dir) || ts.sys.directoryExists(dir),
    };
    const result = ts.resolveModuleName(specifier, from, options, host).resolvedModule;
    if (result) {
      const file = result.resolvedFileName;
      if (!fileSpecifier && result.isExternalLibraryImport && file.split(path.sep).includes("node_modules"))
        return packageFallback();
      if (
        fileSpecifier &&
        base !== file &&
        /\.[cm]?jsx?$/.test(base) &&
        !builtImporter && (this.exists(base) || base === plannedTarget)
      ) {
        throw new Error(
          `Ambiguous import in ${from}: runtime file ${base} and TypeScript file ${file} differ`,
        );
      }
      if (
        fileSpecifier &&
        path.extname(base) &&
        !CODE_SUFFIX.test(base) &&
        (/\.d\.[cm]?ts$/.test(file) || file.endsWith(".d" + path.extname(base) + ".ts"))
      )
        return null;
      return file;
    }
    // The TS resolver does not load arbitrary assets. Resolve aliases to
    // their exact on-disk/virtual file for stylesheet, JSON and image moves.
    const mappings = Object.entries(options.paths || {})
      .filter(([alias]) => capture(alias, specifier) !== null)
      .sort(
        ([a], [b]) =>
          Number(a.includes("*")) - Number(b.includes("*")) ||
          b.split("*")[0].length - a.split("*")[0].length,
      );
    for (const [alias, paths] of mappings.slice(0, 1)) {
      const dir = options.baseUrl || options.pathsBasePath || this.owner(from)?.dir || this.root;
      for (const pattern of paths) {
        const candidate = path.resolve(
          dir,
          pattern.replace("*", () => capture(alias, specifier)),
        );
        if (candidate === plannedTarget || this.exists(candidate)) return candidate;
      }
    }
    if (options.baseUrl && !fileSpecifier) {
      const candidate = path.resolve(options.baseUrl, specifier);
      if (candidate === plannedTarget || this.exists(candidate)) return candidate;
    }
    return packageFallback();
  }

  specifier(from, target, original, kind) {
    const importer = this.owner(from),
      destination = this.owner(target);
    const crossPackage = importer !== destination;
    if (original && destination && this.packageForSpecifier(original) === destination &&
        outputRoot(destination, target)) {
      if (this.resolve(from, original, undefined, kind, true) !== target)
        throw new Error(`Cannot keep '${original}' in ${from}: its alias or package conditions select a different target`);
      return original;
    }
    if (!crossPackage && original && this.resolve(from, original, target, kind) === target) return original;
    if (crossPackage || (original && destination && this.packageForSpecifier(original) === destination)) {
      if (!destination?.data.name)
        throw new PublicImportError(`Cannot import ${target} across package boundary: missing package name`);
      const rows = exportRows(destination);
      const rel = "./" + slash(path.relative(destination.dir, target));
      const choices = [];
      if (this.preferredExports.has(target)) choices.push(this.preferredExports.get(target));
      for (const [key, row] of rows) {
        const value = flatTarget(row);
        if (!value) continue;
        const matched = capture(value, rel);
        if (
          matched !== null ||
          (!value.includes("*") && this.fileAt(path.resolve(destination.dir, value), target) === target)
        ) {
          choices.push(key.replace("*", () => matched));
        }
      }
      if (
        destination.data.exports === undefined &&
        [destination.data.types, destination.data.main, "./index"].some(
          (entry) => entry && this.fileAt(path.resolve(destination.dir, entry), target) === target,
        )
      )
        choices.push(".");
      const name = destination.data.name;
      const oldKey =
        original && this.packageForSpecifier(original) === destination
          ? packageSubpath(destination, original)
          : null;
      const shadowed = [];
      for (const selected of oldKey ? [oldKey, ...choices] : choices) {
        const candidate = name + (selected === "." ? "" : selected.slice(1));
        if (this.packageFile(destination, candidate, target, from, kind) !== target) continue;
        const resolved = this.resolve(from, candidate, target, kind);
        if (resolved === target) return candidate;
        shadowed.push(`${candidate} resolves to ${resolved || "no file"}`);
      }
      if (crossPackage && shadowed.length) {
        throw new PublicImportError(`Cannot import ${target} from ${from}: ${shadowed.join(", ")}`);
      }
      if (crossPackage)
        throw new PublicImportError(`Module ${slash(path.relative(this.root, target))} is not exported by ${name}`);
    }

    return this.localSpecifier(from, target, original, kind);
  }

  localSpecifier(from, target, original, kind) {
    const options = this.options(from);
    let suffix = "";
    if (CODE_SUFFIX.test(target)) {
      if (original !== undefined) {
        suffix = original.match(CODE_SUFFIX)?.[0] || "";
        if (/^\.[cm]?tsx?$/.test(suffix)) suffix = path.extname(target);
      } else if (options.allowImportingTsExtensions) suffix = path.extname(target);
      else if ([ts.ModuleKind.Node16, ts.ModuleKind.NodeNext].includes(options.module)) suffix = ".js";
      else if (options.module === undefined && !this.isWorkspace) {
        throw new Error("cannot infer import extension style; pass originalSpecifier or configure tsconfig");
      }
    }

    const styled = target.replace(CODE_SUFFIX, suffix);
    if (original && !original.startsWith(".")) {
      const mappings = Object.entries(options.paths || {});
      // Prefer the importer's old alias when multiple aliases cover the target.
      mappings.sort(
        ([a], [b]) => Number(capture(b, original) !== null) - Number(capture(a, original) !== null),
      );
      const dir = options.baseUrl || options.pathsBasePath || this.owner(from)?.dir || this.root;
      for (const [alias, patterns] of mappings) {
        for (const pattern of patterns) {
          const absolute = path.resolve(dir, pattern);
          for (const candidate of [styled, target]) {
            const matched = capture(absolute, candidate);
            if (matched === null) continue;
            const spec = alias.replace("*", () => slash(matched));
            if (this.resolve(from, spec, target, kind) === target) return spec;
          }
        }
      }
    }
    const relative = slash(path.relative(path.dirname(from), styled));
    const candidate = relative.startsWith("../") || relative.startsWith("./") ? relative : "./" + relative;
    if (this.resolve(from, candidate, target, kind) !== target) {
      throw new Error(
        `Cannot express an unambiguous import of ${target} from ${from}: ${candidate} resolves elsewhere`,
      );
    }
    return candidate;
  }

  builtRows(pkg) {
    let cached = this.buildRows.get(pkg);
    if (!cached || cached.data !== pkg.data) {
      const rows = [...exportRows(pkg), [".", [pkg.data.main, pkg.data.types]]];
      cached = { data: pkg.data, rows: rows.filter(([, row]) =>
        [...allTargets(row)].some(raw => outputRoot(pkg, path.resolve(pkg.dir, raw))),
      ) };
      this.buildRows.set(pkg, cached);
    }
    return cached.rows;
  }

  builtEntryRow(pkg, source) {
    if (!pkg || !within(pkg.dir, source)) return;
    return this.builtRows(pkg).find(([key, row]) => possibleEntry(pkg, source, key, row))?.[0];
  }

  isEntryFile(pkg, file) {
    if (this.builtEntryRow(pkg, file)) return true;
    const relative = relativeFile(pkg, file);
    const entries = pkg.data.exports === undefined
      ? [pkg.data.types, pkg.data.main, "./index"]
      : exportRows(pkg).map(([, row]) => row);
    for (const entry of allTargets(entries)) {
      if (capture(entry, relative) !== null || this.fileAt(path.resolve(pkg.dir, entry)) === file) return true;
    }
    return false;
  }

  editExports(pkg, source, target) {
    if (!pkg) return false;
    const builtRow = this.builtEntryRow(pkg, source);
    if (builtRow) throw new Error(`Cannot move or delete ${source}: built entry '${builtRow}' in ${pkg.filename} may depend on this source. Update the build entry and manifest explicitly first.`);
    const oldValue = relativeFile(pkg, source);
    const value = target ? relativeFile(pkg, target) : undefined;
    let found = false;
    const pointsAtSource = (raw) => {
      if (typeof raw !== "string") return false;
      if (raw.includes("*")) return capture(raw, oldValue) !== null;
      const base = path.resolve(pkg.dir, raw);
      if (base !== source && this.fileAt(base) !== source) return false;
      this.exportFile(pkg, base);
      if (!within(pkg.dir, source)) throw new Error(`Cannot edit target outside ${pkg.filename}: ${raw}`);
      return true;
    };
    const { main, types } = pkg.data;
    if (typeof main === "string" && typeof types === "string" && main !== types &&
        (pointsAtSource(main) || pointsAtSource(types))) {
      const runtime = path.resolve(pkg.dir, main);
      const declaration = path.resolve(pkg.dir, types);
      if ((this.exists(runtime) ? runtime : this.fileAt(runtime)) !== this.fileAt(declaration)) {
        throw new Error(`Cannot safely edit ${source}: main and types in ${pkg.filename} point to different files. Update the runtime and declaration entries together.`);
      }
    }
    const touches = (row) =>
      pointsAtSource(row) || (row && typeof row === "object" && Object.values(row).some(touches));
    for (const [key, row] of exportRows(pkg)) {
      if (touches(row)) {
        const raw = flatTarget(row);
        if (typeof row !== "string" || key.includes("*") || raw.includes("*")) {
          throw new Error(`Cannot safely edit conditional or wildcard export ${key} in ${pkg.filename}`);
        }
        const keys = typeof pkg.data.exports === "string" ? ["exports"] : ["exports", key];
        // Keep an empty exports map when its last public entry disappears.
        edit(pkg, keys, keys.length === 1 && !target ? {} : value);
        found = true;
      }
    }
    for (const field of ["types", "main"]) {
      const raw = pkg.data[field];
      if (pointsAtSource(raw)) {
        edit(pkg, [field], value);
        found = true;
      }
    }
    return found;
  }

  relocateExports(source, target) {
    this.preferredExports.delete(source);
    let ownerWasPublic = false;
    for (const pkg of this.packages) {
      const updated = this.editExports(pkg, source, target && within(pkg.dir, target) ? target : null);
      if (updated && pkg === this.owner(source)) ownerWasPublic = true;
    }
    return ownerWasPublic;
  }

  deleteExports(source) {
    return this.relocateExports(source, null);
  }

  moveExports(source, target, exportAs, privateCompanion = false, transient = false) {
    const from = this.owner(source),
      to = this.owner(target);
    if (from === to) {
      if (exportAs) throw new Error("exportAs is only supported for a cross-package move");
      this.relocateExports(source, target);
      return;
    }
    if (!from?.filename || !to?.data.name)
      throw new Error("Cross-package moves require named packages with package.json");
    const wasPublic = this.relocateExports(source, target);
    if (transient || (privateCompanion && !wasPublic)) return;
    const value = relativeFile(to, target);
    const key = exportAs ?? exportRows(to).find(([, row]) => row === value)?.[0] ?? inferExport(to, target);
    if (!validSubpath(key)) {
      throw new Error(`Invalid exportAs subpath: ${key}`);
    }
    const rows = exportRows(to);
    const existing = rows.find(([k]) => k === key);
    const spec = to.data.name + (key === "." ? "" : key.slice(1));
    const occupied = this.packageFile(to, spec);
    if (occupied && occupied !== target) throw new Error(`Export ${key} already resolves to ${occupied}`);
    if (exportAs) this.preferredExports.set(target, key);
    if (existing && flatTarget(existing[1]) !== value)
      throw new Error(`Export ${key} already exists in ${to.filename}`);
    if (existing) return;
    // Adding a subpath must preserve any existing bare entry, including a
    // main/types fallback that would otherwise be disabled by the new map.
    if (typeof to.data.exports === "string") edit(to, ["exports"], { ".": to.data.exports });
    else if (to.data.exports === undefined) {
      const entries = [
        ...new Set(
          [to.data.types, to.data.main]
            .filter(Boolean)
            .map((entry) => relativeFile(to, path.resolve(to.dir, entry))),
        ),
      ];
      const fallback = this.fileAt(path.join(to.dir, "index"));
      if (!entries.length && fallback) entries.push(relativeFile(to, fallback));
      if (entries.length > 1 || (entries.length && key === "." && entries[0] !== value)) {
        throw new Error(
          `Cannot preserve existing package entry points of ${to.data.name} while adding ${key}`,
        );
      }
      if (entries.length) edit(to, ["exports"], { ".": entries[0] });
    } else if (
      !to.data.exports ||
      Array.isArray(to.data.exports) ||
      Object.keys(to.data.exports).some((k) => !k.startsWith("."))
    ) {
      throw new Error(`Cannot safely extend conditional exports in ${to.filename}`);
    }
    edit(to, ["exports", key], value);
  }

  manifestWrites() {
    return this.packages
      .filter((pkg) => pkg.text !== pkg.original)
      .map((pkg) => ({ path: pkg.filename, text: pkg.text }));
  }

  usage(edges) {
    const usage = new Map();
    for (const { from, to } of edges) {
      if (!to) continue;
      const importer = this.owner(from),
        target = this.owner(to);
      if (!importer || !target || importer === target || !target.data.name) continue;
      if (!usage.has(importer)) usage.set(importer, new Set());
      usage.get(importer).add(target);
    }
    return usage;
  }

  // A batch writes dependency rows, and reports unused rows and cycles, for its
  // final state. Each step only records the version that its new edges need.
  startBatch() {
    this.batch = { versions: new Map(), policies: [] };
  }

  finishBatch(before, after) {
    const { versions, policies } = this.batch;
    this.batch = null;
    if (!this.isWorkspace) return;
    this.writeUsage(before, after, (pkg, target) => {
      const decision = versions.get(pkg)?.get(target);
      if (decision?.error) throw decision.error;
      return decision ? decision.version : this.workspaceVersion(pkg, target, before);
    }, route => policies.find(policy => route.includes(policy.sourcePackage) && route.includes(policy.destinationPackage)));
  }

  reconcile(before, after, policy = {}, index) {
    if (!this.isWorkspace) return;
    if (!this.batch) {
      this.writeUsage(before, after, (pkg, target) => this.workspaceVersion(pkg, target, before, policy),
        () => policy.rejectCycles);
      return;
    }
    if (policy.rejectCycles) this.batch.policies.push({ ...policy, index });
    for (const [pkg, targets] of after) {
      for (const target of targets) {
        if (before.get(pkg)?.has(target) || declared(pkg, target.data.name)) continue;
        if (!this.batch.versions.has(pkg)) this.batch.versions.set(pkg, new Map());
        // The latest step that introduces an edge decides its version.
        let decision;
        try {
          decision = { version: this.workspaceVersion(pkg, target, before, policy) };
        } catch (error) {
          error.index = index;
          decision = { error };
        }
        this.batch.versions.get(pkg).set(target, decision);
      }
    }
  }

  workspaceVersion(pkg, target, before, policy = {}) {
    const name = target.data.name;
    const carried = pkg === policy.destinationPackage && before.get(policy.sourcePackage)?.has(target) &&
      this.builtRows(target).length
      ? dependencyFields.map(field => policy.sourcePackage.data[field]?.[name]).filter(version =>
          typeof version === "string" && version.startsWith("workspace:"))
      : [];
    const versions = new Set(
      carried.length ? carried : dependencyFields.flatMap((field) =>
        Object.entries(pkg.data[field] || {})
          .filter(
            ([dep, version]) =>
              this.byName.has(dep) && typeof version === "string" && version.startsWith("workspace:"),
          )
          .map(([, version]) => version),
      ),
    );
    if (
      versions.size > 1 ||
      [...versions].some((version) => !["workspace:*", "workspace:~", "workspace:^"].includes(version))
    ) {
      throw new Error(`Cannot infer workspace dependency version for ${name} in ${pkg.filename}`);
    }
    return [...versions][0] || "workspace:*";
  }

  writeUsage(before, after, version, refusal) {
    const added = [];
    const addedUsage = [];
    for (const pkg of this.packages) {
      const initial = before.get(pkg) || new Set();
      const final = after.get(pkg) || new Set();
      for (const target of final) {
        const name = target.data.name;
        if (initial.has(target)) continue;
        addedUsage.push([pkg, target]);
        if (declared(pkg, name)) continue;
        edit(pkg, ["dependencies", name], version(pkg, target));
        this.dependencies.record(pkg, name);
        added.push([pkg, target]);
      }
      for (const target of initial) {
        if (!final.has(target) && declared(pkg, target.data.name)) {
          this.warnings.push(
            `${pkg.data.name || pkg.dir} no longer imports ${target.data.name}; dependency retained`,
          );
        }
      }
    }
    const declaredEdges = (pkg) =>
      this.packages.filter((next) => next.data.name && declared(pkg, next.data.name));
    const usedEdges = (pkg) => after.get(pkg) || [];
    function cycle(pkg, target, edges) {
      function route(node, seen) {
        if (node === pkg) return [pkg];
        if (seen.has(node)) return null;
        seen.add(node);
        for (const next of edges(node)) {
          const tail = route(next, seen);
          if (tail) return [node, ...tail];
        }
        return null;
      }
      const tail = route(target, new Set());
      return tail && [pkg, ...tail];
    }
    for (const [pairs, edges] of [
      [added, declaredEdges],
      [addedUsage, usedEdges],
    ]) {
      for (const [pkg, target] of pairs) {
        const route = cycle(pkg, target, edges);
        if (!route) continue;
        const warning = `Dependency cycle: ${route.map((p) => p.data.name || p.dir).join(" -> ")}`;
        const rejected = refusal(route);
        if (rejected) {
          const error = new Error(warning + ". Move the consumers or break the cycle before redirecting the entry export.");
          if (rejected.index !== undefined) error.index = rejected.index;
          throw error;
        }
        if (!this.warnings.includes(warning)) this.warnings.push(warning);
      }
    }
  }

  installedModule(from, specifier, options, host, mode) {
    // The disk can still contain workspace files that this batch moved or deleted.
    // Let the normal host supply only declarations or sources in installed packages.
    const result = ts.resolveModuleName(specifier, from, options, {
      ...host,
      fileExists: file => this.includes(file) ? this.exists(file) : host.fileExists(file),
      readFile: (file) => this.readResolutionFile(file),
    }, undefined, undefined, mode).resolvedModule;
    return result?.resolvedFileName.split(path.sep).includes("node_modules") ? result : undefined;
  }

  externalMode(file, options, host, mode) {
    if (mode !== undefined || !ts.importSyntaxAffectsModuleResolution(options)) return mode;
    return ts.getImpliedNodeFormatForFile(file, undefined, {
      ...host,
      readFile: file => this.readResolutionFile(file),
    }, options);
  }

  assertExternalPackageMapping(file, spec, mode) {
    const options = this.options(file);
    if (!options.baseUrl && !this.hasAlias(file, spec)) return;
    mode = this.externalMode(file, options, ts.sys, mode);
    const mapped = this.installedModule(file, spec, options, ts.sys, mode);
    if (!mapped) return;
    const plain = this.installedModule(file, spec, { ...options, baseUrl: undefined, paths: undefined }, ts.sys, mode);
    if (mapped.resolvedFileName !== plain?.resolvedFileName) {
      throw new Error(`Cannot carry '${spec}' for ${file}: a path alias resolves to ${mapped.resolvedFileName}; select its package explicitly`);
    }
  }

  resolveExternal(from, specifier, host = ts.sys, mode) {
    // Both lookup locations must use the importing file's condition. The old
    // link may be in a CommonJS member while the moved module emits ESM.
    const options = this.options(from);
    mode = this.externalMode(from, options, host, mode);
    const resolve = (anchor) => this.installedModule(anchor, specifier, options, host, mode);
    const local = resolve(from);
    if (local || !this.dependencies.additions.size) return local;
    const name = packageName(specifier);
    const origin = name && this.dependencies.linkOrigin(this.owner(from), name);
    if (!origin) return;
    // An installed but incompatible destination package (e.g. a missing
    // subpath) must still produce its own diagnostics.
    if (installedAt(from, name)) return;
    return resolve(origin);
  }

  makeProject(options = this.checkerOptions, fileSystem) {
    const compilerOptions = { allowJs: true, checkJs: false, ...options };
    if (this.isWorkspace) {
      if (compilerOptions.jsx === undefined) compilerOptions.jsx = ts.JsxEmit.Preserve;
      if (compilerOptions.module === undefined) compilerOptions.module = ts.ModuleKind.ESNext;
      if (compilerOptions.moduleResolution === undefined)
        compilerOptions.moduleResolution = ts.ModuleResolutionKind.Bundler;
    }
    return new Project({
      fileSystem,
      compilerOptions,
      resolutionHost: host => this.resolutionHost(host),
    });
  }

  resolutionHost(host) {
    return {
      resolveModuleNames: (names, from, reusedNames, redirect, options, source) => {
        // ts-morph exposes the compiler's legacy name resolver. The containing
        // SourceFile supplies each literal and its per-import resolution mode.
        const modes = new Map();
        for (const literal of source?.imports || []) {
          if (!modes.has(literal.text)) modes.set(literal.text, []);
          modes.get(literal.text).push(literalMode(literal));
        }
        return names.map((name) => {
          const kind = modes.get(name)?.shift();
          if (!this.includes(from) && !outputRoot(this.owner(from), from)) return this.resolveExternal(from, name, host, kind);
          const file = this.resolve(from, name, undefined, kind);
          if (
            file &&
            (CODE_SUFFIX.test(file) || (file.endsWith(".json") && this.options(from).resolveJsonModule))
          ) {
            return {
              resolvedFileName: file,
              extension: ts.extensionFromPath(file),
              isExternalLibraryImport: false,
            };
          }
          if (this.packageForSpecifier(name) || (name.startsWith(".") && within(this.root, from)))
            return undefined;
          return this.resolveExternal(from, name, host, kind);
        });
      },
    };
  }
}

module.exports = { Workspace, PublicImportError };
