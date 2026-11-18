"""Workspace checker scope regressions on synthetic legacy scripts."""
import json

import pytest

from tests.test_workspace_batch import run, snapshot


@pytest.fixture
def script_workspace(tmp_path):
    (tmp_path / "package.json").write_text('{"workspaces":["packages/*"]}')
    for name in ("a", "b"):
        pkg = tmp_path / "packages" / name
        pkg.mkdir(parents=True)
        (pkg / "package.json").write_text(json.dumps({"name": "@acme/" + name}))
        (pkg / "tsconfig.json").write_text('{"compilerOptions":{"module":"ESNext","moduleDetection":"legacy"}}')
        (pkg / "counter.ts").write_text("let count = 1; console.log(count);\n")
    return tmp_path


@pytest.mark.parametrize("member", ["a", "b"])
def test_member_script_global_rename_preserves_both_scopes(script_workspace, member):
    root = script_workspace
    source = root / "packages" / member
    before = snapshot(root)
    args = {"file": "counter.ts", "old_name": "count", "new_name": "renamed"}
    for apply in (False, True):
        error = run(source, "rename_symbol", **args, apply=apply, refused=True)
        assert "counter.ts" in error and "script global" in error
        assert snapshot(root) == before


def test_batch_move_symbol_refuses_ambiguous_script_declaration(script_workspace):
    root = script_workspace
    for member in ("a", "b"):
        (root / "packages" / member / "counter.ts").write_text("function count() { return 1; }\ncount();")
    before = snapshot(root)
    operations = [
        {"operation": "move_module", "source": "packages/a/counter.ts", "target": "packages/a/renamed.ts"},
        {"operation": "move_symbol", "source_file": "packages/a/renamed.ts", "symbol_name": "count",
         "target_file": "packages/a/impl.ts"},
    ]
    error = run(root, "batch", operations=operations, apply=True, refused=True)
    assert "batch[1]" in error and "script global" in error and "renamed.ts" in error
    assert snapshot(root) == before


def test_unrelated_export_keeps_module_identity_beside_scripts(script_workspace):
    root = script_workspace
    a = root / "packages/a"
    (a / "package.json").write_text('{"name":"@acme/a","exports":{"./lib":"./lib.ts"}}')
    (a / "lib.ts").write_text("export const count = 42;")
    caller = root / "packages/b/main.ts"
    caller.write_text('import {count} from "@acme/a/lib"; console.log(count);')
    result = run(root, "rename_symbol", file="packages/a/lib.ts", old_name="count", new_name="result", apply=True)
    assert sorted(result["affected_files"]) == ["packages/a/lib.ts", "packages/b/main.ts"]
    assert caller.read_text() == 'import {result} from "@acme/a/lib"; console.log(result);'


def test_member_script_detection_uses_own_config(script_workspace):
    root = script_workspace
    (root / "tsconfig.json").write_text('{"compilerOptions":{"moduleDetection":"legacy"}}')
    (root / "packages/a/tsconfig.json").write_text('{"compilerOptions":{"moduleDetection":"force"}}')
    (root / "packages/b/counter.ts").write_text("export {};")
    (root / "packages/a/reader.ts").write_text("console.log(count);")
    before = snapshot(root)
    error = run(root, "rename_symbol", file="packages/a/counter.ts", old_name="count", new_name="result",
                apply=True, refused=True)
    assert "script global" in error and "counter.ts" in error
    assert snapshot(root) == before
