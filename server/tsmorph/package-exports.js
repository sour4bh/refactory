// A published package can expose generated files for reading while its source
// and manifest remain the only writable parts of the refactoring workspace.
const path = require("node:path");
const { ts } = require("ts-morph");
const { canonical } = require("./source-paths");

const within = (dir, file) => file === dir || file.startsWith(dir + path.sep);

function outputRoot(pkg, file, directory = false) {
  if (!pkg || !within(pkg.canonicalDir, canonical(file))) return;
  for (const dir of [pkg.options?.declarationDir, pkg.options?.outDir]) {
    if (dir && dir !== pkg.dir && within(pkg.dir, dir) && within(dir, file)) return dir;
  }
  const first = path.relative(pkg.dir, file).split(path.sep)[0];
  if (!pkg.publishedOutputs?.has(canonical(first))) return;
  // A conventional directory can contain both a published declaration and
  // configured TS sources. Only compiler outDir/declarationDir reserve the
  // entire tree unconditionally.
  if (directory && pkg.config?.paths.enters(file)) return;
  if (/\.[cm]?tsx?$/.test(file) && !/\.d\.[cm]?ts$/.test(file) && pkg.config?.paths.includes(file)) return;
  return path.join(pkg.dir, first);
}

function* conditionTargets(row, conditions) {
  if (typeof row === "string") yield row;
  else if (Array.isArray(row)) {
    for (const option of row) yield* conditionTargets(option, conditions);
  } else if (row && typeof row === "object") {
    // Prefer explicit declarations for type checking, even in manifests that
    // list the runtime condition first. For the other active conditions use
    // package.json key order, including nested import/require branches.
    const entries = Object.entries(row);
    for (const [key, branch] of entries) {
      if ((key === "types" && conditions.includes(key)) || ts.isApplicableVersionedTypesKey(conditions, key))
        yield* conditionTargets(branch, conditions);
    }
    for (const [key, branch] of entries) {
      if (key !== "types" && (key === "default" || conditions.includes(key)))
        yield* conditionTargets(branch, conditions);
    }
  }
}

function conditionsFor(pkg, from, options, kind) {
  let mode;
  if (kind === "require" || kind === ts.ModuleKind.CommonJS) mode = ts.ModuleKind.CommonJS;
  else if (kind === "dynamic" || kind === ts.ModuleKind.ESNext) mode = ts.ModuleKind.ESNext;
  else if (options.module === ts.ModuleKind.CommonJS || /\.[cm][tj]s$/i.test(from || "")) {
    mode = /\.m[tj]s$/i.test(from || "") ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS;
  } else if ([ts.ModuleKind.Node16, ts.ModuleKind.Node18, ts.ModuleKind.Node20, ts.ModuleKind.NodeNext].includes(options.module)) {
    mode = pkg?.data.type === "module" ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS;
  } else mode = ts.ModuleKind.ESNext;
  return ts.getConditions(options, mode);
}

function* allTargets(row) {
  if (typeof row === "string") yield row;
  else if (row && typeof row === "object") {
    for (const branch of Object.values(row)) yield* allTargets(branch);
  }
}

const stripExtension = (file) => file.replace(/(?:\.d)?\.[cm]?[tj]sx?$/i, "");

// Only use output/source layouts to refuse a possible entry edit. Never infer a
// source resolution or rewrite the output map from the spelling of an artifact.
function possibleEntry(pkg, source, key, row) {
  if (!within(pkg.dir, source)) return false;
  const roots = [pkg.options?.rootDir, path.join(pkg.dir, "src"), pkg.dir];
  const sourceNames = roots.filter(dir => dir && within(dir, source))
    .map(dir => stripExtension(path.relative(dir, source)));
  for (const raw of allTargets(row)) {
    const file = path.resolve(pkg.dir, raw);
    const dir = outputRoot(pkg, file);
    if (!dir) continue;
    const name = stripExtension(path.relative(dir, file));
    const subpath = key === "." ? "index" : key.slice(2);
    for (const pattern of [name, subpath, path.join(subpath, "index")]) {
      const parts = pattern.split("*");
      const matches = (value) => parts.length === 2
        ? value.startsWith(parts[0]) && value.endsWith(parts[1]) && value.length >= parts[0].length + parts[1].length
        : value === pattern;
      if (sourceNames.some(matches) || (within(dir, source) && matches(stripExtension(path.relative(dir, source))))) return true;
    }
  }
  return false;
}

function literalMode(literal) {
  const node = literal?.parent;
  if (!node) return;
  const override = ts.getResolutionModeOverride(node.attributes || node.parent?.attributes);
  if (override !== undefined) return override;
  if (ts.isExternalModuleReference(node) ||
      (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require"))
    return ts.ModuleKind.CommonJS;
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
    return ts.ModuleKind.ESNext;
}

module.exports = { outputRoot, conditionTargets, conditionsFor, possibleEntry, allTargets, literalMode };
