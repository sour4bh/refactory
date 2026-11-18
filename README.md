# refactory

> Codebase refactoring as MCP tools. Move modules, rename symbols, validate imports — across languages, preview-first.

```bash
claude --plugin-dir ~/dev/refactory
```

Instead of manually hunting down every import after moving a file, Claude calls `move_module` and gets it done in one tool call.

---

## What it does

| Tool | Languages | Operation |
|------|-----------|-----------|
| `move_module` | Python, TypeScript | Move a file, update importers, optionally `overwrite` its target. |
| `move_symbol` | Python, TypeScript | Extract a top-level declaration to another module. |
| `rename_symbol` | Python, TypeScript | Rename a binding. Use `line` and `column` for parameters or `Type.member` for TypeScript members. |
| `validate_imports` | Python, TypeScript | Find unresolved imports, broken package subpaths and missing exported names. |
| `delete_module` | TypeScript | Delete `source` and its exports once all importers have been removed. |
| `replace_module` | TypeScript | Redirect a file or public package specifier to one target, or split named bindings across targets. |
| `rewrite_props` | TypeScript | Apply JSX attribute `rules` to a component identified by `module` and `export_name`. |
| `batch` | TypeScript | Plan ordered `operations` in memory and commit them together. |

Python-only tools:

| Tool | Description |
|------|-------------|
| `organize_imports` | Organize imports in a Python module using Rope |
| `extract_variable` | Extract a selected Python expression into a variable |
| `extract_function` | Extract selected Python statements into a function |
| `inline_symbol` | Inline a selected Python local variable, parameter, or function |

Mutating tools preview by default. Claude must pass `apply: true` to write files. Python previews use Rope's native change descriptions instead of copying the whole repo to a temporary project.

---

## Why MCP tools instead of manual edits

When you ask Claude to move `src/utils.py` to `src/core/utils.py` without tooling, it:
1. Reads dozens of files to find imports
2. Edits each one manually, spending tokens on boilerplate
3. Can miss dynamic imports, re-exports, or barrel files

With refactory, Claude calls one tool:
```
move_module("src/utils.py", "src/core/utils.py")
→ { success: true, affected_files: ["src/api.py", "src/db.py", "tests/test_utils.py", ...] }
```

For a TypeScript migration, pass related edits to one ordered `batch` call.

---

## Languages

**Python** — via [Rope](https://rope.readthedocs.io/)
- AST-based symbol location (handles decorators, nested classes)
- Automatic `__init__.py` creation in target directories
- Circular import detection before `move_symbol`
- Rope's refactoring engines rewrite relative and absolute imports

**TypeScript** — via [ts-morph](https://ts-morph.com/)
- Respects `tsconfig.json` path aliases
- Updates ES6 and CommonJS imports
- Handles barrel files and re-exports
- Monorepo-aware

Language is detected from file extension. Both backends validate that resolved paths stay within the project root.

---

## Installation

```bash
claude --plugin-dir ~/dev/refactory
```

Dependencies (rope, ts-morph) are auto-installed on first session start via the `SessionStart` hook.

Manual install if needed:

```bash
pip install rope mcp
cd server/tsmorph && pnpm install
```

---

## Usage

Each MCP call takes an absolute `project_root`. Paths in the request are relative to that directory. In a declared TypeScript workspace, the root or a member directory selects the whole workspace. Use the workspace root for plans spanning packages. Result paths are relative to the workspace root.

A saved `migration.json` can contain the following batch. Here the old button has already had its importers redirected or removed.

```json
{
  "operations": [
    {"operation": "delete_module", "source": "packages/ui/src/button.tsx"},
    {
      "operation": "move_module",
      "source": "packages/controls/src/button-compact.tsx",
      "target": "packages/ui/src/button.tsx",
      "export_as": "./button",
      "companions": "auto"
    }
  ],
  "fail_on_new_errors": true
}
```

Preview it through MCP using `batch({"project_root":"/workspace","payload_file":"migration.json","diff":true})`. Review `operations`, `affected_files`, per-file `stats` and `warnings`. Send the same request with `apply: true` to write. Only the outer MCP request can authorize writes. Pass `diff_limit` in bytes to bound the combined unified diff (default 32,768; minimum 18). A truncation marker identifies omitted content. Binary rows carry `binary: true` and zero line counts.

The Node CLI accepts the same snake_case fields. Legacy camelCase fields and `dryRun` also work. Pass a JSON argument, `-` for stdin, or `@file` for a complete request containing `project_root`.

```sh
node server/tsmorph/refactor.js batch '{"project_root":"/workspace","payload_file":"migration.json","diff":true}'
node server/tsmorph/refactor.js move_module @request.json
```

### Workspace files

- `move_module` and `delete_module` accept code or an asset. Set `companions` to explicit asset paths or `"auto"` to include exclusive local assets. Moved companions retain their basenames.
- For a cross-package move, choose the public subpath with `export_as`, or let the engine infer it from consistent existing exports. Importers use the destination package name and public subpath. If the moved code needs a private module left behind, export it or revise the move.
- In a workspace with members, the target of `move_module` must be in a member. A target below the root but outside every member refuses, so that the root manifest does not get export or dependency rows. Create the member's `package.json` and include it in the workspace first. A move between two directories of the root package, and a repository with only a root package, keep their present behavior.
- A cross-package move copies external npm dependencies into the destination manifest using the source's range and section (`dependencies`, `peerDependencies` or `optionalDependencies`). It keeps an existing destination declaration. For a missing, dev-only, conflicting or location-dependent range, declare the intended dependency first. Existing sorted dependency and export maps keep their lexical key order.
- If a plan adds dependencies, one warning lists the manifests that require a package install before type checking. With `fail_on_new_errors`, preview and apply check the same staged files and manifests. An installed declaration from the source package can stand in for a destination link pending installation.
- A batch checks package boundaries against its final state. A step can leave a temporary import of a private module or of a module in transit. The final check rewrites that import to the spelling the final state needs, or refuses with the step that added it. An import between two files that end in one member stays relative (or keeps its alias), as a move of both files together would write it. A package that a file only passes through, without `export_as`, gets no export row.
- Dependency rows of a batch follow its final state. The batch writes a workspace dependency only for an import that the final state has. A row for an npm package that a moved file carried into a package is removed when that file leaves the package again in the same batch. The warning "no longer imports ...; dependency retained" applies only to a row that the manifest had before the batch. Cycle warnings, and the refusal of a cycle through a redirected public re-export, use the final package graph. For example, if an app follows a module from package A to B to C, the app's manifest gets only the row for C.
- `replace_module` accepts a destination file or bare specifier. Use `names: {"TextField":"Input"}` to switch imported exports. Local bindings keep their names by default. `rename_local: true` also renames matching references.
- `delete_module` checks surviving consumers at the end of the batch. A group that only references itself can be deleted together.
- Moves track literal module references in JSDoc, including `@import` and `import("./types").Name`. A symbol move that would split file-scoped JSDoc imports or leave a JSDoc consumer behind refuses and names the file.

### Built packages and runtime loaders

For a conditional package export, the resolver reads the importing file's module settings and prefers applicable `types` branches. It can read declarations from `dist`. If a declared build output is absent, `validate_imports` warns once for that package. A missing public subpath is still an error. A file moving across packages keeps its public import of a built dependency when it resolves to the same entry. Its new package acquires that dependency using the source package's workspace range when available.

Move an implementation out of a built package with `move_module` and `export_as`. The source barrel's re-export follows it. The old package acquires the dependency, so its consumers can keep their imports. A new cycle caused by redirecting a public re-export refuses the move. Moving an entry source that may back a generated public row requires an explicit edit to the build entry and manifest.

Source and generated declarations have separate checker identities. Symbol and JSX operations refuse when the selected file feeds a recognized built entry with public consumers. Redirect those consumers by package specifier first.

To migrate the barrel's consumers, select its exact public specifier as `source` and route each imported name:

```json
{
  "operation": "replace_module",
  "source": "@acme/effects",
  "names": {
    "Fade": {"target": "@acme/motion/fade"},
    "FadeProps": {"target": "@acme/motion/fade"},
    "Slide": {"target": "@acme/motion/slide", "name": "Ticker"}
  }
}
```

Static imports and named re-exports split by target. Existing local aliases and type-only bindings are preserved. Unmapped names and whole-module uses that cannot be split produce a refusal with the importer. Migrate any consumer module augmentations explicitly before redirecting the entry. The single-`target` form still supports namespace, dynamic and CommonJS consumers.

A relative computed loader is bounded by the last complete directory in its static prefix. For example, `new URL("../dist/" + entry, import.meta.url)` reaches files below `../dist/`. A prefix that a tsconfig `paths` alias or `baseUrl` maps is bounded by every directory that the mapping can reach: with `"~/*": ["./src/*"]`, `import("~/data/" + name)` reaches files below `src/data/`, and a package prefix also reaches that package. Moving or deleting an unrelated source can proceed. A finite set of literal choices is checked individually, including directory descendants. The engine recognizes conditionals, `||`, `??`, `concat` and local literal arrays used in a loop, a map callback or an indexed read. If a literal suffix can traverse above that directory, the operation can refuse.

A dynamic import of the `.href` or `.pathname` of `new URL("<static path>", import.meta.url)`, or of `fileURLToPath(...)` of that URL from `node:url`, names the file of the static path. This also applies through `const` bindings, for example `const FIXTURE = new URL("../fixtures/data.ts", import.meta.url).href; await import(FIXTURE)`. Only a move or a delete of that file is affected, and a move updates the string. The engine does not follow a shadowed `URL` or `fileURLToPath`, or a URL object that the file changes.

Every other computed `import()`, `require()` or `new URL(..., import.meta.url)` expression that the engine cannot bound refuses each mutation, and the refusal lists its locations. If the named files only load external artifacts, pass their workspace-relative paths or globs in `external_computed_files`, for example `["apps/site/src/load-artifact.ts"]`. Set it on the outer request for a batch. Preview and apply list each accepted file, line and expression in `accepted_computed_imports`. An acknowledgment covers only the values that the engine cannot see. The literal choices and directory prefixes that the expression also has are still checked, so static overlap still requires a manual edit. The engine also lists the values that the file itself writes into a binding that the loader reads: plain and logical assignments (`=`, `||=`, `&&=`, `??=`) of a `let` or a parameter, and `push`, `unshift`, `splice`, `fill` or an indexed assignment on an array or on a `const` alias of it. If the file changes such a binding in another way, for example with `+=`, or passes the array to a function, the engine cannot list all of its paths. Such a loader needs an acknowledgment, as every other loader that the engine cannot bound does, and the refusal says that the file changes or passes on the value that the expression reads. With the acknowledgment, the values that the engine can list stay checked: the array entries, each listed write, each plain assignment and each literal prefix. For example, after `let dir = "../dist/"; dir += name`, each value starts with `../dist/`, so a move or delete of a file below `../dist/` refuses. The engine does not use that start as a bound, because it does not follow the repeated writes, so the loader still needs the acknowledgment. To avoid the acknowledgment, keep the paths in a `const` string or array that the file only reads. A relocated loader must match at both paths, and a move that could change its runtime base can refuse.

### JSX migrations

`rewrite_props` follows the component's importers, including aliases and re-exports. Its checker loads potential consumers, the declarations they depend on and applicable ambient declarations. A reachable global export or a component forwarded from an installed package can make any workspace file a candidate. Setting `fail_on_new_errors` also runs workspace validation before and after the edit. An omitted replacement value preserves the original expression. An empty replacement array removes the attribute.

```json
{
  "project_root": "/workspace",
  "module": "packages/ui/src/button.tsx",
  "export_name": "Button",
  "rules": [
    {"prop": "tone", "replace": [{"prop": "variant"}]},
    {"prop": "size", "equals": "sm", "replace": [{"prop": "size", "value": "small"}]},
    {"prop": "primary", "equals": true, "replace": [{"prop": "variant", "value": "primary"}]},
    {"prop": "legacy", "replace": []},
    {"prop": "rounded", "absent": true, "replace": [{"prop": "rounded", "value": true}]}
  ]
}
```

A rule with `to_child` moves the attribute into the children of the element, at the `start` or the `end`. This example turns `<Button icon={<Plus />}>Add</Button>` into `<Button><Plus />Add</Button>`:

```json
{"prop": "icon", "to_child": "start"}
```

A JSX element value becomes that element, a string literal becomes text, and another expression becomes `{expression}`. A self-closing element gets a closing tag. `equals` and `absent` work as for the other rules. An `absent` rule needs a literal `value` to insert. Two rules for one element, for example `icon` at the start and `iconRight` at the end, keep both positions. A usage with a spread attribute or a `children` attribute, or a move that could change the order in which expressions run, goes to `manual`. A value can change places with another attribute or child when neither of them runs program code: literals, identifiers, arrow functions and function expressions (their creation runs none of their body), JSX elements built from such values, and `?:`, `&&`, `||`, `??`, `!`, parentheses, `as`, `satisfies` and non-null `!` around such values; a literal or a function can also change places with any other value. A call, a property read, a class expression, `++` or another operator can run code, so a move across it goes to `manual`.

Review `matched`, `rewritten`, `left_for_manual` and each `manual` entry. Spreads, conflicts, uncertain matches and component references outside JSX tags need review. Use `fail_on_manual: true` for an all-or-nothing migration of those sites.

For complex multi-step reorganizations, use the `/refactor` command to invoke the refactor-planner agent — it analyzes the codebase structure, drafts a preview plan, and executes stages in order.

---

## Components

```
server/
├── main.py               MCP server, tool routing, language detection
├── backends/
│   ├── python.py         Rope-based Python refactoring
│   └── typescript.py     ts-morph subprocess wrapper
└── tsmorph/
    ├── refactor.js       CLI and ordered operation dispatch
    └── *.js              Workspace resolution, planning and transactional writes

hooks/
└── hooks.json            SessionStart: auto-install dependencies

commands/
└── refactor.md           /refactor — invokes refactor-planner agent

skills/
└── refactoring/          Refactoring patterns knowledge base
```

---

## Testing

Tests use hermetic fixtures — each test gets an isolated temporary project, so operations can't interfere with each other.

```bash
export PATH="$PWD/.venv/bin:$PATH"
ruff check server tests
PYTHONPATH="$PWD/server" pytest -q
PYTHONPATH="$PWD/server" pytest -qs -m performance
```

## Notes

- TypeScript `validate_imports` and `fail_on_new_errors` check configured source files and their compiler dependencies. They build one program for each member, release it before the next member, and share only parsed files between adjacent members, so the peak memory follows the largest member and not the number of members. `replace_module` checks its importers in the same way. They report selected import diagnostics and missing local files or workspace exports. Mutation tools also inventory unbuilt files for references. The Python scan honors `.gitignore` inside git repos (via `git ls-files`) and skips standard build/venv/cache/worktree paths elsewhere.
- `move_symbol` now fails closed on ambiguous or destructive cases such as same-file moves, target binding collisions, multi-declarator variables, and source-local dependencies that are not safely importable after the move.
- Python `move_module` and `move_symbol` fail closed on two known Rope hazards rather than silently corrupt consumer files:
  - **Basename collision** — if the source file exports a top-level binding with the same name as the module (e.g. `project_service = ProjectService()` inside `project_service.py`), Rope confuses variable attribute access with module attribute access and rewrites `project_service.method()` call sites incorrectly. Rename the binding first, then retry.
  - **Lazy (in-function) imports** — Rope hoists in-function `import` statements to module top, breaking circular-import workarounds. If any consumer imports the moved module/symbol from inside a function, refactory refuses and lists every offending site. Un-lazy those imports (or resolve the underlying circular dependency) first.
- A TypeScript apply briefly holds `.refactory-write.lock` in the workspace root and rechecks its inputs before installing files. If a process crashes, inspect the working tree and sibling backups before clearing a stale lock. Edits involving an in-scope symlink to a managed target refuse when its importers cannot be tracked.
- Writes are transactional to the extent the filesystem allows. The TypeScript backend computes every change in memory (preview and apply share that one plan, so previews list dynamic `import()` consumers too), refuses if the result would contain a syntax error, stages temp sibling files first — a staging failure changes nothing — then installs them with sibling backups it restores if a later step fails. The Python backend snapshots every file a Rope change touches and restores those bytes when the change fails mid-apply, then undoes previously applied changes. A power loss mid-commit can still leave a partial state; version control remains the last line of defense.
- Moves between language families (`.ts`/`.tsx` to `.js`/`.jsx` or back) are refused, because type annotations do not survive the move. A member's tsconfig can include source directories named `build`, including `src/build`. Discovery and writes respect configured exclusions, compiler output directories, published build outputs, `.git` and `node_modules`. Without a tsconfig, conventional build and cache directories are skipped.
- TypeScript analysis uses TypeScript 6.0.2, bundled with ts-morph 28.0.0. Unknown compiler options produce warnings. A parse error in planned source prevents the write. Set `REFACTORY_TIMEOUT_SECONDS` to a positive integer to adjust the MCP subprocess timeout (default 120). On macOS and Linux a timeout stops planning and lets an in-progress commit finish or roll back.
- The workspace resolver supports nested package globs with `*` and `**`. It checks generated package imports against the caller's aliases and checks ancestor manifests for affected exports. Conditional and wildcard rows can be read. Changing one may require a manifest decision. Generated declarations give the checker a public API but do not identify the build's source entry.
- Mapped namespace or star replacements can require manual work when the module object escapes or a barrel combines several exports. JSX rules leave ambiguous conditional branches and splits that would evaluate an expression twice for manual review.
- Literal relative `new URL("./file.svg", import.meta.url)` references use physical files and directories. Validation groups pre-existing missing URL targets into one warning per member. Moves within a package rebase these URLs, including paths to expected build output. A shadowed constructor or a file URL that would cross packages can require manual edits. A standalone asset move lists recognized stylesheet imports, CSS URLs and markup `src`/`href` sites for review. Computed names, custom loaders and runtime asset lookups may require a separate inventory. Projects using only `jsconfig.json` fall back to a filesystem crawl.
- All MCP tools require an explicit absolute `project_root`. In linked worktrees, pass the worker checkout's import root directly (for example `.../worker/backend`) so cwd drift cannot silently select the main checkout.
- Python `move_symbol` previews require the target module to already exist on disk. Rope cannot compute an exact import-rewrite preview against a module it cannot read, and refactory refuses to fabricate or stage one. Create the destination file first (an empty file is fine) or run with `apply: true`.
- For TypeScript `move_symbol`, select the file declaring the symbol. A barrel containing only `export { run } from "./impl"` has no declaration to move. Moving `run` from `impl.ts` updates that named re-export, and its consumers keep importing through the barrel.
- TypeScript semantic edits refuse ambiguous references to script globals across separately configured workspace members. An explicit module import can identify its declaration across those same members.
- If TypeScript applies all edits but cannot remove a transaction backup or release its write lock, the result reports success and a warning identifying the retained path.
