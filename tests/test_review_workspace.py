"""Regression cases for workspace resolution, config membership and public manifests."""


import json

import pytest

from tests.test_workspace_batch import snapshot
from tests.test_workspace_resolution import call, write


def test_absolute_import_tracks_move_preview_and_apply(tmp_path):
    """Track a filesystem-absolute source import through a rename."""
    write(tmp_path, "item.ts", "export const x = 1;")
    use = write(tmp_path, "use.ts", f'import {{x}} from "{tmp_path}/item";\nexport {{x}};')
    preview = call(tmp_path, "move_module", source="item.ts", target="new.ts")
    assert "use.ts" in preview["affected_files"]
    applied = call(tmp_path, "move_module", source="item.ts", target="new.ts", apply=True)
    assert applied["affected_files"] == preview["affected_files"]
    assert 'from "./new"' in use.read_text()


def test_validation_uses_configured_roots_and_dependency_closure(tmp_path):
    """Ignore an excluded example but validate excluded files imported by a root."""
    write(tmp_path, "tsconfig.json", '{"extends":"./base.json"}')
    write(tmp_path, "base.json", '{"include":["src/**/*.ts"]}')
    entry = write(tmp_path, "src/main.ts", "export const x = 1;")
    write(tmp_path, "examples/unbuilt.ts", 'import "./missing";')
    assert call(tmp_path, "validate_imports")["errors"] == []
    entry.write_text('import "../examples/unbuilt";')
    errors = call(tmp_path, "validate_imports")["errors"]
    assert any(e["file"] == "examples/unbuilt.ts" and "./missing" in e["error"] for e in errors)


def test_validation_excludes_unbuilt_ambient_globals(tmp_path):
    """An excluded ambient script must not hide errors in included modules."""
    write(tmp_path, "tsconfig.json", '{"include":["src/**/*.ts"]}')
    write(tmp_path, "src/main.ts", "export const x = onlyInExample;")
    write(tmp_path, "examples/globals.d.ts", "declare const onlyInExample: number;")
    errors = call(tmp_path, "validate_imports")["errors"]
    assert any(e["file"] == "src/main.ts" and "onlyInExample" in e["error"] for e in errors)


def test_validation_membership_uses_created_batch_paths(tmp_path):
    """A previously unbuilt source creates a diagnostic when it enters the include set."""
    write(tmp_path, "tsconfig.json", '{"include":["src/**/*.ts"]}')
    write(tmp_path, "src/main.ts", "export {};")
    write(tmp_path, "examples/unbuilt.ts", 'import "missing-external";')
    error = call(tmp_path, "batch", ok=False, fail_on_new_errors=True, apply=True, operations=[
        {"operation": "move_module", "source": "examples/unbuilt.ts", "target": "src/built.ts"},
    ])
    assert "src/built.ts" in error and "missing-external" in error
    assert (tmp_path / "examples/unbuilt.ts").exists() and not (tmp_path / "src/built.ts").exists()


def test_generated_package_import_cannot_bind_paths_stub(tmp_path):
    """Refuse if an importer's alias shadows the destination package subpath."""
    write(tmp_path, "package.json", '{"workspaces":["packages/*"]}')
    for name in ["old", "ui", "site"]:
        rows = {"./x": "./x.ts"} if name == "old" else {}
        write(tmp_path, f"packages/{name}/package.json", json.dumps({"name": "@acme/" + name, "exports": rows}))
    write(tmp_path, "packages/old/x.ts", "export const x = 1;")
    write(tmp_path, "packages/site/stub.ts", "export const other = 2;")
    write(tmp_path, "packages/site/tsconfig.json", json.dumps({"compilerOptions": {
        "moduleResolution": "bundler", "module": "ESNext", "paths": {"@acme/ui/x": ["./stub.ts"]},
    }}))
    write(tmp_path, "packages/site/use.ts", 'import {x} from "@acme/old/x";\nexport {x};')
    before = snapshot(tmp_path)
    error = call(tmp_path, "batch", ok=False, apply=True, fail_on_new_errors=True, operations=[
        {"operation": "move_module", "source": "packages/old/x.ts", "target": "packages/ui/x.ts",
         "export_as": "./x"},
    ])
    assert "site/use.ts" in error and "stub.ts" in error
    assert snapshot(tmp_path) == before


@pytest.mark.parametrize("operation", ["move_module", "delete_module"])
def test_ancestor_exports_follow_member_file(tmp_path, operation):
    """Update or remove every ancestor row when a member file moves or disappears."""
    root_manifest = write(tmp_path, "package.json", json.dumps({
        "name": "@acme/root", "workspaces": ["packages/*"], "exports": {"./public": "./packages/a/x.ts"},
    }))
    member_manifest = write(tmp_path, "packages/a/package.json",
                            '{"name":"@acme/a","exports":{"./x":"./x.ts"}}')
    write(tmp_path, "packages/a/x.ts", "export const x = 1;")
    kwargs = {"source": "packages/a/x.ts"}
    if operation == "move_module":
        kwargs["target"] = "packages/a/y.ts"
    before = snapshot(tmp_path)
    preview = call(tmp_path, operation, **kwargs)
    assert snapshot(tmp_path) == before
    result = call(tmp_path, operation, apply=True, **kwargs)
    assert result["affected_files"] == preview["affected_files"]
    assert "package.json" in result["affected_files"] and "packages/a/package.json" in result["affected_files"]
    after = json.loads(root_manifest.read_text())["exports"], json.loads(member_manifest.read_text())["exports"]
    assert after == (({"./public": "./packages/a/y.ts"}, {"./x": "./y.ts"}) if "target" in kwargs else ({}, {}))


@pytest.mark.parametrize("source", ["x.ts", "x.js"])
def test_ambiguous_runtime_and_typescript_export_refuses(tmp_path, source):
    """A physical JS export cannot redirect either its runtime or TypeScript counterpart."""
    write(tmp_path, "package.json", '{"name":"@acme/ui","exports":{"./x":"./x.js"}}')
    write(tmp_path, "x.ts", "export const typed = 1;")
    write(tmp_path, "x.js", "exports.runtime = 2;")
    before = snapshot(tmp_path)
    error = call(tmp_path, "move_module", source=source, target="new" + source[1:], apply=True, ok=False)
    assert "package.json" in error and "x.ts" in error and "x.js" in error
    assert snapshot(tmp_path) == before


@pytest.mark.parametrize("config_file", ["tsconfig.json", "base.json"])
def test_commit_rechecks_resolution_config(tmp_path, monkeypatch, config_file):
    """Compare both direct and inherited compiler settings inside the write lock."""
    config = {"compilerOptions": {"paths": {"~/*": ["./src/*"]}, "module": "ESNext", "moduleResolution": "bundler"}}
    write(tmp_path, config_file, json.dumps(config))
    if config_file != "tsconfig.json":
        write(tmp_path, "tsconfig.json", '{"extends":"./base.json"}')
    write(tmp_path, "src/a.ts", "export const x = 1;")
    write(tmp_path, "copies/b.ts", "export const other = 2;")
    use = write(tmp_path, "use.ts", 'import {x} from "~/a";\nexport {x};')
    original = snapshot(tmp_path)
    replacement = json.dumps(config).replace("./src/*", "./copies/*")
    fault = write(tmp_path, "fault.cjs",
                  'const fs = require("node:fs"); const original = fs.mkdirSync;\n'
                  'fs.mkdirSync = function(p, ...args) {\n'
                  '  if (String(p).endsWith(".refactory-write.lock")) fs.writeFileSync('
                  + json.dumps(str(tmp_path / config_file)) + ', ' + json.dumps(replacement) + ');\n'
                  '  return original(p, ...args);\n};')
    monkeypatch.setenv("NODE_OPTIONS", f'--require="{fault}"')
    error = call(tmp_path, "move_module", source="src/a.ts", target="src/b.ts", apply=True, ok=False)
    assert config_file in error and "changed" in error
    assert use.read_bytes() == original["use.ts"] and (tmp_path / "src/a.ts").exists()
    assert not (tmp_path / "src/b.ts").exists()


def test_alias_to_package_directory_uses_staged_manifest(tmp_path):
    """Retarget through a directory alias after an earlier step changes its package entry."""
    write(tmp_path, "package.json", '{"workspaces":["packages/*"]}')
    write(tmp_path, "packages/ui/package.json", '{"name":"@acme/ui","main":"./src/item.ts"}')
    write(tmp_path, "packages/site/package.json", '{"name":"@acme/site"}')
    write(tmp_path, "packages/site/tsconfig.json", json.dumps({"compilerOptions": {
        "module": "ESNext", "moduleResolution": "bundler", "paths": {"entry-alias": ["../ui"]},
    }}))
    write(tmp_path, "packages/ui/src/item.ts", "export const x = 1;")
    write(tmp_path, "packages/site/temp.ts", "export const x = 2;")
    consumer = write(tmp_path, "packages/site/use.ts", 'import {x} from "./temp"; export {x};')
    call(tmp_path, "batch", apply=True, fail_on_new_errors=True, operations=[
        {"operation": "move_module", "source": "packages/ui/src/item.ts", "target": "packages/ui/src/new.ts"},
        {"operation": "replace_module", "source": "packages/site/temp.ts", "target": "entry-alias"},
    ])
    assert 'from "@acme/ui"' in consumer.read_text()


def test_batch_cannot_move_a_resolution_config_as_an_asset(tmp_path):
    """Preserve a custom-named config consumed by an earlier resolution lookup."""
    write(tmp_path, "tsconfig.json", '{"extends":"./options.json"}')
    write(tmp_path, "options.json", '{"compilerOptions":{"module":"ESNext"}}')
    write(tmp_path, "item.ts", "export const x = 1;")
    before = snapshot(tmp_path)
    error = call(tmp_path, "batch", ok=False, apply=True, operations=[
        {"operation": "move_module", "source": "options.json", "target": "moved.json"},
    ])
    assert "options.json" in error and "config" in error
    assert snapshot(tmp_path) == before


def test_alias_cannot_mask_unexported_workspace_subpath_in_validation(tmp_path):
    """A compiler alias does not provide a runtime workspace export."""
    write(tmp_path, "package.json", '{"workspaces":["packages/*"]}')
    write(tmp_path, "packages/ui/package.json", '{"name":"@acme/ui","exports":{}}')
    write(tmp_path, "packages/site/package.json", '{"name":"@acme/site"}')
    write(tmp_path, "packages/site/tsconfig.json", json.dumps({"compilerOptions": {
        "module": "ESNext", "moduleResolution": "bundler", "paths": {"@acme/ui/private": ["./stub.ts"]},
    }}))
    write(tmp_path, "packages/site/stub.ts", "export const x = 0;")
    write(tmp_path, "packages/site/main.ts", 'export {x} from "@acme/ui/private";')
    errors = call(tmp_path, "validate_imports")["errors"]
    assert any(e["file"] == "packages/site/main.ts" and "@acme/ui/private" in e["error"] for e in errors)


@pytest.mark.parametrize("public", [True, False])
def test_replace_workspace_target_cannot_redirect_to_alias_stub(tmp_path, public):
    """Validate both the named public destination and its binding from the importer."""
    write(tmp_path, "package.json", '{"workspaces":["packages/*"]}')
    write(tmp_path, "packages/ui/package.json", json.dumps({
        "name": "@acme/ui", "exports": {"./x": "./item.ts"} if public else {},
    }))
    write(tmp_path, "packages/ui/item.ts", "export const x = 1;")
    write(tmp_path, "packages/site/package.json", '{"name":"@acme/site"}')
    write(tmp_path, "packages/site/tsconfig.json", json.dumps({"compilerOptions": {
        "module": "ESNext", "moduleResolution": "bundler", "paths": {"@acme/ui/x": ["./stub.ts"]},
    }}))
    write(tmp_path, "packages/site/stub.ts", "export const x = 0;")
    write(tmp_path, "packages/site/old.ts", "export const x = 3;")
    write(tmp_path, "packages/site/main.ts", 'export {x} from "./old";')
    before = snapshot(tmp_path)
    error = call(tmp_path, "replace_module", source="packages/site/old.ts", target="@acme/ui/x", apply=True, ok=False)
    assert ("stub.ts" in error and "site/main.ts" in error) if public else "ui/package.json" in error
    assert snapshot(tmp_path) == before
