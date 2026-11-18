"""Exercise replacing a public entry with several independently checked targets."""
import json

import pytest

from tests.test_e2e_mcp import call_json, open_mcp_session
from tests.test_workspace_batch import run, snapshot


@pytest.fixture
def entries(tmp_path):
    """Create three source-export workspace members without package-manager symlinks."""
    (tmp_path / "package.json").write_text('{"workspaces":["packages/*"]}')
    for name, exports in [
        ("effects", {".": "./src/index.ts", "./primitives": "./src/index.ts"}),
        ("motion", {"./fade": "./src/fade.ts", "./scroll": "./src/scroll.ts"}),
        ("app", {}),
    ]:
        pkg = tmp_path / "packages" / name
        (pkg / "src").mkdir(parents=True)
        (pkg / "tsconfig.json").write_text('{"compilerOptions":{"module":"ESNext","moduleResolution":"bundler"}}')
        (pkg / "package.json").write_text(json.dumps({"name": "@acme/" + name, "exports": exports}))
    (tmp_path / "packages/effects/src/index.ts").write_text(
        "export const Fade=1, Scroll=2; export type Props = {}; export default Fade;"
    )
    (tmp_path / "packages/motion/src/fade.ts").write_text("export const Fade=1; export type Options = {};")
    (tmp_path / "packages/motion/src/scroll.ts").write_text("export const Ticker=2;")
    return tmp_path


ROUTES = {
    "Fade": {"target": "@acme/motion/fade"},
    "Scroll": {"target": "@acme/motion/scroll", "name": "Ticker"},
    "Props": {"target": "@acme/motion/fade", "name": "Options"},
}


@pytest.mark.parametrize("entry", ["@acme/effects", "@acme/effects/primitives"])
def test_replace_public_entry_splits_imports_and_reexports(entries, entry):
    app = entries / "packages/app/src/view.ts"
    other = "@acme/effects" if entry.endswith("primitives") else "@acme/effects/primitives"
    app.write_text(
        f'import {{ Fade, Scroll as Local, type Props }} from "{entry}";\n'
        f'export type {{ Props as Public }} from "{entry}";\n'
        f'export {{ Fade, Scroll }} from "{entry}";\n'
        f'import type {{ Props as P }} from "{other}";\n'
        'export const x: Props & P = {Fade, Local};'
    )
    before = snapshot(entries)
    step = {"operation": "replace_module", "source": entry, "names": ROUTES}
    kwargs = {"operations": [step], "diff": True, "fail_on_new_errors": True}
    preview = run(entries, "batch", **kwargs)
    assert snapshot(entries) == before
    applied = run(entries, "batch", apply=True, **kwargs)
    assert applied["diff"] == preview["diff"]
    text = app.read_text()
    assert 'from "@acme/motion/fade"' in text and 'from "@acme/motion/scroll"' in text
    assert "Ticker as Local" in text and "Ticker as Scroll" in text
    assert "type Options as Props" in text and "export type { Options as Public }" in text
    assert f'import type {{ Props as P }} from "{other}";' in text
    assert 'export const x: Props & P = {Fade, Local};' in text
    manifest = json.loads((entries / "packages/app/package.json").read_text())
    assert manifest["dependencies"]["@acme/motion"] == "workspace:*"


def test_split_refuses_and_lists_all_unmapped_importers(entries):
    app = entries / "packages/app/src"
    for file in ["a.ts", "b.ts"]:
        (app / file).write_text('import {Fade, Scroll} from "@acme/effects";')
    before = snapshot(entries)
    reason = run(entries, "replace_module", source="@acme/effects", names={"Fade": ROUTES["Fade"]},
                 refused=True, apply=True)
    assert all(s in reason for s in ["Scroll", "a.ts", "b.ts"])
    assert snapshot(entries) == before


@pytest.mark.parametrize("use", [
    'import * as ns from "@acme/effects"; export const all = ns;',
    'export * from "@acme/effects";',
    'import "@acme/effects";',
    'export const loader = () => import("@acme/effects");',
])
def test_split_refuses_without_a_statically_named_destination(entries, use):
    (entries / "packages/app/src/view.ts").write_text(use)
    before = snapshot(entries)
    reason = run(entries, "replace_module", source="@acme/effects", names=ROUTES, refused=True, apply=True)
    assert "view.ts" in reason and "split" in reason.lower()
    assert snapshot(entries) == before


def test_split_checks_each_target_export_and_alias_resolution(entries):
    (entries / "packages/app/src/view.ts").write_text('import {Fade, Scroll} from "@acme/effects";')
    (entries / "packages/motion/src/scroll.ts").write_text("export type Ticker=number;")
    before = snapshot(entries)
    reason = run(entries, "replace_module", source="@acme/effects", names=ROUTES, refused=True, apply=True)
    assert "view.ts" in reason and "Ticker" in reason and "value" in reason
    assert snapshot(entries) == before
    (entries / "packages/app/tsconfig.json").write_text(
        '{"compilerOptions":{"paths":{"@acme/effects":["./src/stub.ts"]}}}'
    )
    (entries / "packages/app/src/stub.ts").write_text("export const Fade=5, Scroll=6;")
    before = snapshot(entries)
    reason = run(entries, "replace_module", source="@acme/effects", names=ROUTES, refused=True, apply=True)
    assert "view.ts" in reason and "stub.ts" in reason
    assert snapshot(entries) == before


def test_package_source_single_target_and_per_name_local_rename(entries):
    app = entries / "packages/app/src/view.ts"
    app.write_text('import {Scroll} from "@acme/effects"; export const value = {Scroll};')
    options = {"source": "@acme/effects", "rename_local": True}
    run(entries, "replace_module", target="@acme/motion/scroll", names={"Scroll": "Ticker"}, **options)
    run(entries, "replace_module", names=ROUTES, apply=True, **options)
    assert 'import { Ticker } from "@acme/motion/scroll";' in app.read_text()
    assert 'value = {Scroll: Ticker}' in app.read_text()


@pytest.mark.asyncio
async def test_mcp_split_names_needs_no_common_target(entries):
    (entries / "packages/app/src/view.ts").write_text('import {Fade, Scroll} from "@acme/effects";')
    request = {"project_root": str(entries), "source": "@acme/effects", "names": ROUTES, "diff": True}
    async with open_mcp_session() as session:
        result = await call_json(session, "replace_module", request)
    assert result["diff"] == run(entries, "replace_module", source="@acme/effects", names=ROUTES, diff=True)["diff"]


@pytest.mark.parametrize("per_name", [True, False])
def test_named_replacement_from_an_unbuilt_public_entry(entries, per_name):
    pkg = entries / "packages/effects/package.json"
    pkg.write_text(json.dumps({"name": "@acme/effects", "exports": {
        ".": {"import": "./dist/index.js", "types": "./dist/index.d.ts"},
    }}))
    app = entries / "packages/app/src/view.ts"
    app.write_text('import {Fade, type Props} from "@acme/effects"; export const all: Props = {Fade};')
    fields = ({"names": ROUTES} if per_name else
              {"target": "@acme/motion/fade", "names": {"Props": "Options"}})
    run(entries, "replace_module", source="@acme/effects", **fields, apply=True)
    assert 'from "@acme/motion/fade"' in app.read_text() and 'type Options as Props' in app.read_text()
    assert run(entries, "validate_imports")["errors"] == []


def test_unbuilt_source_requires_proven_visibility_for_type_positions(entries):
    pkg = entries / "packages/effects/package.json"
    pkg.write_text(json.dumps({"name": "@acme/effects", "exports": {
        ".": {"types": "./dist/index.d.ts", "import": "./dist/index.js"},
    }}))
    (entries / "packages/app/src/view.ts").write_text('import { Fade } from "@acme/effects"; export type A = Fade;')
    before = snapshot(entries)
    reason = run(entries, "replace_module", source="@acme/effects", names=ROUTES, refused=True, apply=True)
    assert "view.ts" in reason and "build" in reason.lower()
    assert snapshot(entries) == before


@pytest.mark.parametrize("comment", ["/* retain this annotation */", "/* @ts-expect-error */\n"])
def test_split_protects_import_comments(entries, comment):
    use = 'import {Fade, Scroll} from "@acme/effects";'
    app = entries / "packages/app/src/view.ts"
    app.write_text(comment + use if "expect-error" in comment else use.replace("Fade,", "Fade," + comment))
    before = snapshot(entries)
    reason = run(entries, "replace_module", source="@acme/effects", names=ROUTES, refused=True, apply=True)
    assert "view.ts" in reason and "annotated" in reason
    assert snapshot(entries) == before


def test_replacement_still_checks_unreferenced_public_destination(entries):
    before = snapshot(entries)
    reason = run(entries, "replace_module", source="packages/effects/src/index.ts",
                 target="@acme/motion/private", refused=True, apply=True)
    assert "does not export" in reason and "@acme/motion/private" in reason
    assert snapshot(entries) == before


def test_resolved_script_cannot_supply_a_named_export(entries):
    (entries / "packages/motion/src/fade.ts").write_text("const Fade=1;")
    (entries / "packages/app/src/view.ts").write_text('import { Fade } from "@acme/effects";')
    before = snapshot(entries)
    error = run(entries, "replace_module", source="@acme/effects", target="@acme/motion/fade", refused=True, apply=True)
    assert "Fade" in error and "view.ts" in error
    assert snapshot(entries) == before


def test_routing_preserves_the_requested_public_subpath(entries):
    app = entries / "packages/app/src/view.ts"
    app.write_text('import {Fade} from "@acme/effects";')
    pkg = entries / "packages/motion/package.json"
    manifest = json.loads(pkg.read_text())
    manifest["exports"]["./client/fade"] = manifest["exports"]["./fade"]
    pkg.write_text(json.dumps(manifest))
    run(entries, "replace_module", source="@acme/effects", names={"Fade": {"target": "@acme/motion/client/fade"}},
        apply=True)
    assert 'from "@acme/motion/client/fade"' in app.read_text()


def test_computed_only_consumer_of_an_unbuilt_package_is_protected(entries):
    pkg = entries / "packages/effects/package.json"
    pkg.write_text(json.dumps({"name": "@acme/effects", "exports": {
        ".": {"types": "./dist/index.d.ts", "import": "./dist/index.js"},
    }}))
    (entries / "packages/app/src/loader.ts").write_text('export const load = () => import("@acme/" + "effects");')
    before = snapshot(entries)
    error = run(entries, "replace_module", source="@acme/effects", names=ROUTES, apply=True, refused=True)
    assert "computed" in error and "loader.ts" in error
    assert snapshot(entries) == before


def test_package_replacement_protects_consumer_type_augmentations(entries):
    pkg = entries / "packages/effects"
    (pkg / "dist").mkdir()
    (pkg / "dist/index.d.ts").write_text("export declare const Fade: number; export interface Props {tone: string}")
    (pkg / "dist/index.js").write_text("export const Fade = 1;")
    (pkg / "package.json").write_text(json.dumps({"name": "@acme/effects", "exports": {
        ".": {"import": "./dist/index.js", "types": "./dist/index.d.ts"},
    }}))
    (entries / "packages/motion/src/fade.ts").write_text("export const Fade = 1; export interface Options {tone: string}")
    app = entries / "packages/app/src"
    (app / "extra.d.ts").write_text('export {}; declare module "@acme/effects" { interface Props { note: string } }')
    (app / "view.ts").write_text('import {Fade, type Props} from "@acme/effects"; export const f=(p: Props)=>p.note + Fade;')
    before = snapshot(entries)
    for apply in (False, True):
        error = run(entries, "replace_module", source="@acme/effects", names=ROUTES, apply=apply, refused=True)
        assert "extra.d.ts" in error and "augment" in error and "@acme/effects" in error
        assert snapshot(entries) == before


def test_public_replacement_avoids_unrelated_member_declarations(entries, monkeypatch):
    pkg = entries / "packages/tools"
    pkg.mkdir()
    (pkg / "package.json").write_text('{"name":"@acme/tools"}')
    (pkg / "tsconfig.json").write_text('{"compilerOptions":{"module":"ESNext","moduleResolution":"bundler"}}')
    (pkg / "main.ts").write_text('export type {Item} from "helper";')
    (pkg / "globals.ts").write_text('declare var toolVersion: string;')
    dependency = pkg / "node_modules/helper"
    dependency.mkdir(parents=True)
    declaration = dependency / "index.d.ts"
    declaration.write_text("export interface Item {value: number;}")
    trace = entries / "trace.cjs"
    log = entries / "reads.log"
    trace.write_text("const fs = require('node:fs'); const read = fs.readFileSync;\n"
                     f"fs.readFileSync = function(file, ...rest) {{ if (file === {json.dumps(str(declaration))}) "
                     f"fs.appendFileSync({json.dumps(str(log))}, 'read\\n'); return read.call(this, file, ...rest); }};")
    (entries / "packages/app/src/view.ts").write_text('import {Fade} from "@acme/effects"; export {Fade};')
    monkeypatch.setenv("NODE_OPTIONS", f'--require="{trace}"')
    result = run(entries, "replace_module", source="@acme/effects", names=ROUTES, apply=True)
    assert "packages/app/src/view.ts" in result["affected_files"]
    assert not log.exists()
