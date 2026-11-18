"""Move typed JSX component attributes into child positions through CLI and MCP."""
import pytest

from tests.test_e2e_mcp import call_json, open_mcp_session
from tests.test_workspace_batch import run, snapshot


@pytest.fixture
def button(tmp_path):
    (tmp_path / "button.tsx").write_text("export const Button = (props: any) => null;")
    (tmp_path / "tsconfig.json").write_text('{"compilerOptions":{"jsx":"preserve","module":"esnext"}}')
    return tmp_path


def write_view(root, body):
    path = root / "view.tsx"
    path.write_text('import {Button as B} from "./button"; declare const Plus: any, Arrow: any, attrs: any, icon: any;\n'
                    + "export const view = " + body + ";")
    return path


def request(*rules):
    return {"module": "button.tsx", "export_name": "Button", "rules": list(rules)}


@pytest.mark.parametrize(("body", "expected"), [
    ('<B icon={<Plus />}>Add</B>', '<B><Plus />Add</B>'),
    ('<B icon={icon}/>', '<B>{icon}</B>'),
    ('<B icon="hello"/>', '<B>hello</B>'),
    ('<B icon={"hello"}/>', '<B>hello</B>'),
    ('<B icon={42}/>', '<B>{42}</B>'),
    ('<B icon/>', '<B>{true}</B>'),
    ('<B icon="&amp;"/>', '<B>&amp;</B>'),
    ('<B icon={<><Plus /></>} />', '<B><><Plus /></></B>'),
])
def test_child_value_and_self_closing_tag(button, body, expected):
    path = write_view(button, body)
    fields = request({"prop": "icon", "to_child": "start"})
    before = snapshot(button)
    preview = run(button, "rewrite_props", diff=True, **fields)
    assert snapshot(button) == before
    applied = run(button, "rewrite_props", diff=True, apply=True, **fields)
    assert applied["diff"] == preview["diff"] and applied["rewritten"] == 1
    assert expected in path.read_text()


@pytest.mark.parametrize(("body", "expected"), [
    ('<B icon={<Plus/>} right={<Arrow/>}>Add</B>', '<B><Plus/>Add<Arrow/></B>'),
    ('<B icon={<Plus/>} right={<Arrow/>}></B>', '<B><Plus/><Arrow/></B>'),
    ('<B icon={<Plus/>} right={<Arrow/>}/>', '<B><Plus/><Arrow/></B>'),
])
def test_start_and_end_keep_both_values(button, body, expected):
    file = write_view(button, body)
    run(button, "rewrite_props", apply=True, **request({"prop": "right", "to_child": "end"},
                                                       {"prop": "icon", "to_child": "start"}))
    assert expected in file.read_text()


def test_child_rules_match_equals_and_absent(button):
    file = write_view(button, '<><B label="yes"/><B label="no"/><B/><B label={icon}/></>')
    result = run(button, "rewrite_props", apply=True, **request(
        {"prop": "label", "equals": "yes", "to_child": "end"},
        {"prop": "label", "absent": True, "to_child": "start", "value": "empty"}))
    assert result["matched"] == 4 and result["rewritten"] == 2 and result["left_for_manual"] == 1
    assert '<B>yes</B><B label="no"/><B>empty</B><B label={icon}/>' in file.read_text()


@pytest.mark.parametrize(("body", "expected"), [
    ('<B icon={<Plus/>} onClick={() => attrs.go()}>Add</B>', 'onClick={() => attrs.go()}><Plus/>Add</B>'),
    ('<B icon={<Plus/>} onClick={function () { attrs.go(); }}>Add</B>', 'attrs.go(); }}><Plus/>Add</B>'),
    ('<B icon={icon ? <Plus/> : undefined} disabled={!icon}>Add</B>',
     '<B disabled={!icon}>{icon ? <Plus/> : undefined}Add</B>'),
    ('<B icon={(icon ?? <Plus/>)} disabled={icon && true}>Add</B>', '<B disabled={icon && true}>{(icon ?? <Plus/>)}Add</B>'),
])
def test_values_that_run_no_code_can_change_places(button, body, expected):
    file = write_view(button, body)
    result = run(button, "rewrite_props", apply=True, **request({"prop": "icon", "to_child": "start"}))
    assert result["rewritten"] == 1 and result["left_for_manual"] == 0
    assert expected in file.read_text()


@pytest.mark.parametrize("later", ["onClick={attrs.make()}", "title={attrs.title}", "count={icon++}",
                                   "disabled={icon ? attrs.make() : false}", "kind={class extends attrs.Base {}}"])
def test_a_later_expression_that_can_run_code_is_manual(button, later):
    write_view(button, "<B icon={<Plus/>} " + later + ">Add</B>")
    before = snapshot(button)
    result = run(button, "rewrite_props", **request({"prop": "icon", "to_child": "start"}))
    assert result["rewritten"] == 0 and result["left_for_manual"] == 1
    assert "evaluation order" in result["manual"][0]["reason"]
    assert snapshot(button) == before


@pytest.mark.parametrize(("body", "reason"), [
    ('<B {...attrs} icon={<Plus/>}/>', "spread"),
    ('<B icon={<Plus/>} children="Add"/>', "children"),
])
def test_ambiguous_children_are_manual_and_strictly_atomic(button, body, reason):
    write_view(button, '<><B icon={<Plus/>}/>' + body + '</>')
    before = snapshot(button)
    fields = request({"prop": "icon", "to_child": "start"})
    result = run(button, "rewrite_props", **fields)
    assert result["matched"] == 2 and result["rewritten"] == result["left_for_manual"] == 1
    assert reason in result["manual"][0]["reason"] and result["manual"][0]["file"] == "view.tsx"
    assert reason in run(button, "rewrite_props", refused=True, fail_on_manual=True, apply=True, **fields)
    assert snapshot(button) == before


@pytest.mark.asyncio
async def test_prop_child_rule_mcp(button):
    write_view(button, '<B icon={<Plus/>}>Add</B>')
    fields = request({"prop": "icon", "to_child": "start"})
    async with open_mcp_session() as session:
        result = await call_json(session, "rewrite_props", {"project_root": str(button), **fields, "diff": True})
    assert result["diff"] == run(button, "rewrite_props", **fields, diff=True)["diff"]
