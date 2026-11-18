"""Built package outputs are read-only package identities across workspace edits."""

import json

import pytest

from tests.test_workspace_batch import snapshot
from tests.test_workspace_resolution import call, write


@pytest.fixture
def built_workspace(tmp_path):
    """Create a library with built entries and two packages shipping their TypeScript source."""
    write(tmp_path, "package.json", '{"private":true,"workspaces":["packages/*"]}')
    write(tmp_path, "tsconfig.base.json", json.dumps({"compilerOptions": {
        "module": "ESNext", "moduleResolution": "bundler", "strict": True, "jsx": "react-jsx",
    }}))
    manifests = {
        "hooks": {"exports": {
            ".": {"import": "./dist/runtime.js", "types": "./dist/index.d.ts"},
            "./client": {"types": "./dist/client/index.d.ts", "import": "./dist/client/index.js"},
        }, "main": "./dist/runtime.js", "types": "./dist/index.d.ts"},
        "old": {"dependencies": {"@acme/hooks": "workspace:^"}, "exports": {"./button": "./src/button.ts"}},
        "ui": {"exports": {"./icon": "./src/icon.ts"}},
    }
    for name, data in manifests.items():
        write(tmp_path, f"packages/{name}/package.json", json.dumps({"name": "@acme/" + name, **data}))
        write(tmp_path, f"packages/{name}/tsconfig.json", '{"extends":"../../tsconfig.base.json"}')
    write(tmp_path, "packages/hooks/src/client/index.ts", "export const useClient = 1;")
    write(tmp_path, "packages/hooks/src/index.ts", "export const useHook = 1;")
    write(tmp_path, "packages/old/src/button.ts",
          'import {useHook} from "@acme/hooks"; import {useClient} from "@acme/hooks/client";\n'
          'export const button = useHook + useClient;')
    write(tmp_path, "packages/ui/src/icon.ts", "export const icon = 1;")
    return tmp_path


def build(root):
    """Write generated declarations and runtime files."""
    write(root, "packages/hooks/dist/runtime.js", "export const runtimeOnly = 1;")
    write(root, "packages/hooks/dist/shared.d.ts", "export declare const useHook: number;")
    write(root, "packages/hooks/dist/index.d.ts", 'export {useHook} from "./shared";')
    write(root, "packages/hooks/dist/client/index.d.ts", "export declare const useClient: number;")
    write(root, "packages/hooks/dist/client/index.js", "export const useClient = 1;")


@pytest.mark.parametrize("built", [True, False])
def test_built_package_import_survives_move_and_carries_dependency(built_workspace, built):
    root = built_workspace
    if built:
        build(root)
    initial = snapshot(root)
    validated = call(root, "validate_imports")
    assert validated["errors"] == []
    warnings = validated["warnings"]
    if built:
        assert not warnings
    else:
        assert len(warnings) == 1 and "@acme/hooks" in warnings[0] and "dist/" in warnings[0]
    step = {"operation": "move_module", "source": "packages/old/src/button.ts",
            "target": "packages/ui/src/button.ts", "export_as": "./button"}
    kwargs = {"operations": [step], "fail_on_new_errors": True, "diff": True}
    preview = call(root, "batch", **kwargs)
    assert snapshot(root) == initial
    applied = call(root, "batch", apply=True, **kwargs)
    assert applied["diff"] == preview["diff"]
    assert "packages/ui/package.json" in applied["affected_files"]
    assert not any("/dist/" in path for path in applied["affected_files"])
    assert (root / step["target"]).read_bytes() == initial[step["source"]]
    ui = json.loads((root / "packages/ui/package.json").read_text())
    assert ui["dependencies"]["@acme/hooks"] == "workspace:^"
    assert ui["exports"]["./button"] == "./src/button.ts"
    assert "./button" not in json.loads((root / "packages/old/package.json").read_text())["exports"]


@pytest.mark.parametrize("operation", ["move_module", "delete_module"])
def test_built_public_source_entry_refuses_manifest_edit(built_workspace, operation):
    root = built_workspace
    source = "packages/hooks/src/client/index.ts"
    before = snapshot(root)
    params = {"target": "packages/hooks/src/client/new.ts"} if operation == "move_module" else {}
    for apply in [False, True]:
        error = call(root, operation, ok=False, source=source, apply=apply, **params)
        assert source in error and "./client" in error and "package.json" in error
        assert snapshot(root) == before


def test_conditional_entry_prefers_types_and_preserves_missing_name_error(built_workspace):
    root = built_workspace
    build(root)
    write(root, "packages/ui/src/check.ts", 'export {runtimeOnly} from "@acme/hooks";')
    errors = call(root, "validate_imports")["errors"]
    assert len(errors) == 1 and "runtimeOnly" in errors[0]["error"]


def test_unbuilt_warning_does_not_hide_broken_public_or_local_imports(built_workspace):
    root = built_workspace
    write(root, "packages/ui/src/check.ts", 'import "@acme/hooks/no-row"; import "./absent";')
    result = call(root, "validate_imports")
    messages = [error["error"] for error in result["errors"]]
    assert all(any(spec in message for message in messages) for spec in ["@acme/hooks/no-row", "./absent"])
    assert all("@acme/hooks/client" not in message for message in messages)
    assert len(result["warnings"]) == 1


def test_unrelated_operation_loads_unusual_export_shapes(built_workspace):
    root = built_workspace
    write(root, "packages/hooks/package.json", json.dumps({"name": "@acme/hooks", "exports": {
        "./client": [{"unknown": "./unused"}, None], ".": {"browser": "./other.js"},
    }}))
    result = call(root, "rename_symbol", file="packages/ui/src/icon.ts", old_name="icon", new_name="picture")
    assert result["affected_files"] == ["packages/ui/src/icon.ts"]


def test_member_conditions_select_require_or_import_declarations(built_workspace):
    """A dependency with separate branches can expose different names to each importer."""
    root = built_workspace
    hooks = root / "packages/hooks"
    (hooks / "package.json").write_text(json.dumps({"name": "@acme/hooks", "exports": {
        ".": {"require": {"types": "./dist/common.d.cts"}, "import": {"types": "./dist/module.d.mts"}},
    }}))
    write(hooks, "dist/common.d.cts", "export declare const cjs: number;")
    write(hooks, "dist/module.d.mts", "export declare const esm: number;")
    (root / "packages/old/src/button.ts").write_text('export {esm} from "@acme/hooks";')
    write(root, "packages/ui/tsconfig.json", json.dumps({"compilerOptions": {
        "module": "NodeNext", "moduleResolution": "NodeNext",
    }}))
    check = write(root, "packages/ui/src/main.cts",
                  'import hooks = require("@acme/hooks"); export const value = hooks.cjs;\n'
                  'export const future = import("@acme/hooks").then(h => h.esm);')
    assert call(root, "validate_imports")["errors"] == []
    check.write_text('export {esm} from "@acme/hooks";')
    assert any("esm" in e["error"] for e in call(root, "validate_imports")["errors"])


def test_built_main_and_types_without_exports(built_workspace):
    root = built_workspace
    build(root)
    (root / "packages/hooks/package.json").write_text(json.dumps({
        "name": "@acme/hooks", "main": "./dist/runtime.js", "types": "./dist/index.d.ts",
    }))
    (root / "packages/old/src/button.ts").write_text('export {useHook} from "@acme/hooks";')
    assert call(root, "validate_imports")["errors"] == []
    (root / "packages/hooks/dist/index.d.ts").unlink()
    errors = call(root, "validate_imports")["errors"]
    assert any("useHook" in e["error"] for e in errors)


def test_type_only_resolution_mode_is_specific_to_each_import(built_workspace):
    root = built_workspace
    hooks = root / "packages/hooks"
    (hooks / "package.json").write_text(json.dumps({"name": "@acme/hooks", "exports": {
        ".": {"require": {"types": "./dist/common.d.cts"}, "import": {"types": "./dist/module.d.mts"}},
    }}))
    write(hooks, "dist/common.d.cts", "export type Common = string;")
    write(hooks, "dist/module.d.mts", "export type Module = number;")
    (root / "packages/old/src/button.ts").write_text(
        'import type {Common} from "@acme/hooks" with {"resolution-mode":"require"};\n'
        'import type {Module} from "@acme/hooks" with {"resolution-mode":"import"};\n'
        'export type Both = [Common, Module];'
    )
    assert call(root, "validate_imports")["errors"] == []


@pytest.mark.parametrize(("op", "params"), [
    ("rename_symbol", {"file": "packages/hooks/src/value.ts", "old_name": "value", "new_name": "changed"}),
    ("move_symbol", {"source_file": "packages/hooks/src/index.ts", "symbol_name": "local",
                     "target_file": "packages/hooks/src/new.ts"}),
    ("rewrite_props", {"module": "packages/hooks/src/value.ts", "export_name": "value",
                       "rules": [{"prop": "tone", "replace": []}]}),
])
def test_public_semantic_edits_refuse_disconnected_build_declarations(built_workspace, op, params):
    root = built_workspace
    write(root, "packages/hooks/src/index.ts", 'export {value} from "./barrel"; export const local = 1;')
    write(root, "packages/hooks/src/barrel.ts", 'export {value} from "./value";')
    write(root, "packages/hooks/src/value.ts", "export const value = (props: any) => null;")
    write(root, "packages/hooks/dist/index.d.ts", "export declare const value: (props: any) => null;")
    write(root, "packages/ui/src/use.ts", 'import {value} from "@acme/hooks"; export {value};')
    before = snapshot(root)
    for apply in (False, True):
        error = call(root, "batch", apply=apply, ok=False, operations=[{"operation": op, **params}])
        assert "batch[0]" in error and "@acme/hooks" in error and "src/index.ts" in error
        assert snapshot(root) == before


def test_internal_symbol_outside_entry_closure_can_be_renamed(built_workspace):
    root = built_workspace
    private = write(root, "packages/hooks/src/internal.ts", "export const internal = 1;")
    call(root, "rename_symbol", file="packages/hooks/src/internal.ts", old_name="internal",
         new_name="privateValue", apply=True)
    assert "export const privateValue" in private.read_text()


def test_cannot_overwrite_a_built_entry_source(built_workspace):
    root = built_workspace
    write(root, "packages/hooks/src/clean.ts", "export const other = 0;")
    before = snapshot(root)
    error = call(root, "move_module", source="packages/hooks/src/clean.ts",
                 target="packages/hooks/src/index.ts", overwrite=True, ok=False, apply=True)
    assert "src/index.ts" in error and "package.json" in error
    assert snapshot(root) == before


def test_custom_types_output_directory_is_read_only(built_workspace):
    root = built_workspace
    hooks = root / "packages/hooks"
    (hooks / "tsconfig.json").write_text(json.dumps({
        "extends": "../../tsconfig.base.json", "compilerOptions": {"declarationDir": "lib", "declaration": True},
    }))
    (hooks / "package.json").write_text(json.dumps({
        "name": "@acme/hooks", "exports": {".": {"import": "./dist/runtime.js", "types": "./lib/index.d.ts"}},
    }))
    write(hooks, "lib/index.d.ts", "export declare const hook: number;")
    (root / "packages/old/src/button.ts").write_text('export {hook} from "@acme/hooks";')
    assert call(root, "validate_imports")["errors"] == []
    before = snapshot(root)
    error = call(root, "rename_symbol", file="packages/hooks/lib/index.d.ts", old_name="hook",
                 new_name="changed", apply=True, ok=False)
    assert "lib/index.d.ts" in error and ("output" in error or "outside" in error.lower())
    assert snapshot(root) == before


def test_replacing_built_entry_file_names_public_specifier(built_workspace):
    root = built_workspace
    before = snapshot(root)
    error = call(root, "replace_module", source="packages/hooks/src/index.ts",
                 target="packages/ui/src/icon.ts", apply=True, ok=False)
    assert "@acme/hooks" in error and "packages/hooks/src/index.ts" in error
    assert snapshot(root) == before


def test_versioned_types_and_inactive_export_conditions(built_workspace):
    root = built_workspace
    hooks = root / "packages/hooks"
    (hooks / "package.json").write_text(json.dumps({
        "name": "@acme/hooks", "exports": {".": {
            "browser": "./dist/browser.d.ts", "types@>=6": "./dist/current.d.ts",
            "types": "./dist/base.d.ts", "default": "./dist/fallback.js",
        }},
    }))
    write(hooks, "dist/current.d.ts", "export type Current = string;")
    write(hooks, "dist/base.d.ts", "export type Previous = number;")
    write(hooks, "dist/browser.d.ts", "export type Browser = boolean;")
    (root / "packages/old/src/button.ts").write_text('export type {Current} from "@acme/hooks";')
    assert call(root, "validate_imports")["errors"] == []


@pytest.mark.parametrize("created", [True, False])
def test_build_output_rechecked_under_write_lock(built_workspace, monkeypatch, created):
    root = built_workspace
    decl = root / "packages/hooks/dist/index.d.ts"
    if not created:
        build(root)
    hook = write(root, "race.cjs", 'const fs = require("node:fs"), mkdir = fs.mkdirSync;\n'
                 'fs.mkdirSync = function(p, ...args) { if (String(p).endsWith(".refactory-write.lock")) {\n'
                 '  mkdir(' + json.dumps(str(decl.parent)) + ', {recursive:true});\n'
                 '  fs.writeFileSync(' + json.dumps(str(decl)) + ', "export declare const changed: boolean;");\n'
                 '} return mkdir(p, ...args); };')
    monkeypatch.setenv("NODE_OPTIONS", f'--require="{hook}"')
    before = snapshot(root)
    error = call(root, "move_module", source="packages/ui/src/icon.ts", target="packages/ui/src/picture.ts",
                 apply=True, ok=False)
    assert "dist/index.d.ts" in error and "changed" in error.lower()
    assert (root / "packages/ui/src/icon.ts").read_bytes() == before["packages/ui/src/icon.ts"]
    assert not (root / "packages/ui/src/picture.ts").exists()


def test_entry_symbol_can_be_renamed_after_public_consumers_are_gone(built_workspace):
    root = built_workspace
    (root / "packages/old/src/button.ts").write_text('export const button = 1;')
    call(root, "rename_symbol", file="packages/hooks/src/index.ts", old_name="useHook", new_name="useNew", apply=True)
    assert "useNew" in (root / "packages/hooks/src/index.ts").read_text()


def test_split_main_and_types_refuses_cross_package_runtime_move(built_workspace):
    root = built_workspace
    (root / "packages/hooks/package.json").write_text(json.dumps({
        "name": "@acme/hooks", "main": "./runtime.js", "types": "./public.d.ts",
    }))
    write(root, "packages/hooks/runtime.js", "exports.run = () => 1;")
    write(root, "packages/hooks/public.d.ts", "export declare function run(): number;")
    (root / "packages/old/src/button.ts").write_text('export {run} from "@acme/hooks";')
    before = snapshot(root)
    error = call(root, "move_module", source="packages/hooks/runtime.js", target="packages/ui/src/worker.js",
                 export_as="./worker", apply=True, ok=False)
    assert "main" in error and "types" in error and "package.json" in error
    assert snapshot(root) == before
