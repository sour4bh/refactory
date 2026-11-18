"""Exercise file-relative source URLs and stylesheet consumers during workspace edits."""

import pytest

from tests.test_workspace_batch import snapshot
from tests.test_workspace_resolution import call, write


def test_move_asset_rewrites_source_url_and_lists_consumer(tmp_path):
    """A URL follows exact file identity and preserves its query and fragment."""
    write(tmp_path, "x.svg", "<svg/>")
    app = write(tmp_path, "app.ts", 'const icon = new URL("./x.svg?raw#icon", import.meta.url);')
    before = snapshot(tmp_path)
    opts = {"source": "x.svg", "target": "media/new icon.svg"}
    preview = call(tmp_path, "move_module", **opts)
    assert "app.ts" in preview["affected_files"]
    assert snapshot(tmp_path) == before
    result = call(tmp_path, "move_module", apply=True, **opts)
    assert preview["affected_files"] == result["affected_files"]
    assert 'new URL("./media/new%20icon.svg?raw#icon", import.meta.url)' in app.read_text()


def test_source_url_participates_in_delete_and_auto_companions(tmp_path):
    """URL references protect shared assets and move single-consumer assets."""
    icon = write(tmp_path, "x.svg", "<svg/>")
    write(tmp_path, "app.ts", 'export const icon = new URL("x.svg", import.meta.url);')
    before = snapshot(tmp_path)
    error = call(tmp_path, "delete_module", source="x.svg", ok=False, apply=True)
    assert "app.ts" in error and snapshot(tmp_path) == before
    result = call(tmp_path, "batch", apply=True, operations=[
        {"operation": "move_module", "source": "app.ts", "target": "src/app.ts", "companions": "auto"},
        {"operation": "move_module", "source": "src/x.svg", "target": "src/y.svg"},
    ])
    assert {"app.ts", "src/app.ts", "x.svg", "src/y.svg"} == set(result["affected_files"])
    assert not icon.exists()
    assert 'new URL("./y.svg", import.meta.url)' in (tmp_path / "src/app.ts").read_text()


@pytest.mark.parametrize("operation", ["move_module", "delete_module"])
def test_comment_in_stylesheet_import_detects_consumer(tmp_path, operation):
    """Comments between a CSS import and its path retain the dependency."""
    write(tmp_path, "theme.css", "a {color:red}")
    write(tmp_path, "all.css", 'a {}\n@import /* shared */ "./theme.css";')
    before = snapshot(tmp_path)
    if operation == "move_module":
        result = call(tmp_path, operation, source="theme.css", target="colors.css", apply=True)
        assert any("all.css:2" in warning and "theme.css" in warning for warning in result["warnings"])
    else:
        error = call(tmp_path, operation, source="theme.css", ok=False, apply=True)
        assert "all.css" in error and snapshot(tmp_path) == before


def test_source_url_refuses_cross_package_or_shadowed_constructor(tmp_path):
    """A URL needs a physical relative path and the global constructor."""
    write(tmp_path, "package.json", '{"workspaces":["packages/*"]}')
    for name in ["old", "ui"]:
        write(tmp_path, f"packages/{name}/package.json", f'{{"name":"@acme/{name}","exports":{{}}}}')
    write(tmp_path, "packages/old/x.svg", "<svg/>")
    code = 'export const icon = new URL("./x.svg", import.meta.url);'
    use = write(tmp_path, "packages/old/app.ts", code)
    before = snapshot(tmp_path)
    error = call(tmp_path, "move_module", source="packages/old/x.svg", target="packages/ui/x.svg",
                 export_as="./icon", apply=True, ok=False)
    assert "app.ts" in error and "URL" in error and snapshot(tmp_path) == before
    use.write_text("class URL { constructor(a: string, b: string) {} }\n" + code)
    before = snapshot(tmp_path)
    error = call(tmp_path, "move_module", source="packages/old/x.svg", target="packages/old/y.svg",
                 apply=True, ok=False)
    assert "app.ts" in error and "shadow" in error and snapshot(tmp_path) == before


def test_move_source_rebases_its_url_without_module_substitution(tmp_path):
    """A literal JS URL addresses the physical JS file even beside a TS counterpart."""
    write(tmp_path, "item.js", "export const x = 1;")
    write(tmp_path, "item.ts", "export const x = 2;")
    write(tmp_path, "use.ts", 'const url = new URL("./item.js", import.meta.url);')
    call(tmp_path, "move_module", source="use.ts", target="nested/use.ts", apply=True)
    assert 'new URL("../item.js", import.meta.url)' in (tmp_path / "nested/use.ts").read_text()


def test_stylesheet_comments_and_string_content_are_not_consumers(tmp_path):
    """CSS string values and comment bodies are not import declarations."""
    write(tmp_path, "theme.css", "a {}")
    write(tmp_path, "all.css", '''/* @import "theme.css"; */
.label { content: 'url("./theme.css")'; }
''')
    result = call(tmp_path, "delete_module", source="theme.css", apply=True)
    assert result["affected_files"] == ["theme.css"]


def test_symbol_move_updates_its_source_url(tmp_path):
    """Relocating one declaration uses the same URL rewrite as moving a file."""
    write(tmp_path, "tsconfig.json", '{"compilerOptions":{"module":"ESNext"}}')
    write(tmp_path, "x.svg", "<svg/>")
    write(tmp_path, "app.ts", 'export function icon() { return new URL("./x.svg", import.meta.url); }')
    call(tmp_path, "move_symbol", source_file="app.ts", target_file="ui/util.ts", symbol_name="icon", apply=True)
    assert 'new URL("../x.svg", import.meta.url)' in (tmp_path / "ui/util.ts").read_text()
