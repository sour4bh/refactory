#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { scriptScopeCheck } = require("./script-scopes");
const { Session } = require("./session");
const { ComputedImports } = require("./computed-imports");
const { commit, guarded } = require("./files");
const { moveModule, deleteModule, checkDeletions, moveDependencyPolicy } = require("./moves");
const { moveSymbol, renameSymbol } = require("./symbols");

const { replaceModule } = require("./replace");
const { rewriteProps } = require("./props");

const operations = {
  move_module: moveModule,
  delete_module: deleteModule,
  move_symbol: moveSymbol,
  rename_symbol: renameSymbol,
  replace_module: replaceModule,
  rewrite_props: rewriteProps,
};
const fields = {
  project_root: "projectRoot",
  source_file: "sourceFile",
  target_file: "targetFile",
  symbol_name: "symbolName",
  old_name: "oldName",
  new_name: "newName",
  export_as: "exportAs",
  fail_on_new_errors: "failOnNewErrors",
  rename_local: "renameLocal",
  export_name: "exportName",
  fail_on_manual: "failOnManual",
  diff_limit: "diffLimit",
  payload_file: "payloadFile",
  external_computed_files: "externalComputedFiles",
};

function normalize(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected a JSON object");
  const result = Object.create(null);
  for (const [key, value] of Object.entries(raw)) {
    const field = Object.hasOwn(fields, key) ? fields[key] : key;
    if (Object.hasOwn(result, field)) throw new Error("Duplicate field: " + key);
    result[field] = value;
  }
  return result;
}

function payload(arg) {
  let json;
  if (arg === "-") json = fs.readFileSync(0, "utf8");
  else if (arg?.startsWith("@")) json = fs.readFileSync(arg.slice(1), "utf8");
  else json = arg;
  const opts = normalize(JSON.parse(json));
  if (!opts.payloadFile) return opts;
  if (!opts.projectRoot || !path.isAbsolute(opts.projectRoot))
    throw new Error("payload_file needs an absolute project_root");
  const root = fs.realpathSync(opts.projectRoot);
  const file = guarded(root, path.resolve(root, opts.payloadFile));
  const data = normalize(JSON.parse(fs.readFileSync(file, "utf8")));
  return { ...data, ...opts, projectRoot: root, apply: opts.apply === true, dryRun: opts.apply !== true };
}

function newDiagnostics(session, initial, final) {
  const counts = new Map();
  const key = (file, e) => JSON.stringify([file, e.code, e.error]);
  for (const error of initial) {
    const id = key(path.join(session.root, error.file), error);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return final.filter((error) => {
    const id = key(session.origins.get(path.join(session.root, error.file)), error);
    const count = counts.get(id) || 0;
    if (!count) return true;
    counts.set(id, count - 1);
    return false;
  });
}

async function run(operation, args) {
  const session = new Session(args.projectRoot);
  const computed = new ComputedImports(session, args.externalComputedFiles);
  if (operation === "validate_imports") {
    computed.check(false);
    return { errors: await session.diagnostics(), warnings: session.warnings, ...computed.report() };
  }
  const batch = operation === "batch";
  const steps = batch ? args.operations : [{ ...args, operation }];
  if (!Array.isArray(steps)) throw new Error("batch requires an operations array");
  if (batch) session.startBatch(steps);
  computed.check();
  if (!steps.length && computed.refusal()) throw new Error(computed.refusal());
  const initial = args.failOnNewErrors === true ? await session.diagnostics(false) : null;
  const summaries = [];
  let index = 0,
    entries;
  try {
    for (const raw of steps) {
      const step = normalize(raw);
      if (!Object.hasOwn(operations, step.operation)) throw new Error("Unknown operation: " + step.operation);
      if (batch && ["projectRoot", "apply", "dryRun", "payloadFile"].some((key) => key in step)) {
        throw new Error("Set project_root, apply and payload_file on the outer batch");
      }
      if (batch && "externalComputedFiles" in step)
        throw new Error("Set external_computed_files on the outer batch");
      if (batch && "failOnNewErrors" in step)
        throw new Error("Set fail_on_new_errors on the outer batch to check the final state");
      session.operationIndex = index;
      const semantic = step.operation !== "move_module" && step.operation !== "delete_module";
      if (semantic) session.assertBuiltSymbolScope(step);
      const checkScopes = ["rename_symbol", "move_symbol"].includes(step.operation) && scriptScopeCheck(session);
      const movePolicy = step.operation === "move_module" ? moveDependencyPolicy(session, step) : undefined;
      const result = await operations[step.operation](session, step);
      if (checkScopes) checkScopes();
      session.finishOperation(semantic, movePolicy);
      computed.check();
      if (result.warnings) session.warnings.push(...result.warnings);
      summaries.push({ operation: step.operation, ...result });
      index++;
    }
    checkDeletions(session);
    if (batch) session.finishBatch();
    if (computed.refusal()) {
      const error = new Error(computed.refusal());
      error.index = computed.firstMissingStep ?? 0;
      throw error;
    }
    if (initial) {
      const extra = newDiagnostics(session, initial, await session.diagnostics());
      if (extra.length) {
        const first = extra[0];
        const file = path.resolve(session.root, first.file);
        const source = session.project.getSourceFile(file);
        const related = (session.index.byFile.get(file) || []).filter(
          (ref) => source?.getLineAndColumnAtPos(ref.start).line === first.line,
        );
        const error = new Error("New import errors: " + JSON.stringify(extra));
        error.index =
          session.editedBy.get(file) ??
          related.map((ref) => session.editedBy.get(ref.to)).find((i) => i !== undefined);
        throw error;
      }
    }
    entries = session.plan();
  } catch (error) {
    const missing = computed.refusal(error.computedSites);
    if (missing && error.message !== missing) error.message += "\n" + missing;
    if (!batch) throw error;
    const at = error.index ?? Math.min(index, steps.length - 1);
    throw new Error(
      `batch[${at}] ${steps[at]?.operation || ""}${index === steps.length ? " (final check)" : ""}: ${error.message}`,
    );
  }
  const dryRun = Object.hasOwn(args, "apply") ? args.apply !== true : args.dryRun !== false;
  const install = session.workspace.dependencies.warning();
  if (install) session.warnings.push(install);
  const details = require("./report").report(session, entries, args);
  if (!dryRun && entries.length) {
    // The wrapper can terminate planning on its deadline. Once a synchronous
    // commit starts, let it finish (or roll back) and return the actual result.
    process.on("SIGTERM", () => {});
    commit(session, entries);
  }
  const result = batch ? { operations: summaries } : summaries[0];
  return {
    ...result,
    ...details,
    ...computed.report(),
    success: true,
    dry_run: dryRun,
    changes_count: entries.length,
    affected_files: entries.map((e) => session.rel(e.path)),
    warnings: [...new Set(session.warnings)],
  };
}

async function main() {
  const [operation, arg] = process.argv.slice(2);
  console.log(JSON.stringify(await run(operation, payload(arg))));
}

main().catch(error => {
  console.error(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
});
