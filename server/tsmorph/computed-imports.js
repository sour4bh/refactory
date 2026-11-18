const path = require("node:path");
const { ts } = require("ts-morph");
const { inside } = require("./files");

function fileMatcher(root, patterns) {
  if (!Array.isArray(patterns))
    throw new Error("external_computed_files must be a list of workspace file paths or globs");
  const files = new Set();
  const globs = [];
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || !pattern || pattern.includes("\0"))
      throw new Error("Each external_computed_files entry must be a nonempty file path or glob");
    const file = path.resolve(root, pattern);
    if (!inside(root, file) || pattern.split(/[\\/]/).includes(".."))
      throw new Error(`external_computed_files entry must be inside the workspace: ${pattern}`);
    if (!/[*?]/.test(pattern)) {
      files.add(file);
      continue;
    }
    const relative = path.relative(root, file).split(path.sep).join("/");
    const { includeFilePattern } = ts.getFileMatcherPatterns(root, undefined, [relative], true, root);
    if (!includeFilePattern)
      throw new Error(`Invalid external_computed_files glob: ${pattern}. Use a file pattern such as src/**/*.ts`);
    globs.push(new RegExp(includeFilePattern));
  }
  return (file) => files.has(file) || globs.some((glob) => glob.test(file.split(path.sep).join("/")));
}

class ComputedImports {
  constructor(session, patterns = []) {
    this.session = session;
    this.matches = fileMatcher(session.root, patterns);
    this.accepted = new Map();
    this.missing = new Set();
    this.unlisted = new Set();
  }

  check(requireAcknowledgment = true) {
    for (const [file, refs] of this.session.index.computed) {
      const matches = this.matches(file);
      const occurrences = new Map();
      for (const ref of refs) {
        if (!ref.needsAcknowledgment) continue;
        const site = { file: this.session.rel(file), line: ref.line, expression: ref.spec };
        if (matches) {
          // Record each acknowledged path once across rescans, including
          // loaders later deleted or renamed. Keep identical calls on one line.
          const occurrence = occurrences.get(ref.spec) || 0;
          occurrences.set(ref.spec, occurrence + 1);
          const key = JSON.stringify([file, ref.spec, occurrence]);
          if (!this.accepted.has(key)) this.accepted.set(key, site);
        } else if (requireAcknowledgment) {
          this.firstMissingStep ??= this.session.operationIndex ?? 0;
          this.missing.add(`${site.file}:${site.line} (${site.expression})`);
          if (ref.unlisted) this.unlisted.add(`${site.file}:${site.line}`);
        }
      }
    }
  }

  refusal(alreadyListed) {
    if (!this.missing.size) return;
    const sites = [...this.missing].filter(site => !alreadyListed?.has(site)).sort();
    const unlisted = [...this.unlisted].sort();
    return "Cannot determine the targets of computed references. If these loaders only load external artifacts, " +
      "list their workspace-relative paths or globs in external_computed_files" +
      (sites.length ? ":\n" + sites.join("\n") : ".") +
      (unlisted.length ? `\nAt ${unlisted.join(", ")}, the file changes or passes on a value that the expression reads, ` +
        "so the engine cannot list its paths. Keep the paths in a const string or array that the file only reads, " +
        "or list the file in external_computed_files if it loads only external artifacts." : "");
  }

  report() {
    if (!this.accepted.size) return {};
    const sites = [...this.accepted.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    return { accepted_computed_imports: sites };
  }
}

module.exports = { ComputedImports };
