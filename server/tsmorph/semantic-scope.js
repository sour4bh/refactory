// A semantic edit checks its potential consumers and their compiler dependencies.
// The file system serves the current batch texts, including virtual destinations.
const { ts } = require("ts-morph");
const { directoryEntries, validationFileSystem } = require("./validation");

function providesAmbientBindings(source) {
  return !ts.isExternalOrCommonJsModule(source) || source.statements.some(statement =>
    ts.isNamespaceExportDeclaration(statement) ||
    (ts.isModuleDeclaration(statement) && (ts.isStringLiteral(statement.name) || ts.isGlobalScopeAugmentation(statement)))
  );
}

function addScopeRoots(project, session, roots) {
  const ws = session.workspace;
  const members = new Set(Array.from(roots, file => ws.owner(file)));
  // Script globals and module augmentations may affect binding without an import.
  for (const source of session.files()) {
    if (members.has(ws.owner(source.getFilePath())) && providesAmbientBindings(source.compilerNode))
      project.addSourceFileAtPath(source.getFilePath());
  }
  for (const file of roots) project.addSourceFileAtPath(file);
}

function scopedProject(session, roots) {
  const tree = directoryEntries(session.paths, session.root);
  const project = session.workspace.makeProject(undefined, validationFileSystem(session, tree));
  addScopeRoots(project, session, roots);
  return project;
}

function potentialConsumers(session, paths) {
  const consumers = new Set(paths);
  for (const file of consumers) {
    const source = session.project.getSourceFile(file);
    // A global provider can expose the component without an import edge. An
    // installed declaration can be forwarded through unindexed external barrels.
    if (!source || !session.paths.has(file) || providesAmbientBindings(source.compilerNode)) {
      for (const candidate of session.files()) consumers.add(candidate.getFilePath());
      break;
    }
    // Even a file without export-from syntax can forward a namespace through
    // an inferred return type, default export or object property.
    for (const ref of session.referencesTo(file))
      if (ref.kind !== "url") consumers.add(ref.file);
  }
  return consumers;
}

module.exports = { scopedProject, potentialConsumers, addScopeRoots };
