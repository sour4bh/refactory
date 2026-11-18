const { ts } = require("ts-morph");

// Retain offsets from one checker snapshot until every reference has been examined.
function editedText(text, start, end, edits) {
  const parts = [];
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
    if (edit.end > end) throw new Error("Overlapping source edits");
    parts.push(text.slice(edit.end, end), edit.replacement);
    end = edit.start;
  }
  parts.push(text.slice(start, end));
  return parts.reverse().join("");
}

class TextEdits {
  constructor() {
    this.files = new Map();
  }

  add(file, start, end, replacement) {
    if (file.text.slice(start, end) === replacement) return;
    if (!this.files.has(file.fileName)) this.files.set(file.fileName, new Map());
    const edits = this.files.get(file.fileName);
    const key = start + ":" + end;
    if (edits.has(key) && edits.get(key).replacement !== replacement) {
      throw new Error("Conflicting edits in " + file.fileName + " at " + start);
    }
    edits.set(key, { start, end, replacement });
  }

  replace(node, replacement) {
    this.add(node.getSourceFile(), node.getStart(), node.end, replacement);
  }

  takeText(node) {
    const file = node.getSourceFile();
    const pending = this.files.get(file.fileName);
    const start = node.getStart(), end = node.end;
    if (!pending) return file.text.slice(start, end);
    const nested = [];
    for (const [key, edit] of pending) {
      if (edit.start >= start && edit.end <= end) {
        nested.push(edit);
        pending.delete(key);
      }
    }
    return editedText(file.text, start, end, nested);
  }

  apply(project) {
    for (const [name, edits] of this.files) {
      const file = project.getSourceFileOrThrow(name);
      const original = file.getFullText();
      file.replaceWithText(editedText(original, 0, original.length, [...edits.values()]));
    }
  }
}

function walk(node, visit) {
  if (visit(node) === false) return;
  for (const doc of node.jsDoc || []) walk(doc, visit);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function targetSymbol(checker, symbol) {
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function exportSurface(checker, module) {
  if (!module) return new Map();
  const moduleType = checker.getTypeOfSymbolAtLocation(module, module.declarations[0]);
  return new Map(
    checker.getExportsOfModule(module).map((symbol) => {
      const target = targetSymbol(checker, symbol);
      // A type-only re-export retains its declaration flags, but is absent from
      // the module's value type. This also covers chains of export type *.
      const runtime = checker.getPropertyOfType(moduleType, symbol.name);
      return [symbol.name, { target, runtime: !!runtime && targetSymbol(checker, runtime) === target }];
    }),
  );
}

function moduleForFile(checker, file) {
  // A CommonJS module gets a bound symbol even if it has no ES module syntax.
  return checker.getSymbolAtLocation(file) || file.symbol;
}

function getExports(checker, file) {
  return exportSurface(checker, moduleForFile(checker, file));
}

function requireBindingName(name) {
  const token = ts.stringToToken(name);
  if (
    typeof name !== "string" ||
    !/^[$A-Z_a-z][$\w]*$/.test(name) ||
    (token >= ts.SyntaxKind.FirstReservedWord && token <= ts.SyntaxKind.LastFutureReservedWord) ||
    ["await", "arguments", "eval"].includes(name)
  )
    throw new Error("Invalid TypeScript identifier: " + name);
}

module.exports = {
  TextEdits,
  walk,
  targetSymbol,
  getExports,
  moduleForFile,
  exportSurface,
  requireBindingName,
};
