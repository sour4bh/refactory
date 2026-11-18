const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const WRITE_LOCK = ".refactory-write.lock";
const CODE = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const { canonical, reserved, conventional } = require("./source-paths");

function isCode(file) {
  return CODE.has(path.extname(file));
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

function guarded(root, file, workspace) {
  if (!inside(root, file)) throw new Error(`Path '${file}' escapes project root`);
  const reason = workspace?.skipReason(file);
  if (reason) throw new Error(`Cannot edit ${file}: ${reason}`);
  let current = root;
  for (const part of path.relative(root, file).split(path.sep)) {
    if (reserved.has(canonical(part)) || (!workspace && conventional.has(canonical(part)))) throw new Error(`Path in skipped directory: ${file}`);
    current = path.join(current, part);
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Refused symlink path: ${current}`);
    }
  }
  return file;
}

function inventory(root, workspace, linkedTargets, warnings = workspace.warnings) {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (reserved.has(canonical(entry.name))) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (workspace.memberAncestors.has(file) || !workspace.skipReason(file, true)) walk(file);
      }
      else if (workspace.includes(file)) {
        if (entry.isFile()) files.push(file);
        else if (entry.isSymbolicLink()) {
          warnings.push(`Skipped symlink: ${file}`);
          if (fs.existsSync(file)) {
            const target = fs.realpathSync(file);
            if (inside(root, target)) linkedTargets.set(target, file);
          }
        }
      }
    }
  }
  walk(root);
  return files;
}

// Each entry has its before/after bytes (null for an absent file). Keep original
// siblings until all renames succeed, preserving permissions and binary contents.
function install(session, entries, warnings) {
  const temps = [],
    backups = [],
    installed = [],
    directories = new Set();
  function mkdir(dir) {
    if (fs.existsSync(dir)) return;
    mkdir(path.dirname(dir));
    fs.mkdirSync(dir);
    directories.add(dir);
  }
  try {
    for (const entry of entries) {
      guarded(session.root, entry.path, session.workspace);
      const actual = fs.existsSync(entry.path) ? fs.readFileSync(entry.path) : null;
      if (actual === null ? entry.before !== null : !entry.before?.equals(actual)) {
        throw new Error(`File changed during planning: ${entry.path}`);
      }
      if (entry.after === null) continue;
      mkdir(path.dirname(entry.path));
      const temp = entry.path + "." + randomUUID() + ".refactory-tmp";
      temps.push({ target: entry.path, temp });
      const mode = entry.mode ?? fs.statSync(entry.path, { throwIfNoEntry: false })?.mode;
      fs.writeFileSync(temp, entry.after, { flag: "wx", mode });
      if (mode !== undefined) fs.chmodSync(temp, mode);
    }
    for (const entry of entries) {
      if (entry.before === null) continue;
      const backup = entry.path + "." + randomUUID() + ".refactory-backup";
      fs.renameSync(entry.path, backup);
      backups.push({ target: entry.path, backup });
    }
    for (const { target, temp } of temps) {
      fs.renameSync(temp, target);
      installed.push(target);
    }
  } catch (error) {
    const failures = [];
    for (const target of installed.reverse()) {
      try {
        fs.unlinkSync(target);
      } catch {
        failures.push(target);
      }
    }
    for (const { target, backup } of backups.reverse()) {
      try {
        fs.renameSync(backup, target);
      } catch {
        failures.push(backup);
      }
    }
    for (const { temp } of temps) {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        failures.push(temp);
      }
    }
    for (const dir of [...directories].reverse()) {
      try {
        fs.rmdirSync(dir);
      } catch {
        failures.push(dir);
      }
    }
    if (failures.length) throw new Error(`Rollback failed for ${failures.join(", ")}: ${error.message}`);
    throw new Error(`Refused without changing any file: ${error.message}`);
  }
  for (const { backup } of backups) {
    try {
      fs.unlinkSync(backup);
    } catch (error) {
      warnings.push(`Changes committed. Could not remove backup ${backup}: ${error.message}`);
    }
  }
}

function commit(session, entries) {
  const lock = path.join(session.root, WRITE_LOCK);
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Concurrent or interrupted workspace commit at ${lock}`);
    throw new Error(`Refused without changing any file: ${error.message}`);
  }
  let failure;
  try {
    session.verifySnapshot();
    install(session, entries, session.warnings);
  } catch (error) {
    failure = error;
  }
  try {
    fs.rmdirSync(lock);
  } catch (error) {
    const message = `Could not release write lock ${lock}: ${error.message}`;
    if (failure) failure.message += ". " + message;
    else session.warnings.push("Changes committed. " + message);
  }
  if (failure) throw failure;
}

module.exports = { isCode, inside, guarded, inventory, commit };
