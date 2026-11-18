// Dependency edits persist for the entire plan, including intermediate batch moves.
const path = require("node:path");
const { isBuiltin } = require("node:module");
const { isDeepStrictEqual } = require("node:util");
const { ts } = require("ts-morph");
const { edit } = require("./manifest");

const runtimeFields = ["dependencies", "peerDependencies", "optionalDependencies"];
const dependencyFields = [...runtimeFields, "devDependencies"];

function declared(pkg, name) {
  return dependencyFields.some(field => Object.hasOwn(pkg.data[field] || {}, name));
}

function packageName(spec) {
  if (spec.startsWith(".") || spec.startsWith("#") || spec.includes(":") || path.isAbsolute(spec)) return;
  return /^(?:@[^/]+\/)?[^@/][^/]*(?=\/|$)/.exec(spec)?.[0];
}

function installedAt(file, name) {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (ts.sys.directoryExists(path.join(dir, "node_modules", name))) return true;
    if (dir === path.dirname(dir)) return false;
  }
}

class DependencyEdits {
  constructor(workspace) {
    this.workspace = workspace;
    this.additions = new Map();
  }

  record(pkg, name, source, keys = []) {
    if (!this.additions.has(pkg)) this.additions.set(pkg, new Map());
    this.additions.get(pkg).set(name, { source, keys, imports: new Map() });
  }

  // A batch can carry a range into a package that the moved file leaves later
  // in the same batch. Remove each carried row that no final file of the
  // package imports. Rows that existed before the batch are never carried.
  prune(session) {
    const imported = new Map();
    for (const [file, refs] of session.index.byFile) {
      const pkg = this.workspace.owner(file);
      if (!this.additions.has(pkg)) continue;
      if (!imported.has(pkg)) imported.set(pkg, new Set());
      for (const ref of refs) if (ref.kind !== "url") imported.get(pkg).add(packageName(ref.spec));
    }
    for (const [pkg, records] of this.additions) {
      const original = JSON.parse(pkg.original);
      for (const [name, record] of records) {
        if (!record.keys.length || imported.get(pkg)?.has(name)) continue;
        for (const keys of record.keys) {
          edit(pkg, keys, undefined);
          if (!Object.hasOwn(original, keys[0]) && !Object.keys(pkg.data[keys[0]]).length) edit(pkg, [keys[0]], undefined);
        }
        records.delete(name);
      }
      if (!records.size) this.additions.delete(pkg);
      if (isDeepStrictEqual(pkg.data, original)) {
        pkg.text = pkg.original;
        pkg.data = original;
      }
    }
  }

  // A package installed only alongside the original module is available as a
  // read-only resolution input until the caller installs the new manifest.
  linkOrigin(pkg, name) {
    return this.additions.get(pkg)?.get(name)?.source;
  }

  awaitingInstall(file, original, spec) {
    const name = packageName(spec);
    const record = this.additions.get(this.workspace.owner(file))?.get(name);
    return record?.imports.get(original)?.has(spec) &&
      !installedAt(file, name) && !installedAt(record.source, name);
  }

  warning() {
    if (!this.additions.size) return;
    const manifests = [...this.additions.keys()].map(pkg => path.relative(this.workspace.root, pkg.filename)).sort();
    return `A package install is necessary before a type check. Updated dependencies in ${manifests.join(", ")}`;
  }

  carryExternal(file, target, original, ref) {
    const ws = this.workspace;
    const { spec } = ref;
    if (!ws.isWorkspace) return false;
    const from = ws.owner(file);
    const to = ws.owner(target);
    if (from === to || !from || !to || ws.packageForSpecifier(spec)) return false;
    if (ref.kind === "require") ref.checkLoaderBinding?.();
    if (ref.ambiguousRequire)
      throw new Error(`Cannot identify the dependency for '${spec}' in ${file}: require is shadowed`);
    if (ws.resolve(target, spec, undefined, ref.resolutionMode ?? ref.kind, true)) {
      throw new Error(`Cannot relocate '${spec}' in ${file}: it resolves to a workspace file at ${target}`);
    }
    if (/^(?:node:|bun:|https?:|data:)/.test(spec)) return true;
    const name = packageName(spec);
    if (!name) throw new Error(`Cannot identify the dependency for '${spec}' in ${file}; check its package mapping before moving it`);
    ws.assertExternalPackageMapping(file, spec, ref.resolutionMode);
    ws.assertExternalPackageMapping(target, spec, ref.resolutionMode);
    // Browser packages can explicitly depend on an npm polyfill whose name
    // also happens to be a Node builtin, e.g. "buffer".
    if (isBuiltin(spec) && !declared(from, name)) return true;

    const pending = this.additions.get(to)?.has(name);
    if (!pending && declared(to, name)) return true;
    const fields = runtimeFields.filter(field => Object.hasOwn(from.data[field] || {}, name));
    if (!fields.length && !pending) {
      throw new Error(`Cannot carry '${spec}' from ${file}: no runtime dependency range for ${name} in ${from.filename}. Declare it before moving the file.`);
    }
    const peer = fields.includes("peerDependencies");
    const meta = Object.hasOwn(from.data.peerDependenciesMeta || {}, name) ? from.data.peerDependenciesMeta[name] : undefined;
    if (peer && (pending || Object.hasOwn(to.data.peerDependenciesMeta || {}, name)) &&
        !isDeepStrictEqual(meta, to.data.peerDependenciesMeta?.[name])) {
      throw new Error(`Conflicting peer dependency metadata for '${spec}' in ${file} and ${to.filename}; choose its peer requirements first`);
    }
    if (pending) {
      if (fields.length && runtimeFields.some(field => from.data[field]?.[name] !== to.data[field]?.[name])) {
        throw new Error(`Conflicting dependency declarations for '${spec}' in ${file} and staged ${to.filename}; choose a shared range and section first`);
      }
    } else {
      const keys = [];
      for (const field of fields) {
        const range = from.data[field][name];
        if (typeof range !== "string" || !range || /^(?:file:|link:|portal:|patch:|\.\.?\/|\/)/.test(range)) {
          throw new Error(`Cannot carry the range for '${spec}' in ${from.filename} to ${to.filename}; set the destination range before moving ${file}`);
        }
        keys.push([field, name]);
      }
      if (peer && meta !== undefined) keys.push(["peerDependenciesMeta", name]);
      for (const key of keys) edit(to, key, key[0] === "peerDependenciesMeta" ? meta : from.data[key[0]][name]);
      this.record(to, name, this.linkOrigin(from, name) || file, keys);
    }
    const { imports } = this.additions.get(to).get(name);
    if (!imports.has(original)) imports.set(original, new Set());
    imports.get(original).add(spec);
    return true;
  }
}

module.exports = { DependencyEdits, dependencyFields, declared, packageName, installedAt };
