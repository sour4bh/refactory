"""Semantic workspace migrations through the TypeScript CLI."""

import json
import subprocess
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "server" / "tsmorph" / "refactor.js"


def run(root, operation, *, failure=False, **fields):
    result = subprocess.run(
        ["node", str(SCRIPT), operation, json.dumps({"project_root": str(root), "apply": True, **fields})],
        capture_output=True, text=True,
    )
    if failure:
        assert result.returncode, result.stdout
        return json.loads(result.stderr)["error"]
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


@pytest.fixture
def ui_workspace(tmp_path):
    """Create two source packages and a separate consumer with inherited JSX options."""
    (tmp_path / "package.json").write_text(json.dumps({"workspaces": ["packages/*", "apps/*"]}))
    (tmp_path / "tsconfig.base.json").write_text(json.dumps({"compilerOptions": {
        "jsx": "preserve", "module": "ESNext", "moduleResolution": "Bundler", "strict": True,
    }}))
    for path, name in [("packages/old", "@acme/old"), ("packages/ui", "@acme/ui"), ("apps/site", "@acme/site")]:
        package = tmp_path / path
        (package / "src").mkdir(parents=True)
        (package / "tsconfig.json").write_text('{"extends":"../../tsconfig.base.json","include":["src"]}')
        (package / "package.json").write_text(json.dumps({
            "name": name, "exports": {"./button": "./src/button.tsx", "./index": "./src/index.ts"},
        }))
    return tmp_path


def test_replace_all_forms_and_check_exports(ui_workspace):
    old = ui_workspace / "packages/old/src/button.tsx"
    new = ui_workspace / "packages/ui/src/button.tsx"
    app = ui_workspace / "apps/site/src/use.ts"
    old.write_text("export const TextField = 1; export type Props = {}; export default TextField;")
    new.write_text("export const Input = 2; export default Input;")
    app.write_text(
        'import Default, { TextField, type Props } from "@acme/old/button";\n'
        'import * as ns from "@acme/old/button";\n'
        'export { TextField as Field } from "@acme/old/button";\n'
        'const { TextField: value } = require("@acme/old/button");\n'
        'const load = async () => (await import("@acme/old/button")).TextField;\n'
        'const typed: Props = {}; export const all = [Default, TextField, value, ns.TextField, load, typed];\n'
    )
    args = {"source": "packages/old/src/button.tsx", "target": "@acme/ui/button", "names": {"TextField": "Input"}}
    before = app.read_text()
    assert "Props" in run(ui_workspace, "replace_module", failure=True, **args)
    assert app.read_text() == before
    new.write_text(new.read_text() + " export type Props = {};")
    run(ui_workspace, "replace_module", apply=False, **args)
    assert app.read_text() == before
    run(ui_workspace, "replace_module", **args)
    after = app.read_text()
    assert after.count("@acme/ui/button") == 5
    for snippet in ["Input as TextField", "Input as Field", "Input: value", "ns.Input", '")).Input']:
        assert snippet in after
    assert old.exists()
    manifest = json.loads((ui_workspace / "apps/site/package.json").read_text())
    assert manifest["dependencies"]["@acme/ui"] == "workspace:*"


def test_replace_renames_local_without_capturing_other_bindings(ui_workspace):
    old = ui_workspace / "packages/old/src/button.tsx"
    new = ui_workspace / "packages/ui/src/button.tsx"
    app = ui_workspace / "apps/site/src/use.ts"
    old.write_text("export const TextField = 1;")
    new.write_text("export const Input = 2;")
    app.write_text(
        'import { TextField } from "@acme/old/button";\n'
        'export const x = { TextField };\n'
        'export function unrelated(TextField: number) { return TextField; }\n'
    )
    args = {"source": "packages/old/src/button.tsx", "target": "packages/ui/src/button.tsx",
            "names": {"TextField": "Input"}, "renameLocal": True}
    original = app.read_text()
    app.write_text(original + "const Input = 4;")
    assert "capture" in run(ui_workspace, "replace_module", failure=True, **args)
    assert app.read_text() == original + "const Input = 4;"
    app.write_text(original)
    run(ui_workspace, "replace_module", **args)
    assert 'import { Input } from "@acme/ui/button"' in app.read_text()
    assert "x = { TextField: Input }" in app.read_text()
    assert "unrelated(TextField: number) { return TextField; }" in app.read_text()


def test_props_aliases_namespace_and_manual_work(ui_workspace):
    src = ui_workspace / "packages/ui/src"
    (src / "button.tsx").write_text("export const Button = (props: any) => null;")
    (src / "index.ts").write_text('export { Button as Action } from "./button";')
    app = ui_workspace / "apps/site/src/view.tsx"
    app.write_text(
        'import { Action as B } from "@acme/ui/index";\n'
        'import * as ui from "@acme/ui/button";\n'
        'declare const flag: boolean, tone: string, attrs: any;\n'
        'const one = <B primary size={flag ? "sm" : "lg"} hidden/>;\n'
        'const two = <ui.Button tone={tone}></ui.Button>;\n'
        'const three = <B {...attrs} primary/>;\n'
        'const four = <B size={tone}/>;\n'
        'const five = <B primary variant="x"/>;\n'
        'const Alias = B;\n'
        'declare const Other: any, React: any; const six = <Other as={B}/>; React.createElement(B, {});\n'
    )
    args = {"module": "packages/ui/src/button.tsx", "exportName": "Button", "rules": [
        {"prop": "primary", "equals": True, "replace": [{"prop": "variant", "value": "primary"}]},
        {"prop": "size", "equals": "sm", "replace": [{"prop": "size", "value": "small"}]},
        {"prop": "hidden", "replace": []},
        {"prop": "tone", "replace": [{"prop": "color"}]},
        {"prop": "label", "absent": True, "replace": [{"prop": "label", "value": "action"}]},
    ]}
    original = app.read_text()
    assert "manual work" in run(ui_workspace, "rewrite_props", failure=True, failOnManual=True, **args)
    assert app.read_text() == original
    result = run(ui_workspace, "rewrite_props", **args)
    assert result["matched"] == 5
    assert result["rewritten"] == 2
    assert result["left_for_manual"] == 6
    assert {item["line"] for item in result["manual"]} == {6, 7, 8, 9, 10}
    assert '<B variant="primary" size={flag ? "small" : "lg"} label="action"/>' in app.read_text()
    assert '<ui.Button color={tone} label="action"></ui.Button>' in app.read_text()
    assert '<B {...attrs} primary/>' in app.read_text()
    assert '<B primary variant="x"/>' in app.read_text()


def test_member_renames_follow_contextual_types_across_packages(ui_workspace):
    src = ui_workspace / "packages/ui/src/button.tsx"
    src.write_text(
        "export interface Props { tone: string; }\n"
        "export type Options = { size: number };\n"
        "export class Widget { count = 1; }\n"
        "export enum Side { Left }\n"
        "export const Button = (props: Props) => null;\n"
    )
    app = ui_workspace / "apps/site/src/view.tsx"
    app.write_text(
        'import { Props, Options, Widget, Side, Button } from "@acme/ui/button";\n'
        'const tone = "ok"; const p: Props = { tone }; const view = <Button tone={p.tone}/>;\n'
        'function f(p: Props) { const { tone } = p; return tone; }\n'
        'const o: Options = { size: 1 }; new Widget().count; Side.Left;\n'
    )
    operations = [
        {"operation": "rename_symbol", "file": "packages/ui/src/button.tsx", "oldName": old, "newName": new}
        for old, new in [("Props.tone", "variant"), ("Options.size", "scale"),
                         ("Widget.count", "amount"), ("Side.Left", "Start")]
    ]
    run(ui_workspace, "batch", operations=operations)
    output = app.read_text()
    assert 'const p: Props = { variant: tone };' in output
    assert '<Button variant={p.variant}/>' in output
    assert 'const { variant: tone } = p; return tone' in output
    assert '{ scale: 1 }; new Widget().amount; Side.Start;' in output


def test_semantic_edits_after_moving_component_and_changing_export(ui_workspace):
    src = ui_workspace / "packages/old/src/button.tsx"
    src.write_text("export const Button = (props: any) => null;")
    app = ui_workspace / "apps/site/src/view.tsx"
    app.write_text('import { Button as B } from "@acme/old/button";\nexport const v = <B tone="warm"/>;')
    run(ui_workspace, "batch", operations=[
        {"operation": "move_module", "source": "packages/old/src/button.tsx",
         "target": "packages/ui/src/action.tsx", "exportAs": "./action"},
        {"operation": "rewrite_props", "module": "packages/ui/src/action.tsx", "exportName": "Button",
         "rules": [{"prop": "tone", "replace": [{"prop": "variant"}]}], "failOnManual": True},
        {"operation": "rename_symbol", "file": "packages/ui/src/action.tsx", "oldName": "Button", "newName": "Action"},
    ])
    assert 'import { Action as B } from "@acme/ui/action"' in app.read_text()
    assert '<B variant="warm"/>' in app.read_text()


def test_reject_unexported_bare_and_escaping_mapped_namespace(ui_workspace):
    src = ui_workspace / "packages/old/src/button.tsx"
    src.write_text("export const TextField = 1;")
    (ui_workspace / "packages/ui/src/button.tsx").write_text("export const Input = 2;")
    app = ui_workspace / "apps/site/src/use.ts"
    original = 'export const load = () => import("@acme/old/button");'
    app.write_text(original)
    args = {"source": "packages/old/src/button.tsx", "names": {"TextField": "Input"}}
    assert "does not export" in run(ui_workspace, "replace_module", failure=True, target="@acme/ui/private", **args)
    assert "escaping" in run(ui_workspace, "replace_module", failure=True, target="@acme/ui/button", **args)
    assert app.read_text() == original


def test_replace_maps_default_type_star_and_require_properties(ui_workspace):
    (ui_workspace / "packages/old/src/button.tsx").write_text(
        "export default 1; export const Old = 2; export type Props = {};"
    )
    (ui_workspace / "packages/ui/src/button.tsx").write_text(
        "export const Main = 1; export const New = 2; export type Options = {};"
    )
    app = ui_workspace / "apps/site/src/use.ts"
    app.write_text(
        'import Base, { type Props } from "@acme/old/button";\n'
        'const { Old } = require("@acme/old/button");\n'
        'const lazy = import("@acme/old/button").then(mod => mod["Old"]);\n'
        'export const x: Props = { Base, Old, lazy };\n'
    )
    barrel = ui_workspace / "apps/site/src/index.ts"
    barrel.write_text('export * from "@acme/old/button";')
    run(ui_workspace, "replace_module", source="packages/old/src/button.tsx", target="@acme/ui/button",
        names={"default": "Main", "Old": "New", "Props": "Options"})
    after = app.read_text()
    for part in ["Main as Base", "type Options as Props", "{ New: Old }", 'mod["New"]', "x: Props"]:
        assert part in after
    assert "type Options as Props" in barrel.read_text()
    assert "New as Old" in barrel.read_text()


def test_renaming_members_or_imports_refuses_collisions(ui_workspace):
    src = ui_workspace / "packages/old/src/button.tsx"
    src.write_text("export interface Props { size: number; count: number }; export const A=1, B=2;")
    (ui_workspace / "packages/ui/src/button.tsx").write_text("export const Value = 3;")
    app = ui_workspace / "apps/site/src/use.ts"
    app.write_text('import { A } from "@acme/old/button"; import { B } from "@acme/old/button"; export const x = [A,B];')
    before = (src.read_text(), app.read_text())
    assert "already exists" in run(ui_workspace, "rename_symbol", file="packages/old/src/button.tsx",
                                   old_name="Props.size", new_name="count", failure=True)
    assert "Duplicate replacement" in run(ui_workspace, "replace_module", source="packages/old/src/button.tsx",
                                          target="@acme/ui/button", names={"A": "Value", "B": "Value"},
                                          rename_local=True, failure=True)
    assert before == (src.read_text(), app.read_text())


def test_shadowed_require_refuses_without_blocking_other_scopes(ui_workspace):
    old = ui_workspace / "packages/ui/src/button.tsx"
    old.write_text("export const Button = 1;")
    app = ui_workspace / "apps/site/src/use.ts"
    app.write_text(
        'export const value = require("@acme/ui/button").Button;\n'
        'function wrap(require: (s: string) => string) { return require("@acme/ui/button"); }\n'
    )
    args = {"source": "packages/ui/src/button.tsx", "target": "packages/old/src/action.tsx", "export_as": "./action"}
    before = app.read_text()
    assert "shadowed" in run(ui_workspace, "move_module", failure=True, **args)
    assert old.exists() and app.read_text() == before
    app.write_text(before.replace('return require("@acme/ui/button")', 'return require("unrelated")'))
    run(ui_workspace, "move_module", **args)
    assert 'value = require("@acme/old/action")' in app.read_text()
    assert 'return require("unrelated")' in app.read_text()


def test_computed_imports_are_checked_in_final_workspace(ui_workspace):
    old = ui_workspace / "packages/old/src/button.tsx"
    old.write_text("export const Button = 1;")
    (ui_workspace / "packages/ui/src/button.tsx").write_text("export const Button = 2;")
    app = ui_workspace / "apps/site/src/use.ts"
    dynamic = 'export const load = (name: string) => import(`@acme/old/${name}`);'
    app.write_text(dynamic)
    args = {"source": "packages/old/src/button.tsx", "target": "packages/ui/src/button.tsx"}
    reason = run(ui_workspace, "replace_module", failure=True, **args)
    assert "computed module reference" in reason and "apps/site/src/use.ts:1" in reason
    reason = run(ui_workspace, "delete_module", source=args["source"], failure=True)
    assert "apps/site/src/use.ts" in reason
    assert old.exists() and app.read_text() == dynamic
    app.write_text(
        'declare const want: boolean; export const load = () => import(want ? "@acme/ui/button" : "@acme/ui/index");'
    )
    assert run(ui_workspace, "replace_module", **args)["success"]
    app.write_text(dynamic)
    run(ui_workspace, "batch", operations=[
        {"operation": "delete_module", "source": args["source"]},
        {"operation": "delete_module", "source": "apps/site/src/use.ts"},
    ])
    assert not old.exists() and not app.exists()


def test_external_replacement_checks_installed_export_names(ui_workspace):
    src = ui_workspace / "packages/old/src/button.tsx"
    src.write_text("export const Button = 1;")
    app = ui_workspace / "apps/site/src/use.ts"
    app.write_text('import { Button } from "@acme/old/button"; export const b = Button;')
    external = ui_workspace / "node_modules/@acme/external"
    external.mkdir(parents=True)
    (external / "package.json").write_text('{"name":"@acme/external","types":"index.d.ts"}')
    (external / "index.d.ts").write_text("export declare const Label: number;")
    args = {"source": "packages/old/src/button.tsx", "target": "@acme/external"}
    assert "does not export: Button" in run(ui_workspace, "replace_module", failure=True, **args)
    assert "@acme/old/button" in app.read_text()
    run(ui_workspace, "replace_module", names={"Button": "Label"}, **args)
    assert 'import { Label as Button } from "@acme/external"' in app.read_text()


def test_jsx_splits_preserve_evaluation_and_nested_manual_sites(ui_workspace):
    (ui_workspace / "packages/ui/src/button.tsx").write_text("export const Button = (p: any) => null;")
    app = ui_workspace / "apps/site/src/use.tsx"
    original = (
        'import { Button } from "@acme/ui/button"; declare function read(): string;\n'
        'const one = <Button legacy value={read()}/>;\n'
        'const two = <Button legacy size={read() ? "a" : "b"}/>;\n'
        'const three = <Button remove={<Button legacy/>}/>;\n'
        'const four = <Button {...{}} label={<Button legacy/>}/>;\n'
    )
    app.write_text(original)
    result = run(ui_workspace, "rewrite_props", module="packages/ui/src/button.tsx", export_name="Button", rules=[
        {"prop": "legacy", "replace": []}, {"prop": "remove", "replace": []},
        {"prop": "value", "replace": [{"prop": "a"}, {"prop": "b"}]},
        *[{"prop": "size", "equals": size, "replace": [{"prop": "a", "value": size}, {"prop": "b", "value": size}]}
          for size in ("a", "b")],
    ])
    assert result["rewritten"] == 1 and result["left_for_manual"] == 4
    assert app.read_text() == original.replace('<Button remove={<Button legacy/>}/>', '<Button/>')


def test_member_rename_refuses_an_unrelated_union_member(ui_workspace):
    src = ui_workspace / "packages/ui/src/button.tsx"
    original = (
        "export interface Props { tone: number }; export interface Other { tone: number };\n"
        "export function value(data: Props | Other) { return data.tone; }\n"
    )
    src.write_text(original)
    reason = run(ui_workspace, "rename_symbol", failure=True, file="packages/ui/src/button.tsx",
                 old_name="Props.tone", new_name="variant")
    assert "Ambiguous member" in reason and src.read_text() == original
