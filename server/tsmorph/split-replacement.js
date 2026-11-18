const { ts } = require("ts-morph");

function splitBindings(decl) {
  const items = [];
  const isImport = ts.isImportDeclaration(decl);
  const clause = isImport ? decl.importClause : ts.isExportDeclaration(decl) && decl.exportClause;
  const named = isImport ? clause?.namedBindings : clause;
  if (isImport && clause?.name) items.push({ name: "default", local: clause.name });
  if (named && (ts.isNamedImports(named) || ts.isNamedExports(named))) {
    for (const node of named.elements) {
      items.push({ name: (node.propertyName || node.name).text, local: node.name, typeOnly: node.isTypeOnly });
    }
  } else if (named || !items.length) {
    throw new Error(`Cannot split an import without statically named bindings in ${decl.getSourceFile().fileName}; choose one target or rewrite this site first`);
  }
  if (!items.length)
    throw new Error(`Cannot split an empty import or export in ${decl.getSourceFile().fileName}; choose one target`);
  return { isImport, typeOnly: !!(isImport ? clause.isTypeOnly : decl.isTypeOnly), items };
}

function writeSplit(ctx, literal, bindings, routes, renameBinding, quoted) {
  const decl = literal.parent;
  const groups = new Map();
  for (const item of bindings.items) {
    const { name, destination } = routes.get(item.name);
    const provided = ctx.use(item.name, name, destination, bindings.typeOnly || item.typeOnly);
    if (ctx.missingSource && provided) {
      ctx.checkUnbuiltBinding(item, bindings, provided, name);
    }
    let local = item.local.getText();
    if (bindings.isImport && ctx.renameLocal && name !== item.name) {
      renameBinding(ctx, item.local, name);
      local = name;
    }
    const alias = name === local ? "" : " as " + local;
    const spec = destination.spec;
    if (!groups.has(spec)) groups.set(spec, []);
    groups.get(spec).push((item.typeOnly ? "type " : "") + name + alias);
  }
  // Directives, attribute objects and comments may apply to a particular
  // named binding. A statement split must never discard or duplicate them.
  const leading = ctx.file.text.slice(decl.getFullStart(), decl.getStart());
  if (decl.attributes || /\/\/|\/\*/.test(decl.getText()) || (groups.size > 1 && /@ts-|eslint-|prettier-ignore/.test(leading))) {
    throw new Error(`Cannot split annotated import or export in ${ctx.file.fileName}; separate its bindings first`);
  }
  const keyword = (bindings.isImport ? "import" : "export") + (bindings.typeOnly ? " type" : "");
  const end = decl.getText().endsWith(";") ? ";" : "";
  const before = ctx.file.text.slice(0, decl.getStart());
  const indent = before.match(/(?:^|\n)([\t ]*)$/)?.[1] || "";
  const newline = ctx.file.text.includes("\r\n") ? "\r\n" : "\n";
  const statements = [...groups].map(([spec, names]) =>
    keyword + " { " + names.join(", ") + " } from " + quoted(literal, spec) + end);
  ctx.edits.replace(decl, statements.join(newline + indent));
}

module.exports = { splitBindings, writeSplit };
