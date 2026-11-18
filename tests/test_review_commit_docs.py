"""Check committed results, cleanup warnings and named barrel behavior."""
import json

import pytest

from tests.test_workspace_batch import run, snapshot


@pytest.mark.parametrize(
    ("method", "suffix", "operation"),
    [("unlinkSync", ".refactory-backup", "move_module"), ("rmdirSync", ".refactory-write.lock", "batch")],
)
def test_committed_move_reports_retained_cleanup_path(tmp_path, monkeypatch, method, suffix, operation):
    root = tmp_path / "project"
    root.mkdir()
    (root / "item.ts").write_text("export const item = 1;\n")
    (root / "use.ts").write_text('import {item} from "./item";\n')
    fault = tmp_path / "fault.cjs"
    fault.write_text(
        'const fs = require("node:fs");\n'
        f'const method = {json.dumps(method)}, suffix = {json.dumps(suffix)};\n'
        'const original = fs[method]; let injected = false;\n'
        'fs[method] = function(file, ...args) {\n'
        '  if (!injected && String(file).endsWith(suffix)) {\n'
        '    injected = true; throw Object.assign(new Error("EIO: injected cleanup failure"), { code: "EIO" });\n'
        '  }\n'
        '  return original(file, ...args);\n'
        '};\n'
    )
    monkeypatch.setenv("NODE_OPTIONS", f"--require={json.dumps(str(fault))}")
    options = {"source": "item.ts", "target": "renamed.ts"}
    if operation == "batch":
        options = {"operations": [{"operation": "move_module", **options}]}
    before = snapshot(root)
    preview = run(root, operation, **options, diff=True)
    assert snapshot(root) == before
    applied = run(root, operation, **options, apply=True, diff=True)
    assert applied["success"] and preview["diff"] == applied["diff"]
    assert applied["affected_files"] == preview["affected_files"] == ["item.ts", "renamed.ts", "use.ts"]
    assert (root / "renamed.ts").read_bytes() == before["item.ts"]
    assert not (root / "item.ts").exists()
    assert '"./renamed"' in (root / "use.ts").read_text()
    retained, = root.glob("*" + suffix)
    assert any(str(retained) in warning and "EIO" in warning for warning in applied["warnings"])


def test_move_symbol_updates_named_barrel_from_defining_module(tmp_path):
    (tmp_path / "tsconfig.json").write_text('{"compilerOptions":{"module":"ESNext"}}')
    (tmp_path / "impl.ts").write_text("export function run() { return 1; }\n")
    (tmp_path / "index.ts").write_text('export { run } from "./impl";\n')
    (tmp_path / "use.ts").write_text('import { run } from "./index"; export const value = run();\n')
    before = snapshot(tmp_path)
    options = {"symbol_name": "run", "target_file": "target.ts"}
    for apply in (False, True):
        error = run(tmp_path, "move_symbol", **options, source_file="index.ts", apply=apply, refused=True)
        assert "run" in error and "index.ts" in error
        assert snapshot(tmp_path) == before
    preview = run(tmp_path, "move_symbol", **options, source_file="impl.ts", diff=True)
    assert snapshot(tmp_path) == before
    applied = run(tmp_path, "move_symbol", **options, source_file="impl.ts", apply=True, diff=True)
    assert applied["diff"] == preview["diff"]
    assert set(applied["affected_files"]) == {"impl.ts", "target.ts", "index.ts"}
    assert '"./target"' in (tmp_path / "index.ts").read_text()
    assert (tmp_path / "use.ts").read_bytes() == before["use.ts"]
    assert not run(tmp_path, "validate_imports")["errors"]
