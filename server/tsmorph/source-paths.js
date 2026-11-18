// Apply the member config to existing files and to destinations that only exist in a plan.
const path = require("node:path");
const { ts } = require("ts-morph");

const canonical = ts.createGetCanonicalFileName(ts.sys.useCaseSensitiveFileNames);
const reserved = new Set([".git", "node_modules", ".refactory-write.lock"]);
const commonOutputs = new Set(["dist", "out", "build"]);
const conventional = new Set([
  ...commonOutputs, ".next", ".nuxt", ".output", ".source", ".svelte-kit", ".turbo",
  ".venv", "__pycache__", "coverage", "venv",
]);

function configuredPaths(dir, specs) {
  const patterns = ts.getFileMatcherPatterns(dir, specs.validatedExcludeSpecs, specs.validatedIncludeSpecs,
    ts.sys.useCaseSensitiveFileNames, dir);
  const regex = pattern => pattern && new RegExp(pattern, ts.sys.useCaseSensitiveFileNames ? "" : "i");
  const excluded = regex(patterns.excludePattern);
  const included = regex(patterns.includeFilePattern);
  const directories = regex(patterns.includeDirectoryPattern);
  const files = new Set((specs.validatedFilesSpec || []).map(file => path.resolve(dir, file)));
  const parents = new Set();
  for (const file of files) {
    for (let p = path.dirname(file); !parents.has(p); p = path.dirname(p)) parents.add(p);
  }
  return {
    excludes: file => !!excluded?.test(ts.normalizePath(file)),
    includes: file => files.has(file) || !!included?.test(ts.normalizePath(file)),
    enters: file => parents.has(file) || !!directories?.test(ts.normalizePath(file)),
  };
}

module.exports = { canonical, configuredPaths, reserved, conventional, commonOutputs };
