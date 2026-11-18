"""JSDoc import sites participate in the shared module graph."""

import pytest

from tests.test_workspace_batch import run, snapshot


@pytest.fixture
def jsdoc_project(tmp_path):
    (tmp_path / "types.ts").write_text("export type Thing = number;")
    (tmp_path / "tsconfig.json").write_text(
        '{"compilerOptions":{"allowJs":true,"checkJs":true,"module":"ESNext","moduleResolution":"bundler"}}'
    )
    return tmp_path


@pytest.mark.parametrize("doc", ['@import { Thing } from "./types"', '@type {import("./types").Thing}'])
def test_jsdoc_import_blocks_deletion_and_follows_move(jsdoc_project, doc):
    root = jsdoc_project
    use = root / "use.js"
    use.write_text(f"/** {doc} */\nexport const value = 1;")
    before = snapshot(root)
    for apply in [False, True]:
        error = run(root, "batch", operations=[{"operation": "delete_module", "source": "types.ts"}],
                    refused=True, apply=apply)
        assert "batch[0]" in error and "use.js" in error
        assert snapshot(root) == before
    steps = [{"operation": "move_module", "source": "types.ts", "target": "renamed.ts"}]
    preview = run(root, "batch", operations=steps, diff=True)
    assert "use.js" in preview["affected_files"]
    assert run(root, "batch", operations=steps, apply=True, diff=True)["diff"] == preview["diff"]
    assert doc.replace("./types", "./renamed") in use.read_text()
    assert run(root, "validate_imports")["errors"] == []
    (root / "renamed.ts").unlink()
    assert any(e["file"] == "use.js" for e in run(root, "validate_imports")["errors"])


def test_jsdoc_replace_checks_imported_names(jsdoc_project):
    root = jsdoc_project
    (root / "next.ts").write_text("export type Other = number;")
    use = root / "use.js"
    use.write_text('/** @import { Thing } from "./types" */\n/** @type {Thing} */\nexport const v = 1;')
    before = snapshot(root)
    error = run(root, "replace_module", source="types.ts", target="next.ts", apply=True, refused=True)
    assert "Thing" in error
    assert snapshot(root) == before
    run(root, "replace_module", source="types.ts", target="next.ts", names={"Thing": "Other"}, apply=True)
    assert '@import { Other as Thing } from "./next"' in use.read_text()
    assert run(root, "validate_imports")["errors"] == []


def test_move_symbol_protects_jsdoc_importer(jsdoc_project):
    root = jsdoc_project
    (root / "use.js").write_text('/** @import { Thing } from "./types" */\n/** @type {Thing} */\nconst v = 1;')
    before = snapshot(root)
    error = run(root, "move_symbol", source_file="types.ts", target_file="next.ts",
                symbol_name="Thing", apply=True, refused=True)
    assert "use.js" in error and "JSDoc" in error
    assert snapshot(root) == before


def test_jsdoc_symbol_rename_updates_import_and_usage(jsdoc_project):
    root = jsdoc_project
    use = root / "use.js"
    use.write_text('/** @import { Thing } from "./types" */\n/** @type {Thing} */\nexport const v = 1;')
    run(root, "rename_symbol", file="types.ts", old_name="Thing", new_name="Item", apply=True)
    assert "Thing" not in use.read_text()
    assert "@import { Item }" in use.read_text() and "@type {Item}" in use.read_text()


def test_move_symbol_protects_file_scoped_jsdoc_binding(jsdoc_project):
    root = jsdoc_project
    (root / "impl.js").write_text(
        '/** @import { Thing } from "./types" */\nexport const first = 1;\n'
        '/** @param {Thing} value */\nexport function run(value) {return value;}'
    )
    before = snapshot(root)
    error = run(root, "move_symbol", source_file="impl.js", target_file="next.js",
                symbol_name="run", apply=True, refused=True)
    assert "impl.js" in error and "JSDoc" in error
    assert snapshot(root) == before
