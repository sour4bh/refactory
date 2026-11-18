"""Carry installable dependencies during a cross-package move."""

import json

import pytest

from tests.test_workspace_batch import run, snapshot
from tests.test_workspace_resolution import write


MOVE = {"operation": "move_module", "source": "packages/a/src/unit.ts",
        "target": "packages/b/src/unit.ts", "export_as": "./unit"}


@pytest.fixture
def packages(tmp_path):
    """Give each package its own manifest and isolated installed dependencies."""
    write(tmp_path, "package.json", '{"private":true,"workspaces":["packages/*"]}')
    for name in ["a", "b", "site"]:
        write(tmp_path, f"packages/{name}/package.json", json.dumps({"name": "@acme/" + name, "exports": {}}))
        write(tmp_path, f"packages/{name}/tsconfig.json", json.dumps({
            "compilerOptions": {"module": "ESNext", "moduleResolution": "bundler", "strict": True},
            "include": ["src"],
        }))
    return tmp_path


def manifest(root, member, **fields):
    """Update the package fixture without changing the other fields."""
    path = root / f"packages/{member}/package.json"
    data = json.loads(path.read_text())
    path.write_text(json.dumps({**data, **fields}, indent=2) + "\n")
    return path


def install(root, member, name):
    """Create an isolated member install or a hoisted workspace install."""
    directory = (f"packages/{member}/" if member else "") + f"node_modules/{name}"
    write(root, directory + "/package.json", json.dumps({
        "name": name, "version": "1.0.0", "exports": {"./view": "./view.d.ts"},
    }))
    write(root, directory + "/view.d.ts", "export declare const paint: number;\n")


def test_carries_dependency_sections_and_checks_before_install(packages):
    src = manifest(packages, "a", dependencies={"palette": "^1.0.0"},
                   peerDependencies={"@acme/shape": "~1.0.0"}, optionalDependencies={"theme": "1.0.0"},
                   peerDependenciesMeta={"@acme/shape": {"optional": True}},
                   exports={"./unit": "./src/unit.ts"})
    for name in ["palette", "@acme/shape", "theme"]:
        install(packages, "a", name)
    write(packages, MOVE["source"], 'export {paint} from "palette/view";\n'
          'import("@acme/shape/view"); import "theme/view"; import "node:fs"; import "path";\n')
    write(packages, "packages/site/src/main.ts", 'export {paint} from "@acme/a/unit";\n')
    manifest(packages, "site", dependencies={"@acme/a": "workspace:*"})
    before = snapshot(packages)
    fields = {"operations": [MOVE], "fail_on_new_errors": True, "diff": True}
    preview = run(packages, "batch", **fields)
    assert snapshot(packages) == before
    applied = run(packages, "batch", **fields, apply=True)
    assert {**preview, "dry_run": False} == applied
    assert json.loads(src.read_text())["dependencies"] == {"palette": "^1.0.0"}
    dest = json.loads((packages / "packages/b/package.json").read_text())
    assert dest["dependencies"] == {"palette": "^1.0.0"}
    assert dest["peerDependencies"] == {"@acme/shape": "~1.0.0"}
    assert dest["peerDependenciesMeta"] == {"@acme/shape": {"optional": True}}
    assert dest["optionalDependencies"] == {"theme": "1.0.0"}
    assert "packages/b/package.json" in applied["affected_files"]
    warnings = [w for w in applied["warnings"] if "install" in w]
    assert len(warnings) == 1
    assert all(path in warnings[0] for path in ["packages/b/package.json", "packages/site/package.json", "type check"])


def test_unknown_dependency_range_refuses_even_when_hoisted(packages):
    install(packages, None, "palette")
    write(packages, MOVE["source"], 'export {paint} from "palette/view";')
    before = snapshot(packages)
    for apply in [False, True]:
        error = run(packages, "batch", operations=[MOVE], apply=apply, refused=True)
        assert all(p in error for p in [MOVE["source"], "palette/view", "packages/a/package.json", "range"])
        assert snapshot(packages) == before


def test_added_dependency_does_not_hide_a_different_import_error(packages):
    manifest(packages, "a", dependencies={"palette": "^1.0.0"})
    install(packages, "a", "palette")
    write(packages, MOVE["source"], 'export {paint} from "palette/view"; export const unit = 0;')
    write(packages, "packages/b/src/unit.ts", 'export const previous = 1;')
    write(packages, "packages/b/src/caller.ts", 'export {previous} from "./unit";')
    before = snapshot(packages)
    messages = [run(packages, "batch", operations=[{**MOVE, "overwrite": True}],
                    fail_on_new_errors=True, apply=apply, refused=True) for apply in [False, True]]
    assert messages[0] == messages[1]
    assert "previous" in messages[0] and "Cannot find module 'palette/view'" not in messages[0]
    assert snapshot(packages) == before


@pytest.mark.parametrize("ordered", [True, False])
def test_manifest_insertion_preserves_map_style_and_order(packages, ordered):
    old = ["alpha", "omega"] if ordered else ["omega", "alpha"]
    original = ('{ "name" : "@acme/b", "dependencies" : { ' +
                ', '.join(f'"{k}" : "^1"' for k in old) + ' }, "exports" : { ' +
                ', '.join(f'"./{k}" : "./src/{k}.ts"' for k in old) + ' } }\n')
    dest = write(packages, "packages/b/package.json", original)
    manifest(packages, "a", dependencies={"middle": "^2"})
    write(packages, MOVE["source"], 'import "middle";')
    run(packages, "batch", operations=[{**MOVE, "export_as": "./middle"}], apply=True)
    rows = old + ["middle"]
    if ordered:
        rows.sort()
    assert dest.read_text() == ('{ "name" : "@acme/b", "dependencies" : { ' +
                                ', '.join(f'"{k}" : "^{2 if k == "middle" else 1}"' for k in rows) +
                                ' }, "exports" : { ' +
                                ', '.join(f'"./{k}" : "./src/{"unit" if k == "middle" else k}.ts"' for k in rows) +
                                ' } }\n')


def test_external_dep_used_after_two_batch_moves(packages):
    manifest(packages, "a", dependencies={"palette": "^1"})
    install(packages, "a", "palette")
    write(packages, MOVE["source"], 'export {paint} from "palette/view";')
    final = "packages/site/src/unit.ts"
    operations = [MOVE, {**MOVE, "source": MOVE["target"], "target": final}]
    before = snapshot(packages)
    result = run(packages, "batch", operations=operations, fail_on_new_errors=True, apply=True)
    assert "packages/b/package.json" not in result["affected_files"] and "packages/site/package.json" in result["affected_files"]
    assert (packages / "packages/b/package.json").read_bytes() == before["packages/b/package.json"]
    assert json.loads((packages / "packages/site/package.json").read_text())["dependencies"] == {"palette": "^1"}
    assert (packages / final).is_file()
    assert len([w for w in result["warnings"] if "package install" in w]) == 1


def test_incompatible_installed_subpath_remains_an_error(packages):
    manifest(packages, "a", dependencies={"palette": "^1.0.0"})
    install(packages, "a", "palette")
    write(packages, "packages/b/node_modules/palette/package.json", '{"name":"palette","exports":{}}')
    write(packages, MOVE["source"], 'export {paint} from "palette/view";')
    before = snapshot(packages)
    for apply in [False, True]:
        error = run(packages, "move_module", **{k: v for k, v in MOVE.items() if k != "operation"},
                    refused=True, fail_on_new_errors=True, apply=apply)
        assert "palette/view" in error and "New import errors" in error
        assert snapshot(packages) == before


def test_declared_package_awaiting_first_install(packages):
    manifest(packages, "a", dependencies={"palette": "^1.0.0"})
    write(packages, "packages/a/src/ambient.d.ts", 'declare module "palette/view" {export const paint: number}')
    write(packages, MOVE["source"], 'export {paint} from "palette/view";')
    result = run(packages, "batch", operations=[MOVE], fail_on_new_errors=True, apply=True)
    assert "packages/b/package.json" in result["affected_files"]
    assert any("package install" in w for w in result["warnings"])


@pytest.mark.parametrize(("field", "value", "reason"), [
    ("dependencies", "file:./vendor", "destination range"),
    ("devDependencies", "^1", "no runtime dependency range"),
])
def test_unportable_external_dependency_refuses(packages, field, value, reason):
    manifest(packages, "a", **{field: {"palette": value}})
    write(packages, MOVE["source"], 'export {paint} from "palette/view";')
    before = snapshot(packages)
    error = run(packages, "batch", operations=[MOVE], refused=True, apply=True)
    assert "palette/view" in error and reason in error and MOVE["source"] in error
    assert snapshot(packages) == before


def test_conflicting_carried_dependency_refuses_batch(packages):
    manifest(packages, "a", dependencies={"palette": "^1"})
    manifest(packages, "site", dependencies={"palette": "^2"})
    write(packages, MOVE["source"], 'import "palette/view";')
    second = "packages/site/src/second.ts"
    write(packages, second, 'import "palette";')
    before = snapshot(packages)
    error = run(packages, "batch", operations=[MOVE, {**MOVE, "source": second,
                "target": "packages/b/src/second.ts", "export_as": "./second"}], refused=True, apply=True)
    assert "Conflicting" in error and second in error and "batch[1]" in error
    assert snapshot(packages) == before


@pytest.mark.asyncio
async def test_single_move_mcp_runs_same_guard_for_preview_and_apply(packages):
    from tests.test_e2e_mcp import call_error, open_mcp_session

    write(packages, MOVE["source"], "export const current = 1;")
    write(packages, MOVE["target"], "export const previous = 1;")
    write(packages, "packages/b/src/use.ts", 'export {previous} from "./unit";')
    request = {key: value for key, value in MOVE.items() if key != "operation"}
    request.update({"project_root": str(packages), "overwrite": True, "fail_on_new_errors": True})
    before = snapshot(packages)
    async with open_mcp_session() as session:
        for apply in [False, True]:
            error = await call_error(session, "move_module", {**request, "apply": apply})
            assert "New import errors" in error["error"] and "previous" in error["error"]
            assert snapshot(packages) == before


def test_bare_builtin_with_declared_polyfill_and_predeclared_range(packages):
    manifest(packages, "a", dependencies={"buffer": "^3", "palette": "^2"})
    manifest(packages, "b", dependencies={"palette": "^1"})
    write(packages, MOVE["source"], 'import "buffer"; import "palette/view"; import "node:fs";')
    run(packages, "batch", operations=[MOVE], apply=True)
    assert json.loads((packages / "packages/b/package.json").read_text())["dependencies"] == {
        "buffer": "^3", "palette": "^1",
    }


def test_rejects_per_step_import_guard(packages):
    write(packages, MOVE["source"], "export const unit = 1;")
    before = snapshot(packages)
    error = run(packages, "batch", operations=[{**MOVE, "fail_on_new_errors": True}], refused=True, apply=True)
    assert "fail_on_new_errors on the outer batch" in error
    assert snapshot(packages) == before


def test_alias_to_another_installed_package_refuses(packages):
    manifest(packages, "a", dependencies={"palette": "^1"})
    install(packages, "a", "palette")
    install(packages, "b", "shapes")
    config = packages / "packages/b/tsconfig.json"
    settings = json.loads(config.read_text())
    settings["compilerOptions"]["paths"] = {"palette/view": ["./node_modules/shapes/view.d.ts"]}
    config.write_text(json.dumps(settings))
    write(packages, MOVE["source"], 'export {paint} from "palette/view";')
    before = snapshot(packages)
    error = run(packages, "batch", operations=[MOVE], apply=True, refused=True)
    assert "palette/view" in error and "alias" in error and MOVE["target"] in error
    assert snapshot(packages) == before


@pytest.mark.parametrize("installed", [False, True])
def test_new_nodenext_export_error_uses_destination_mode(packages, installed):
    """Both an existing link and a staged link must use the destination's module format."""
    for member in ["a", "b"]:
        write(packages, f"packages/{member}/tsconfig.json", json.dumps({
            "compilerOptions": {"module": "NodeNext", "moduleResolution": "NodeNext"}, "include": ["src"],
        }))
        if member == "b" and not installed:
            continue
        directory = f"packages/{member}/node_modules/palette"
        write(packages, directory + "/package.json", json.dumps({
            "name": "palette", "exports": {"import": "./esm.d.mts", "require": "./cjs.d.cts"},
        }))
        write(packages, directory + "/esm.d.mts", "export declare const other: number;")
        write(packages, directory + "/cjs.d.cts", "export declare const paint: number;")
    manifest(packages, "a", dependencies={"palette": "^1"}, type="commonjs")
    manifest(packages, "b", type="module")
    write(packages, MOVE["source"], 'import {paint} from "palette"; export {paint};')
    assert run(packages, "validate_imports")["errors"] == []
    before = snapshot(packages)
    for apply in [False, True]:
        error = run(packages, "batch", operations=[MOVE], fail_on_new_errors=True, apply=apply, refused=True)
        assert "paint" in error and MOVE["target"] in error
        assert snapshot(packages) == before
    if installed:
        write(packages, "packages/a/src/check.mts", 'export {paint} from "palette";')
        errors = run(packages, "validate_imports")["errors"]
        assert [(e["code"], e["file"]) for e in errors] == [(2305, "packages/a/src/check.mts")]


def test_local_require_does_not_add_a_guessed_npm_dependency(packages):
    manifest(packages, "a", dependencies={"palette": "^1"})
    write(packages, MOVE["source"], 'function require(key: string) { return key; }\n'
          'export const value = require("palette/view");')
    before = snapshot(packages)
    error = run(packages, "batch", operations=[MOVE], refused=True, apply=True)
    assert "palette/view" in error and MOVE["source"] in error and "shadowed" in error
    assert snapshot(packages) == before
