// Keep a real, resolvable binding while one endpoint of a package move is still
// in transit. A semantic operation between the two moves needs that binding too.
const path = require("node:path");
const { PublicImportError } = require("./workspace");
const { replaceLiterals } = require("./references");

class BatchImports {
  constructor(session, steps) {
    this.session = session;
    this.pending = new Map();
    this.moves = new Map();
    // Lookahead only identifies temporary package edges. The ordinary dispatcher
    // validates and executes every step, and finish() checks the actual graph.
    const root = session.workspace.requestRoot;
    for (const [index, step] of steps.entries()) {
      if (!["move_module", "delete_module"].includes(step?.operation) || typeof step.source !== "string") continue;
      if (step.operation === "move_module" && typeof step.target !== "string") continue;
      const from = path.resolve(root, step.source);
      const to = step.operation === "move_module" ? path.resolve(root, step.target) : null;
      if (!this.moves.has(from)) this.moves.set(from, []);
      this.moves.get(from).push({ index, to });
    }
  }

  finalPath(file) {
    let index = this.session.operationIndex;
    while (file) {
      const move = this.moves.get(file)?.find(step => step.index > index);
      if (!move) break;
      file = move.to;
      index = move.index;
    }
    return file;
  }

  binding(file, spec, target) {
    const known = this.pending.get(file)?.get(spec);
    return known && known.target === target ? known : undefined;
  }

  specifier(from, to, original, ref) {
    const ws = this.session.workspace;
    const previous = ref && this.binding(ref.file, ref.spec, ref.to);
    const style = previous ? previous.style : original;
    const kind = ref?.resolutionMode ?? ref?.kind;
    if (ws.owner(from) === ws.owner(to))
      return ws.specifier(from, to, style, kind);

    let spec;
    try {
      spec = ws.specifier(from, to, style, kind);
      const finalFrom = this.finalPath(from), finalTo = this.finalPath(to);
      if (finalFrom && finalTo && ws.owner(finalFrom) !== ws.owner(finalTo)) return spec;
    } catch (error) {
      if (!(error instanceof PublicImportError)) throw error;
      // No intermediate manifest row is necessary. Verify this private spelling
      // just like any other candidate before allowing it in the in-memory text.
      spec = ws.localSpecifier(from, to, style, kind);
    }
    if (!this.pending.has(from)) this.pending.set(from, new Map());
    const pending = this.pending.get(from);
    const known = this.binding(from, spec, to);
    if (known && known.style !== style)
      throw new Error(`Cannot preserve both import styles '${known.style}' and '${style}' in ${from}`);
    pending.set(spec, { target: to, style, index: previous?.index ?? this.session.operationIndex });
    return spec;
  }

  finish() {
    if (!this.pending.size) return;
    const session = this.session;
    const issues = [];
    let firstIndex;
    for (const [file, entries] of this.pending) {
      const edits = [];
      for (const ref of session.index.byFile.get(file) || []) {
        const binding = entries.get(ref.spec);
        if (!binding || ref.to !== binding.target) continue;
        try {
          const spec = session.workspace.specifier(file, ref.to, binding.style, ref.resolutionMode ?? ref.kind);
          if (spec !== ref.spec) edits.push({ ref, spec });
        } catch (error) {
          issues.push(`${session.rel(file)} -> ${session.rel(ref.to)}: ${error.message}`);
          firstIndex = Math.min(firstIndex ?? binding.index, binding.index);
        }
      }
      if (edits.length) {
        const source = session.project.getSourceFileOrThrow(file);
        source.replaceWithText(replaceLiterals(source.getFullText(), edits));
        session.index.scan(source);
      }
    }
    if (issues.length) {
      const error = new Error([...new Set(issues)].join("\n"));
      error.index = firstIndex;
      throw error;
    }
    this.pending.clear();
    session.finishOperation(false);
  }
}

module.exports = { BatchImports };
