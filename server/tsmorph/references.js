const { ts } = require("ts-morph");
const path = require("node:path");
const { scopedProject } = require("./semantic-scope");
const { literalMode } = require("./package-exports");
const { relativeURL, resolveSourceURL, projectedTarget } = require("./assets");

const { inside } = require("./files");
const { literalValues } = require("./computed-values");

const { sourceURL } = require("./derived-url");

// Keep offsets in the exact source snapshot used to resolve each literal. The
// reverse index makes repeated registry/importer rewrites local to their files.
function moduleLiterals(source, session, globalRequire) {
  const { describe, projection } = literalValues(source, session.workspace.options(source.fileName));
  const refs = [];
  const requireCalls = [];
  const urlCalls = [];
  const projections = [];
  const computed = [];
  const forwarded = new Set();
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier &&
        statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const item of statement.exportClause.elements) forwarded.add((item.propertyName || item.name).text);
    } else if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      forwarded.add(statement.expression.text);
    }
  }
  let localRequire = false;
  function visit(node, inJSDoc = false) {
    if (ts.isIdentifier(node) && node.text === "require" && ts.isDeclarationName(node)) localRequire = true;
    let literal, kind;
    if (ts.isJSDocImportTag(node)) {
      literal = node.moduleSpecifier;
      kind = "jsdoc";
    } else if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      literal = node.moduleSpecifier;
      kind = ts.isImportDeclaration(node) ? "import" : "export";
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) kind = "dynamic";
      else if (ts.isIdentifier(node.expression) && node.expression.text === "require") kind = "require";
      if (kind) literal = node.arguments[0];
    } else if (sourceURL(node)) {
      const arg = node.arguments[0];
      if (!ts.isStringLiteralLike(arg) || relativeURL(arg.text)) {
        literal = arg;
        kind = "url";
      }
    } else if (ts.isExternalModuleReference(node)) {
      literal = node.expression;
      kind = "require";
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      literal = node.argument.literal;
      kind = "type";
    }
    const stringArgument = literal && ts.isStringLiteralLike(literal);
    // A const string argument can be specialized at the URL use. Other reads
    // of the shared variable keep their original value.
    const staticURLArg = literal && kind === "url" && ts.isIdentifier(literal) && describe(literal).values;
    if (literal && (stringArgument || staticURLArg?.length === 1 && relativeURL(staticURLArg[0]))) {
      const ref = {
        file: source.fileName,
        spec: stringArgument ? literal.text : staticURLArg[0],
        inlineString: !stringArgument,
        start: literal.getStart(source),
        end: literal.end,
        kind,
      };
      ref.resolutionMode = literalMode(literal);
      ref.reexport = ts.isExportDeclaration(node);
      if (forwarded.size && ts.isImportDeclaration(node) && node.importClause) {
        const { name, namedBindings } = node.importClause;
        ref.reexport = forwarded.has(name?.text) || (namedBindings && (ts.isNamespaceImport(namedBindings)
          ? forwarded.has(namedBindings.name.text)
          : namedBindings.elements.some(item => forwarded.has(item.name.text))));
      }
      refs.push(ref);
      if (inJSDoc) {
        // A namespace import may mention any export. Named bindings let a
        // symbol move proceed when the tag imports only unrelated names.
        const bindings = node.importClause?.namedBindings;
        if (kind === "type") {
          let name = node.qualifier;
          while (name && ts.isQualifiedName(name)) name = name.left;
          ref.jsdocNames = name ? [name.text] : null;
        } else {
          ref.jsdocNames = bindings && ts.isNamespaceImport(bindings) ? null : [];
          if (bindings && ts.isNamedImports(bindings)) {
            ref.jsdocNames.push(...bindings.elements.map((item) => (item.propertyName || item.name).text));
          }
          if (node.importClause?.name && ref.jsdocNames) ref.jsdocNames.push("default");
        }
      }
      if (kind === "require" && ts.isCallExpression(node)) requireCalls.push([ref, node.expression]);
      if (kind === "url") urlCalls.push([ref, ts.skipOuterExpressions(node.expression)]);
    } else if (literal && (kind === "dynamic" || kind === "require" || kind === "url")) {
      const spec = literal.getText(source);
      const ref = {
        kind,
        file: source.fileName,
        line: source.getLineAndCharacterOfPosition(literal.getStart(source)).line + 1,
        spec,
        start: literal.getStart(source),
        end: literal.end,
        ...describe(literal),
      };
      const derived = kind === "dynamic" && projection(literal);
      if (derived) projections.push({ ref, ...derived });
      else computed.push(ref);
    }
    for (const doc of node.jsDoc || []) visit(doc, true);
    ts.forEachChild(node, (child) => visit(child, inJSDoc));
  }
  visit(source);
  // Resolving a loader's binding matters only when an edit needs the site.
  // In particular a URL in an unrelated tool must not pull its dependencies
  // into a component rewrite. Release the checker after recording the flags.
  const loaders = [...urlCalls, ...(localRequire || globalRequire ? requireCalls : [])];
  function checkBindings() {
    const project = scopedProject(session, [source.fileName]);
    const file = project.getSourceFileOrThrow(source.fileName);
    const program = project.getProgram().compilerObject;
    const checker = program.getTypeChecker();
    for (const [ref, expression] of loaders) {
      const id = file.getDescendantAtPos(expression.getStart(source))?.compilerNode;
      if (!id || !ts.isIdentifier(id) || id.text !== expression.text)
        throw new Error("Cannot verify loader binding in " + ref.file + " for " + ref.spec);
      const declarations = checker.getSymbolAtLocation(id)?.declarations || [];
      if (ref.kind === "url")
        ref.shadowedURL = declarations.some(decl => {
          const owner = decl.getSourceFile();
          return !program.isSourceFileDefaultLibrary(owner) &&
            !(owner.isDeclarationFile && /[/\\]node_modules[/\\]@types[/\\]node[/\\]/.test(owner.fileName));
        });
      else
        ref.ambiguousRequire = declarations.some(decl => !(ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Ambient) &&
          !decl.getSourceFile().isDeclarationFile);
      delete ref.checkLoaderBinding;
    }
  }
  for (const [ref] of loaders) ref.checkLoaderBinding = checkBindings;
  for (const { ref, url, form } of projections) {
    const arg = url.arguments[0];
    const anchor = refs.find(item => item.kind === "url" && item.start === arg.getStart(source));
    if (anchor) {
      anchor.checkLoaderBinding?.();
      if (!anchor.shadowedURL) {
        const target = projectedTarget(ref.file, anchor.spec, form);
        if (target && target === resolveSourceURL(ref.file, anchor.spec)) {
          (anchor.projections ??= new Set()).add(form);
          continue; // The URL literal owns the binding and all move edits.
        }
        if (target) {
          // For example fileURLToPath decodes an encoded '#' which import()
          // treats as a fragment. Protect both distinct runtime targets.
          ref.physicalTarget = target;
          anchor.conflictingProjection = form;
        }
      }
    }
    computed.push(ref);
  }
  return { refs, computed };
}

class ReferenceIndex {
  constructor(session) {
    this.session = session;
    this.byFile = new Map();
    this.byTarget = new Map();
    this.pending = new Set();
    this.computed = new Map();
    const files = session.files();
    this.globalRequire = files.some((file) => {
      const source = file.compilerNode;
      if (source.isDeclarationFile || ts.isExternalModule(source)) return false;
      return source.statements.some(
        (statement) =>
          statement.name?.text === "require" ||
          (ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.some((d) => d.name.getText() === "require")),
      );
    });
    for (const source of files) this.scan(source);
  }

  drop(file) {
    this.computed.delete(file);
    for (const ref of this.byFile.get(file) || []) {
      this.pending.delete(ref);
      const bucket = this.byTarget.get(ref.to);
      if (bucket) {
        bucket.delete(ref);
        if (!bucket.size) this.byTarget.delete(ref.to);
      }
    }
    this.byFile.delete(file);
  }

  scan(source) {
    const file = source.getFilePath();
    this.drop(file);
    const { refs, computed } = moduleLiterals(source.compilerNode, this.session, this.globalRequire);
    for (const ref of computed) {
      const scopes = this.prefixScopes(ref, ref.prefix);
      ref.needsAcknowledgment = !ref.values && !ref.physicalTarget && !scopes;
      ref.scopes = new Set([scopes, ...(ref.prefixes || []).map(prefix => this.prefixScopes(ref, prefix))]
        .flat().filter(Boolean));
    }
    if (computed.length) this.computed.set(file, computed);
    for (const ref of refs) this.bind(ref);
    this.byFile.set(file, refs);
  }

  bind(ref) {
    ref.to = this.session.resolve(ref.file, ref.spec, ref.resolutionMode ?? ref.kind, true);
    if (ref.to) {
      this.pending.delete(ref);
      if (!this.byTarget.has(ref.to)) this.byTarget.set(ref.to, new Set());
      this.byTarget.get(ref.to).add(ref);
    } else {
      this.pending.add(ref);
    }
  }

  resolvePending() {
    // A newly created path or export can make a formerly missing import
    // available to the next step. A deleted target may expose a fallback.
    for (const [target, refs] of this.byTarget) {
      if (this.session.exists(target)) continue;
      // Physical URL targets include directories and read-only output that is
      // deliberately absent from the mutation inventory.
      const first = refs.values().next().value;
      if (first?.kind === "url" && this.session.resolve(first.file, first.spec, "url") === target) continue;
      this.byTarget.delete(target);
      for (const ref of refs) this.pending.add(ref);
    }
    for (const ref of this.pending) this.bind(ref);
  }

  snapshotBindings() {
    const previous = new Map(this.byFile);
    for (const [file, entries] of this.computed) {
      const bindings = [...(previous.get(file) || [])];
      for (const { values, known, kind } of entries) {
        for (const spec of new Set(values || known)) {
          const to = this.session.resolve(file, spec, kind, true);
          if (to) bindings.push({ spec, kind, to });
        }
      }
      previous.set(file, bindings);
    }
    return previous;
  }

  assertBindings(previous = this.byFile, moves = new Map(), rewritten = new Map(), deleted = new Set()) {
    // Compare with the graph from BEFORE the topology change. A rescan alone
    // silently accepts a new binding even when the literal's spelling is untouched.
    const overwritten = new Set(moves.values());
    for (const [file, refs] of previous) {
      if (deleted.has(file) || (overwritten.has(file) && !moves.has(file))) continue;
      const importer = moves.get(file) || file;
      for (const ref of refs) {
        if (!ref.to || deleted.has(ref.to)) continue;
        const expected = moves.get(ref.to) || ref.to;
        const spec = rewritten.get(ref) ?? ref.spec;
        const actual = this.session.resolve(importer, spec, ref.resolutionMode ?? ref.kind, true);
        if (actual !== expected) {
          const where = actual ? this.session.rel(actual) : "an unresolved module";
          throw new Error(`Resolution changed for '${spec}' in ${this.session.rel(importer)}: expected ${this.session.rel(expected)}, found ${where}`);
        }
      }
    }
  }

  // The places that a specifier with this static prefix can reach, or
  // undefined when the prefix does not bound them.
  prefixScopes(ref, prefix) {
    if (!prefix) return;
    const { workspace } = this.session;
    if (ref.kind === "url") {
      if (!relativeURL(prefix)) return [{ external: true }];
      const slash = prefix.replaceAll("\\", "/").lastIndexOf("/");
      const dir = resolveSourceURL(ref.file, slash < 0 ? "./" : prefix.slice(0, slash + 1));
      return dir ? [{ dir }] : undefined;
    }
    if (prefix.startsWith(".") || path.isAbsolute(prefix)) {
      const slash = prefix.lastIndexOf("/");
      return [{ dir: path.resolve(path.dirname(ref.file), slash < 0 ? "./" : prefix.slice(0, slash + 1)) }];
    }
    if (prefix.startsWith("node:")) return [{ external: true }];
    // The compiler tries tsconfig paths and baseUrl first, then installed packages.
    const scopes = workspace.mappedDirectories(ref.file, prefix).map(dir => ({ dir }));
    if (/^(?:@[^/]+\/)?[a-zA-Z0-9_-][a-zA-Z0-9._-]*\//.test(prefix)) {
      const pkg = workspace.packageForSpecifier(prefix);
      scopes.push(pkg ? { pkg } : { external: true });
    }
    return scopes.length ? scopes : undefined;
  }

  computedReferencesTo(target, planned = false) {
    const { workspace } = this.session;
    const owner = workspace.owner(target);
    const references = [];
    for (const entries of this.computed.values()) {
      for (const ref of entries) {
        const matches = value => {
          let base;
          if (ref.kind === "url") base = relativeURL(value) && resolveSourceURL(ref.file, value);
          else if (value.startsWith(".") || path.isAbsolute(value)) base = path.resolve(path.dirname(ref.file), value);
          if (base && inside(base, target)) return true;
          if (planned && ref.kind !== "url") return workspace.resolve(ref.file, value, target, ref.kind, true) === target;
          return this.session.resolve(ref.file, value, ref.kind, true) === target;
        };
        if (ref.physicalTarget === target || (ref.values || ref.known || []).some(matches) ||
            [...ref.scopes].some(scope => scope.dir ? inside(scope.dir, target) : scope.pkg === owner) ||
            (ref.unbounded && ref.tails?.some(tail => literalSuffixMatches(tail, target)))) references.push(ref);
      }
    }
    return references;
  }

  assertStaticReferences(targets) {
    const affected = new Set();
    let relocates = false;
    for (const [target, movingTo] of targets) {
      for (const ref of this.computedReferencesTo(target)) affected.add(ref);
      if (!movingTo) continue;
      for (const ref of this.computedReferencesTo(movingTo, true)) affected.add(ref);
      if (path.dirname(movingTo) === path.dirname(target)) continue;
      const cross = this.session.workspace.owner(target) !== this.session.workspace.owner(movingTo);
      for (const ref of this.computed.get(target) || []) {
        const relative = ref.kind === "url" ? relativeURL : (value) => value.startsWith(".");
        const mayBeRelative = ref.values ? ref.values.some(relative) : !ref.prefix || relative(ref.prefix);
        if (cross || mayBeRelative) {
          affected.add(ref);
          relocates = true;
        }
      }
    }
    if (affected.size) throw this.computedError(affected,
      relocates ? "\nCannot relocate the loader because its runtime path may change." : "");
  }

  computedError(refs, detail = "") {
    const entries = [...refs];
    const sites = entries.map(ref => `${this.session.rel(ref.file)}:${ref.line} (${ref.spec})`);
    const descriptions = sites.map((site, i) => entries[i].values?.length === 1
      ? `${site} = '${entries[i].values[0]}'` : site);
    const error = new Error("Cannot safely update computed module reference: " + descriptions.join(", ") + detail);
    error.computedSites = new Set(sites);
    return error;
  }

  hasBuildConsumers(pkg) {
    const ws = this.session.workspace;
    for (const target of this.byTarget.keys()) {
      if (ws.owner(target) === pkg && ws.outputDirectory(target)) return true;
    }
    for (const entries of this.computed.values()) {
      for (const ref of entries) {
        if (ref.kind === "url") continue;
        if ((ref.values || ref.known || []).some(spec => ws.packageForSpecifier(spec) === pkg) ||
            [...ref.scopes].some(scope => scope.pkg === pkg)) return true;
      }
    }
    return false;
  }

  *edges() {
    for (const [from, refs] of this.byFile) {
      for (const { to, spec } of refs) {
        if (to && !this.session.batchImports?.binding(from, spec, to)) yield { from, to };
      }
    }
  }
}

// A fixed suffix following an interpolated parent traversal can still name a
// specific file even when its leading directory is unknown.
function literalSuffixMatches(tail, target) {
  const parts = tail.replace(/%2e/gi, ".").replaceAll("\\", "/").split(/[?#]/, 1)[0].split("/");
  const parent = parts.lastIndexOf("..");
  if (parent < 0) return false;
  const suffix = parts.slice(parent + 1).filter(part => part && part !== ".").join(path.sep);
  if (!suffix) return false;
  const segment = path.sep + suffix;
  return target.endsWith(segment) || (tail.endsWith("/") && target.includes(segment + path.sep));
}

function checkRequire(ref) {
  if (ref.kind === "require") ref.checkLoaderBinding?.();
  if (ref.ambiguousRequire)
    throw new Error(`Cannot rewrite '${ref.spec}' in ${ref.file}: require is shadowed by a local binding`);
}

function replaceLiterals(text, edits) {
  for (const { ref, spec } of edits.sort((a, b) => b.ref.start - a.ref.start)) {
    if (ref.spec === spec) continue;
    checkRequire(ref);
    const quote = ref.inlineString ? '"' : text[ref.start];
    let escaped = JSON.stringify(spec).slice(1, -1);
    if (quote !== '"') escaped = escaped.replaceAll(quote, "\\" + quote);
    const body = quote === "`" ? escaped.replaceAll("${", "\\${") : escaped;
    text = text.slice(0, ref.start) + quote + body + quote + text.slice(ref.end);
  }
  return text;
}

module.exports = { ReferenceIndex, replaceLiterals, checkRequire };
