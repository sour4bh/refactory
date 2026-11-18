// Use the parser's local binding tables to distinguish same-named variables in
// nested scopes. Evaluating a loader argument does not need a workspace program.
const { ts } = require("ts-morph");
const { urlProjection } = require("./derived-url");

function localDeclaration(id, source, options) {
  ts.bindSourceFile(source, options);
  for (let scope = id.parent; scope; scope = scope.parent) {
    const symbol = scope.locals?.get(id.escapedText);
    if (symbol) return symbol.valueDeclaration || symbol.declarations?.[0];
  }
}

function hasLiteralPart(expr) {
  expr = ts.skipOuterExpressions(expr);
  if (ts.isStringLiteralLike(expr) || ts.isTemplateLiteralToken(expr)) return expr.text.length > 0;
  if (ts.isConditionalExpression(expr)) return hasLiteralPart(expr.whenTrue) || hasLiteralPart(expr.whenFalse);
  if (ts.isElementAccessExpression(expr)) return hasLiteralPart(expr.expression);
  return !!ts.forEachChild(expr, hasLiteralPart);
}

const unknown = { values: null, prefix: "", opaque: true };
const uncertain = { ...unknown, opaque: false };
const unbounded = { ...uncertain, unbounded: true };
// The file writes or passes on a value that this analysis does not follow. Like
// an unknown value it needs an acknowledgment; the listed parts stay checked.
const unlisted = { ...uncertain, unlisted: true };
const unique = values => [...new Set(values)];
const finite = (values) => ({ values: [...new Set(values)], prefix: "", opaque: false });

// Keep fixed suffixes across concatenations. A literal parent segment that
// follows a variable can escape its enclosing prefix, even when the variable
// itself never traverses up. WHATWG file URLs accept percent-encoded dots.
function parentSegment(text) {
  const decoded = text.replace(/[\t\n\r]/g, "").replace(/%2e/gi, ".");
  return /(?:^|[/\\])\.\.(?:$|[/\\?#])/.test(decoded);
}

const marked = (result, parts) => parts.some(part => part.unlisted) ? { ...result, unlisted: true } : result;

function alternatives(parts) {
  return marked(choices(parts), parts);
}

function choices(parts) {
  if (parts.every(part => part.values)) return finite(parts.flatMap(part => part.values));
  if (parts.every(part => part.opaque)) return unknown;
  const known = unique(parts.flatMap(part => part.values || part.known || []));
  const prefixes = unique(parts.flatMap(part => [...(part.prefixes || []), ...(part.prefix ? [part.prefix] : [])]));
  const tails = unique(parts.flatMap(part => part.values || part.tails || [""]));
  const starts = parts.flatMap(part => part.values || [part.prefix]);
  let prefix = starts[0] || "";
  for (const start of starts) {
    while (prefix && !start.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  if (parts.some(part => part.unbounded) || starts.some(parentSegment) || tails.length > 256) {
    return { ...unbounded, known, prefixes, ...(tails.length <= 256 && { tails }) };
  }
  return { ...uncertain, prefix, tails, known, prefixes };
}

function append(left, right) {
  return marked(concatenation(left, right), [left, right]);
}

// A value that the left side is known to take still starts the result. With
// a finite right side it gives complete values. A single left value is the
// prefix of the result already.
function startParts(left, right) {
  const starts = left.values?.length > 1 ? left.values : left.known || [];
  const exact = right.values && starts.length * right.values.length <= 256;
  return {
    known: exact ? starts.flatMap(a => right.values.map(b => a + b)) : [],
    prefixes: unique([...(left.prefixes || []), ...(exact ? [] : starts)]),
  };
}

function concatenation(left, right) {
  if (left.values && right.values && left.values.length * right.values.length <= 256)
    return finite(left.values.flatMap(a => right.values.map(b => a + b)));
  const parts = startParts(left, right);
  if (left.unbounded || right.unbounded) {
    const previous = left.tails || [""];
    const tails = right.values && previous.length * right.values.length <= 256
      ? previous.flatMap(a => right.values.map(b => a + b))
      : right.tails || [""];
    return { ...unbounded, tails, ...parts };
  }
  let tails = right.tails || [""];
  if (!left.values) {
    const previous = left.tails || [""];
    const starts = right.values || [right.prefix];
    if (previous.length * starts.length > 256) return { ...unbounded, ...parts };
    const combined = previous.flatMap(a => starts.map(b => a + b));
    if (combined.some(parentSegment)) return { ...unbounded, tails: combined, ...parts };
    if (right.values) tails = combined;
  } else if (left.values.length > 1 && left.values.some(parentSegment)) return { ...unbounded, ...parts };
  return {
    ...parts,
    values: null,
    tails,
    prefix: left.values?.length === 1 ? left.values[0] + right.prefix : left.prefix,
    opaque: (left.opaque || left.values?.[0] === "" && left.values.length === 1) &&
      (right.opaque || right.values?.[0] === "" && right.values.length === 1),
  };
}

function literalValues(source, options) {
  const bindings = new Map();
  const arrays = new Map();
  const declFor = (id) => localDeclaration(id, source, options);

  function safeReads(decl, allow) {
    function unsafe(node) {
      if (ts.isIdentifier(node) && node !== decl.name && node.escapedText === decl.name.escapedText &&
          declFor(node) === decl && !allow(node)) return true;
      return ts.forEachChild(node, unsafe);
    }
    return !unsafe(source);
  }

  function mapCallback(access) {
    if (!ts.isPropertyAccessExpression(access) || access.name.text !== "map") return;
    const call = access.parent;
    if (ts.isCallExpression(call) && call.expression === access) {
      const cb = call.arguments[0];
      if (cb && ts.isFunctionExpressionOrArrowFunction(cb)) return cb;
    }
  }

  function confinedCallback(cb) {
    // A third parameter or arguments can expose the mutable receiver. A
    // named callback can also escape or invoke itself on unrelated values.
    if (cb.parameters.length > 2 || cb.parameters.some(p => !!p.dotDotDotToken)) return false;
    if (!ts.isFunctionExpression(cb)) return true;
    function escapes(node) {
      if (ts.isIdentifier(node) && (node.text === "arguments" || node.text === cb.name?.text)) return true;
      return ts.forEachChild(node, escapes);
    }
    return !escapes(cb.body) && !cb.parameters.some(escapes);
  }

  // Reads of an array, including methods that return a new value. A callback
  // must not receive the array itself as its third argument.
  const readers = new Set(["at", "concat", "entries", "flat", "includes", "indexOf", "join", "keys",
    "lastIndexOf", "slice", "toString", "values"]);
  const visitors = new Set(["every", "filter", "find", "findIndex", "findLast", "findLastIndex", "flatMap",
    "forEach", "map", "reduce", "reduceRight", "some"]);
  const reorders = new Set(["copyWithin", "pop", "reverse", "shift", "sort"]);
  const choiceAssignments = new Set([ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken]);

  // The node together with any parentheses or type assertions around it.
  function outermost(node) {
    let outer = node;
    while (ts.skipOuterExpressions(outer.parent) === node) outer = outer.parent;
    return outer;
  }

  // The entries that one use adds to the array: null for a read, a list of
  // values for a write, and an unlisted value for a use this analysis cannot follow.
  function arrayUse(id) {
    if (ts.isAssignmentTarget(id)) return null; // writes() lists these.
    const outer = outermost(id);
    const parent = outer.parent;
    if ((ts.isForOfStatement(parent) && parent.expression === outer) || ts.isSpreadElement(parent)) return null;
    // A direct alias shares the array, so its writes are writes of the original.
    if (ts.isVariableDeclaration(parent) && parent.initializer === outer && ts.isIdentifier(parent.name))
      return arrayEntries(parent);
    if (!(ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) || parent.expression !== outer)
      return [unlisted];
    const argument = ts.isElementAccessExpression(parent) && ts.skipOuterExpressions(parent.argumentExpression);
    const key = argument ? (ts.isStringLiteralLike(argument) ? argument.text : undefined) : parent.name.text;
    const access = outermost(parent);
    const use = access.parent;
    if (argument && (key === undefined || /^\d+$/.test(key))) {
      if (ts.isBinaryExpression(use) && use.left === access && use.operatorToken.kind === ts.SyntaxKind.EqualsToken)
        return [value(use.right)];
      if (ts.isAssignmentTarget(access) || ts.isDeleteExpression(use) ||
          (ts.isCallExpression(use) && use.expression === access) ||
          (ts.isTaggedTemplateExpression(use) && use.tag === access)) return [unlisted];
      return null;
    }
    if (key === "length") return null;
    if (!ts.isCallExpression(use) || use.expression !== access) return [unlisted];
    if (key === "push" || key === "unshift") return use.arguments.map(element);
    if (key === "splice") return use.arguments.slice(2).map(element);
    if (key === "fill") return use.arguments.slice(0, 1).map(value);
    if (readers.has(key) || reorders.has(key)) return null;
    if (visitors.has(key)) {
      const cb = use.arguments[0];
      return cb && ts.isFunctionExpressionOrArrowFunction(cb) && confinedCallback(cb) ? null : [unlisted];
    }
    return [unlisted];
  }

  // Entries that the file adds after the declaration, or null when the file
  // only reads the array. Code in other files can add to an exported array.
  // An array that the binding gets by assignment adds its entries.
  function arrayEntries(decl) {
    if (arrays.has(decl)) return arrays.get(decl);
    arrays.set(decl, [unlisted]); // A recursive write cannot be listed.
    const entries = ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Export ? [unknown] : [];
    if (!(decl.parent.flags & ts.NodeFlags.Const)) {
      const { assigned, appended, other } = writes(decl);
      entries.push(...assigned.map(right => arrayValues(right)));
      if (appended.length || other) entries.push(unlisted);
    }
    function visit(node) {
      if (ts.isIdentifier(node) && node !== decl.name && node.escapedText === decl.name.escapedText &&
          declFor(node) === decl) entries.push(...(arrayUse(node) || []));
      ts.forEachChild(node, visit);
    }
    visit(source);
    const result = entries.length ? entries : null;
    arrays.set(decl, result);
    return result;
  }

  function arrayValues(expr, index) {
    expr = ts.skipOuterExpressions(expr);
    if (ts.isIdentifier(expr)) {
      const decl = declFor(expr);
      if (!decl || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name) || !decl.initializer) return unknown;
      const initializer = ts.skipOuterExpressions(decl.initializer);
      // The entries of the original array include the writes through this alias.
      if (ts.isIdentifier(initializer)) return arrayValues(initializer, index);
      if (!ts.isArrayLiteralExpression(initializer)) return hasLiteralPart(decl.initializer) ? uncertain : unknown;
      const entries = arrayEntries(decl);
      if (entries) return alternatives([...initializer.elements.map(element), ...entries]);
      expr = initializer;
    }
    if (!ts.isArrayLiteralExpression(expr)) return hasLiteralPart(expr) ? uncertain : unknown;
    if (index && ts.isNumericLiteral(index) && expr.elements.every(el => !ts.isSpreadElement(el))) {
      const selected = expr.elements[Number(index.text)];
      return selected ? value(selected) : uncertain;
    }
    return alternatives(expr.elements.map(element));
  }

  function element(node) {
    return ts.isSpreadElement(node) ? arrayValues(node.expression) : value(node);
  }

  // The writes to a binding after its declaration: the right side of each plain
  // or logical assignment, the right side of each `+=`, and whether the file
  // writes the binding in another way.
  function writes(decl) {
    const found = { assigned: [], appended: [], other: false };
    function visit(node) {
      if (ts.isIdentifier(node) && node !== decl.name && node.escapedText === decl.name.escapedText &&
          declFor(node) === decl && ts.isAssignmentTarget(node)) {
        const target = outermost(node);
        const write = target.parent;
        const operator = ts.isBinaryExpression(write) && write.left === target && write.operatorToken.kind;
        if (operator === ts.SyntaxKind.EqualsToken || choiceAssignments.has(operator)) found.assigned.push(write.right);
        else if (operator === ts.SyntaxKind.PlusEqualsToken) found.appended.push(write.right);
        else found.other = true;
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    return found;
  }

  // The values of a binding: its initial values and each assigned value. Each
  // `+=` adds one concatenation of those values. The file can repeat a `+=`,
  // so a binding with `+=` or another write also has an unlisted part.
  function withWrites(decl, initial) {
    const { assigned, appended, other } = writes(decl);
    const parts = [...initial, ...assigned.map(value)];
    const base = parts.length ? alternatives(parts) : unknown;
    if (!appended.length && !other) return base;
    return alternatives([base, ...appended.map(right => append(base, value(right))), unlisted]);
  }

  function binding(decl) {
    if (bindings.has(decl)) return bindings.get(decl);
    bindings.set(decl, unlisted); // A recursive initializer cannot be listed.
    let result = unknown;
    if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
      const loop = decl.parent.parent;
      const initial = [];
      if (ts.isForOfStatement(loop) && loop.initializer === decl.parent) {
        initial.push(arrayValues(loop.expression));
      } else if (decl.initializer) {
        initial.push(value(decl.initializer));
      }
      if (!(decl.parent.flags & ts.NodeFlags.Const)) result = withWrites(decl, initial);
      else if (initial.length) result = alternatives(initial);
    } else if (ts.isParameter(decl) && ts.isIdentifier(decl.name)) {
      // Callers in any file supply the value. A default value is still a static choice.
      const cb = decl.parent, call = cb.parent;
      if (decl.initializer) result = alternatives([value(decl.initializer), unknown]);
      if (ts.isCallExpression(call) && cb.parameters[0] === decl && mapCallback(call.expression) === cb) {
        result = arrayValues(call.expression.expression);
        if (!confinedCallback(cb)) {
          const parts = [result, unknown];
          function calls(node) {
            if (cb.name && ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
                node.expression.text === cb.name.text && node.arguments[0]) parts.push(value(node.arguments[0]));
            ts.forEachChild(node, calls);
          }
          calls(cb.body);
          result = alternatives(parts);
        }
      }
      result = withWrites(decl, [result]);
    }
    bindings.set(decl, result);
    return result;
  }

  function value(expr) {
    expr = ts.skipOuterExpressions(expr);
    if (ts.isStringLiteralLike(expr)) return finite([expr.text]);
    if (ts.isIdentifier(expr)) {
      const decl = declFor(expr);
      return decl ? binding(decl) : unknown;
    }
    if (ts.isElementAccessExpression(expr)) {
      const array = ts.skipOuterExpressions(expr.expression);
      if (ts.isIdentifier(array) || ts.isArrayLiteralExpression(array)) return arrayValues(array, expr.argumentExpression);
    }
    if (ts.isConditionalExpression(expr)) {
      const yes = value(expr.whenTrue), no = value(expr.whenFalse);
      if (yes.opaque && no.opaque) return unknown;
      return alternatives([yes, no]);
    }
    if (ts.isBinaryExpression(expr) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
      ts.SyntaxKind.AmpersandAmpersandToken].includes(expr.operatorToken.kind))
      return alternatives([value(expr.left), value(expr.right)]);
    if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) &&
        expr.expression.name.text === "concat" && ts.isStringLiteralLike(expr.expression.expression))
      return expr.arguments.reduce((result, arg) => append(result, value(arg)), value(expr.expression.expression));
    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return append(value(expr.left), value(expr.right));
    if (ts.isTemplateExpression(expr)) {
      let result = finite([expr.head.text]);
      for (const span of expr.templateSpans) {
        result = append(result, value(span.expression));
        result = append(result, finite([span.literal.text]));
      }
      return result;
    }
    return hasLiteralPart(expr) ? uncertain : unknown;
  }
  return { describe: value, projection: urlProjection(declFor, safeReads) };
}

module.exports = { literalValues, localDeclaration };
