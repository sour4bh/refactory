"""MCP schemas for shared mutations and TypeScript workspace operations."""
from typing import Any

from mcp.types import Tool

STRING = {"type": "string"}
BOOLEAN = {"type": "boolean"}
EXTERNAL_COMPUTED_FILES = {
    "type": "array",
    "items": {"type": "string", "minLength": 1},
    "description": "Paths or globs whose import, require or URL loaders that the engine cannot bound only access "
                   "external artifacts (TypeScript). Their literal paths stay checked.",
}
LITERAL = {"type": ["string", "number", "boolean"]}
COMPANIONS = {
    "description": "Move or delete explicit asset paths, or auto-select exclusive neighbours.",
    "oneOf": [{"const": "auto"}, {"type": "array", "items": STRING}],
}
PROP_RULE = {
    "type": "object",
    "properties": {
        "prop": STRING,
        "equals": LITERAL,
        "absent": BOOLEAN,
        "to_child": {"enum": ["start", "end"], "description": "Move the attribute value into JSX children."},
        "value": {**LITERAL, "description": "Literal child to insert for an absent prop."},
        "replace": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"prop": STRING, "value": LITERAL},
                "required": ["prop"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["prop"],
    "oneOf": [{"required": ["replace"]}, {"required": ["to_child"]}],
    "additionalProperties": False,
}
COMMON = {
    "project_root": {"type": "string", "description": "Absolute project or workspace member directory."},
    "apply": {"type": "boolean", "default": False},
    "fail_on_new_errors": {"type": "boolean", "description": "Refuse new import errors (TypeScript)."},
    "external_computed_files": EXTERNAL_COMPUTED_FILES,
    "diff": {"type": "boolean", "description": "Include unified diffs (TypeScript)."},
    "diff_limit": {"type": "integer", "minimum": 18, "description": "Maximum diff bytes (TypeScript)."},
}
TYPESCRIPT_ONLY = frozenset({"delete_module", "batch", "replace_module", "rewrite_props"})


def _tool(
    name: str,
    description: str,
    properties: dict[str, Any],
    *required: str,
    **constraints: Any,
) -> Tool:
    """Describe one preview-first workspace tool."""
    return Tool(name=name, description=description, inputSchema={
        "type": "object",
        "properties": {**COMMON, **properties},
        "required": ["project_root", *required],
        "additionalProperties": False,
        **constraints,
    })


def workspace_tools() -> list[Tool]:
    """Return the migration and shared mutation tools."""
    return [
        _tool("move_module", "Move a file and update importers.", {
            "source": STRING, "target": STRING, "overwrite": BOOLEAN,
            "export_as": {"type": "string", "description": "Destination package export, e.g. ./button."},
            "companions": COMPANIONS,
        }, "source", "target"),
        _tool("move_symbol", "Move a top-level declaration and update references.", {
            "source_file": STRING, "symbol_name": STRING, "target_file": STRING,
        }, "source_file", "symbol_name", "target_file"),
        _tool("rename_symbol", "Rename a binding or TypeScript Type.member; optional 1-based selectors.", {
            "file": STRING, "old_name": STRING, "new_name": STRING,
            "line": {"type": "integer", "minimum": 1}, "column": {"type": "integer", "minimum": 1},
        }, "file", "old_name", "new_name"),
        _tool("delete_module", "Delete an unreferenced file and its exports.", {
            "source": STRING, "companions": COMPANIONS,
        }, "source"),
        _tool("replace_module", "Redirect a file or package entry to one or more modules.", {
            "source": STRING, "target": STRING,
            "names": {"type": "object", "additionalProperties": {"oneOf": [
                STRING, {"type": "object", "properties": {"target": STRING, "name": STRING},
                         "required": ["target"], "additionalProperties": False},
            ]}},
            "rename_local": BOOLEAN,
        }, "source", anyOf=[{"required": ["target"]}, {"required": ["names"]}]),
        _tool("rewrite_props", "Transform JSX attributes on one component export.", {
            "module": STRING, "export_name": STRING, "rules": {"type": "array", "minItems": 1, "items": PROP_RULE},
            "fail_on_manual": BOOLEAN,
        }, "module", "export_name", "rules"),
        _tool("batch", "Run ordered TypeScript operations in one transaction.", {
            "operations": {
                "type": "array",
                "description": "Each step has operation and the corresponding tool's fields.",
                "items": {
                    "type": "object",
                    "properties": {"operation": {"enum": [
                        "move_module", "move_symbol", "rename_symbol", "delete_module", "replace_module", "rewrite_props",
                    ]}},
                    "required": ["operation"],
                },
            },
            "payload_file": {"type": "string", "description": "Project-relative file containing the batch JSON object."},
        }, oneOf=[{"required": ["operations"]}, {"required": ["payload_file"]}]),
    ]
