const { formatPatch, structuredPatch } = require("diff");
const { isUtf8 } = require("node:buffer");

const TRUNCATED = "\n[diff truncated]\n";

function binary(bytes) {
  return bytes && (bytes.includes(0) || !isUtf8(bytes));
}

function report(session, entries, args) {
  const stats = [];
  const limit = args.diffLimit ?? 32768;
  if (!Number.isSafeInteger(limit) || limit < Buffer.byteLength(TRUNCATED)) {
    throw new Error(`diff_limit must be an integer of at least ${Buffer.byteLength(TRUNCATED)} bytes`);
  }
  let output = "",
    used = 0,
    truncated = false;
  for (const { path, before, after } of entries) {
    const file = session.rel(path);
    const a = before ? "a/" + file : "/dev/null";
    const b = after ? "b/" + file : "/dev/null";
    let added = 0,
      removed = 0,
      patch = "";
    const include = args.diff === true && !truncated;
    if (binary(before) || binary(after)) {
      stats.push({ path: file, added, removed, binary: true });
      if (include) patch = `Binary files ${a} and ${b} differ\n`;
    } else {
      const hunks = structuredPatch(a, b, before?.toString() || "", after?.toString() || "", "", "");
      for (const hunk of hunks.hunks) {
        for (const line of hunk.lines) {
          if (line[0] === "+") added++;
          if (line[0] === "-") removed++;
        }
      }
      stats.push({ path: file, added, removed });
      if (include) patch = formatPatch(hunks);
    }
    if (include) {
      const bytes = Buffer.from(patch);
      const remaining = limit - used;
      if (bytes.length <= remaining) {
        output += patch;
        used += bytes.length;
      } else {
        const prefix = Buffer.concat([Buffer.from(output), bytes.subarray(0, remaining)]).subarray(
          0,
          limit - Buffer.byteLength(TRUNCATED),
        );
        let end = prefix.length;
        while (end && !isUtf8(prefix.subarray(0, end))) end--;
        output = prefix.subarray(0, end).toString() + TRUNCATED;
        truncated = true;
      }
    }
  }
  return args.diff === true ? { stats, diff: output, diff_truncated: truncated } : { stats };
}

module.exports = { report };
