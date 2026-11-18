const { ts } = require("ts-morph");
const { checkRequire } = require("./references");
const { memberPrograms } = require("./validation");
const { potentialConsumers } = require("./semantic-scope");
const { parseDestination, selectSource, resolveDestination, checkExport, checkAugmentations } = require("./replacement-targets");
const { splitBindings, writeSplit } = require("./split-replacement");
const {
  TextEdits,
  walk,
  moduleForFile,
  exportSurface,
  requireBindingName,
} = require("./semantic-edits");

const identifier = /^[$A-Z_a-z][$\w]*$/;

function quoted(node, value) {
  const quote = node.getText()[0];
  const escaped = value.replaceAll("\\", "\\\\").replaceAll(quote, "\\" + quote);
  return quote + (quote === "`" ? escaped.replaceAll("${", "\\${") : escaped) + quote;
}

// getSymbolAtLocation returns the shorthand property symbol. The checker exposes
// its local value symbol separately, and likewise for local export specifiers.
function localSymbol(checker, id) {
  const parent = id.parent;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === id) {
    return checker.getShorthandAssignmentValueSymbol(parent);
  }
  if (
    ts.isExportSpecifier(parent) &&
    !parent.parent.parent.moduleSpecifier &&
    id === (parent.propertyName || parent.name)
  ) {
    return checker.getExportSpecifierLocalTargetSymbol(parent);
  }
  return checker.getSymbolAtLocation(id);
}

function renameBinding(ctx, id, newName) {
  if (id.text === newName) return;
  requireBindingName(newName);
  const binding = ctx.checker.getSymbolAtLocation(id);
  const scope = ts.getEnclosingBlockScopeContainer(id) || ctx.file;
  let pending = ctx.renamed.get(scope);
  if (!pending) ctx.renamed.set(scope, (pending = new Map()));
  if (pending.has(newName) && pending.get(newName) !== binding)
    throw new Error("Duplicate replacement binding " + newName);
  pending.set(newName, binding);
  walk(ctx.file, (node) => {
    if (!ts.isIdentifier(node) || node.text !== id.text || localSymbol(ctx.checker, node) !== binding) return;
    const collision = ctx.checker.resolveName(
      newName,
      node,
      ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Alias,
      false,
    );
    if (collision && collision !== binding)
      throw new Error("Renaming " + id.text + " would capture " + newName + " in " + ctx.file.fileName);
    if (id === node) return;
    let replacement = newName;
    if (ts.isShorthandPropertyAssignment(node.parent)) replacement = node.text + ": " + newName;
    if (ts.isExportSpecifier(node.parent) && !node.parent.propertyName)
      replacement = newName + " as " + node.text;
    ctx.edits.replace(node, replacement);
  });
}

function namedBinding(ctx, imported, local, separator, typeOnly = false) {
  const next = ctx.use(imported.text, typeOnly);
  if (next === imported.text) return;
  if (ctx.renameLocal && ts.isIdentifier(local)) {
    renameBinding(ctx, local, next);
    const gap = ctx.file.text.slice(imported.end, local.getStart());
    if (imported !== local && /^\s*(as|:)\s*$/.test(gap)) {
      ctx.edits.add(ctx.file, imported.getStart(), local.end, next);
    } else {
      ctx.edits.replace(imported, next);
      if (imported !== local) ctx.edits.replace(local, next);
    }
  } else if (imported === local) {
    ctx.edits.replace(imported, next + separator + local.text);
  } else {
    ctx.edits.replace(imported, next);
  }
}

function commonJsType(checker, module) {
  const assignment = module?.exports?.get(ts.InternalSymbolName.ExportEquals);
  const symbol = assignment || module;
  return (
    symbol && checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration || symbol.declarations[0])
  );
}

function requireInvocation(ctx, kind) {
  if (ctx.replacementModuleType && ctx.checker.getSignaturesOfType(ctx.replacementModuleType, kind).length)
    return;
  const action = kind === ts.SignatureKind.Call ? "call" : "construct";
  throw new Error(`Cannot verify ${action} of replacement require result in ${ctx.file.fileName}`);
}

function moduleEscape(ctx) {
  if (ctx.require && ctx.originalModuleType) {
    for (const kind of [ts.SignatureKind.Call, ts.SignatureKind.Construct]) {
      if (ctx.checker.getSignaturesOfType(ctx.originalModuleType, kind).length) requireInvocation(ctx, kind);
    }
  }
  for (const name of ctx.originalExports.keys()) {
    const next = ctx.use(name);
    if (next !== name)
      throw new Error(
        "Cannot follow an escaping module namespace with renamed export " + name + " in " + ctx.file.fileName,
      );
  }
}

function destructure(ctx, pattern) {
  for (const element of pattern.elements) {
    if (element.dotDotDotToken) {
      moduleEscape(ctx);
      continue;
    }
    const key = element.propertyName || element.name;
    if (!ts.isIdentifier(key) && !ts.isStringLiteral(key)) {
      throw new Error("Computed or nested module binding needs manual replacement in " + ctx.file.fileName);
    }
    namedBinding(ctx, key, element.name, ": ");
  }
}

function namespaceUse(ctx, expression) {
  while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
  const parent = expression.parent;
  if (
    ctx.require &&
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    parent.expression === expression
  ) {
    return requireInvocation(
      ctx,
      ts.isNewExpression(parent) ? ts.SignatureKind.Construct : ts.SignatureKind.Call,
    );
  }
  if (ts.isPropertyAccessExpression(parent) && parent.expression === expression) {
    ctx.edits.replace(parent.name, ctx.use(parent.name.text));
  } else if (ts.isQualifiedName(parent) && parent.left === expression) {
    ctx.edits.replace(parent.right, ctx.use(parent.right.text));
  } else if (
    ts.isElementAccessExpression(parent) &&
    parent.expression === expression &&
    ts.isStringLiteralLike(parent.argumentExpression)
  ) {
    ctx.edits.replace(
      parent.argumentExpression,
      quoted(parent.argumentExpression, ctx.use(parent.argumentExpression.text)),
    );
  } else if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === expression &&
    ts.isObjectBindingPattern(parent.name)
  ) {
    destructure(ctx, parent.name);
  } else {
    moduleEscape(ctx);
  }
}

function namespaceBinding(ctx, id) {
  const sym = ctx.checker.getSymbolAtLocation(id);
  if (!sym) throw new Error("Unresolved namespace binding in " + ctx.file.fileName);
  walk(ctx.file, (node) => {
    if (
      node !== id &&
      ts.isIdentifier(node) &&
      node.text === id.text &&
      localSymbol(ctx.checker, node) === sym
    ) {
      namespaceUse(ctx, node);
    }
  });
}

function callUsage(ctx, call) {
  let expr = call;
  let awaited = false;
  while (ts.isAwaitExpression(expr.parent) || ts.isParenthesizedExpression(expr.parent)) {
    expr = expr.parent;
    if (ts.isAwaitExpression(expr)) awaited = true;
  }
  const parent = expr.parent;
  if (ts.isExpressionStatement(parent)) return;
  if (call.expression.kind === ts.SyntaxKind.ImportKeyword && !awaited) {
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.name.text === "then" &&
      ts.isCallExpression(parent.parent)
    ) {
      const callback = parent.parent.arguments[0];
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        const first = callback.parameters[0]?.name;
        if (!first) return;
        if (ts.isIdentifier(first)) return namespaceBinding(ctx, first);
        if (ts.isObjectBindingPattern(first)) return destructure(ctx, first);
      }
    }
    return moduleEscape(ctx);
  }
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    if (!(parent.parent.flags & ts.NodeFlags.Const)) return moduleEscape(ctx);
    return namespaceBinding(ctx, parent.name);
  }
  namespaceUse(ctx, expr);
}

function staticImport(ctx, decl) {
  const clause = decl.importClause;
  if (!clause) return;
  const typeOnly = clause.isTypeOnly || ts.isJSDocImportTag(decl);
  const bindings = clause.namedBindings;
  if (clause.name) {
    const next = ctx.use("default", typeOnly);
    if (next !== "default") {
      if (bindings && !ts.isNamedImports(bindings))
        throw new Error("Split namespace and default imports before mapping default in " + ctx.file.fileName);
      const local = ctx.renameLocal ? next : clause.name.text;
      if (ctx.renameLocal) renameBinding(ctx, clause.name, next);
      const binding = next + (local === next ? "" : " as " + local);
      if (bindings) {
        ctx.edits.replace(clause.name, "");
        ctx.edits.replace(
          clause.getChildren().find((child) => child.kind === ts.SyntaxKind.CommaToken),
          "",
        );
        const start = bindings.getStart() + 1;
        ctx.edits.add(ctx.file, start, start, " " + binding + (bindings.elements.length ? "," : " "));
      } else {
        ctx.edits.replace(clause.name, "{ " + binding + " }");
      }
    }
  }
  if (bindings && ts.isNamespaceImport(bindings)) namespaceBinding(ctx, bindings.name);
  if (bindings && ts.isNamedImports(bindings)) {
    for (const binding of bindings.elements) {
      namedBinding(
        ctx,
        binding.propertyName || binding.name,
        binding.name,
        " as ",
        typeOnly || binding.isTypeOnly,
      );
    }
  }
}

function staticExport(ctx, decl) {
  const clause = decl.exportClause;
  if (clause && ts.isNamedExports(clause)) {
    for (const item of clause.elements) {
      const key = item.propertyName || item.name;
      const next = ctx.use(key.text, decl.isTypeOnly || item.isTypeOnly);
      if (next !== key.text) ctx.edits.replace(key, item.propertyName ? next : next + " as " + key.text);
    }
    return;
  }
  if (clause) return moduleEscape(ctx);
  const entries = [];
  let needsExplicitExports = !ctx.provided;
  const originalNames = new Set();
  for (const [name, symbol] of ctx.originalExports) {
    if (name === "default") continue;
    const next = ctx.use(name, decl.isTypeOnly);
    originalNames.add(next);
    needsExplicitExports ||=
      next !== name || (!decl.isTypeOnly && !symbol.runtime && ctx.provided?.get(next)?.runtime);
    if (!identifier.test(next) || !identifier.test(name))
      throw new Error("Unsupported export-star name " + name);
    const typeOnly = !decl.isTypeOnly && !symbol.runtime;
    entries.push((typeOnly ? "type " : "") + next + (next === name ? "" : " as " + name));
  }
  const added = [...(ctx.provided?.keys() || [])].filter(
    (name) => name !== "default" && !originalNames.has(name),
  );
  if (!needsExplicitExports && !added.length) {
    for (const other of ctx.file.statements) {
      if (other === decl || !ts.isExportDeclaration(other) || other.exportClause || !other.moduleSpecifier)
        continue;
      const module = ctx.checker.getSymbolAtLocation(other.moduleSpecifier);
      if (!module) throw new Error("Cannot verify sibling star export in " + ctx.file.fileName);
      for (const [name, symbol] of exportSurface(ctx.checker, module)) {
        const next = ctx.provided.get(name);
        if (name !== "default" && next && symbol.target !== next.target) {
          throw new Error(`Replacement makes star export ${name} ambiguous in ${ctx.file.fileName}`);
        }
      }
    }
    return;
  }
  if (
    ctx.file.statements.some(
      (statement) =>
        statement !== decl &&
        (ts.isExportDeclaration(statement) ||
          ts.getModifiers(statement)?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword)),
    )
  ) {
    const extra = added.length ? " (replacement also exports " + added.join(", ") + ")" : "";
    throw new Error("Cannot safely expand star in a barrel with other exports: " + ctx.file.fileName + extra);
  }
  const star = decl.getChildren().find((n) => n.kind === ts.SyntaxKind.AsteriskToken);
  ctx.edits.replace(star, "{ " + entries.join(", ") + " }");
}

function inspectUse(ctx, literal) {
  const parent = literal.parent;
  if (ts.isImportDeclaration(parent) || ts.isJSDocImportTag(parent)) return staticImport(ctx, parent);
  if (ts.isExportDeclaration(parent)) return staticExport(ctx, parent);
  if (ts.isCallExpression(parent)) return callUsage(ctx, parent);
  if (ts.isExternalModuleReference(parent) && ts.isImportEqualsDeclaration(parent.parent)) {
    return namespaceBinding(ctx, parent.parent.name);
  }
  if (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)) {
    let name = parent.parent.qualifier;
    while (name && ts.isQualifiedName(name)) name = name.left;
    if (name) return ctx.edits.replace(name, ctx.use(name.text, true));
    return moduleEscape(ctx);
  }
  throw new Error("Unsupported module reference in " + ctx.file.fileName);
}

function replacementRules(session, args) {
  if (args.names !== undefined && (!args.names || typeof args.names !== "object" || Array.isArray(args.names)))
    throw new Error("names must be an object keyed by exported names");
  const split = args.target === undefined;
  const rows = new Map();
  const destinations = new Map();
  function destination(input) {
    if (!destinations.has(input)) destinations.set(input, { ...parseDestination(session, input), input });
    return destinations.get(input);
  }
  const common = split ? undefined : destination(args.target);
  for (const [from, value] of Object.entries(args.names || {})) {
    const name = split ? value?.name ?? from : value;
    if (!identifier.test(from) || typeof name !== "string" || !identifier.test(name)) {
      throw new Error("names must map exported identifiers to exported identifiers or target rows");
    }
    if (split && (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some(key => key !== "target" && key !== "name"))) {
      throw new Error("Each names row needs a target and optional name when target is omitted");
    }
    rows.set(from, { name, dest: common || destination(value.target) });
  }
  if (split && !rows.size) throw new Error("Provide a target or a non-empty names map with per-name targets");
  return { split, rows, common, destinations };
}

// The compiler's token lookup treats JSDoc as trivia. The reference index also
// records @import and import("...") literals inside JSDoc.
function literalAt(file, ref) {
  let literal;
  if (file) walk(file, node => {
    if (literal || node.pos > ref.start || node.end <= ref.start) return false;
    if (ts.isStringLiteralLike(node) && node.getStart(file) === ref.start) literal = node;
  });
  if (!literal || literal.text !== ref.spec)
    throw new Error("Cannot identify module reference at " + ref.file + ":" + ref.start);
  return literal;
}

function missingName(map, name, file) {
  if (!map.has(name)) map.set(name, new Set());
  map.get(name).add(file);
}

function missingNames(map) {
  return [...map.keys()].sort().map(name => name + " (used in " + [...map.get(name)].sort().join(", ") + ")").join(", ");
}

function unbuiltBinding(ctx, item, bindings, provided, name) {
  const problem = () => new Error(
    `Cannot verify ${item.name} against ${name} in ${ctx.file.fileName}; build the source package (${ctx.missingSource}) or split this binding manually`
  );
  if (!bindings.isImport) {
    // A value re-export can expose type, namespace and runtime meanings to
    // downstream consumers. The absent declaration is needed to compare them.
    if (!bindings.typeOnly && !item.typeOnly) throw problem();
    if (!(provided.target.flags & ts.SymbolFlags.Type)) throw problem();
    return;
  }
  const alias = ctx.checker.getSymbolAtLocation(item.local);
  if (!alias) throw problem();
  // Even an unused non-type binding can emit a runtime import.
  if (!bindings.typeOnly && !item.typeOnly && !provided.runtime) throw problem();
  walk(ctx.file, node => {
    if (node === item.local || !ts.isIdentifier(node) || node.text !== item.local.text ||
        localSymbol(ctx.checker, node) !== alias) return;
    // A local re-export can have consumers beyond this source file.
    if (ts.isExportSpecifier(node.parent)) throw problem();
    const meaning = ts.getMeaningFromLocation(node);
    if ((meaning & ts.SemanticMeaning.Type && !(provided.target.flags & ts.SymbolFlags.Type)) ||
        (meaning & ts.SemanticMeaning.Namespace && !(provided.target.flags & ts.SymbolFlags.Namespace)) ||
        (meaning & ts.SemanticMeaning.Value && !provided.runtime)) throw problem();
  });
}

async function replaceModule(session, args) {
  const sourceRequest = selectSource(session, args.source);
  const sites = sourceRequest.sites;
  const rules = replacementRules(session, args);
  const noRoute = new Map();
  for (const dest of rules.destinations.values()) {
    if (args.source === dest.input || (dest.file && sourceRequest.file === dest.file))
      throw new Error("source and replacement target are identical");
    const member = dest.spec && session.workspace.packageForSpecifier(dest.spec);
    if (!sites.length && member && !session.workspace.packageFile(member, dest.spec))
      throw new Error(`Workspace package does not export ${dest.spec} in ${session.rel(member.filename)}`);
  }
  // Resolve the routes first so their declarations can be included in each importer program.
  // Resolution (including conditional exports and aliases) belongs to the caller.
  for (const site of sites) {
    const { ref } = site;
    checkRequire(ref);
    site.routes = new Map();
    if (rules.split || site.missingSource) {
      const bindings = splitBindings(literalAt(session.project.getSourceFileOrThrow(ref.file).compilerNode, ref).parent);
      for (const { name } of bindings.items) {
        const rule = rules.rows.get(name) || (rules.common && { name, dest: rules.common });
        if (!rule) {
          missingName(noRoute, name, session.rel(ref.file));
        } else if (!site.routes.has(name)) {
          const destination = resolveDestination(session, rule.dest, ref, site.source);
          site.routes.set(name, { name: rule.name, destination });
        }
      }
    } else {
      site.destination = resolveDestination(session, rules.common, ref, site.source);
    }
  }
  if (noRoute.size) throw new Error("No replacement target for: " + missingNames(noRoute));

  const roots = new Map();
  function memberRoots(file) {
    const member = session.workspace.owner(file);
    if (!roots.has(member)) roots.set(member, new Set());
    return roots.get(member);
  }
  // A downstream member can augment a type that its barrel re-exports.
  // Include those consumers in augmentation checks, even if their own
  // import statements keep the same spelling.
  for (const file of potentialConsumers(session, sites.map(site => site.ref.file)))
    memberRoots(file).add(file);
  const byMember = new Map();
  const sources = new Set();
  for (const site of sites) {
    const member = session.workspace.owner(site.ref.file);
    if (!byMember.has(member)) byMember.set(member, []);
    byMember.get(member).push(site);
    const extra = memberRoots(site.ref.file);
    if (site.source) {
      sources.add(site.source);
      extra.add(site.source);
    }
    if (site.destination?.resolved) extra.add(site.destination.resolved);
    for (const { destination } of site.routes.values())
      if (destination.resolved) extra.add(destination.resolved);
  }
  const missing = new Map();
  const edits = new TextEdits();
  for await (const { member, program } of memberPrograms(session, roots)) {
    checkAugmentations(session, program, sources, args.source);
    inspectSites(session, args, rules, program, byMember.get(member) || [], edits, missing);
  }
  if (missing.size)
    throw new Error([...missing].map(([target, names]) => `Replacement ${target} does not export: ${missingNames(names)}`).join("\n"));
  edits.apply(session.project);
  return { source: args.source, target: args.target, references: sites.length };
}

function inspectSites(session, args, rules, program, sites, edits, missing) {
  const checker = program.getTypeChecker();
  const modules = new Map();
  function targetInfo(resolved, spec) {
    const key = resolved || spec;
    if (!modules.has(key)) {
      if (resolved && !program.getSourceFile(resolved))
        throw new Error(`Cannot verify exports of ${resolved} for replacement ${spec}`);
      const module = resolved
        ? moduleForFile(checker, program.getSourceFile(resolved))
        : checker.getAmbientModules().find(symbol => symbol.name === JSON.stringify(spec));
      // A resolved script has a known, empty export surface. Only a genuinely
      // unresolved external module may lack a surface to check.
      modules.set(key, { module, exports: resolved || module ? exportSurface(checker, module) : undefined });
    }
    return modules.get(key);
  }
  const renamed = new Map();
  for (const { ref, source, missingSource, routes, destination } of sites) {
    const literal = literalAt(program.getSourceFile(ref.file), ref);
    const file = literal.getSourceFile();
    const original = targetInfo(source, args.source);
    const check = (oldName, name, dest, typeOnly) => {
      const provided = targetInfo(dest.resolved, dest.spec).exports;
      if ((rules.split || missingSource) && !provided) {
        throw new Error(`Cannot verify exports of ${dest.input} imported by ${session.rel(ref.file)}; provide its declarations`);
      }
      if (provided && !provided.has(name)) {
        if (!missing.has(dest.input)) missing.set(dest.input, new Map());
        missingName(missing.get(dest.input), name, session.rel(ref.file));
      }
      const replacement = provided?.get(name);
      checkExport(original.exports?.get(oldName), replacement, typeOnly, name, session.rel(ref.file), dest.input);
      return replacement;
    };
    const ctx = { file, checker, edits, renamed, renameLocal: args.renameLocal === true, missingSource };
    if (rules.split || missingSource) {
      writeSplit({
        ...ctx,
        use: check,
        checkUnbuiltBinding: (item, bindings, provided, name) => unbuiltBinding(ctx, item, bindings, provided, name),
      }, literal, splitBindings(literal.parent), routes, renameBinding, quoted);
    } else {
      const target = targetInfo(destination.resolved, destination.spec);
      inspectUse({
        ...ctx,
        originalExports: original.exports || new Map(),
        provided: target.exports,
        require: ref.kind === "require",
        originalModuleType: commonJsType(checker, original.module),
        replacementModuleType: ref.kind === "require" && commonJsType(checker, target.module),
        use(old, typeOnly = false) {
          const name = rules.rows.get(old)?.name || old;
          check(old, name, destination, typeOnly);
          return name;
        },
      }, literal);
      edits.replace(literal, quoted(literal, destination.spec));
    }
  }

}

module.exports = { replaceModule };
