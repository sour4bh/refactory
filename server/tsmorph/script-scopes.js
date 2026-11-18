// The workspace checker shares module symbols. Legacy script globals, however,
// belong to their individual tsconfig programs. Keep their original bindings
// until a semantic step has identified exactly which files it would edit.
const { ts } = require("ts-morph");

function scriptScopeCheck(session, project = session.project) {
  const ws = session.workspace;
  if (!ws.isWorkspace) return;
  const sources = project.getSourceFiles().filter(file => ws.includes(file.getFilePath())).map(file => file.compilerNode);
  if (sources.every((source) => source.statements.some(ts.isExternalModuleIndicator))) return;

  const checker = project.getTypeChecker().compilerObject;
  const scope = (file) => {
    const member = ws.owner(file);
    return member?.config?.dir ?? ws.rootConfig?.dir ?? member?.dir ?? ws.root;
  };
  const scopeMismatches = new Set();
  const declarations = new Set();
  const byName = new Map();
  for (const source of sources) {
    if (source.statements.some(ts.isExternalModuleIndicator)) continue;
    // Re-evaluate module detection with the member's options without changing
    // the SourceFile held by the workspace checker.
    const memberView = Object.create(source);
    ts.getSetExternalModuleIndicator(ws.options(source.fileName))(memberView);
    if (ts.isExternalOrCommonJsModule(memberView) !== ts.isExternalOrCommonJsModule(source)) {
      scopeMismatches.add(source.fileName);
    }
    if (ts.isExternalOrCommonJsModule(source)) continue;
    for (const symbol of source.locals?.values() || []) {
      const name = symbol.getName();
      const binding = { scope: scope(source.fileName), file: source.fileName };
      for (const decl of symbol.declarations || []) declarations.add(decl);
      if (!byName.has(name)) byName.set(name, new Map());
      byName.get(name).set(binding.scope, binding);
    }
  }
  if (!declarations.size && !scopeMismatches.size) return;

  return () => {
    for (const source of sources) {
      if (session.editedBy.get(source.fileName) !== session.operationIndex) continue;
      if (scopeMismatches.has(source.fileName)) {
        throw new Error(
          `Cannot disambiguate script globals in ${session.rel(source.fileName)}: ` +
            "the member and workspace checker disagree on module detection",
        );
      }
      const owner = scope(source.fileName);
      function visit(node) {
        const candidates = ts.isIdentifier(node) && byName.get(node.text);
        if (candidates && (candidates.size > 1 || !candidates.has(owner))) {
          const symbol = ts.isShorthandPropertyAssignment(node.parent)
            ? checker.getShorthandAssignmentValueSymbol(node.parent)
            : checker.getSymbolAtLocation(node);
          if (symbol?.declarations?.some((decl) => declarations.has(decl))) {
            const foreign = [...candidates.values()].find((binding) => binding.scope !== owner);
            throw new Error(
              `Cannot disambiguate script global '${node.text}' in ${session.rel(source.fileName)}: ` +
                `${session.rel(foreign.file)} belongs to a separate member scope`,
            );
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  };
}

module.exports = { scriptScopeCheck };
