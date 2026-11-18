"""Exercise ordered plans and the byte-for-byte commit boundary."""

import json
import subprocess
import time
from pathlib import Path

import pytest


ENGINE = Path(__file__).resolve().parents[1] / "server" / "tsmorph" / "refactor.js"


def run(root, operation, *, refused=False, **options):
    """Call the CLI using the same request fields as MCP."""
    payload = {"project_root": str(root), **options}
    proc = subprocess.run(["node", str(ENGINE), operation, "-"], input=json.dumps(payload),
                          capture_output=True, text=True, timeout=120)
    if refused:
        assert proc.returncode != 0, proc.stdout
        return json.loads(proc.stderr)["error"]
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def snapshot(root):
    """Read all project files, including binary assets."""
    return {str(path.relative_to(root)): path.read_bytes() for path in root.rglob("*") if path.is_file()}


def test_ordered_plan_and_refusal_index(tmp_path):
    (tmp_path / "button.ts").write_text("export const Button = 0;\n")
    (tmp_path / "clean.ts").write_text("export const Button = 1;\n")
    (tmp_path / "registry.ts").write_text('export const rows = {"button": () => import("./clean")};\n')
    operations = [
        {"operation": "delete_module", "source": "button.ts"},
        {"operation": "move_module", "source": "clean.ts", "target": "button.ts"},
        {"operation": "rename_symbol", "file": "button.ts", "old_name": "Button", "new_name": "Action"},
    ]
    before = snapshot(tmp_path)
    preview = run(tmp_path, "batch", operations=operations)
    assert [step["operation"] for step in preview["operations"]] == [step["operation"] for step in operations]
    error = run(tmp_path, "batch", refused=True, apply=True,
                operations=operations + [{"operation": "delete_module", "source": "missing.ts"}])
    assert "batch[3]" in error and "missing.ts" in error
    assert snapshot(tmp_path) == before
    applied = run(tmp_path, "batch", apply=True, operations=operations)
    assert applied["affected_files"] == preview["affected_files"]
    assert (tmp_path / "button.ts").read_text() == "export const Action = 1;\n"
    assert not (tmp_path / "clean.ts").exists()
    assert 'import("./button")' in (tmp_path / "registry.ts").read_text()


def test_delete_checks_final_importers(tmp_path):
    (tmp_path / "a.ts").write_text('import "./b";\n')
    (tmp_path / "b.ts").write_text('import "./a";\n')
    (tmp_path / "c.ts").write_text('require("./a");\n')
    before = snapshot(tmp_path)
    error = run(tmp_path, "delete_module", refused=True, source="a.ts", apply=True)
    assert "b.ts" in error and "c.ts" in error
    ops = [{"operation": "delete_module", "source": name + ".ts"} for name in ["b", "a", "c"]]
    assert "batch[1]" in run(tmp_path, "batch", refused=True, operations=ops[:2], apply=True)
    assert snapshot(tmp_path) == before
    run(tmp_path, "batch", operations=ops, apply=True)
    assert not snapshot(tmp_path)


def test_fail_on_new_errors_includes_overwrite_and_keeps_old_errors(tmp_path):
    (tmp_path / "old.ts").write_text("export const Old = 1;")
    (tmp_path / "new.ts").write_text("export const New = 2;")
    (tmp_path / "use.ts").write_text('import { Old } from "./old";\nimport "./already-missing";\n')
    ops = [{"operation": "move_module", "source": "new.ts", "target": "old.ts", "overwrite": True}]
    before = snapshot(tmp_path)
    assert "Old" in run(tmp_path, "batch", operations=ops, apply=True, fail_on_new_errors=True, refused=True)
    assert snapshot(tmp_path) == before
    run(tmp_path, "batch", operations=[], fail_on_new_errors=True)


def test_cannot_stage_through_symlinks_or_skipped_directories(tmp_path):
    (tmp_path / "a.ts").write_text("export const a = 1;")
    (tmp_path / "build").mkdir()
    (tmp_path / "link").symlink_to(tmp_path / "build", target_is_directory=True)
    for target in ["link/a.ts", "dist/a.ts", "../a.ts"]:
        run(tmp_path, "move_module", refused=True, apply=True, source="a.ts", target=target)
    assert list((tmp_path / "build").iterdir()) == []
    assert (tmp_path / "a.ts").exists()


def test_assets_in_moves_and_deletes(tmp_path):
    (tmp_path / "icon.svg").write_bytes(b"<svg/>")
    (tmp_path / "theme.module.css").write_text("body {}")
    (tmp_path / "shared.json").write_text("{}")
    (tmp_path / "widget.ts").write_text(
        'import styles from "./theme.module.css";\nimport "./icon.svg";\nimport "./shared.json";\n')
    (tmp_path / "other.ts").write_text('import "./shared.json";')
    (tmp_path / "all.css").write_text('@import "./theme.module.css";')
    opts = dict(source="widget.ts", target="components/widget.ts", companions="auto")
    before = snapshot(tmp_path)
    preview = run(tmp_path, "move_module", **opts)
    assert snapshot(tmp_path) == before
    assert sorted(preview["affected_files"]) == ["components/icon.svg", "components/widget.ts", "icon.svg", "widget.ts"]
    run(tmp_path, "move_module", **opts, apply=True)
    text = (tmp_path / "components/widget.ts").read_text()
    for spec in ["../theme.module.css", "./icon.svg", "../shared.json"]:
        assert spec in text
    error = run(tmp_path, "delete_module", source="theme.module.css", refused=True)
    assert "all.css" in error and "widget.ts" in error
    result = run(tmp_path, "move_module", source="theme.module.css", target="theme.css", apply=True)
    assert any("all.css" in warning for warning in result["warnings"])
    assert "../theme.css" in (tmp_path / "components/widget.ts").read_text()
    run(tmp_path, "delete_module", source="components/widget.ts", companions=["components/icon.svg"], apply=True)
    assert not (tmp_path / "components/icon.svg").exists()


def test_validate_catches_missing_ambient_and_unexported_subpath(tmp_path):
    (tmp_path / "package.json").write_text('{"workspaces":["packages/*"]}')
    package = tmp_path / "packages/ui"
    package.mkdir(parents=True)
    (package / "package.json").write_text('{"name":"@acme/ui","exports":{"./button":"./button.ts"}}')
    (package / "button.ts").write_text("export const Button = 1")
    (package / "private.ts").write_text("export const Private = 2")
    (tmp_path / "types.d.ts").write_text('declare module "*.css"; declare module "@acme/ui/private";')
    (tmp_path / "app.ts").write_text('import "./lost.css"; import "@acme/ui/private";')
    errors = run(tmp_path, "validate_imports")["errors"]
    assert all(any(name in e["error"] for e in errors) for name in ["lost.css", "@acme/ui/private"])


@pytest.mark.performance
def test_batch_500_on_1000_files(tmp_path):
    """Measure a package migration including edits to a shared dynamic-import registry."""
    (tmp_path / "package.json").write_text('{"workspaces":["packages/*","apps/*"]}')
    for kind, name in [("packages", "old"), ("packages", "ui"), ("apps", "site")]:
        package = tmp_path / kind / name
        package.mkdir(parents=True)
        (package / "tsconfig.json").write_text('{"extends":"../../tsconfig.base.json"}')
        exports = {f"./item-{i}": f"./item-{i}.ts" for i in range(500)} if name == "old" else {}
        (package / "package.json").write_text(json.dumps({"name": "@acme/" + name, "exports": exports}, indent=2))
    (tmp_path / "tsconfig.base.json").write_text('{"compilerOptions":{"module":"ESNext","moduleResolution":"bundler"}}')
    ops, registry = [], []
    for i in range(500):
        name = f"item-{i}"
        (tmp_path / f"packages/old/{name}.ts").write_text(f"export const value = {i};\n")
        if i:
            (tmp_path / f"apps/site/use-{i}.ts").write_text(f'import {{ value }} from "@acme/old/{name}";\n')
        registry.append(f'  "{name}": () => import("@acme/old/{name}"),\n')
        ops.append({"operation": "move_module", "source": f"packages/old/{name}.ts",
                    "target": f"packages/ui/{name}.ts", "export_as": f"./{name}"})
    (tmp_path / "apps/site/registry.ts").write_text("export const registry = {\n" + "".join(registry) + "};\n")
    plan = tmp_path / "plan.json"
    plan.write_text(json.dumps({"operations": ops}))
    start = time.monotonic()
    result = run(tmp_path, "batch", payload_file="plan.json", apply=True)
    elapsed = time.monotonic() - start
    print(f"500 cross-package moves on 1000 sources: {elapsed:.2f}s")
    assert elapsed < 90
    assert len(result["operations"]) == 500
    assert (tmp_path / "apps/site/registry.ts").read_text().count("@acme/ui/") == 500


def test_diff_counts_limit_and_parser_refusal(tmp_path):
    config = {"compilerOptions": {"unrecognizedFutureOption": True, "module": "ESNext"}}
    (tmp_path / "tsconfig.json").write_text(json.dumps(config))
    (tmp_path / "button.ts").write_text("export const button = 1;\n")
    kwargs = {"source": "button.ts", "target": "control.ts", "diff": True}
    full = run(tmp_path, "move_module", **kwargs)
    assert "unrecognizedFutureOption" in " ".join(full["warnings"])
    assert "--- a/button.ts" in full["diff"] and "+++ b/control.ts" in full["diff"]
    assert full["stats"] == [{"path": "button.ts", "added": 0, "removed": 1},
                             {"path": "control.ts", "added": 1, "removed": 0}]
    short = run(tmp_path, "move_module", **kwargs, diff_limit=80)
    assert short["diff_truncated"] and short["diff"].endswith("[diff truncated]\n")
    assert len(short["diff"].encode()) <= 80
    (tmp_path / "button.ts").write_text("export const = ;")
    error = run(tmp_path, "move_module", **kwargs, refused=True, apply=True)
    assert "TypeScript " in error and ".ts" in error
    assert not (tmp_path / "control.ts").exists()


def test_binary_move_with_exports_is_byte_preserving(tmp_path):
    (tmp_path / "package.json").write_text('{ "exports": { "./image": "./icon.png" } }')
    icon = tmp_path / "icon.png"
    icon.write_bytes(b"\x00\xff\x01")
    (tmp_path / "use.ts").write_text('import "./icon.png";')
    result = run(tmp_path, "move_module", source="icon.png", target="assets/new.png", diff=True, apply=True)
    assert (tmp_path / "assets/new.png").read_bytes() == b"\x00\xff\x01"
    assert "Binary files" in result["diff"]
    assert '"./assets/new.png"' in (tmp_path / "package.json").read_text()
    assert '"./assets/new.png"' in (tmp_path / "use.ts").read_text()


def test_second_move_follows_unchanged_public_specifier(tmp_path):
    (tmp_path / "package.json").write_text('{"workspaces":["packages/*"]}')
    for name in ["old", "new"]:
        member = tmp_path / "packages" / name
        member.mkdir(parents=True)
        rows = {"./item": "./item.ts"} if name == "old" else {}
        (member / "package.json").write_text(json.dumps({"name": "@acme/" + name, "exports": rows}))
    (tmp_path / "packages/old/item.ts").write_text("export const x = 1;")
    (tmp_path / "app.ts").write_text('import {x} from "@acme/old/item";')
    ops = [
        {"operation": "move_module", "source": "packages/old/item.ts", "target": "packages/old/sub/item.ts"},
        {"operation": "move_module", "source": "packages/old/sub/item.ts", "target": "packages/new/item.ts",
         "export_as": "./button"},
    ]
    run(tmp_path, "batch", apply=True, operations=ops)
    assert '"@acme/new/button"' in (tmp_path / "app.ts").read_text()


def test_shadowing_an_existing_directory_module_refuses(tmp_path):
    (tmp_path / "button").mkdir()
    (tmp_path / "button/index.ts").write_text("export const legacy = 1;")
    (tmp_path / "use.ts").write_text('import "./button";')
    (tmp_path / "new.ts").write_text("export const replacement = 1;")
    before = snapshot(tmp_path)
    error = run(tmp_path, "move_module", source="new.ts", target="button.ts", apply=True, refused=True)
    assert "use.ts" in error
    assert snapshot(tmp_path) == before


def test_failed_commit_restores_code_assets_and_manifests(tmp_path):
    (tmp_path / "package.json").write_text('{"exports":{"./component":"./component.ts"}}')
    (tmp_path / "component.ts").write_text('import "./style.css";')
    (tmp_path / "style.css").write_text("body {}")
    before = snapshot(tmp_path)
    fault = tmp_path / "fault.cjs"
    fault.write_text(
        'const fs = require("node:fs"); const rename = fs.renameSync; let installs = 0;\n'
        'fs.renameSync = function(a, b) {\n'
        '  if (a.endsWith(".refactory-tmp") && ++installs === 2) throw new Error("injected install failure");\n'
        '  return rename(a,b);\n'
        '};'
    )
    before["fault.cjs"] = fault.read_bytes()
    args = {"project_root": str(tmp_path), "source": "component.ts", "target": "new/widget.ts",
            "companions": "auto", "apply": True}
    result = subprocess.run(["node", "--require", str(fault), str(ENGINE), "move_module", json.dumps(args)],
                            capture_output=True, text=True)
    assert "injected install failure" in result.stderr
    assert snapshot(tmp_path) == before
    assert not (tmp_path / "new").exists()


def test_batch_hands_new_module_to_every_semantic_operation(tmp_path):
    (tmp_path / "tsconfig.json").write_text('{"compilerOptions":{"module":"ESNext","jsx":"preserve"}}')
    (tmp_path / "old.tsx").write_text("export const Button = (p: any) => null;")
    (tmp_path / "clean.tsx").write_text("export interface Props { tone: string }\nexport const Button = (p: Props) => null;")
    (tmp_path / "view.tsx").write_text('import {Button} from "./old"; export const view = <Button color="red"/>;')
    (tmp_path / "util.ts").write_text("export function help() { return 1; }")
    ops = [
        {"operation": "move_module", "source": "clean.tsx", "target": "button.tsx"},
        {"operation": "replace_module", "source": "old.tsx", "target": "button.tsx"},
        {"operation": "delete_module", "source": "old.tsx"},
        {"operation": "rewrite_props", "module": "button.tsx", "export_name": "Button",
         "rules": [{"prop": "color", "replace": [{"prop": "tone"}]}], "fail_on_manual": True},
        {"operation": "rename_symbol", "file": "button.tsx", "old_name": "Props.tone", "new_name": "variant"},
        {"operation": "move_symbol", "source_file": "util.ts", "target_file": "button.tsx", "symbol_name": "help"},
    ]
    preview = run(tmp_path, "batch", operations=ops, diff=True, fail_on_new_errors=True)
    applied = run(tmp_path, "batch", apply=True, operations=ops, diff=True, fail_on_new_errors=True)
    assert preview["diff"] == applied["diff"]
    assert '<Button variant="red"/>' in (tmp_path / "view.tsx").read_text()
    assert "export function help()" in (tmp_path / "button.tsx").read_text()
    assert not (tmp_path / "old.tsx").exists()


def test_symlink_import_of_moved_file_refuses(tmp_path):
    item = tmp_path / "item.ts"
    item.write_text("export const Item = 1;")
    (tmp_path / "linked.ts").symlink_to(item)
    (tmp_path / "app.ts").write_text('import {Item} from "./linked";')
    assert "symlink" in run(tmp_path, "move_module", source="item.ts", target="new.ts", apply=True, refused=True)
    assert item.is_file() and not (tmp_path / "new.ts").exists()


def test_stale_plan_does_not_miss_concurrent_importer(tmp_path):
    (tmp_path / "item.ts").write_text("export const Item = 1;")
    fault = tmp_path / "concurrent.cjs"
    fault.write_text(
        'const fs = require("node:fs"); const mkdir = fs.mkdirSync;\n'
        'fs.mkdirSync = function(p, ...args) {\n'
        '  if (String(p).endsWith(".refactory-write.lock")) fs.writeFileSync('
        + json.dumps(str(tmp_path / "another.ts")) + ', \'import "./item";\');\n'
        '  return mkdir(p, ...args);\n};'
    )
    args = {"project_root": str(tmp_path), "source": "item.ts", "target": "new.ts", "apply": True}
    result = subprocess.run(["node", "--require", str(fault), str(ENGINE), "move_module", json.dumps(args)],
                            capture_output=True, text=True)
    assert "changed during planning" in result.stderr
    assert (tmp_path / "item.ts").is_file() and not (tmp_path / "new.ts").exists()
    assert not (tmp_path / ".refactory-write.lock").exists()


def test_move_symbol_rebases_lazy_module_reference(tmp_path):
    (tmp_path / "tsconfig.json").write_text('{"compilerOptions":{"module":"ESNext"}}')
    (tmp_path / "source.ts").write_text('export function load() { return import("./item"); }')
    (tmp_path / "item.ts").write_text("export const value = 1;")
    run(tmp_path, "move_symbol", source_file="source.ts", target_file="inner/target.ts",
        symbol_name="load", apply=True)
    assert 'import("../item")' in (tmp_path / "inner/target.ts").read_text()
