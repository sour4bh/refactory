// Identify value-preserving paths from a dynamic import to the editable URL literal.
const { ts } = require("ts-morph");

function sourceURL(node) {
  if (!ts.isNewExpression(node) || !node.arguments?.[1]) return false;
  const ctor = ts.skipOuterExpressions(node.expression);
  const base = ts.skipOuterExpressions(node.arguments[1]);
  if (!ts.isIdentifier(ctor) || ctor.text !== "URL") return false;
  const property = ts.isPropertyAccessExpression(base) ? base.name
    : ts.isElementAccessExpression(base) && ts.isStringLiteralLike(base.argumentExpression) ? base.argumentExpression
    : undefined;
  if (property?.text !== "url") return false;
  const meta = ts.skipOuterExpressions(base.expression);
  return ts.isMetaProperty(meta) && meta.keywordToken === ts.SyntaxKind.ImportKeyword && meta.name.text === "meta";
}

function urlProjection(declFor, safeReads) {
  function constBinding(expr) {
    if (!ts.isIdentifier(expr)) return;
    const decl = declFor(expr);
    if (decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) &&
        decl.parent.flags & ts.NodeFlags.Const && decl.initializer) return decl;
  }

  function isNativeConversion(expr) {
    expr = ts.skipOuterExpressions(expr);
    let decl, named;
    if (ts.isIdentifier(expr)) {
      decl = declFor(expr);
      if (!decl || !ts.isImportSpecifier(decl)) return false;
      named = (decl.propertyName || decl.name).text;
    } else if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
      decl = declFor(expr.expression);
      if (!decl || !ts.isNamespaceImport(decl)) return false;
      named = expr.name.text;
    } else return false;
    const imp = ts.findAncestor(decl, ts.isImportDeclaration);
    return named === "fileURLToPath" && !decl.isTypeOnly && !imp?.importClause?.isTypeOnly &&
      ["node:url", "url"].includes(imp?.moduleSpecifier.text);
  }

  function projectionName(expr) {
    if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
    if (ts.isElementAccessExpression(expr) && ts.isStringLiteralLike(expr.argumentExpression))
      return expr.argumentExpression.text;
  }

  function urlObject(expr, seen) {
    expr = ts.skipOuterExpressions(expr);
    if (sourceURL(expr) && expr.arguments.length === 2) return expr;
    const decl = constBinding(expr);
    if (!decl || seen.has(decl)) return;
    seen.add(decl);
    // const preserves the object identity, but URL properties and searchParams
    // are mutable. Only infer the URL when every use reads its projection.
    if (!safeReads(decl, id => {
      let read = id;
      while (ts.skipOuterExpressions(read.parent) === id) read = read.parent;
      const use = read.parent;
      if (["href", "pathname"].includes(projectionName(use)) && use.expression === read)
        return !ts.isAssignmentTarget(use) && !ts.isDeleteExpression(use.parent);
      return ts.isCallExpression(use) && use.arguments.length === 1 && use.arguments[0] === read &&
        isNativeConversion(use.expression);
    })) return;
    return urlObject(decl.initializer, seen);
  }

  return function projection(expr, seen = new Set()) {
    expr = ts.skipOuterExpressions(expr);
    const decl = constBinding(expr);
    if (decl && !seen.has(decl)) {
      seen.add(decl);
      return projection(decl.initializer, seen);
    }
    let form = projectionName(expr);
    let object;
    if (form === "href" || form === "pathname") object = expr.expression;
    else if (ts.isCallExpression(expr) && expr.arguments.length === 1 && isNativeConversion(expr.expression)) {
      form = "fileURLToPath";
      object = expr.arguments[0];
    } else return;
    const url = urlObject(object, seen);
    if (url) return { url, form };
  };
}

module.exports = { sourceURL, urlProjection };
