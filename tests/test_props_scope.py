"""Check the semantic scope of component migrations."""

import json

from tests.test_workspace_batch import run


def test_props_checks_consumers_of_declaration_and_barrel_without_loading_unrelated_types(tmp_path, monkeypatch):
    (tmp_path / "package.json").write_text('{"workspaces":["packages/*"]}')
    for name in ("ui", "site", "tools"):
        folder = tmp_path / "packages" / name
        folder.mkdir(parents=True)
        (folder / "package.json").write_text(json.dumps({
            "name": "@acme/" + name, "exports": {"./button": "./button.tsx", "./entry": "./entry.ts"},
        }))
        (folder / "tsconfig.json").write_text('{"compilerOptions":{"module":"ESNext","moduleResolution":"Bundler",'
                                              '"moduleDetection":"legacy","jsx":"preserve","types":[]}}')
    ui = tmp_path / "packages/ui"
    (ui / "button.tsx").write_text('export const Button = (p: any) => null;')
    (ui / "entry.ts").write_text('export {Button as Action} from "./button";')
    site = tmp_path / "packages/site"
    (site / "a.tsx").write_text('import {Button} from "@acme/ui/button"; export const a = <Button old/>;')
    (site / "barrel.ts").write_text('import * as api from "@acme/ui/entry"; export {api};')
    (site / "b.tsx").write_text('import {api} from "./barrel"; export const b = <api.Action old/>;')
    tools = tmp_path / "packages/tools"
    (tools / "globals.ts").write_text('declare var unrelated: number;')
    (tools / "cli.ts").write_text('import {Helper} from "@acme/auxiliary"; export const t: Helper = {};\n'
                                  'export const fixture = new URL("./sample.txt", import.meta.url);')
    (tools / "sample.txt").write_text("fixture")
    dependency = tmp_path / "node_modules/@acme/auxiliary"
    dependency.mkdir(parents=True)
    (dependency / "package.json").write_text('{"name":"@acme/auxiliary","types":"./index.d.ts"}')
    declaration = dependency / "index.d.ts"
    declaration.write_text("export interface Helper {}")
    log = dependency / "reads.log"
    preload = tmp_path / "trace.cjs"
    preload.write_text(
        'const fs = require("node:fs"); const original = fs.readFileSync;\n'
        f'fs.readFileSync = function(file, ...rest) {{ if (file === {json.dumps(str(declaration))}) '
        f'fs.appendFileSync({json.dumps(str(log))}, "read\\n"); return original.call(this, file, ...rest); }};'
    )
    monkeypatch.setenv("NODE_OPTIONS", f'--require="{preload}"')
    result = run(tmp_path, "rewrite_props", module="packages/ui/entry.ts", export_name="Action",
                 rules=[{"prop": "old", "replace": [{"prop": "fresh"}]}], apply=True)
    assert set(result["affected_files"]) == {"packages/site/a.tsx", "packages/site/b.tsx"}
    assert result["rewritten"] == 2
    assert not log.exists(), "Read a declaration reachable only from an unrelated member"


def test_props_follows_global_namespace_exposed_by_a_barrel(tmp_path):
    (tmp_path / "button.tsx").write_text('export const Button = (p: any) => null;')
    (tmp_path / "bridge.d.ts").write_text('export as namespace Widgets; export * from "./button";')
    (tmp_path / "view.tsx").write_text('const element = <Widgets.Button old/>;')
    result = run(tmp_path, "rewrite_props", module="button.tsx", export_name="Button",
                 rules=[{"prop": "old", "replace": [{"prop": "fresh"}]}], apply=True)
    assert result["affected_files"] == ["view.tsx"]
    assert "<Widgets.Button fresh/>" in (tmp_path / "view.tsx").read_text()


def test_props_file_forwarding_installed_component_includes_direct_importers(tmp_path):
    package = tmp_path / "node_modules/@acme/widgets"
    package.mkdir(parents=True)
    (tmp_path / "tsconfig.json").write_text('{"compilerOptions":{"module":"esnext","moduleResolution":"bundler"}}')
    (package / "package.json").write_text('{"name":"@acme/widgets","types":"index.d.ts"}')
    (package / "index.d.ts").write_text("export declare function Button(props: any): any;")
    (tmp_path / "entry.ts").write_text('export {Button as Action} from "@acme/widgets";')
    (tmp_path / "view.tsx").write_text('import {Button} from "@acme/widgets"; export const view = <Button old/>;')
    result = run(tmp_path, "rewrite_props", module="entry.ts", export_name="Action",
                 rules=[{"prop": "old", "replace": [{"prop": "fresh"}]}], apply=True)
    assert result["affected_files"] == ["view.tsx"]


def test_validation_keeps_member_globals_separate_while_sharing_installed_declarations(tmp_path):
    (tmp_path / "package.json").write_text('{"workspaces":["packages/*"]}')
    dependency = tmp_path / "node_modules/@acme/shared"
    dependency.mkdir(parents=True)
    (dependency / "package.json").write_text('{"name":"@acme/shared","types":"index.d.ts"}')
    (dependency / "index.d.ts").write_text("export type Row = ReadonlyArray<string>;")
    for name in ("a", "b"):
        package = tmp_path / "packages" / name
        package.mkdir(parents=True)
        (package / "package.json").write_text(json.dumps({"name": "@acme/" + name}))
        (package / "tsconfig.json").write_text('{"compilerOptions":{"module":"esnext","moduleResolution":"bundler",'
                                               '"moduleDetection":"legacy","lib":["esnext"]}}')
        (package / "view.ts").write_text('import type {Row} from "@acme/shared"; export const data: Row = sample;')
    (tmp_path / "packages/a/globals.ts").write_text('declare const sample: readonly string[];')
    errors = run(tmp_path, "validate_imports")["errors"]
    assert [(error["file"], error["code"]) for error in errors] == [("packages/b/view.ts", 2304)]
    assert "sample" in errors[0]["error"]
