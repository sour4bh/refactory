"""Regression cases for workspace semantic rewrites."""

import pytest

from tests.test_workspace_batch import run, snapshot


def test_replace_cannot_resurrect_batch_deletion(tmp_path):
    (tmp_path / "tsconfig.json").write_text('{"compilerOptions":{"paths":{"@acme/old":["./old.ts"]}}}')
    (tmp_path / "old.ts").write_text("export const value = 0;")
    (tmp_path / "other.ts").write_text("export const value = 1;")
    (tmp_path / "use.ts").write_text('import {value} from "./other"; console.log(value);')
    before = snapshot(tmp_path)
    operations = [
        {"operation": "delete_module", "source": "old.ts"},
        {"operation": "replace_module", "source": "other.ts", "target": "@acme/old"},
    ]
    error = run(tmp_path, "batch", operations=operations, fail_on_new_errors=True, apply=True, refused=True)
    assert "use.ts" in error and "@acme/old" in error
    assert snapshot(tmp_path) == before


@pytest.mark.parametrize(
    "replacement",
    [
        "export type Btn = number;",
        'export type {Btn} from "./impl";',
        'export {Btn} from "./types";',
        'export type * from "./impl";',
    ],
)
def test_replace_preserves_runtime_exports(tmp_path, replacement):
    (tmp_path / "old.ts").write_text("export const Btn = 1;")
    (tmp_path / "impl.ts").write_text("export const Btn = 2;")
    (tmp_path / "types.ts").write_text('export type {Btn} from "./impl";')
    (tmp_path / "new.ts").write_text(replacement)
    (tmp_path / "use.ts").write_text('import {Btn} from "./old"; console.log(Btn);')
    before = snapshot(tmp_path)
    error = run(tmp_path, "replace_module", source="old.ts", target="new.ts", apply=True, refused=True)
    assert "Btn" in error and "use.ts" in error and "value" in error
    assert snapshot(tmp_path) == before


@pytest.mark.parametrize(
    ("code", "old", "new"),
    [
        (
            "export interface Props {tone: string}; declare const p: Props & {color: number}; const {tone, color} = p;",
            "Props.tone",
            "color",
        ),
        (
            "export class Base {old = 1}; class Derived extends Base {next = 2};"
            " export function read(b: Base) {return b.old}; read(new Derived());",
            "Base.old",
            "next",
        ),
        (
            "export class Base {old = 1}; const Derived = class extends Base {next = 2};"
            " export function read(b: Base) {return b.old}; read(new Derived());",
            "Base.old",
            "next",
        ),
        (
            "export interface Base {old: number}; interface Derived extends Base {next: number};"
            " declare const data: Derived; export function read(b: Base) {return b.old}; read(data);",
            "Base.old",
            "next",
        ),
    ],
)
def test_member_rename_refuses_colliding_receiver(tmp_path, code, old, new):
    (tmp_path / "model.ts").write_text(code)
    before = snapshot(tmp_path)
    error = run(tmp_path, "rename_symbol", file="model.ts", old_name=old, new_name=new, apply=True, refused=True)
    assert "model.ts" in error and new in error
    assert snapshot(tmp_path) == before


def test_props_reports_dropped_condition_evaluation(tmp_path):
    (tmp_path / "button.tsx").write_text("export const Button = (p: any) => null;")
    view = tmp_path / "view.tsx"
    view.write_text(
        'import {Button} from "./button"; let count = 0;\nexport const x = <Button tone={(++count) ? "a" : "b"}/>;'
    )
    before = snapshot(tmp_path)
    fields = {
        "module": "button.tsx",
        "export_name": "Button",
        "rules": [{"prop": "tone", "equals": value, "replace": []} for value in ("a", "b")],
    }
    result = run(tmp_path, "rewrite_props", **fields, apply=True)
    assert result["left_for_manual"] == 1 and result["rewritten"] == 0
    assert result["manual"][0]["file"] == "view.tsx" and result["manual"][0]["line"] == 2
    assert snapshot(tmp_path) == before


@pytest.mark.parametrize("replace", [[], [{"prop": "variant", "value": 1}]])
def test_props_keeps_overwritten_expression_evaluation(tmp_path, replace):
    view = tmp_path / "button.tsx"
    view.write_text("export const Button = (p: any) => null; let count = 0; const el = <Button tone={++count}/>;")
    before = snapshot(tmp_path)
    result = run(
        tmp_path,
        "rewrite_props",
        module="button.tsx",
        export_name="Button",
        apply=True,
        rules=[{"prop": "tone", "replace": replace}],
    )
    assert result["left_for_manual"] == 1 and result["rewritten"] == 0
    assert snapshot(tmp_path) == before


def test_replacement_can_resolve_installed_declaration_dependencies(tmp_path):
    pkg = tmp_path / "node_modules" / "@acme" / "controls"
    pkg.mkdir(parents=True)
    (pkg / "package.json").write_text('{"name":"@acme/controls","types":"index.d.ts"}')
    (pkg / "index.d.ts").write_text('export {Btn} from "./public";')
    (pkg / "public.d.ts").write_text("export declare const Btn: number;")
    (tmp_path / "old.ts").write_text("export const Btn = 1;")
    use = tmp_path / "use.ts"
    use.write_text('import {Btn} from "./old"; console.log(Btn);')
    run(tmp_path, "replace_module", source="old.ts", target="@acme/controls", apply=True)
    assert '"@acme/controls"' in use.read_text()
    (pkg / "public.d.ts").write_text("export type Btn = number;")
    use.write_text('import {Btn} from "./old"; console.log(Btn);')
    assert "value" in run(
        tmp_path, "replace_module", source="old.ts", target="@acme/controls", apply=True, refused=True
    )
    (pkg / "public.d.ts").unlink()
    assert "Btn" in run(tmp_path, "replace_module", source="old.ts", target="@acme/controls", apply=True, refused=True)


def test_star_replacement_preserves_sibling_exports(tmp_path):
    (tmp_path / "old.ts").write_text("export const x = 1;")
    (tmp_path / "new.ts").write_text("export const x = 2, y = 3;")
    (tmp_path / "other.ts").write_text("export const y = 4;")
    barrel = tmp_path / "barrel.ts"
    barrel.write_text('export * from "./old"; export * from "./other";')
    (tmp_path / "use.ts").write_text('import {x, y} from "./barrel"; console.log(x, y);')
    before = snapshot(tmp_path)
    error = run(tmp_path, "replace_module", source="old.ts", target="new.ts", apply=True, refused=True)
    assert "barrel.ts" in error and "y" in error
    assert snapshot(tmp_path) == before


@pytest.mark.parametrize(
    ("old", "usage", "expected"),
    [
        ("function () {}", 'require("./old.cjs")()', "call"),
        ("class Item {}", 'new (require("./old.cjs"))()', "construct"),
        ("function () {}", 'const load = require("./old.cjs"); load()', "call"),
    ],
)
def test_require_replacement_preserves_module_invocation(tmp_path, old, usage, expected):
    (tmp_path / "old.cjs").write_text("module.exports = " + old + ";")
    new = tmp_path / "new.cjs"
    new.write_text("module.exports = {};")
    (tmp_path / "use.cjs").write_text(usage)
    before = snapshot(tmp_path)
    fields = {"source": "old.cjs", "target": "new.cjs", "apply": True}
    error = run(tmp_path, "replace_module", refused=True, **fields)
    assert "use.cjs" in error and expected in error
    assert snapshot(tmp_path) == before
    new.write_text("module.exports = " + old + ";")
    run(tmp_path, "replace_module", **fields)
    assert '"./new.cjs"' in (tmp_path / "use.cjs").read_text()


def test_star_replacement_refuses_divergent_reexports_of_same_binding(tmp_path):
    (tmp_path / "shared.ts").write_text("export const x = 1;")
    for name in ["old", "other"]:
        (tmp_path / f"{name}.ts").write_text('export {x} from "./shared";')
    (tmp_path / "new.ts").write_text("export const x = 2;")
    (tmp_path / "barrel.ts").write_text('export * from "./old"; export * from "./other";')
    (tmp_path / "use.ts").write_text('import {x} from "./barrel"; console.log(x);')
    before = snapshot(tmp_path)
    error = run(tmp_path, "replace_module", source="old.ts", target="new.ts", apply=True, refused=True)
    assert "barrel.ts" in error and "x" in error
    assert snapshot(tmp_path) == before


def test_parenthesized_dynamic_import_keeps_promise_then(tmp_path):
    (tmp_path / "old.ts").write_text("export const Btn = 1;")
    (tmp_path / "new.ts").write_text("export const New = 2;")
    use = tmp_path / "use.ts"
    use.write_text('export const load = () => ((import("./old"))).then(m => m.Btn);')
    run(tmp_path, "replace_module", source="old.ts", target="new.ts", names={"Btn": "New"}, apply=True)
    assert use.read_text() == 'export const load = () => ((import("./new"))).then(m => m.New);'


def test_prop_replacements_preserve_negative_zero(tmp_path):
    file = tmp_path / "button.tsx"
    file.write_text(
        "export const Button = (p: any) => null; declare const flag: boolean;\n"
        'const a = <Button tone="off"/>; const b = <Button tone={flag ? "off" : "on"}/>;'
    )
    rules = [{"prop": "tone", "equals": "off", "replace": [{"prop": "tone", "value": -0.0}]}]
    run(tmp_path, "rewrite_props", module="button.tsx", export_name="Button", rules=rules, apply=True)
    assert "<Button tone={-0}/>" in file.read_text()
    assert '<Button tone={flag ? -0 : "on"}/>' in file.read_text()


def test_prop_match_distinguishes_signed_zero(tmp_path):
    file = tmp_path / "button.tsx"
    file.write_text("export const Button = (p: any) => null; const a = <Button v={0}/>; const b = <Button v={-0}/>;")
    rules = [
        {"prop": "v", "equals": n, "replace": [{"prop": "v", "value": v}]}
        for n, v in [(0, "positive"), (-0.0, "negative")]
    ]
    run(tmp_path, "rewrite_props", module="button.tsx", export_name="Button", rules=rules, apply=True)
    assert '<Button v="positive"/>; const b = <Button v="negative"/>' in file.read_text()


def test_missing_replacement_exports_identify_their_importers(tmp_path):
    (tmp_path / "old.ts").write_text("export const x = 1, y = 2;")
    (tmp_path / "new.ts").write_text("export {};")
    (tmp_path / "consumer.ts").write_text('import {x} from "./old";')
    (tmp_path / "barrel.ts").write_text('export {y} from "./old";')
    before = snapshot(tmp_path)
    error = run(tmp_path, "replace_module", source="old.ts", target="new.ts", refused=True, apply=True)
    for detail in ["new.ts", "consumer.ts", "barrel.ts", "x", "y"]:
        assert detail in error, error
    assert snapshot(tmp_path) == before


def test_props_evaluations_survive_mappings_and_conflicts(tmp_path):
    file = tmp_path / "button.tsx"
    original = (
        "export const Button = (p: any) => null; let count = 0;\n"
        'const one = <Button tone={(++count) ? "a" : "b"}/>;\n'
        "const two = <Button tone={++count} size={++count} variant={++count}/>;\n"
        "const three = <Button tone={++count} tone={++count}/>;\n"
        "const four = <Button tone={++count}/>;\n"
    )
    file.write_text(original)
    fields = {"module": "button.tsx", "export_name": "Button", "apply": True}
    mapped = run(
        tmp_path,
        "rewrite_props",
        **fields,
        rules=[
            {"prop": "tone", "equals": item, "replace": [{"prop": "variant", "value": "fresh"}]} for item in ["a", "b"]
        ],
    )
    assert mapped["rewritten"] == 1 and mapped["left_for_manual"] == 3
    assert file.read_text() == original.replace(
        'tone={(++count) ? "a" : "b"}', 'variant={(++count) ? "fresh" : "fresh"}'
    )
    before = file.read_text()
    renamed = run(
        tmp_path,
        "rewrite_props",
        **fields,
        rules=[{"prop": "size", "replace": [{"prop": "other"}]}, {"prop": "tone", "replace": [{"prop": "variant"}]}],
    )
    assert renamed["rewritten"] == 1 and renamed["left_for_manual"] == 2
    assert file.read_text() == before.replace("four = <Button tone", "four = <Button variant")


@pytest.mark.asyncio
async def test_mcp_emits_negative_zero_prop(tmp_path):
    from tests.test_e2e_mcp import call_json, open_mcp_session

    file = tmp_path / "button.tsx"
    file.write_text("export const Button = (p: any) => null; export const item = <Button/>;")
    async with open_mcp_session() as session:
        result = await call_json(
            session,
            "rewrite_props",
            {
                "module": "button.tsx",
                "export_name": "Button",
                "project_root": str(tmp_path),
                "apply": True,
                "rules": [{"prop": "tone", "absent": True, "replace": [{"prop": "tone", "value": -0.0}]}],
            },
        )
    assert result["rewritten"] == 1
    assert "<Button tone={-0}/>" in file.read_text()
