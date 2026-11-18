---
name: Refactoring Patterns
description: This skill should be used when discussing codebase reorganization patterns, module structure best practices, or planning how to restructure Python/TypeScript projects. Use when user asks about "how to organize code", "module structure", "when to split files", or "refactoring strategies".
version: 1.0.0
---

# Codebase Refactoring Patterns

Guide for reorganizing code by responsibility while maintaining clean imports.

## Module Organization Principles

### Responsibility-Based Structure

Organize by what code does, not what it is:

```
project/
├── api/           # External interfaces (REST, GraphQL, CLI)
├── core/          # Business logic, domain models
├── storage/       # Data persistence (DB, cache, files)
├── integrations/  # Third-party service clients
└── utils/         # Shared utilities (logging, config)
```

### When to Split a Module

Split when:
- File exceeds 500 lines
- Multiple unrelated responsibilities
- Circular import risks
- Different change frequencies

Keep together when:
- High cohesion (always change together)
- Shared internal state
- Complex initialization order

## Python Refactoring Patterns

### Moving Modules

Use `move_module` MCP tool. Creates `__init__.py` files automatically.

```json
{"source": "src/db.py", "target": "src/storage/db.py"}
```

After move, re-export from package `__init__.py` for backward compatibility:
```python
# src/storage/__init__.py
from src.storage.db import Database, connect
```

### Moving Symbols

Use `move_symbol` for functions/classes between modules:

```json
{
  "source_file": "src/utils.py",
  "symbol_name": "parse_config",
  "target_file": "src/config/parser.py"
}
```

### Circular Import Prevention

Before moving, check for cycles:
1. A imports B, B imports A → cycle
2. Solution: Extract shared code to new module C

## TypeScript Refactoring Patterns

### Barrel Exports

For `move_symbol`, pass the file that declares the symbol as `source_file`. Moving a declaration also updates a named barrel re-export such as `export { run } from "./impl"`. Consumers can keep importing from the barrel. Selecting a barrel that only re-exports the symbol is refused.

### Path Aliases

Configure tsconfig.json for clean imports:
```json
{
  "compilerOptions": {
    "paths": {
      "@storage/*": ["src/storage/*"],
      "@core/*": ["src/core/*"]
    }
  }
}
```

## TypeScript workspace migrations

Use an absolute workspace `project_root` and express the migration as ordered steps in a `batch`. Put large plans in a JSON file in the workspace and pass `payload_file`. Each step has an `operation` field and the same arguments as the standalone tool. Set `apply` on the outer request.

1. Use `replace_module` to redirect consumers. Select an exact public specifier to migrate barrel imports. For separate destinations, give each imported name a `{"target": "...", "name": "..."}` row in `names`. Omit `name` to keep the export name.
2. Use `delete_module` for retired modules. The final batch state must have no surviving importers.
3. Use `move_module` with an explicit `export_as` where a new package lacks a consistent export pattern. Select companion assets with `companions: "auto"` or explicit paths. The destination must be in an existing workspace member: create the member's `package.json` and add it to the workspace before the batch.
4. Use `rewrite_props` on the new component with rules for renamed, mapped, added or removed attributes. To move an attribute into the children, use `{"prop": "icon", "to_child": "start"}` (or `"end"`); `<Button icon={<Plus />}>Add</Button>` becomes `<Button><Plus />Add</Button>`. Review the reported file, line and reason for manual sites, for example a spread or a `children` attribute. A value moves past other attributes only when neither runs code (literals, identifiers, functions, JSX elements, and `?:`, `&&`, `||`, `??`, `!` or type assertions of these); a call or a property read next to it makes the site manual. Use `fail_on_manual` when the migration requires full coverage.
5. Preview with `diff` and `fail_on_new_errors`. Review changes to package exports, dependencies and JSX usage, then apply the same approved plan.

A batch checks package boundaries, export rows and dependency rows against its final state, so the order of moves inside one batch does not matter for these checks. Files that end in one member keep relative imports between them. A package that a file only passes through gets no export row, and a dependency row that only an intermediate step needs is not written. The "dependency retained" warning applies only to rows that existed before the batch, and cycle warnings describe the final package graph.

For a TypeScript property rename, supply `old_name: "Props.tone"` and the new member name to `rename_symbol`. For Python, continue to run individual Rope operations in order.

A built package may expose declarations and runtime files through different export conditions. Check `validate_imports` warnings for missing build outputs. Moving a re-exported implementation updates the source barrel. A new package cycle through that public re-export requires a change to the plan.

Review carried npm ranges and dependency sections in the manifest diff. If the plan adds dependencies, run a package install before the member type checks.

For computed imports, requires and source URLs, inspect the reported sites. A static relative directory prefix, a prefix that a tsconfig `paths` alias or `baseUrl` maps, or a finite directory choice reaches only that subtree. An `import()` of `new URL("<static path>", import.meta.url).href`, `.pathname` or `fileURLToPath(...)`, also through a `const`, names the file of the static path, and a move updates the string. If the other loaders read only external artifacts, pass their workspace-relative files or globs in `external_computed_files` on the outer request. The acknowledgment covers only values that the engine cannot see; literal choices and prefixes are still checked. A loader that reads a binding which the file changes in a way the engine does not follow (for example `+=`, or passing the array to a function) needs the acknowledgment too, and the entries, listed writes and literal prefixes that the engine sees stay checked. To avoid the acknowledgment, keep its paths in a `const` value that the file only reads. Review the `accepted_computed_imports` locations in the preview.

## Validation Checklist

After refactoring:
1. Run `validate_imports` tool
2. Run test suite
3. Check for unused imports
4. Verify __init__.py exports
5. Update documentation paths

## Common Mistakes

❌ **Don't:**
- Move without checking dependents first
- Forget __init__.py in new packages
- Leave stale imports
- Break backward compatibility without deprecation

✅ **Do:**
- Preview first (omit apply, or pass apply: false); execute with apply: true
- Re-export from package root if public API
- Update all relative imports
- Add deprecation warnings for moved public APIs
