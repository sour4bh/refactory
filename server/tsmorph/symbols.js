const { Node, SyntaxKind, ts } = require("ts-morph");
const path = require("path");
const { requireBindingName, walk } = require("./semantic-edits");
const { isCode } = require("./files");
const { referenceTarget } = require("./assets");
const { replaceLiterals } = require("./references");

function validateSourceExtension(filePath, label) {
  if (!isCode(filePath)) throw new Error(`${label} must be a TypeScript/JavaScript source file: ${filePath}`);
}

function assertSameLanguageFamily(source, target) {
  if (/\.[cm]?tsx?$/.test(source) !== /\.[cm]?tsx?$/.test(target)) {
    throw new Error(`cannot move between language families: ${source} to ${target}`);
  }
}

function exportMovedDeclaration(targetFile, symbolName) {
  const named =
    targetFile.getFunction(symbolName) ||
    targetFile.getClass(symbolName) ||
    targetFile.getInterface(symbolName) ||
    targetFile.getTypeAlias(symbolName) ||
    targetFile.getEnum(symbolName);
  if (named) {
    named.setIsExported(true);
    return;
  }
  const variableDeclaration = targetFile.getVariableDeclaration(symbolName);
  if (variableDeclaration) {
    variableDeclaration.getVariableStatement().setIsExported(true);
    return;
  }
  throw new Error(`could not export moved symbol ${symbolName} in the target file`);
}

function buildNamedSpecifier(name, alias, isTypeOnly) {
  if (!alias && !isTypeOnly) {
    return name;
  }
  return { name, alias, isTypeOnly };
}

function ensureNamedImport(refFile, moduleSpecifier, options) {
  const existingImport = refFile.getImportDeclarations().find((declaration) => {
    return (
      declaration.getModuleSpecifierValue() === moduleSpecifier &&
      !declaration.getNamespaceImport() &&
      (!options.isTypeOnly || declaration.getImportClause()) &&
      !(declaration.isTypeOnly() && !options.isTypeOnly)
    );
  });

  if (existingImport) {
    const alreadyPresent = existingImport.getNamedImports().some((namedImport) => {
      const alias = namedImport.getAliasNode()?.getText();
      return (
        namedImport.getName() === options.name &&
        alias === options.alias &&
        (existingImport.isTypeOnly() || namedImport.isTypeOnly()) === options.isTypeOnly
      );
    });

    if (!alreadyPresent) {
      existingImport.addNamedImport(
        buildNamedSpecifier(options.name, options.alias, options.isTypeOnly && !existingImport.isTypeOnly()),
      );
    }
    return;
  }

  refFile.addImportDeclaration({
    moduleSpecifier,
    namedImports: [buildNamedSpecifier(options.name, options.alias, options.isTypeOnly)],
  });
}

function ensureDefaultImport(refFile, moduleSpecifier, name, isTypeOnly = false) {
  const existingImport = refFile.getImportDeclarations().find((declaration) => {
    return (
      declaration.getModuleSpecifierValue() === moduleSpecifier &&
      declaration.getDefaultImport() !== undefined
    );
  });

  if (existingImport) {
    if (existingImport.getDefaultImport().getText() !== name) {
      throw new Error(`Target import collision for default import '${name}' from '${moduleSpecifier}'`);
    }
    if (existingImport.isTypeOnly() && !isTypeOnly)
      throw new Error("Target binding is imported as type-only: " + name);
    return;
  }

  refFile.addImportDeclaration({
    moduleSpecifier,
    isTypeOnly,
    defaultImport: name,
  });
}

function ensureNamespaceImport(refFile, moduleSpecifier, name, isTypeOnly = false) {
  const existingImport = refFile.getImportDeclarations().find((declaration) => {
    return (
      declaration.getModuleSpecifierValue() === moduleSpecifier &&
      declaration.getNamespaceImport() !== undefined
    );
  });

  if (existingImport) {
    if (existingImport.getNamespaceImport().getText() !== name) {
      throw new Error(`Target import collision for namespace import '${name}' from '${moduleSpecifier}'`);
    }
    if (existingImport.isTypeOnly() && !isTypeOnly)
      throw new Error("Target binding is imported as type-only: " + name);
    return;
  }

  refFile.addImportDeclaration({
    moduleSpecifier,
    isTypeOnly,
    namespaceImport: name,
  });
}

function ensureNamedExport(refFile, moduleSpecifier, options) {
  const existingExport = refFile.getExportDeclarations().find((declaration) => {
    return (
      declaration.getModuleSpecifierValue() === moduleSpecifier &&
      declaration.getNamedExports().length > 0 &&
      !(declaration.isTypeOnly() && !options.isTypeOnly)
    );
  });

  if (existingExport) {
    const alreadyPresent = existingExport.getNamedExports().some((namedExport) => {
      const alias = namedExport.getAliasNode()?.getText();
      return (
        namedExport.getName() === options.name &&
        alias === options.alias &&
        (existingExport.isTypeOnly() || namedExport.isTypeOnly()) === options.isTypeOnly
      );
    });

    if (!alreadyPresent) {
      existingExport.addNamedExport(
        buildNamedSpecifier(options.name, options.alias, options.isTypeOnly && !existingExport.isTypeOnly()),
      );
    }
    return;
  }

  refFile.addExportDeclaration({
    moduleSpecifier,
    namedExports: [buildNamedSpecifier(options.name, options.alias, options.isTypeOnly)],
  });
}

function ensureDefaultReexport(refFile, moduleSpecifier) {
  const existingExport = refFile.getExportDeclarations().find((declaration) => {
    return (
      declaration.getModuleSpecifierValue() === moduleSpecifier &&
      declaration.getNamedExports().some((namedExport) => namedExport.getName() === "default")
    );
  });
  if (existingExport) {
    return;
  }

  refFile.addExportDeclaration({
    moduleSpecifier,
    namedExports: [{ name: "default" }],
  });
}

function removeEmptyImportDeclaration(importDeclaration) {
  if (
    importDeclaration.getNamedImports().length === 0 &&
    !importDeclaration.getDefaultImport() &&
    !importDeclaration.getNamespaceImport()
  ) {
    importDeclaration.remove();
  }
}

function removeEmptyExportDeclaration(exportDeclaration) {
  if (exportDeclaration.getNamedExports().length === 0) {
    exportDeclaration.remove();
  }
}

function getMovedSymbolText(session, symbol, target) {
  const node = Node.isVariableDeclaration(symbol) ? symbol.getVariableStatement() : symbol;
  const source = node.getSourceFile().getFilePath();
  const start = node.getFullStart();
  const end = node.getEnd();
  const edits = [];
  if (path.dirname(source) !== path.dirname(target)) {
    const blockers = (session.index.computed.get(source) || []).filter(ref => ref.start >= start && ref.end <= end);
    if (blockers.length) throw session.index.computedError(blockers,
      "\nCannot relocate the loader because its runtime path may change.");
  }
  for (const ref of session.index.byFile.get(source) || []) {
    if (ref.start < start || ref.end > end) continue;
    const originalTarget = referenceTarget(ref);
    if (!originalTarget) {
      if (
        ref.kind === "url" || ref.spec.startsWith(".") ||
        session.workspace.packageForSpecifier(ref.spec) ||
        session.workspace.hasAlias(source, ref.spec)
      ) {
        throw new Error(`Cannot relocate unresolved '${ref.spec}' in ${session.rel(source)}`);
      }
      continue;
    }
    edits.push({
      ref: { ...ref, start: ref.start - start, end: ref.end - start },
      spec: session.specifier(target, originalTarget, ref.spec, ref),
    });
  }
  return replaceLiterals(node.getFullText(), edits);
}

function getLineAndColumn(sourceFile, node) {
  return sourceFile.getLineAndColumnAtPos(node.getStart());
}

function nodeMatchesSelector(node, sourceFile, line, column) {
  if (line === null || line === undefined) {
    return true;
  }
  const position = getLineAndColumn(sourceFile, node);
  if (position.line !== line) {
    return false;
  }
  if (column === null || column === undefined) {
    return true;
  }
  return position.column === column;
}

function uniqueNodes(nodes) {
  const seen = new Set();
  return nodes.filter((node) => {
    const key = `${node.getSourceFile().getFilePath()}:${node.getStart()}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function getTopLevelSymbolCandidates(sourceFile, name) {
  return uniqueNodes([
    ...sourceFile.getFunctions().filter((node) => node.getName() === name),
    ...sourceFile.getClasses().filter((node) => node.getName() === name),
    ...sourceFile.getInterfaces().filter((node) => node.getName() === name),
    ...sourceFile.getTypeAliases().filter((node) => node.getName() === name),
    ...sourceFile.getEnums().filter((node) => node.getName() === name),
    ...sourceFile.getVariableDeclarations().filter((node) => node.getName() === name),
  ]);
}

function getParameterCandidates(sourceFile, name) {
  return uniqueNodes(
    sourceFile.getDescendantsOfKind(SyntaxKind.Parameter).filter((parameter) => {
      const nameNode = parameter.getNameNode();
      return Node.isIdentifier(nameNode) && nameNode.getText() === name;
    }),
  );
}

function selectRenameCandidate(sourceFile, oldName, line, column) {
  const candidates = [
    ...getTopLevelSymbolCandidates(sourceFile, oldName),
    ...getParameterCandidates(sourceFile, oldName),
  ];
  const matching = candidates.filter((node) => {
    const nameNode = node.getNameNode ? node.getNameNode() : node;
    return nodeMatchesSelector(nameNode, sourceFile, line, column);
  });

  if (matching.length === 0) {
    throw new Error(`Symbol '${oldName}' not found in ${sourceFile.getBaseName()}`);
  }
  if (line !== null && line !== undefined && matching.length > 1) {
    throw new Error(`Symbol '${oldName}' is ambiguous at line ${line}; pass column`);
  }
  if (line === null || line === undefined) {
    if (matching.length === 1) {
      return matching[0];
    }
    throw new Error(`Symbol '${oldName}' is ambiguous in ${sourceFile.getBaseName()}; pass line and column`);
  }

  return matching[0];
}

function hasTopLevelBinding(sourceFile, name) {
  return sourceFile.getStatements().some((statement) => {
    if (
      Node.isFunctionDeclaration(statement) ||
      Node.isClassDeclaration(statement) ||
      Node.isInterfaceDeclaration(statement) ||
      Node.isTypeAliasDeclaration(statement) ||
      Node.isEnumDeclaration(statement)
    ) {
      return statement.getName() === name;
    }

    if (Node.isVariableStatement(statement)) {
      return statement.getDeclarations().some((declaration) => {
        return Node.isIdentifier(declaration.getNameNode()) && declaration.getName() === name;
      });
    }

    if (Node.isImportDeclaration(statement)) {
      if (statement.getDefaultImport()?.getText() === name) {
        return true;
      }
      if (statement.getNamespaceImport()?.getText() === name) {
        return true;
      }
      return statement.getNamedImports().some((namedImport) => {
        return (namedImport.getAliasNode()?.getText() || namedImport.getName()) === name;
      });
    }

    return false;
  });
}

function resolveMovableSymbol(sourceFile, symbolName) {
  const candidates = getTopLevelSymbolCandidates(sourceFile, symbolName);
  if (candidates.length === 0) {
    throw new Error(`Symbol '${symbolName}' not found in ${sourceFile.getBaseName()}`);
  }
  if (candidates.length > 1) {
    throw new Error(`move_symbol cannot handle merged declarations for '${symbolName}'`);
  }

  const symbol = candidates[0];
  if (Node.isVariableDeclaration(symbol)) {
    const declarationList = symbol.getVariableStatement().getDeclarationList();
    if (declarationList.getDeclarations().length > 1) {
      throw new Error(
        `move_symbol cannot move '${symbolName}' from a multi-declarator statement; split it first`,
      );
    }
    if (!Node.isIdentifier(symbol.getNameNode())) {
      throw new Error(`move_symbol cannot move '${symbolName}' from a destructuring declaration`);
    }
  }

  return symbol;
}

function isNodeWithin(node, container) {
  return (
    node.getSourceFile() === container.getSourceFile() &&
    node.getStart() >= container.getStart() &&
    node.getEnd() <= container.getEnd()
  );
}

function isReferenceIdentifier(identifier, symbolRoot) {
  if (identifier.getStart() === symbolRoot.getStart()) {
    return false;
  }

  const parent = identifier.getParent();
  if (!parent) {
    return false;
  }

  if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier) {
    return false;
  }
  if (Node.isPropertyAssignment(parent) && parent.getNameNode() === identifier) {
    return false;
  }
  if (Node.isBindingElement(parent)) {
    return parent.getPropertyNameNode() !== identifier && parent.getNameNode() !== identifier;
  }
  if (
    Node.isImportSpecifier(parent) ||
    Node.isExportSpecifier(parent) ||
    Node.isImportClause(parent) ||
    Node.isNamespaceImport(parent) ||
    Node.isNamespaceExport(parent) ||
    Node.isNamedImports(parent) ||
    Node.isNamedExports(parent) ||
    Node.isTypeParameterDeclaration(parent)
  ) {
    return false;
  }
  if (
    (Node.isFunctionDeclaration(parent) ||
      Node.isClassDeclaration(parent) ||
      Node.isInterfaceDeclaration(parent) ||
      Node.isTypeAliasDeclaration(parent) ||
      Node.isEnumDeclaration(parent) ||
      Node.isMethodDeclaration(parent) ||
      Node.isMethodSignature(parent) ||
      Node.isPropertyDeclaration(parent) ||
      Node.isPropertySignature(parent) ||
      Node.isVariableDeclaration(parent) ||
      Node.isParameterDeclaration(parent)) &&
    parent.getNameNode?.() === identifier
  ) {
    return false;
  }
  if (Node.isQualifiedName(parent) && parent.getRight() === identifier) {
    return false;
  }

  return true;
}

function isTopLevelDeclaration(declaration, sourceFile) {
  if (declaration.getSourceFile() !== sourceFile) {
    return false;
  }
  if (Node.isVariableDeclaration(declaration)) {
    return Node.isSourceFile(declaration.getVariableStatement().getParent());
  }
  return Node.isSourceFile(declaration.getParent());
}

function classifyImportDeclaration(declaration) {
  const importDeclaration = declaration.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
  if (!importDeclaration) {
    return null;
  }

  const moduleSpecifier = importDeclaration.getModuleSpecifierValue();
  const resolvedFilePath = importDeclaration.getModuleSpecifierSourceFile()?.getFilePath();
  if (Node.isImportSpecifier(declaration)) {
    return {
      kind: "named",
      moduleSpecifier,
      resolvedFilePath,
      name: declaration.getName(),
      alias: declaration.getAliasNode()?.getText(),
      isTypeOnly: declaration.isTypeOnly() || importDeclaration.isTypeOnly(),
    };
  }
  if (Node.isImportClause(declaration) && declaration.getDefaultImport()) {
    return {
      kind: "default",
      moduleSpecifier,
      resolvedFilePath,
      name: declaration.getDefaultImport().getText(),
      isTypeOnly: importDeclaration.isTypeOnly(),
    };
  }
  if (Node.isNamespaceImport(declaration)) {
    return {
      kind: "namespace",
      moduleSpecifier,
      resolvedFilePath,
      name: declaration.getNameNode().getText(),
      isTypeOnly: importDeclaration.isTypeOnly(),
    };
  }
  return null;
}

function getLocalExportInfo(sourceFile, declaration, localName) {
  if (!isTopLevelDeclaration(declaration, sourceFile)) {
    return { exportShape: "none", localName };
  }

  if (Node.isVariableDeclaration(declaration)) {
    const statement = declaration.getVariableStatement();
    if (statement.getDeclarations().length > 1 || !Node.isIdentifier(declaration.getNameNode())) {
      return { exportShape: "unsupported-var", localName };
    }
    if (statement.isExported()) {
      return { exportShape: statement.isDefaultExport() ? "default" : "named", localName };
    }
  } else if (declaration.isExported?.()) {
    return { exportShape: declaration.isDefaultExport?.() ? "default" : "named", localName };
  }

  for (const exportAssignment of sourceFile.getExportAssignments()) {
    if (!exportAssignment.isExportEquals() && exportAssignment.getExpression().getText() === localName) {
      return { exportShape: "default", localName };
    }
  }

  for (const exportDeclaration of sourceFile.getExportDeclarations()) {
    if (exportDeclaration.getModuleSpecifierValue()) {
      continue;
    }
    for (const namedExport of exportDeclaration.getNamedExports()) {
      if (namedExport.getName() !== localName) {
        continue;
      }
      const alias = namedExport.getAliasNode()?.getText();
      if (alias) {
        return { exportShape: "aliased", localName, externalName: alias };
      }
      return { exportShape: "named", localName };
    }
  }

  return { exportShape: "none", localName };
}

function isTypePosition(identifier) {
  const parent = identifier.getParent();
  if (!parent) {
    return false;
  }
  const parentKind = parent.getKind();
  return (
    Node.isTypeReference(parent) ||
    Node.isExpressionWithTypeArguments(parent) ||
    Node.isTypeAliasDeclaration(parent) ||
    Node.isTypeLiteral(parent) ||
    Node.isTypeQuery(parent) ||
    Node.isUnionTypeNode(parent) ||
    Node.isIntersectionTypeNode(parent) ||
    Node.isArrayTypeNode(parent) ||
    Node.isTupleTypeNode(parent) ||
    Node.isHeritageClause(parent) ||
    parentKind === SyntaxKind.TypeOperator
  );
}

function collectSymbolDependencies(symbol, sourceFile) {
  const passThroughImports = new Map();
  const sourceLocalRefs = new Map();
  const symbolRoot = Node.isVariableDeclaration(symbol) ? symbol.getVariableStatement() : symbol;

  for (const identifier of symbolRoot.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (!isReferenceIdentifier(identifier, symbolRoot)) {
      continue;
    }

    const symbolInfo = identifier.getSymbol();
    if (!symbolInfo) {
      continue;
    }

    const declarations = symbolInfo.getDeclarations();
    if (declarations.length === 0) {
      continue;
    }

    if (declarations.every((declaration) => isNodeWithin(declaration, symbolRoot))) {
      continue;
    }

    const importDeclaration = declarations
      .map((declaration) => classifyImportDeclaration(declaration))
      .find(Boolean);
    if (importDeclaration) {
      const key = `${importDeclaration.kind}:${importDeclaration.moduleSpecifier}:${importDeclaration.name}:${importDeclaration.alias || ""}:${importDeclaration.isTypeOnly}`;
      if (!passThroughImports.has(key)) {
        passThroughImports.set(key, importDeclaration);
      }
      continue;
    }

    const localDeclarationsForSymbol = uniqueNodes(
      declarations.filter((declaration) => isTopLevelDeclaration(declaration, sourceFile)),
    );
    if (localDeclarationsForSymbol.length === 0) {
      continue;
    }

    const localName = identifier.getText();
    const key = `${localName}:${localDeclarationsForSymbol.map((declaration) => declaration.getStart()).join(",")}`;
    if (!sourceLocalRefs.has(key)) {
      if (localDeclarationsForSymbol.length > 1) {
        sourceLocalRefs.set(key, {
          exportShape: "merged",
          localName,
          declarations: localDeclarationsForSymbol,
          isTypeOnly: isTypePosition(identifier),
        });
        continue;
      }

      const exportInfo = getLocalExportInfo(sourceFile, localDeclarationsForSymbol[0], localName);
      sourceLocalRefs.set(key, {
        ...exportInfo,
        declarations: localDeclarationsForSymbol,
        isTypeOnly: isTypePosition(identifier),
      });
      continue;
    }

    if (!isTypePosition(identifier)) {
      sourceLocalRefs.get(key).isTypeOnly = false;
    }
  }

  return {
    passThroughImports: [...passThroughImports.values()],
    sourceLocalRefs: [...sourceLocalRefs.values()],
  };
}

function ensureDependencyImport(targetFile, moduleSpecifier, dependency) {
  if (dependency.kind === "named") {
    ensureNamedImport(targetFile, moduleSpecifier, {
      name: dependency.name,
      alias: dependency.alias,
      isTypeOnly: dependency.isTypeOnly,
    });
    return;
  }
  if (dependency.kind === "default") {
    ensureDefaultImport(targetFile, moduleSpecifier, dependency.name, dependency.isTypeOnly);
    return;
  }
  if (dependency.kind === "namespace") {
    ensureNamespaceImport(targetFile, moduleSpecifier, dependency.name, dependency.isTypeOnly);
  }
}

function dependencyModuleSpecifier(session, target, source, dependency) {
  const resolved = session.resolve(source, dependency.moduleSpecifier);
  if (resolved && session.workspace.includes(resolved)) {
    return session.specifier(target, resolved, dependency.moduleSpecifier);
  }
  if (dependency.moduleSpecifier.startsWith(".")) {
    throw new Error(`Cannot rebase unresolved dependency ${dependency.moduleSpecifier}`);
  }
  return dependency.moduleSpecifier;
}

function moveSymbol(session, args) {
  const { sourceFile: srcPath, symbolName, targetFile: tgtPath } = args;
  const sourcePath = session.path(srcPath);
  const targetPath = session.path(tgtPath);
  validateSourceExtension(srcPath, "source_file");
  validateSourceExtension(tgtPath, "target_file");
  assertSameLanguageFamily(srcPath, tgtPath);
  if (sourcePath === targetPath) {
    throw new Error("source and target are identical");
  }

  const { project } = session;
  const warnings = [];
  session.assertReadableCode(sourcePath);
  session.assertReadableCode(targetPath);
  const sourceFile = project.getSourceFileOrThrow(sourcePath);
  if (session.index.byFile.get(sourcePath)?.some((ref) => ref.kind === "jsdoc")) {
    throw new Error(`Cannot split file-scoped JSDoc import bindings when moving a symbol from ${srcPath}`);
  }
  let targetFile = project.getSourceFile(targetPath);
  if (!targetFile) {
    targetFile = session.addCode(targetPath, "");
  }
  const symbol = resolveMovableSymbol(sourceFile, symbolName);
  if (hasTopLevelBinding(targetFile, symbolName)) {
    throw new Error(`target ${tgtPath} already has a binding '${symbolName}'`);
  }

  const sourceFilePath = sourceFile.getFilePath();
  const targetFilePath = targetFile.getFilePath();
  const dependencies = collectSymbolDependencies(symbol, sourceFile);
  const mergedDependencies = dependencies.sourceLocalRefs.filter(
    (dependency) => dependency.exportShape === "merged",
  );
  if (mergedDependencies.length > 0) {
    throw new Error(
      `move_symbol cannot handle merged declarations: ${mergedDependencies.map((dependency) => dependency.localName).join(", ")}`,
    );
  }
  const unsupportedVariables = dependencies.sourceLocalRefs.filter(
    (dependency) => dependency.exportShape === "unsupported-var",
  );
  if (unsupportedVariables.length > 0) {
    throw new Error(
      `move_symbol cannot promote multi-declarator or destructured variables: ${unsupportedVariables.map((dependency) => dependency.localName).join(", ")}`,
    );
  }
  const unresolvedDependencies = dependencies.sourceLocalRefs.filter(
    (dependency) => dependency.exportShape === "none",
  );
  if (unresolvedDependencies.length > 0) {
    throw new Error(
      `move_symbol requires these source bindings to be exported first: ${unresolvedDependencies.map((dependency) => dependency.localName).join(", ")}`,
    );
  }

  const isExported = symbol.isExported ? symbol.isExported() : false;
  const isDefaultExport = symbol.isDefaultExport ? symbol.isDefaultExport() : false;
  const exportName = isDefaultExport ? "default" : symbolName;
  for (const ref of session.referencesTo(sourceFilePath)) {
    if (ref.jsdocNames === null || ref.jsdocNames?.includes(exportName)) {
      throw new Error(`Cannot move ${symbolName}: JSDoc import in ${session.rel(ref.file)} needs to be retargeted`);
    }
  }
  const isTypeOnlySymbol = Node.isInterfaceDeclaration(symbol) || Node.isTypeAliasDeclaration(symbol);
  const sourceSpecifier = session.specifier(sourceFilePath, targetFilePath);
  const referencingNodes = symbol.findReferencesAsNodes ? symbol.findReferencesAsNodes() : [];
  const referencingFiles = [...new Set(referencingNodes.map((node) => node.getSourceFile()))];

  targetFile.addStatements(getMovedSymbolText(session, symbol, targetFilePath));

  for (const dependency of dependencies.passThroughImports) {
    if (dependency.resolvedFilePath === targetFilePath) {
      continue;
    }
    ensureDependencyImport(
      targetFile,
      dependencyModuleSpecifier(session, targetFilePath, sourceFilePath, dependency),
      dependency,
    );
  }

  for (const dependency of dependencies.sourceLocalRefs) {
    const moduleSpecifier = session.specifier(targetFilePath, sourceFilePath);
    if (dependency.exportShape === "default") {
      ensureDefaultImport(targetFile, moduleSpecifier, dependency.localName);
      continue;
    }
    if (dependency.exportShape === "aliased") {
      ensureNamedImport(targetFile, moduleSpecifier, {
        name: dependency.externalName,
        alias: dependency.localName,
        isTypeOnly: dependency.isTypeOnly,
      });
      continue;
    }
    ensureNamedImport(targetFile, moduleSpecifier, {
      name: dependency.localName,
      alias: undefined,
      isTypeOnly: dependency.isTypeOnly,
    });
  }

  for (const refFile of referencingFiles) {
    if (refFile.getFilePath() === sourceFilePath || refFile.getFilePath() === targetFilePath) {
      continue;
    }

    for (const importDeclaration of refFile.getImportDeclarations()) {
      const resolvedFile = importDeclaration.getModuleSpecifierSourceFile();
      if (!resolvedFile || resolvedFile.getFilePath() !== sourceFilePath) {
        continue;
      }

      const originalSpecifier = importDeclaration.getModuleSpecifierValue();
      const newSpecifier = session.specifier(refFile.getFilePath(), targetFilePath, originalSpecifier);
      const namedImports = importDeclaration
        .getNamedImports()
        .filter((namedImport) => namedImport.getName() === symbolName);
      for (const namedImport of namedImports) {
        const alias = namedImport.getAliasNode()?.getText();
        const isTypeOnly = importDeclaration.isTypeOnly() || namedImport.isTypeOnly();
        namedImport.remove();
        removeEmptyImportDeclaration(importDeclaration);
        ensureNamedImport(refFile, newSpecifier, {
          name: symbolName,
          alias,
          isTypeOnly,
        });
      }
    }

    for (const exportDeclaration of refFile.getExportDeclarations()) {
      const resolvedFile = exportDeclaration.getModuleSpecifierSourceFile();
      if (!resolvedFile || resolvedFile.getFilePath() !== sourceFilePath) {
        continue;
      }

      const originalSpecifier = exportDeclaration.getModuleSpecifierValue();
      const newSpecifier = session.specifier(refFile.getFilePath(), targetFilePath, originalSpecifier);
      const namedExports = exportDeclaration
        .getNamedExports()
        .filter((namedExport) => namedExport.getName() === symbolName);
      for (const namedExport of namedExports) {
        const alias = namedExport.getAliasNode()?.getText();
        const isTypeOnly = exportDeclaration.isTypeOnly() || namedExport.isTypeOnly();
        namedExport.remove();
        removeEmptyExportDeclaration(exportDeclaration);
        ensureNamedExport(refFile, newSpecifier, {
          name: symbolName,
          alias,
          isTypeOnly,
        });
      }
    }
  }

  symbol.remove();

  const sourceStillReferencesSymbol = sourceFile
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .some((identifier) => {
      return identifier.getText() === symbolName;
    });

  if (sourceStillReferencesSymbol) {
    if (!isExported) {
      exportMovedDeclaration(targetFile, symbolName);
      warnings.push(
        `${symbolName} was not exported; it is now exported from ${tgtPath} so ${srcPath} can import it back`,
      );
    }
    if (isDefaultExport) {
      ensureDefaultImport(sourceFile, sourceSpecifier, symbolName);
    } else {
      ensureNamedImport(sourceFile, sourceSpecifier, {
        name: symbolName,
        alias: undefined,
        isTypeOnly: isTypeOnlySymbol,
      });
    }
  }

  if (isExported) {
    if (isDefaultExport) {
      ensureDefaultReexport(sourceFile, sourceSpecifier);
    } else {
      ensureNamedExport(sourceFile, sourceSpecifier, {
        name: symbolName,
        alias: undefined,
        isTypeOnly: isTypeOnlySymbol,
      });
    }
  }

  return {
    symbol: symbolName,
    source: srcPath,
    target: tgtPath,
    warnings,
    preview: `Move symbol ${symbolName} from ${srcPath} to ${tgtPath}.`,
  };
}

function memberCandidate(file, oldName, newName, line, column) {
  const parts = oldName.split(".");
  if (parts.length !== 2) throw new Error("Specify members as Type.member");
  const [typeName, memberName] = parts;
  const owner =
    file.getInterface(typeName) ||
    file.getClass(typeName) ||
    file.getEnum(typeName) ||
    file.getTypeAlias(typeName)?.getTypeNode();
  if (!owner?.getMembers) throw new Error("Cannot find a type with declared members named " + typeName);
  const matches = owner.getMembers().filter((member) => member.getName?.() === memberName);
  if (owner.getMembers().some((member) => member.getName?.() === newName && newName !== memberName)) {
    throw new Error("Member already exists: " + typeName + "." + newName);
  }
  const selected = matches.filter((member) => nodeMatchesSelector(member.getNameNode(), file, line, column));
  if (!selected.length) throw new Error("Member not found: " + oldName);
  const first = selected[0].getNameNode();
  if (
    !Node.isIdentifier(first) ||
    selected.some((member) => member.getSymbol() !== selected[0].getSymbol())
  ) {
    throw new Error("Ambiguous or computed member: " + oldName);
  }
  const inherited = owner.getType().getProperty(newName);
  if (inherited && newName !== memberName) throw new Error("Member already exists: " + newName);
  return first;
}

// A base-typed read can receive any derived instance. Its rename locations
// alone cannot reveal that a derived type already uses the destination key.
function checkRelatedMembers(session, declaration, newName) {
  const checker = session.project.getTypeChecker().compilerObject;
  const original = new Set(
    declaration
      .getSymbol()
      .getDeclarations()
      .map((d) => d.compilerNode),
  );
  function inheritsMember(type, visited) {
    if (visited.has(type)) return false;
    visited.add(type);
    if (type.getProperty(declaration.getText())?.declarations?.some((d) => original.has(d))) return true;
    return type.getBaseTypes()?.some((base) => inheritsMember(base, visited)) || false;
  }
  for (const file of session.files()) {
    walk(file.compilerNode, (node) => {
      if (!ts.isClassLike(node) && !ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node))
        return;
      const symbol = node.symbol;
      if (!symbol) return;
      const types = [checker.getDeclaredTypeOfSymbol(symbol)];
      if (ts.isClassLike(node)) types.push(checker.getTypeOfSymbolAtLocation(symbol, node));
      for (const type of types) {
        if (type.getProperty(newName) && inheritsMember(type, new Set())) {
          throw new Error(`Related type already has member ${newName} in ${session.rel(file.getFilePath())}`);
        }
      }
    });
  }
}

function checkMemberReferences(session, declaration, newName) {
  checkRelatedMembers(session, declaration, newName);
  const declared = new Set(declaration.getSymbol().getDeclarations());
  const service = session.project.getLanguageService();
  for (const loc of service.findRenameLocations(declaration, { usePrefixAndSuffixText: true })) {
    const file = loc.getSourceFile();
    const node = file.getDescendantAtPos(loc.getTextSpan().getStart());
    if (!node) throw new Error("Cannot identify a member reference in " + file.getFilePath());
    const parent = node.getParent();
    if (Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent)) {
      const refs = node.getSymbol()?.getDeclarations() || [];
      if (refs.some((ref) => declared.has(ref)) && refs.some((ref) => !declared.has(ref))) {
        throw new Error("Ambiguous member on a union or intersection in " + file.getFilePath());
      }
      if (parent.getExpression().getType().getProperty(newName)) {
        throw new Error("Receiver already has member " + newName + " in " + file.getFilePath());
      }
    }
    if (Node.isBindingElement(parent) && Node.isObjectBindingPattern(parent.getParent())) {
      const pattern = parent.getParent();
      if (pattern.getType().getProperty(newName)) {
        throw new Error(`Destructuring receiver already has member ${newName} in ${file.getFilePath()}`);
      }
    }
    if (Node.isPropertyAssignment(parent) || Node.isShorthandPropertyAssignment(parent)) {
      const object = parent.getParent();
      if (Node.isObjectLiteralExpression(object) && object.getProperty(newName)) {
        throw new Error("Object literal already contains " + newName + " in " + file.getFilePath());
      }
    }
    if (
      Node.isJsxAttribute(parent) &&
      parent
        .getParent()
        ?.getAttributes?.()
        .some((attr) => attr.getNameNode?.().getText() === newName)
    ) {
      throw new Error("JSX attribute already exists: " + newName);
    }
  }
}

function renameSymbol(session, args) {
  const { file, oldName, newName, line = null, column = null } = args;
  validateSourceExtension(file, "file");
  requireBindingName(newName);
  if (
    (line != null && (!Number.isInteger(line) || line < 1)) ||
    (column != null && (!Number.isInteger(column) || column < 1 || line == null))
  ) {
    throw new Error("line and column must be 1-based; column requires line");
  }
  const sourcePath = session.path(file);
  session.assertReadableCode(sourcePath);
  const sourceFile = session.project.getSourceFileOrThrow(sourcePath);
  const symbol = oldName.includes(".")
    ? memberCandidate(sourceFile, oldName, newName, line, column)
    : selectRenameCandidate(sourceFile, oldName, line, column);
  if (
    !oldName.includes(".") &&
    oldName !== newName &&
    !Node.isParameterDeclaration(symbol) &&
    hasTopLevelBinding(sourceFile, newName)
  )
    throw new Error("Target already has a binding " + newName);
  if (oldName.includes(".") && symbol.getText() !== newName) checkMemberReferences(session, symbol, newName);
  symbol.rename(newName, { usePrefixAndSuffixText: oldName.includes(".") });
  return {
    old_name: oldName,
    new_name: newName,
    file,
    preview: `Rename ${oldName} to ${newName} in ${file}.`,
  };
}

module.exports = { moveSymbol, renameSymbol };
