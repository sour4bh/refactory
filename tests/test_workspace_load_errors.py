"""Workspace-load refusals identify the bad input and an action the caller can take."""
import pytest

from tests.test_workspace_batch import run, snapshot


@pytest.mark.parametrize("operation", ["validate_imports", "move_module"])
def test_ambiguous_load_names_importer_and_remedy(tmp_path, operation):
    (tmp_path / "tsconfig.json").write_text('{"compilerOptions":{"moduleResolution":"bundler","module":"ESNext"}}')
    (tmp_path / "item.js").write_text("export const value = 1;")
    (tmp_path / "item.ts").write_text("export const value = 2;")
    (tmp_path / "use.ts").write_text('import { value } from "./item.js"; export {value};')
    before = snapshot(tmp_path)
    args = {} if operation == "validate_imports" else {"source": "item.ts", "target": "moved.ts", "apply": True}
    error = run(tmp_path, operation, **args, refused=True)
    assert "use.ts" in error and "./item.js" in error and "item.ts" in error
    assert "retry" in error.lower() and "target" in error.lower()
    assert snapshot(tmp_path) == before


def test_invalid_workspace_config_gives_repair_action(tmp_path):
    (tmp_path / "tsconfig.json").write_text('{"compilerOptions": {')
    error = run(tmp_path, "validate_imports", refused=True)
    assert "tsconfig.json" in error and "fix" in error.lower() and "retry" in error.lower()


def test_invalid_manifest_shape_names_file_and_remedy(tmp_path):
    (tmp_path / "package.json").write_text("null")
    error = run(tmp_path, "validate_imports", refused=True)
    assert "package.json" in error and "object" in error.lower() and "retry" in error.lower()
