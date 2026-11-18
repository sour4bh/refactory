# AGENTS.md

This file provides guidance to coding agents (Claude Code, Codex) when working with code in this repository.

## Project Overview

**Refactory** is an MCP (Model Context Protocol) plugin that provides token-efficient codebase refactoring tools. Instead of manually editing imports across dozens of files, the agent calls specialized tools that handle refactoring operations atomically.

The plugin supports both Python (via Rope library) and TypeScript (via ts-morph).

## Development Commands

### Setup & Installation

The plugin auto-installs dependencies on first use via the SessionStart hook:
- Python: `rope`, `mcp`
- TypeScript: `ts-morph` and `diff` (requires Node.js and pnpm/npm)

Manual installation (if needed):
```bash
# Python dependencies
pip install rope mcp

# TypeScript dependencies
cd server/tsmorph && pnpm install
```

### Running tests

```bash
export PATH="$PWD/.venv/bin:$PATH"
ruff check server tests
PYTHONPATH="$PWD/server" pytest -q
PYTHONPATH="$PWD/server" pytest -q -m 'not performance'
```

The suite uses isolated fixture projects. `scripts/test.sh` also exercises the installed plugin CLI when available.

## Architecture

### Core Components

**MCP Server** (`server/main.py`)
- Entry point that implements the MCP protocol
- Routes tool calls to appropriate language backends
- Handles language detection and validation
- Returns structured JSON responses

**Language backends**

- `server/backends/python.py` uses Rope for Python operations.
- `server/backends/typescript.py` sends JSON over stdin to the Node CLI. `REFACTORY_TIMEOUT_SECONDS` configures the default 120-second deadline.
- `server/workspace_tools.py` defines MCP schemas for shared mutations and the TypeScript workspace tools.
- `server/tsmorph/refactor.js` normalizes CLI inputs, executes operations in order, and commits the final plan.
- The workspace resolver reads member manifests and per-member tsconfig options. A session tracks the in-memory files, asset bytes, module reference index and manifest edits. Mutations share this session, including in a batch.

### Tool interface

MCP requires an absolute `project_root`. The TypeScript CLI accepts the same snake_case fields. Tools preview by default. Use `apply: true` to commit. Loads from a member can update files across its declared workspace. Validate every write path against the workspace boundary and skipped-directory list.

TypeScript mutations include `move_module`, `move_symbol`, `rename_symbol`, `delete_module`, `replace_module` and `rewrite_props`. Put ordered operations in a `batch`, or supply a project-relative JSON `payload_file` for a large plan. Each operation reads prior edits. Report errors with the operation index and reject the complete plan on failure.

### Extensions & Configuration

**Hooks** (`hooks/`)
- `hooks.json`: Triggers dependency installation on SessionStart
- `install-deps.sh`: Auto-installs rope, mcp, and ts-morph on first use

**Commands** (`commands/`)
- `refactor.md`: CLI command `/refactor` that invokes the refactor-planner agent

**Skills** (`skills/`)
- `refactoring/SKILL.md`: Knowledge about module organization patterns and refactoring strategies

## Implementation and testing

Use `workspace.js` for per-file tsconfig, package lookup and specifier selection. A public export must exist before writing a cross-package import. Pass the original specifier to preserve alias and extension conventions when moving a file.

A TypeScript preview and apply must compute the same edits in memory. Include code, assets and manifests in one staged transaction. Check changed source for parser errors before staging. Re-use the operation dispatcher for CLI and MCP calls.

Before changing file paths or exports, capture existing reference targets. Verify that untouched references still bind to them before rescanning. Resolve each batch step against the session, including deleted paths. Check package boundaries, export rows and dependency rows of a batch against its final state: `BatchImports` keeps temporary bindings, and the workspace writes dependency rows and their warnings once, after the last step. Recheck resolution config inputs under the write lock.

Treat build outputs as read-only resolver inputs. Missing generated entries can still identify a workspace dependency. Keep the per-importer resolution mode when checking a moved specifier. Use member tsconfig patterns to distinguish source directories such as `src/build` from generated or excluded directories. For computed loaders, check finite alternatives and static directory bounds before accepting unbounded sites through `external_computed_files`. List every value that the loader's file writes into a binding that the loader reads. A write that cannot be listed makes the site need an acknowledgment, and the listed values stay checked under it. Scope JSX semantic checks using the import graph, including re-exports and ambient bindings. Measure child-process peak RSS with the declaration-heavy performance fixture.

Use hermetic pytest fixtures. Give dependency-probe tests a temporary engine directory and a stub installer. Cover both preview and apply, refusal with byte-for-byte preservation, skipped paths, and member-root entry points. Exercise large plans under the `performance` pytest marker.

Python-specific behavior remains in the Rope backend, including circular-import checks, `__init__.py` creation, project path validation and change rollback.

## References

- [Rope Documentation](https://rope.readthedocs.io/)
- [ts-morph Documentation](https://ts-morph.readthedocs.io/)
- [MCP Protocol](https://modelcontextprotocol.io/)
