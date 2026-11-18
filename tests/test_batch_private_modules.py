"""Exercise package boundaries against the final batch tree."""

import json

import pytest

from tests.test_workspace_batch import run, snapshot
from tests.test_workspace_resolution import write


@pytest.fixture
def packages(tmp_path):
    """Create two members with private siblings and an independently named workspace root."""
    write(tmp_path, "package.json", '{"name":"@acme/root","workspaces":["packages/*"]}')
    for name in ["ui", "blocks"]:
        write(tmp_path, f"packages/{name}/package.json", json.dumps({"name": "@acme/" + name, "exports": {}}))
        write(tmp_path, f"packages/{name}/tsconfig.json", '{"compilerOptions":{"module":"ESNext",'
              '"moduleResolution":"bundler","paths":{"~/*":["./src/*"]}}}')
    write(tmp_path, "packages/ui/src/a.ts", 'import { b } from "./b.js";\nexport function a() { return b; }\n')
    write(tmp_path, "packages/ui/src/b.ts", 'export const b = 1;\n')
    return tmp_path


def move(name):
    """Describe an explicitly exported cross-package move."""
    return {"operation": "move_module", "source": f"packages/ui/src/{name}.ts",
            "target": f"packages/blocks/src/{name}.ts", "export_as": f"./{name}"}


@pytest.mark.parametrize("order", [("a", "b"), ("b", "a")])
def test_batch_moves_private_siblings_together(packages, order):
    write(packages, "packages/ui/src/b.ts", 'import { a } from "~/a";\nexport function b() { return a; }\n')
    before = snapshot(packages)
    fields = {"operations": [move(name) for name in order], "diff": True, "fail_on_new_errors": True}
    preview = run(packages, "batch", **fields)
    assert snapshot(packages) == before
    applied = run(packages, "batch", apply=True, **fields)
    assert applied["diff"] == preview["diff"]
    assert applied["warnings"] == preview["warnings"] == []
    assert (packages / "packages/blocks/src/a.ts").read_bytes() == before["packages/ui/src/a.ts"]
    assert (packages / "packages/blocks/src/b.ts").read_bytes() == before["packages/ui/src/b.ts"]
    assert "packages/ui/package.json" not in applied["affected_files"]
    assert json.loads((packages / "packages/blocks/package.json").read_text()) == {
        "name": "@acme/blocks", "exports": {"./a": "./src/a.ts", "./b": "./src/b.ts"},
    }


def test_intermediate_binding_available_to_rename(packages):
    operations = [move("a"), {"operation": "rename_symbol", "file": "packages/ui/src/b.ts",
                              "old_name": "b", "new_name": "heading"}, move("b")]
    run(packages, "batch", operations=operations, apply=True, fail_on_new_errors=True)
    assert 'import { heading } from "./b.js"' in (packages / "packages/blocks/src/a.ts").read_text()


def test_private_import_can_be_removed_by_replacement(packages):
    write(packages, "packages/blocks/src/label.ts", "export const b = 2;")
    operations = [move("a"), {"operation": "replace_module", "source": "packages/ui/src/b.ts",
                              "target": "packages/blocks/src/label.ts"}]
    run(packages, "batch", operations=operations, apply=True, fail_on_new_errors=True)
    assert 'from "./label.js"' in (packages / "packages/blocks/src/a.ts").read_text()


def test_final_private_reference_refuses_atomically(packages):
    write(packages, "packages/ui/src/c.ts", "export const c = 3;")
    before = snapshot(packages)
    for apply in (False, True):
        error = run(packages, "batch", operations=[move("a"), move("c")], apply=apply, refused=True)
        assert "batch[0]" in error and "packages/ui/src/b.ts" in error and "not exported" in error
        assert snapshot(packages) == before


@pytest.mark.parametrize("tool", ["move_module", "batch"])
@pytest.mark.parametrize("suffix", ["packages/uncreated/src/a.ts", "loose/a.ts"])
def test_workspace_move_requires_existing_destination_member(packages, tool, suffix):
    before = snapshot(packages)
    step = {**move("b"), "target": suffix}
    fields = {"operations": [step]} if tool == "batch" else {k: v for k, v in step.items() if k != "operation"}
    for apply in (False, True):
        error = run(packages, tool, apply=apply, refused=True, **fields)
        assert suffix in error and "member" in error and "first" in error
        assert snapshot(packages) == before


def test_root_script_can_move_within_workspace_root(packages):
    write(packages, "scripts/a.ts", "export const a = 1;")
    write(packages, "scripts/use.ts", 'import { a } from "./a";\nexport const b = a;\n')
    applied = run(packages, "move_module", source="scripts/a.ts", target="tools/a.ts", apply=True)
    assert "package.json" not in applied["affected_files"]
    assert 'from "../tools/a"' in (packages / "scripts/use.ts").read_text()


def test_standalone_package_can_move_under_new_directory(tmp_path):
    write(tmp_path, "package.json", '{"name":"@acme/root","exports":{"./a":"./src/a.ts"}}')
    write(tmp_path, "src/a.ts", "export const a = 1;")
    run(tmp_path, "move_module", source="src/a.ts", target="lib/a.ts", apply=True)
    assert json.loads((tmp_path / "package.json").read_text())["exports"] == {"./a": "./lib/a.ts"}


def test_transit_package_needs_no_inferred_export(packages):
    write(packages, "packages/transit/package.json", '{"name":"@acme/transit"}')
    original = snapshot(packages)
    first = {**move("b"), "target": "packages/transit/src/b.ts"}
    del first["export_as"]
    steps = [first, {**move("b"), "source": first["target"]}]
    applied = run(packages, "batch", operations=steps, apply=True, fail_on_new_errors=True)
    assert "packages/transit/package.json" not in applied["affected_files"]
    assert (packages / "packages/transit/package.json").read_bytes() == original["packages/transit/package.json"]
    assert 'from "@acme/blocks/b"' in (packages / "packages/ui/src/a.ts").read_text()
    assert json.loads((packages / "packages/ui/package.json").read_text())["dependencies"] == {
        "@acme/blocks": "workspace:*",
    }


def test_deleted_importer_requires_no_temporary_export(packages):
    steps = [move("a"), {"operation": "delete_module", "source": move("a")["target"]}]
    run(packages, "batch", operations=steps, apply=True)
    for name in ("ui", "blocks"):
        assert json.loads((packages / f"packages/{name}/package.json").read_text()) == {
            "name": f"@acme/{name}", "exports": {},
        }


def test_package_replacement_sees_public_import_during_moves(packages):
    write(packages, "packages/blocks/src/new.ts", "export const b = 2;")
    steps = [move("b"), {"operation": "replace_module", "source": "@acme/blocks/b",
                         "target": "packages/blocks/src/new.ts"}, move("a")]
    run(packages, "batch", operations=steps, apply=True, fail_on_new_errors=True)
    assert 'from "./new.js"' in (packages / "packages/blocks/src/a.ts").read_text()
