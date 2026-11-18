// Child text uses JSX entity decoding. Preserve literal braces and whitespace,
// and keep adjacent text values as separate children in the emitted element.
const { ts } = require("ts-morph");

const isElement = node => ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);

function textChild(value, fromAttribute = false) {
  if (!value.length) return { text: '{""}' };
  const entities = { "&": fromAttribute ? "&" : "&amp;", "<": "&lt;", ">": "&gt;", "{": "&#123;", "}": "&#125;",
    "\r": "&#13;", "\n": "&#10;" };
  return { text: value.replace(/[&<>{}\r\n]/g, char => entities[char]), jsxText: true };
}

function childValue(attr, rule) {
  const init = attr?.initializer;
  if (!attr) return typeof rule.value === "string" ? textChild(rule.value) :
    { text: "{" + (Object.is(rule.value, -0) ? "-0" : JSON.stringify(rule.value)) + "}" };
  if (!init) return { text: "{true}" };
  if (ts.isStringLiteral(init)) return textChild(init.text, true);
  if (isElement(init)) return { node: init };
  const expr = init.expression;
  if (!expr) throw new Error("missing child expression for " + rule.prop);
  const padded = init.getText().slice(1, -1).trim();
  if (expr.getText() === padded) {
    if (isElement(expr)) return { node: expr };
    if (ts.isStringLiteralLike(expr)) return textChild(expr.text);
  }
  return { node: init };
}

const SELECTING = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken]);

// An expression must still run once. Preserve its relative evaluation order
// around other expressions that could mutate what it reads. The levels: 0 reads
// nothing, 1 reads bindings and runs no code, 2 can run code.
function evaluation(node) {
  if (ts.isJsxAttribute(node)) return node.initializer ? evaluation(node.initializer) : 0;
  if (ts.isJsxExpression(node)) return node.expression ? evaluation(node.expression) : 0;
  if (ts.isJsxText(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) ||
      [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) return 0;
  if (ts.isIdentifier(node)) return 1;
  // Creating a function runs none of its body.
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return 0;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node)) return evaluation(node.expression);
  // These operators call no code of the program: they only test or pick an operand.
  if (ts.isConditionalExpression(node))
    return Math.max(evaluation(node.condition), evaluation(node.whenTrue), evaluation(node.whenFalse));
  if (ts.isBinaryExpression(node) && SELECTING.has(node.operatorToken.kind))
    return Math.max(evaluation(node.left), evaluation(node.right));
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken)
    return evaluation(node.operand);
  if (isElement(node)) {
    const tag = ts.isJsxElement(node) ? node.openingElement : node;
    if (tag.tagName && !ts.isIdentifier(tag.tagName)) return 2;
    const parts = [...(tag.attributes?.properties || []), ...(node.children || [])];
    return parts.some(part => evaluation(part) === 2) ? 2 : 1;
  }
  return 2;
}

function planChildren(element, moves, edits) {
  const file = element.getSourceFile();
  const attrs = element.attributes.properties;
  const selfClosing = ts.isJsxSelfClosingElement(element);
  const children = selfClosing ? [] : element.parent.children;
  // At each end retain source attribute order. Absent rules follow in request order.
  moves.sort((a, b) => (a.attr?.pos ?? Infinity) - (b.attr?.pos ?? Infinity));
  const first = moves.filter(move => move.position === "start");
  const last = moves.filter(move => move.position === "end");
  const moving = new Set(moves.map(move => move.attr));
  const reordered = [...attrs.filter(attr => !moving.has(attr)), ...first.map(m => m.attr),
    ...children, ...last.map(m => m.attr)].filter(Boolean);
  const active = reordered.map(node => ({ node, level: evaluation(node) })).filter(item => item.level);
  for (let i = 0; i < active.length; i++) {
    if (active.slice(i + 1).some(next => next.node.pos < active[i].node.pos && Math.max(next.level, active[i].level) === 2))
      throw new Error("moving a prop to children could change expression evaluation order");
  }

  function render(items, previousText = false, nextText = false) {
    let result = "";
    for (const { child } of items) {
      if (previousText && child.jsxText) result += "{/**/}";
      result += child.node ? edits.takeText(child.node) : child.text;
      previousText = child.jsxText;
    }
    return result + (items.length && previousText && nextText ? "{/**/}" : "");
  }

  // The traversal also checks JSX inside an attribute. Render its final text
  // before removing it, starting with the innermost element.
  return () => {
    if (selfClosing) {
      const slash = element.getChildren().find(node => node.kind === ts.SyntaxKind.SlashToken);
      const at = file.text.slice(slash.pos, slash.getStart()).trim() ? slash.getStart() : slash.pos;
      edits.add(file, at, element.end, ">" + render([...first, ...last]) + "</" + element.tagName.getText() + ">");
    } else if (!children.length) {
      edits.add(file, element.end, element.end, render([...first, ...last]));
    } else {
      const end = element.parent.closingElement.getStart();
      edits.add(file, element.end, element.end, render(first, false, ts.isJsxText(children[0])));
      edits.add(file, end, end, render(last, ts.isJsxText(children.at(-1))));
    }
    for (const { attr } of moves) {
      if (!attr) continue;
      const at = file.text.slice(attr.pos, attr.getStart()).trim() ? attr.getStart() : attr.pos;
      edits.add(file, at, attr.end, "");
    }
  };
}

module.exports = { childValue, planChildren };
