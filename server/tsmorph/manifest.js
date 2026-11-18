// Edit the smallest possible range of a JSON manifest, retaining unrelated whitespace and key order.
const path = require("path");
const { ts } = require("ts-morph");

const indentAt = (text, pos) => text.slice(text.lastIndexOf("\n", pos - 1) + 1, pos).match(/^[ \t]*/)[0];
const sortedMaps = new Set(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies",
  "peerDependenciesMeta", "exports"]);

function edit(pkg, keys, value) {
  if (!pkg.filename) throw new Error(`Missing package.json for ${pkg.dir}`);
  const text = pkg.text;
  const doc = ts.parseJsonText(pkg.filename, text);
  let object = doc.statements[0]?.expression;
  let start, end, insert, parent;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    if (!ts.isObjectLiteralExpression(object))
      throw new Error(`Expected an object at ${keys.slice(0, index).join(".")} in ${pkg.filename}`);
    const fields = object.properties;
    const matches = fields.filter((field) => field.name.text === key);
    if (matches.length > 1) throw new Error(`Duplicate key ${key} in ${pkg.filename}`);
    const field = matches[0];
    if (field && index < keys.length - 1) {
      parent = object;
      object = field.initializer;
      continue;
    }
    const nl = text.includes("\r\n") ? "\r\n" : "\n";
    const objStart = object.getStart(doc),
      objEnd = object.end;
    const parentIndent = indentAt(text, objStart);
    const step = text.match(/\n([\t ]+)"/)?.[1] || "  ";
    // Honor each existing container's layout, including a compact object in
    // an otherwise multi-line manifest.
    const multiline =
      text.slice(objStart, objEnd).includes("\n") ||
      (!fields.length &&
        parent &&
        ts.isObjectLiteralExpression(parent) &&
        text.slice(parent.getStart(doc), parent.end).includes("\n"));
    const fieldIndent =
      fields.length && multiline ? indentAt(text, fields[0].getStart(doc)) : parentIndent + step;
    const sample = fields.length ? object : parent;
    const first = sample?.properties[0];
    const colon = first ? text.slice(first.name.end, first.initializer.getStart(doc)) : ": ";
    const opening = first && !multiline ? text.slice(sample.getStart(doc) + 1, first.getStart(doc)) : "";
    const closing = first && !multiline ? text.slice(sample.properties.at(-1).end, sample.end - 1) : "";
    function render(item, level) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const entries = Object.entries(item);
        if (!entries.length) return "{}";
        const next = level + step;
        return (
          "{" +
          entries
            .map(
              ([name, child], i) =>
                (i ? "," : "") +
                (multiline ? nl + next : opening) +
                JSON.stringify(name) +
                colon +
                render(child, next),
            )
            .join("") +
          (multiline ? nl + level : closing) +
          "}"
        );
      }
      return JSON.stringify(item);
    }
    if (field && value === undefined) {
      const i = fields.indexOf(field);
      if (fields.length === 1) {
        start = objStart + 1;
        end = objEnd - 1;
      } else if (i < fields.length - 1) {
        start = field.getStart(doc);
        end = fields[i + 1].getStart(doc);
      } else {
        start = fields[i - 1].end;
        end = field.end;
      }
      insert = "";
    } else if (field) {
      start = field.initializer.getStart(doc);
      end = field.initializer.end;
      insert = render(value, fieldIndent);
    } else {
      if (value === undefined) return;
      const nested = keys.slice(index + 1).reduceRight((inner, name) => ({ [name]: inner }), value);
      const property = JSON.stringify(key) + colon + render(nested, fieldIndent);
      if (fields.length) {
        let gap = text.slice(objStart + 1, fields[0].getStart(doc));
        if (multiline) gap = nl + fieldIndent;
        else if (fields.length > 1)
          gap = text.slice(fields[0].end, fields[1].getStart(doc)).split(",").at(-1);
        const sorted = index === 1 && sortedMaps.has(keys[0]) &&
          fields.every((item, i) => !i || fields[i - 1].name.text <= item.name.text);
        const following = sorted && fields.find(item => item.name.text > key);
        if (following) {
          start = end = following.getStart(doc);
          insert = property + "," + gap;
        } else {
          start = end = fields[fields.length - 1].end;
          insert = "," + gap + property;
        }
      } else {
        start = objStart + 1;
        end = objEnd - 1;
        insert = multiline ? nl + fieldIndent + property + nl + parentIndent : opening + property + closing;
      }
    }
    break;
  }
  pkg.text = text.slice(0, start) + insert + text.slice(end);
  pkg.data = JSON.parse(pkg.text);
}

const relativeFile = (pkg, file) => "./" + path.relative(pkg.dir, file).split(path.sep).join("/");

function inferExport(pkg, target) {
  const relative = relativeFile(pkg, target);
  const rules = new Map();
  for (const [key, value] of Object.entries(pkg.data.exports || {})) {
    if (key === ".") continue;
    if (!key.startsWith("./") || typeof value !== "string" || key.includes("*") || value.includes("*")) {
      throw new Error(`Cannot infer export pattern for ${pkg.data.name}; provide exportAs`);
    }
    const source = value.slice(2).split("/");
    const publicPath = key.slice(2).split("/");
    const ext = source.at(-1).match(/\.[^.]+$/)?.[0] || "";
    // A typical row is "./button": "./src/components/button.tsx".
    // Require a shared filename; a bespoke public alias provides no pattern.
    const omitExt = Boolean(ext && publicPath.at(-1) === source.at(-1).slice(0, -ext.length));
    if (omitExt) source[source.length - 1] = source.at(-1).slice(0, -ext.length);
    if (source.at(-1) !== publicPath.at(-1))
      throw new Error(`Cannot infer export pattern for ${pkg.data.name}; provide exportAs`);
    while (source.length && publicPath.length && source.at(-1) === publicPath.at(-1)) {
      source.pop();
      publicPath.pop();
    }
    const rule = {
      source: [".", ...source].join("/") + "/",
      output: [".", ...publicPath].join("/") + "/",
      omitExt,
    };
    rules.set(JSON.stringify(rule), rule);
  }
  const [rule] = rules.values();
  if (rules.size !== 1 || !relative.startsWith(rule.source)) {
    throw new Error(`Cannot infer a consistent export pattern for ${pkg.data.name}; provide exportAs`);
  }
  const tail = relative.slice(rule.source.length);
  return rule.output + (rule.omitExt ? tail.replace(/\.[^.\/]+$/, "") : tail);
}

module.exports = { edit, inferExport, relativeFile };
