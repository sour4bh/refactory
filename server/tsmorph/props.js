const path = require("path");
const { ts } = require("ts-morph");
const { TextEdits, walk, targetSymbol, getExports } = require("./semantic-edits");

const { scopedProject, potentialConsumers, addScopeRoots } = require("./semantic-scope");
const { childValue, planChildren } = require("./prop-children");
const { scriptScopeCheck } = require("./script-scopes");

const unknown = Symbol("unknown");
const validName = (name) => typeof name === "string" && /^[$A-Z_a-z][$\w-]*$/.test(name);
const isLiteral = (value) => ["string", "boolean"].includes(typeof value) || Number.isFinite(value);

function groupRules(rules) {
  if (!Array.isArray(rules) || !rules.length) throw new Error("rules must be a non-empty array");
  const groups = new Map();
  for (const rule of rules) {
    if (
      !rule ||
      !validName(rule.prop) ||
      ("to_child" in rule ? (!["start", "end"].includes(rule.to_child) || "replace" in rule ||
        Boolean(rule.absent) !== ("value" in rule) || ("value" in rule && !isLiteral(rule.value))) :
        (!Array.isArray(rule.replace) || "value" in rule)) ||
      Object.keys(rule).some((key) => !["prop", "equals", "absent", "replace", "to_child", "value"].includes(key)) ||
      ("absent" in rule && typeof rule.absent !== "boolean") ||
      ("equals" in rule && (rule.absent || !isLiteral(rule.equals)))
    ) {
      throw new Error("Invalid prop rule: " + JSON.stringify(rule));
    }
    for (const out of rule.replace || []) {
      if (
        !out ||
        !validName(out.prop) ||
        Object.keys(out).some((key) => !["prop", "value"].includes(key)) ||
        ("value" in out ? !isLiteral(out.value) : rule.absent)
      ) {
        throw new Error("Invalid replacement for prop " + rule.prop);
      }
    }
    const group = groups.get(rule.prop) || [];
    if (
      group.some(
        (previous) =>
          Boolean(previous.absent) === Boolean(rule.absent) &&
          (!("equals" in previous) || !("equals" in rule) || Object.is(previous.equals, rule.equals)),
      )
    ) {
      throw new Error("Overlapping rules for " + rule.prop);
    }
    group.push(rule);
    groups.set(rule.prop, group);
  }
  return groups;
}

function literal(expr) {
  if (!expr) return true;
  if (ts.isParenthesizedExpression(expr)) return literal(expr.expression);
  if (ts.isStringLiteralLike(expr)) return expr.text;
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expr.operand)
  )
    return -Number(expr.operand.text);
  return unknown;
}

function literalText(value) {
  return Object.is(value, -0) ? "-0" : JSON.stringify(value);
}

function initializer(value) {
  if (typeof value === "string") {
    // An expression handles quotes, entities, and newlines without JSX decoding.
    return /^[^"&<>\r\n]+$/.test(value) ? '="' + value + '"' : "={" + JSON.stringify(value) + "}";
  }
  return "={" + literalText(value) + "}";
}

function mapConditional(prop, expr, rules) {
  // Both branches must produce the same attribute names. A rename or removal
  // in only one branch would require changing the surrounding element shape.
  function branch(node) {
    const value = literal(node);
    if (value === unknown) throw new Error("non-literal branch for " + prop);
    const rule = rules.find((r) => Object.is(r.equals, value));
    return rule
      ? rule.replace.map((out) => ({
          prop: out.prop,
          text: "value" in out ? literalText(out.value) : node.getText(),
        }))
      : [{ prop, text: node.getText() }];
  }
  const left = branch(expr.whenTrue),
    right = branch(expr.whenFalse);
  if (left.length !== right.length || left.some((out, i) => out.prop !== right[i].prop)) {
    throw new Error("conditional branches produce different props for " + prop);
  }
  if (!left.length && literal(expr.condition) === unknown) {
    throw new Error("removing " + prop + " would discard evaluation of its condition");
  }
  if (left.length > 1 && literal(expr.condition) === unknown) {
    throw new Error("splitting " + prop + " would evaluate its condition more than once");
  }
  return left.map((out, i) => {
    const tail = right[i];
    const body =
      expr.getSourceFile().text.slice(expr.getStart(), expr.whenTrue.getStart()) +
      out.text +
      expr.getSourceFile().text.slice(expr.whenTrue.end, expr.whenFalse.getStart()) +
      tail.text;
    return { prop: out.prop, suffix: "={" + body + "}" };
  });
}

function replacements(attr, prop, rules) {
  const absent = !attr;
  const applicable = rules.filter((rule) => Boolean(rule.absent) === absent);
  if (!applicable.length) return null;
  let rule = applicable.find((rule) => !("equals" in rule));
  if (!rule) {
    const init = attr.initializer;
    let expr = init && ts.isJsxExpression(init) ? init.expression : init;
    while (expr && ts.isParenthesizedExpression(expr)) expr = expr.expression;
    if (expr && ts.isConditionalExpression(expr)) {
      const branches = [expr.whenTrue, expr.whenFalse].map(branch => {
        const value = literal(branch);
        if (value === unknown) throw new Error("non-literal branch for " + prop);
        return applicable.find(r => Object.is(r.equals, value));
      });
      if (branches.some(r => r?.to_child)) {
        if (!branches[0]?.to_child || branches[0].to_child !== branches[1]?.to_child)
          throw new Error("conditional branches produce different child positions for " + prop);
        return { position: branches[0].to_child, child: childValue(attr, branches[0]) };
      }
      return mapConditional(prop, expr, applicable);
    }
    // JSX strings use JSX entity/linebreak decoding, which differs from a JS string.
    if (init && ts.isStringLiteral(init) && /[&\r\n]/.test(init.text)) {
      throw new Error("JSX string with entities or line breaks for " + prop);
    }
    const value = literal(expr);
    if (value === unknown || (init && !expr)) throw new Error("non-literal value for " + prop);
    rule = applicable.find((item) => Object.is(item.equals, value));
    if (!rule) return null;
  }
  if (rule.to_child) return { position: rule.to_child, child: childValue(attr, rule) };
  if (
    attr?.initializer &&
    ts.isJsxExpression(attr.initializer) &&
    literal(attr.initializer.expression) === unknown &&
    rule.replace.filter((out) => !("value" in out)).length > 1
  ) {
    throw new Error("splitting " + prop + " would evaluate its expression more than once");
  }
  if (
    attr?.initializer &&
    !rule.replace.some((out) => !("value" in out)) &&
    ts.isJsxExpression(attr.initializer)
  ) {
    const expr = attr.initializer.expression;
    if (literal(expr) === unknown && !discardableJsx(expr)) {
      throw new Error("replacing " + prop + " would discard evaluation of its expression");
    }
  }
  return rule.replace.map((out) => ({
    prop: out.prop,
    suffix:
      "value" in out ? initializer(out.value) : attr.getSourceFile().text.slice(attr.name.end, attr.end),
  }));
}

function discardableJsx(expr) {
  if (!ts.isJsxElement(expr) && !ts.isJsxSelfClosingElement(expr) && !ts.isJsxFragment(expr)) return false;
  let safe = true;
  walk(expr, (node) => {
    if (ts.isJsxSpreadAttribute(node) || (ts.isJsxExpression(node) && literal(node.expression) === unknown))
      safe = false;
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && !ts.isIdentifier(node.tagName))
      safe = false;
  });
  return safe;
}

function hasJsx(node) {
  if (!node) return false;
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return true;
  return ts.forEachChild(node, hasJsx) || false;
}

function planElement(element, groups, edits, discarded, childPlans) {
  const attrs = element.attributes.properties;
  const byName = new Map();
  for (const attr of attrs) {
    if (ts.isJsxSpreadAttribute(attr))
      throw new Error("spread attribute may supply a matched or replacement prop");
    const name = attr.name.getText();
    if (byName.has(name)) throw new Error("duplicate prop " + name);
    byName.set(name, attr);
  }
  const planned = [];
  const children = [];
  const introduced = new Set();
  for (const [prop, rules] of groups) {
    const attr = byName.get(prop);
    const outputs = replacements(attr, prop, rules);
    if (!outputs) continue;
    if (outputs.position) {
      children.push({ attr, ...outputs });
      continue;
    }
    for (const out of outputs) {
      if ((out.prop !== prop && byName.has(out.prop)) || introduced.has(out.prop)) {
        throw new Error("replacement prop already exists: " + out.prop);
      }
      introduced.add(out.prop);
    }
    const text = outputs.map((out) => out.prop + out.suffix).join(" ");
    if (text !== (attr?.getText() || "")) {
      const nameOnly =
        attr &&
        outputs.length === 1 &&
        outputs[0].suffix === attr.getSourceFile().text.slice(attr.name.end, attr.end);
      const nested = !nameOnly && hasJsx(attr?.initializer);
      if (
        nested &&
        outputs.some((out) => out.suffix === attr.getSourceFile().text.slice(attr.name.end, attr.end))
      ) {
        throw new Error("splitting an attribute with nested JSX requires manual work");
      }
      planned.push(nameOnly ? { attr: attr.name, text: outputs[0].prop } : { attr, text, nested });
    }
  }
  if (children.length) {
    if (byName.has("children") || introduced.has("children")) throw new Error("explicit children prop already exists");
    childPlans.push(planChildren(element, children, edits));
  }
  const added = [];
  for (const { attr, text, nested } of planned) {
    if (nested) discarded.add(attr);
    if (!attr) added.push(text);
    else if (!text) {
      const trivia = attr.getSourceFile().text.slice(attr.pos, attr.getStart());
      edits.add(attr.getSourceFile(), trivia.trim() ? attr.getStart() : attr.pos, attr.end, "");
    } else edits.replace(attr, text);
  }
  if (added.length) {
    const at = attrs.length
      ? attrs[attrs.length - 1].end
      : element.typeArguments?.end !== undefined
        ? element.getChildren().find((node) => node.kind === ts.SyntaxKind.GreaterThanToken).end
        : element.tagName.end;
    edits.add(element.getSourceFile(), at, at, " " + added.join(" "));
  }
  return planned.length > 0 || children.length > 0;
}

function isBindingName(id) {
  let n = id;
  while (n && (ts.isPropertyAccessExpression(n.parent) || ts.isQualifiedName(n.parent))) n = n.parent;
  if (
    (ts.isJsxOpeningElement(n.parent) ||
      ts.isJsxSelfClosingElement(n.parent) ||
      ts.isJsxClosingElement(n.parent)) &&
    n.parent.tagName === n &&
    (n === id || n.name === id)
  )
    return true;
  const parent = id.parent;
  return (
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isNamespaceExport(parent) ||
    (parent.name === id &&
      (ts.isFunctionDeclaration(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isVariableDeclaration(parent) ||
        ts.isBindingElement(parent)))
  );
}

function componentScope(session, args) {
  const selected = session.path(args.module);
  let files = potentialConsumers(session, [selected]);
  const project = scopedProject(session, files);
  function bind() {
    const checker = project.getTypeChecker().compilerObject;
    const source = project.getSourceFileOrThrow(selected).compilerNode;
    const symbol = getExports(checker, source).get(args.exportName);
    if (!symbol?.runtime || !symbol.target?.declarations?.length)
      throw new Error("Cannot resolve component export " + args.exportName + " in " + args.module);
    return { checker, project, component: symbol.target, files };
  }
  let scope = bind();
  // A caller can select a barrel's alias. A consumer of the original declaration
  // (or a different barrel) need not import the selected module.
  const origins = scope.component.declarations.map(decl => decl.getSourceFile().fileName);
  if (origins.some(file => !files.has(file))) {
    const expanded = potentialConsumers(session, [selected, ...origins]);
    addScopeRoots(project, session, [...expanded].filter(file => !files.has(file)));
    files = expanded;
    scope = bind();
  }
  return scope;
}

function rewriteProps(session, args) {
  const groups = groupRules(args.rules);
  const { checker, project, component, files } = componentScope(session, args);
  const checkScopes = scriptScopeCheck(session, project);
  const manual = [];
  const edits = new TextEdits();
  let matched = 0,
    rewritten = 0;
  function report(node, reason) {
    const source = node.getSourceFile();
    manual.push({
      file: path.relative(session.root, source.fileName),
      line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      reason,
    });
  }
  const childPlans = [];
  const discarded = new WeakSet();
  const unresolved = new WeakSet();
  for (const file of files) {
    if (!session.paths.has(file)) continue;
    walk(project.getSourceFileOrThrow(file).compilerNode, (node) => {
      if (discarded.has(node)) return false;
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        if (targetSymbol(checker, checker.getSymbolAtLocation(node.tagName)) !== component) return;
        matched++;
        try {
          for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
            if (unresolved.has(ancestor)) throw new Error("inside an attribute left for manual work");
          }
          if (planElement(node, groups, edits, discarded, childPlans)) rewritten++;
        } catch (error) {
          unresolved.add(node.attributes);
          report(node, error.message);
        }
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const key = node.propertyName || node.name;
        if (ts.isIdentifier(key) || ts.isStringLiteral(key)) {
          const sym = checker.getTypeAtLocation(node.parent).getProperty(key.text);
          if (targetSymbol(checker, sym) === component) report(node, "component reference in destructuring");
        }
      } else if (ts.isStringLiteralLike(node) && ts.isElementAccessExpression(node.parent)) {
        if (targetSymbol(checker, checker.getSymbolAtLocation(node)) === component)
          report(node, "component reference outside JSX tag");
      } else if (ts.isIdentifier(node) && !isBindingName(node) && !ts.isBindingElement(node.parent)) {
        const sym = ts.isShorthandPropertyAssignment(node.parent)
          ? checker.getShorthandAssignmentValueSymbol(node.parent)
          : checker.getSymbolAtLocation(node);
        if (targetSymbol(checker, sym) === component) report(node, "component reference outside JSX tag");
      }
    });
  }
  if (args.failOnManual && manual.length) {
    throw new Error(
      "Prop rewrite requires manual work: " +
        manual.map((site) => site.file + ":" + site.line + " " + site.reason).join("; "),
    );
  }
  for (const plan of childPlans.reverse()) plan();
  edits.apply(session.project);
  if (checkScopes) checkScopes();
  return { matched, rewritten, left_for_manual: manual.length, manual };
}

module.exports = { rewriteProps };
