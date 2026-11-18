"""Regression cases for workspace graph changes within and between operations."""

import json

import pytest

from tests.test_workspace_batch import run, snapshot


def test_missing_default_export_is_an_import_error(tmp_path):
    (tmp_path / "a.ts").write_text("export const value = 1;")
    (tmp_path / "b.ts").write_text("export default 1;")
    (tmp_path / "use.ts").write_text('import value from "./b"; console.log(value);')
    before = snapshot(tmp_path)
    move = {"operation": "move_module", "source": "a.ts", "target": "b.ts", "overwrite": True}
    for apply in [False, True]:
        error = run(tmp_path, "batch", operations=[move], fail_on_new_errors=True, apply=apply, refused=True)
        assert "use.ts" in error and "default" in error
        assert snapshot(tmp_path) == before
    (tmp_path / "b.ts").write_text("export const value = 1;")
    issues = run(tmp_path, "validate_imports")["errors"]
    assert any(issue["file"] == "use.ts" and "default" in issue["error"] for issue in issues)


@pytest.mark.parametrize(("target", "consumer"), [
    ("export type Btn = number;", 'import {Btn} from "./mod"; console.log(Btn);'),
    ('export type {Btn} from "./value";', 'import {Btn} from "./mod"; console.log(Btn);'),
    ('export {Btn} from "./value";', 'export * from "./mod"; export * from "./other";'),
])
def test_final_guard_checks_unusable_exports_after_overwrite(tmp_path, target, consumer):
    (tmp_path / "value.ts").write_text("export const Btn = 1;")
    (tmp_path / "other.ts").write_text("export const Btn = 2;")
    (tmp_path / "next.ts").write_text(target)
    # The barrel's stars initially agree on a declaration, as a direct import would.
    (tmp_path / "mod.ts").write_text('export {Btn} from "./other";')
    (tmp_path / "use.ts").write_text(consumer)
    assert run(tmp_path, "validate_imports")["errors"] == []
    before = snapshot(tmp_path)
    op = {"operation": "move_module", "source": "next.ts", "target": "mod.ts", "overwrite": True}
    error = run(tmp_path, "batch", operations=[op], fail_on_new_errors=True, apply=True, refused=True)
    assert "use.ts" in error and "Btn" in error
    assert snapshot(tmp_path) == before


def test_move_makes_unresolved_reference_available_to_next_step(tmp_path):
    (tmp_path / "a.ts").write_text("export const value = 1;")
    (tmp_path / "use.ts").write_text('export {value} from "./b";')
    operations = [{"operation": "move_module", "source": "a.ts", "target": "b.ts"},
                  {"operation": "move_module", "source": "b.ts", "target": "c.ts"}]
    preview = run(tmp_path, "batch", operations=operations, diff=True)
    assert "use.ts" in preview["affected_files"]
    apply = run(tmp_path, "batch", operations=operations, diff=True, apply=True)
    assert preview["diff"] == apply["diff"]
    assert (tmp_path / "use.ts").read_text() == 'export {value} from "./c";'


def test_batch_writes_only_final_workspace_dependency(tmp_path):
    (tmp_path / "package.json").write_text('{"name":"@acme/site","workspaces":["packages/*"]}')
    for name in ["a", "b", "c"]:
        member = tmp_path / "packages" / name
        member.mkdir(parents=True)
        rows = {"./item": "./item.ts"} if name == "a" else {}
        (member / "package.json").write_text(json.dumps({"name": "@acme/" + name, "exports": rows}))
    (tmp_path / "packages/a/item.ts").write_text("export const value = 1;")
    (tmp_path / "use.ts").write_text('export {value} from "@acme/a/item";')
    steps = [{"operation": "move_module", "source": f"packages/{a}/item.ts",
              "target": f"packages/{b}/item.ts", "export_as": "./item"} for a, b in [("a", "b"), ("b", "c")]]
    preview = run(tmp_path, "batch", operations=steps)
    apply = run(tmp_path, "batch", operations=steps, apply=True)
    assert json.loads((tmp_path / "package.json").read_text())["dependencies"] == {"@acme/c": "workspace:*"}
    assert apply["warnings"] == preview["warnings"]
    assert not any("no longer imports" in warning for warning in apply["warnings"])


def test_existing_diagnostic_follows_module_identity(tmp_path):
    (tmp_path / "item.ts").write_text('import {x} from "external-missing"; export {x};')
    kwargs = {"operations": [{"operation": "move_module", "source": "item.ts", "target": "renamed.ts"}],
              "fail_on_new_errors": True}
    assert run(tmp_path, "validate_imports")["errors"]
    preview = run(tmp_path, "batch", **kwargs)
    assert run(tmp_path, "batch", **kwargs, apply=True)["affected_files"] == preview["affected_files"]
    assert all(e["file"] == "renamed.ts" for e in run(tmp_path, "validate_imports")["errors"])


def test_move_refuses_shadowing_import_in_rewritten_file(tmp_path):
    (tmp_path / "from.ts").write_text("export const newValue = 1;")
    (tmp_path / "button").mkdir()
    (tmp_path / "button/index.ts").write_text("export const oldValue = 2;")
    use = tmp_path / "use.ts"
    use.write_text('import {newValue} from "./from"; import {oldValue} from "./button";')
    before = snapshot(tmp_path)
    for apply in [False, True]:
        error = run(tmp_path, "move_module", source="from.ts", target="button.ts",
                    apply=apply, refused=True)
        assert "use.ts" in error and "./button" in error
        assert snapshot(tmp_path) == before


def test_batch_rescan_keeps_evidence_of_shadowing(tmp_path):
    (tmp_path / "from.ts").write_text("export const x = 1;")
    (tmp_path / "other.ts").write_text("export const value = 1;")
    (tmp_path / "button").mkdir()
    (tmp_path / "button/index.ts").write_text("export const y = 1;")
    (tmp_path / "use.ts").write_text('export {y} from "./button";')
    before = snapshot(tmp_path)
    error = run(tmp_path, "batch", operations=[
        {"operation": "move_module", "source": "from.ts", "target": "button.ts"},
        {"operation": "rename_symbol", "file": "other.ts", "old_name": "value", "new_name": "newValue"},
    ], apply=True, refused=True)
    assert "batch[0]" in error and "use.ts" in error and "./button" in error
    assert snapshot(tmp_path) == before


def test_file_creation_cannot_shadow_an_untouched_computed_import(tmp_path):
    (tmp_path / "new.ts").write_text("export const x = 1;")
    (tmp_path / "button").mkdir()
    (tmp_path / "button/index.ts").write_text("export const y = 1;")
    (tmp_path / "registry.ts").write_text('export const load = () => import("./" + "button");')
    before = snapshot(tmp_path)
    error = run(tmp_path, "move_module", source="new.ts", target="button.ts", apply=True, refused=True)
    assert "registry.ts" in error and "./button" in error
    assert snapshot(tmp_path) == before


def test_move_symbol_checks_shadowing_when_creating_a_file(tmp_path):
    (tmp_path / "tsconfig.json").write_text('{"compilerOptions":{"module":"ESNext"}}')
    (tmp_path / "from.ts").write_text("export function value() { return 1; }")
    (tmp_path / "button").mkdir()
    (tmp_path / "button/index.ts").write_text("export const y = 1;")
    (tmp_path / "use.ts").write_text('export {y} from "./button";')
    before = snapshot(tmp_path)
    error = run(tmp_path, "move_symbol", source_file="from.ts", target_file="button.ts",
                symbol_name="value", apply=True, refused=True)
    assert "use.ts" in error and "./button" in error
    assert snapshot(tmp_path) == before


def test_computed_export_is_checked_when_deleted_path_is_reused(tmp_path):
    (tmp_path / "package.json").write_text('{"workspaces":["packages/*"]}')
    ui = tmp_path / "packages/ui"
    ui.mkdir(parents=True)
    (ui / "package.json").write_text('{"name":"@acme/ui","exports":{"./button":"./button.ts"}}')
    (ui / "button.ts").write_text("export const x = 1;")
    (ui / "clean.ts").write_text("export const x = 2;")
    (tmp_path / "registry.ts").write_text('export const load = () => import("@acme/ui/" + "button");')
    before = snapshot(tmp_path)
    ops = [{"operation": "delete_module", "source": "packages/ui/button.ts"},
           {"operation": "move_module", "source": "packages/ui/clean.ts", "target": "packages/ui/button.ts"}]
    for apply in [False, True]:
        error = run(tmp_path, "batch", operations=ops, apply=apply, refused=True)
        assert "batch[0]" in error and "registry.ts" in error
        assert snapshot(tmp_path) == before
