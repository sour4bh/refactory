#!/usr/bin/env python
"""
Refactory MCP Server - Token-efficient codebase refactoring tools.

Provides shared cross-language tools plus Python-only Rope extras.
"""
import asyncio
import json
import logging
import sys
import threading
from pathlib import Path
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import CallToolResult, Tool, TextContent

from backends.python import PythonBackend
from backends.typescript import TypeScriptBackend
from validation import validate_position_selector
from workspace_tools import EXTERNAL_COMPUTED_FILES, TYPESCRIPT_ONLY, workspace_tools

logging.basicConfig(level=logging.INFO, stream=sys.stderr)
logger = logging.getLogger("refactory")

server = Server("refactory")

BACKENDS = {
    "python": PythonBackend,
    "typescript": TypeScriptBackend,
}

EXTENSION_MAP = {
    ".py": "python",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "typescript",
    ".jsx": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".mjs": "typescript",
    ".cjs": "typescript",
}

PREVIEW_MESSAGE = "Preview only. To apply these changes, call the same tool with apply: true."


def detect_language(file_path: str) -> str:
    """Detect language from file extension."""
    ext = Path(file_path).suffix.lower()
    lang = EXTENSION_MAP.get(ext)
    if not lang:
        raise ValueError(f"Unsupported file type: {ext}. Supported: {list(EXTENSION_MAP.keys())}")
    return lang


def get_backend(language: str):
    """Get refactoring backend for language."""
    backend_cls = BACKENDS.get(language)
    if not backend_cls:
        raise ValueError(f"Unsupported language: {language}. Supported: {list(BACKENDS.keys())}")
    return backend_cls()


def format_apply_result(result: dict[str, Any], apply_changes: bool) -> dict[str, Any]:
    """Expose apply-mode semantics at the MCP boundary."""
    formatted = dict(result)
    formatted.pop("dry_run", None)
    formatted["apply"] = apply_changes
    if result.get("success") and not apply_changes:
        formatted["message"] = PREVIEW_MESSAGE
    return formatted


def require_project_root(arguments: dict[str, Any]) -> str:
    """Return the required absolute project root for a tool call."""
    project_root = arguments.get("project_root")
    if not project_root:
        raise ValueError("project_root is required and must be an absolute path")
    root = Path(project_root).expanduser()
    if not root.is_absolute():
        raise ValueError(f"project_root must be an absolute path: {project_root}")
    if not root.is_dir():
        raise ValueError(f"Project root does not exist: {project_root}")
    return str(root)


@server.list_tools()
async def list_tools() -> list[Tool]:
    """List available refactoring tools."""
    return [
        *workspace_tools(),
        Tool(
            name="validate_imports",
            description="Check for refactor-related import and name-resolution errors after restructuring. This is a narrow safety probe, not a full compiler or linter run.",
            inputSchema={
                "type": "object",
                "properties": {
                    "project_root": {
                        "type": "string",
                        "description": "Absolute root directory of the project",
                    },
                    "language": {
                        "type": "string",
                        "enum": ["python", "typescript"],
                        "description": "Language to validate (validates all if not specified)",
                    },
                    "external_computed_files": EXTERNAL_COMPUTED_FILES,
                },
                "required": ["project_root"],
            },
        ),
        Tool(
            name="organize_imports",
            description="Python-only: organize imports in a Python module using Rope.",
            inputSchema={
                "type": "object",
                "properties": {
                    "file": {
                        "type": "string",
                        "description": "Python file whose imports should be organized",
                    },
                    "project_root": {
                        "type": "string",
                        "description": "Absolute root directory of the project",
                    },
                    "apply": {
                        "type": "boolean",
                        "description": "Apply changes to files. Omit or false to preview only.",
                        "default": False,
                    },
                },
                "required": ["file", "project_root"],
            },
        ),
        Tool(
            name="extract_variable",
            description="Python-only: extract the selected expression into a variable using Rope.",
            inputSchema={
                "type": "object",
                "properties": {
                    "file": {"type": "string", "description": "Python file containing the selection"},
                    "new_name": {"type": "string", "description": "Name of the extracted variable"},
                    "start_line": {"type": "integer", "description": "1-based start line"},
                    "start_column": {"type": "integer", "description": "1-based start column"},
                    "end_line": {"type": "integer", "description": "1-based end line"},
                    "end_column": {
                        "type": "integer",
                        "description": "1-based end column (exclusive)",
                    },
                    "project_root": {
                        "type": "string",
                        "description": "Absolute root directory of the project",
                    },
                    "apply": {
                        "type": "boolean",
                        "description": "Apply changes to files. Omit or false to preview only.",
                        "default": False,
                    },
                },
                "required": [
                    "file",
                    "new_name",
                    "start_line",
                    "start_column",
                    "end_line",
                    "end_column",
                    "project_root",
                ],
            },
        ),
        Tool(
            name="extract_function",
            description="Python-only: extract the selected statements into a function using Rope.",
            inputSchema={
                "type": "object",
                "properties": {
                    "file": {"type": "string", "description": "Python file containing the selection"},
                    "new_name": {"type": "string", "description": "Name of the extracted function"},
                    "start_line": {"type": "integer", "description": "1-based start line"},
                    "start_column": {"type": "integer", "description": "1-based start column"},
                    "end_line": {"type": "integer", "description": "1-based end line"},
                    "end_column": {
                        "type": "integer",
                        "description": "1-based end column (exclusive)",
                    },
                    "project_root": {
                        "type": "string",
                        "description": "Absolute root directory of the project",
                    },
                    "apply": {
                        "type": "boolean",
                        "description": "Apply changes to files. Omit or false to preview only.",
                        "default": False,
                    },
                },
                "required": [
                    "file",
                    "new_name",
                    "start_line",
                    "start_column",
                    "end_line",
                    "end_column",
                    "project_root",
                ],
            },
        ),
        Tool(
            name="inline_symbol",
            description="Python-only: inline a selected local variable, parameter, or function using Rope.",
            inputSchema={
                "type": "object",
                "properties": {
                    "file": {"type": "string", "description": "Python file containing the symbol reference"},
                    "line": {"type": "integer", "description": "1-based line containing the symbol"},
                    "column": {"type": "integer", "description": "1-based column containing the symbol"},
                    "project_root": {
                        "type": "string",
                        "description": "Absolute root directory of the project",
                    },
                    "apply": {
                        "type": "boolean",
                        "description": "Apply changes to files. Omit or false to preview only.",
                        "default": False,
                    },
                },
                "required": ["file", "line", "column", "project_root"],
            },
        ),
    ]


MUTATING_TOOLS = frozenset({
    *TYPESCRIPT_ONLY,
    "move_module",
    "move_symbol",
    "rename_symbol",
    "organize_imports",
    "extract_variable",
    "extract_function",
    "inline_symbol",
})

# Hold this in the worker thread so a cancelled MCP call cannot release it
# while Node/Rope is still committing. Sibling member roots can overlap.
_write_lock = threading.Lock()


def _dispatch_apply(name: str, arguments: dict[str, Any], project_root: str) -> dict[str, Any]:
    """Serialize mutations for this server process."""
    with _write_lock:
        return _dispatch_tool(name, arguments, project_root, False)


def _dispatch_tool(name: str, arguments: dict[str, Any], project_root: str, dry_run: bool) -> dict[str, Any]:
    """Run one tool synchronously; called from a worker thread."""
    path_field = {"move_module": "source", "move_symbol": "source_file", "rename_symbol": "file"}.get(name)
    if name in TYPESCRIPT_ONLY or (path_field and Path(arguments[path_field]).suffix.lower() != ".py"):
        backend = get_backend("typescript")
        return backend.run_operation(name, arguments, project_root, dry_run)
    if path_field:
        unsupported = {"diff", "diff_limit", "export_as", "companions", "external_computed_files",
                       "fail_on_new_errors"}.intersection(arguments)
        if unsupported:
            raise ValueError(f"{', '.join(sorted(unsupported))} not supported for Python files")

    if name == "move_module":
        source = arguments["source"]
        target = arguments["target"]
        overwrite = arguments.get("overwrite", False)
        language = detect_language(source)
        backend = get_backend(language)
        result = backend.move_module(
            source,
            target,
            project_root,
            dry_run,
            overwrite=overwrite,
        )

    elif name == "move_symbol":
        source_file = arguments["source_file"]
        symbol_name = arguments["symbol_name"]
        target_file = arguments["target_file"]
        language = detect_language(source_file)
        backend = get_backend(language)
        result = backend.move_symbol(
            source_file,
            symbol_name,
            target_file,
            project_root,
            dry_run,
        )

    elif name == "rename_symbol":
        file = arguments["file"]
        old_name = arguments["old_name"]
        new_name = arguments["new_name"]
        line, column = validate_position_selector(
            arguments.get("line"),
            arguments.get("column"),
        )
        language = detect_language(file)
        backend = get_backend(language)
        result = backend.rename_symbol(
            file,
            old_name,
            new_name,
            project_root,
            dry_run,
            line=line,
            column=column,
        )

    elif name == "validate_imports":
        language = arguments.get("language")
        results = []
        warnings = []
        accepted = []
        if language == "python" and "external_computed_files" in arguments:
            raise ValueError("external_computed_files not supported for Python files")
        languages = [language] if language else list(BACKENDS.keys())
        for lang in languages:
            try:
                backend = get_backend(lang)
                if lang == "typescript":
                    report = backend.run_operation("validate_imports", arguments, project_root, True)
                    warnings.extend(report.get("warnings", []))
                    accepted = report.get("accepted_computed_imports", [])
                    lang_result = report["errors"]
                else:
                    lang_result = backend.validate_imports(project_root)
            except Exception as exc:
                logger.exception(f"{lang} validate_imports failed")
                results.append({
                    "language": lang,
                    "errors": [{
                        "file": "",
                        "line": 0,
                        "error": f"{lang} validation could not run: {exc}",
                        "type": "backend_error",
                    }],
                })
                continue
            if lang_result:
                results.append({"language": lang, "errors": lang_result})
        result = {"valid": len(results) == 0, "issues": results}
        if warnings:
            result["warnings"] = warnings
        if accepted:
            result["accepted_computed_imports"] = accepted

    elif name == "organize_imports":
        backend = get_backend("python")
        result = backend.organize_imports(
            arguments["file"],
            project_root,
            dry_run,
        )

    elif name == "extract_variable":
        backend = get_backend("python")
        result = backend.extract_variable(
            file=arguments["file"],
            new_name=arguments["new_name"],
            start_line=arguments["start_line"],
            start_column=arguments["start_column"],
            end_line=arguments["end_line"],
            end_column=arguments["end_column"],
            project_root=project_root,
            dry_run=dry_run,
        )

    elif name == "extract_function":
        backend = get_backend("python")
        result = backend.extract_function(
            file=arguments["file"],
            new_name=arguments["new_name"],
            start_line=arguments["start_line"],
            start_column=arguments["start_column"],
            end_line=arguments["end_line"],
            end_column=arguments["end_column"],
            project_root=project_root,
            dry_run=dry_run,
        )

    elif name == "inline_symbol":
        backend = get_backend("python")
        result = backend.inline_symbol(
            file=arguments["file"],
            line=arguments["line"],
            column=arguments["column"],
            project_root=project_root,
            dry_run=dry_run,
        )

    else:
        raise ValueError(f"Unknown tool: {name}")

    return result


@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent] | CallToolResult:
    """Execute a refactoring tool off the event loop, serializing overlapping writes."""
    try:
        project_root = require_project_root(arguments)
        apply_changes = arguments.get("apply") is True
        dry_run = not apply_changes

        if name in MUTATING_TOOLS and apply_changes:
            result = await asyncio.to_thread(_dispatch_apply, name, arguments, project_root)
        else:
            result = await asyncio.to_thread(_dispatch_tool, name, arguments, project_root, dry_run)

        if name != "validate_imports":
            result = format_apply_result(result, apply_changes)

        return [TextContent(type="text", text=json.dumps(result, indent=2))]

    except Exception as e:
        logger.exception(f"Tool {name} failed")
        return CallToolResult(
            isError=True,
            content=[TextContent(type="text", text=json.dumps({"error": str(e)}))],
        )


async def main():
    """Run the MCP server."""
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
