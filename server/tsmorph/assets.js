const path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { isCode } = require("./files");

// A source URL is relative to the containing file. Module resolution (extension
// substitution, paths and package exports) has no role in its runtime identity.
function relativeURL(spec) {
  return !/^(?:[a-z][a-z\d+.-]*:|[\/\\])/i.test(spec.trimStart());
}

function resolveSourceURL(file, spec) {
  try {
    return path.resolve(fileURLToPath(new URL(spec, pathToFileURL(file))));
  } catch {
    return undefined;
  }
}

function projectedTarget(file, spec, form) {
  try {
    const base = pathToFileURL(file);
    const url = new URL(spec, base);
    const input = form === "href" ? url.href : form === "pathname" ? url.pathname : fileURLToPath(url);
    return path.resolve(fileURLToPath(new URL(input, base)));
  } catch {
    return undefined;
  }
}

function sourceURLSpecifier(session, file, to, ref) {
  ref.checkLoaderBinding?.();
  if (ref.conflictingProjection)
    throw new Error(`The ${ref.conflictingProjection} import in ${session.rel(ref.file)} names a different file after URL decoding`);
  if (ref.shadowedURL) throw new Error(`URL constructor is shadowed in ${session.rel(ref.file)}`);
  if (!ref.projections?.size && session.workspace.owner(file) !== session.workspace.owner(to))
    throw new Error(`File-relative URL in ${session.rel(file)} would cross a package boundary`);
  if (resolveSourceURL(file, ref.spec) === to) return ref.spec;
  let relative = path.relative(path.dirname(file), to).split(path.sep).map(encodeURIComponent).join("/");
  if (new URL(ref.spec, pathToFileURL(ref.file)).pathname.endsWith("/") && relative) relative += "/";
  const suffix = ref.spec.match(/[?#][\s\S]*$/)?.[0] || "";
  const spec = (relative.startsWith("../") ? relative : "./" + relative) + suffix;
  for (const form of ref.projections || []) {
    if (projectedTarget(file, spec, form) !== to)
      throw new Error(`Cannot preserve the ${form} import of ${session.rel(to)} in ${session.rel(file)} after URL encoding`);
  }
  return spec;
}

// Non-code consumers are advisory for moves. Deletion and automatic selection
// use the same evidence, so a stylesheet still used by another stylesheet stays.
function assetImports(session, file) {
  if (!/\.(?:css|scss|less|sass|svg|html?|vue|svelte|astro|mdx?)$/i.test(file)) return [];
  const raw = session.bytes(file).toString("utf8");
  // Mask block comments without interpreting comment markers in quoted paths.
  // Keep their line breaks so warnings still point to the original stylesheet.
  const text = raw.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\//g,
    token => token.startsWith("/*") ? token.replace(/[^\r\n]/g, " ") : token);
  const result = [];
  // In stylesheets, consume unrelated string tokens whole. Their contents
  // may describe an import without making one (e.g. CSS 'content' values).
  const pattern = /\.(?:css|scss|less|sass)$/i.test(file)
    ? /(?:@(?:import|use|forward)\b\s*(?!url\()|\burl\(\s*)(?:"([^"]+)"|'([^']+)'|([^\s)'";]+))|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gi
    : /(?:@(?:import|use|forward)\s+(?!url\()|url\(\s*|(?:href|src)\s*=\s*)(?:"([^"]+)"|'([^']+)'|([^\s)'";]+))/gi;
  let line = 1;
  let previous = 0;
  for (const match of text.matchAll(pattern)) {
    const spec = (match[1] ?? match[2] ?? match[3])?.split(/[?#]/)[0];
    if (!spec || /^(?:[a-z]+:|\/)/i.test(spec)) continue;
    const pkg = session.workspace.packageForSpecifier(spec);
    const to = pkg ? session.resolve(file, spec) : path.resolve(path.dirname(file), spec);
    line += text.slice(previous, match.index).split("\n").length - 1;
    previous = match.index;
    result.push({ file, spec, to, line });
  }
  return result;
}

function assetConsumers(session, target) {
  if (!session.assetIndex) {
    session.assetIndex = new Map();
    for (const file of session.paths) {
      for (const ref of assetImports(session, file)) {
        if (!session.assetIndex.has(ref.to)) session.assetIndex.set(ref.to, []);
        session.assetIndex.get(ref.to).push(ref);
      }
    }
  }
  return session.assetIndex.get(target) || [];
}

function companions(session, module, option) {
  if (option === undefined) return [];
  if (!isCode(module)) throw new Error("Only a code module can select asset companions");
  const candidates = new Set(
    (session.index.byFile.get(module) || [])
      .filter((ref) => (ref.kind === "url" || ref.spec.startsWith(".")) && ref.to && session.paths.has(ref.to) && !isCode(ref.to))
      .map((ref) => ref.to),
  );
  if (option === "auto") {
    return [...candidates].filter(
      (file) =>
        session.referencesTo(file).every((ref) => ref.file === module) &&
        !assetConsumers(session, file).length,
    );
  }
  if (!Array.isArray(option)) throw new Error("companions must be an array of paths or 'auto'");
  return [
    ...new Set(
      option.map((input) => {
        const file = session.path(input);
        if (!candidates.has(file))
          throw new Error(`Not an imported relative asset of ${session.rel(module)}: ${input}`);
        return file;
      }),
    ),
  ];
}

function referenceTarget(ref) {
  return ref.to || (ref.kind === "url" ? resolveSourceURL(ref.file, ref.spec) : undefined);
}

module.exports = { projectedTarget, referenceTarget, companions, assetConsumers, assetImports, relativeURL, resolveSourceURL, sourceURLSpecifier };
