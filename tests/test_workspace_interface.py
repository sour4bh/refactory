"""Tests for the workspace MCP and command-line contracts."""
import json
import os
import subprocess

import pytest

from backends.typescript import TSMORPH_SCRIPT, TypeScriptBackend
from tests.test_e2e_mcp import call_error, call_json, open_mcp_session


@pytest.mark.asyncio
async def test_file_batch_preview_and_apply_match_cli(tmp_path):
    """Load a saved batch through both transports and keep apply authority on the call."""
    source = tmp_path / "button.ts"
    source.write_text("export const button = 1;\n")
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(json.dumps({
        "apply": True,
        "operations": [
            {"operation": "move_module", "source": "button.ts", "target": "control.ts"},
            {"operation": "rename_symbol", "file": "control.ts", "old_name": "button", "new_name": "control"},
        ],
    }))
    request = {"project_root": str(tmp_path), "payload_file": "plan.json"}
    cli_file = tmp_path / "request.json"
    cli_file.write_text(json.dumps(request))
    direct = subprocess.run(
        ["node", str(TSMORPH_SCRIPT), "batch", f"@{cli_file}"],
        text=True, capture_output=True, check=True,
    )
    cli = json.loads(direct.stdout)
    assert source.is_file()
    async with open_mcp_session() as session:
        preview = await call_json(session, "batch", request)
        assert preview["apply"] is False
        assert source.is_file()
        applied = await call_json(session, "batch", {**request, "apply": True})

    for field in ("affected_files", "operations", "warnings", "stats"):
        assert applied[field] == preview[field] == cli[field]
    assert not source.exists()
    assert (tmp_path / "control.ts").read_text() == "export const control = 1;\n"


@pytest.mark.asyncio
async def test_python_inputs_refused_for_workspace_mutations(tmp_path):
    """Each TypeScript-only tool refuses Python through the MCP error channel."""
    source = tmp_path / "button.py"
    source.write_text("button = 1\n")
    steps = {
        "delete_module": {"source": "button.py"},
        "batch": {"operations": [{"operation": "move_module", "source": "button.py", "target": "item.py"}]},
        "replace_module": {"source": "button.py", "target": "item.py"},
        "rewrite_props": {"module": "button.py", "export_name": "button", "rules": [{"prop": "old", "replace": []}]},
    }
    async with open_mcp_session() as session:
        for name, args in steps.items():
            result = await call_error(session, name, {**args, "project_root": str(tmp_path), "apply": True})
            assert "not supported for Python files" in result["error"], (name, result)
    assert source.read_text() == "button = 1\n"


def test_timeout_and_stdin_payload(monkeypatch, tmp_path):
    """Send large arguments via stdin and enforce the configured subprocess deadline."""
    from backends import typescript

    monkeypatch.setenv("REFACTORY_TIMEOUT_SECONDS", "1")
    operations = [{"operation": "delete_module", "source": f"file{i}.ts"} for i in range(500)]
    fixture = tmp_path / "read-stdin.cjs"
    receipt = tmp_path / "receipt.json"
    fixture.write_text(
        'const fs = require("node:fs"); const input = JSON.parse(fs.readFileSync(0, "utf8"));\n'
        'fs.writeFileSync(process.env.PLAN_RECEIPT, JSON.stringify([process.argv.slice(2), input]));\n'
        'setTimeout(() => {}, 30000);\n'
    )
    monkeypatch.setenv("PLAN_RECEIPT", str(receipt))
    monkeypatch.setattr(typescript, "TSMORPH_SCRIPT", fixture)
    with pytest.raises(RuntimeError, match="timed out after 1 seconds"):
        TypeScriptBackend().run_operation("batch", {"operations": operations}, str(tmp_path), True)
    argv, payload = json.loads(receipt.read_text())
    assert argv == ["batch", "-"]
    assert payload["operations"] == operations


@pytest.mark.skipif(os.name != "posix", reason="POSIX SIGTERM during commit")
def test_timeout_during_commit_returns_actual_result(monkeypatch, tmp_path):
    """A deadline during the rename sequence must allow the transaction to finish."""
    fixture = tmp_path / "slow-commit.cjs"
    fixture.write_text(
        'const fs = require("node:fs"); const rename = fs.renameSync;\n'
        'fs.renameSync = function(from, to) {\n'
        '  if (String(to).endsWith(".refactory-backup")) {\n'
        '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);\n'
        '  }\n'
        '  return rename(from, to);\n'
        '};\n'
    )
    monkeypatch.setenv("NODE_OPTIONS", f'--require="{fixture}"')
    monkeypatch.setenv("REFACTORY_TIMEOUT_SECONDS", "2")
    source = tmp_path / "button.ts"
    source.write_text("export const button = 1;\n")
    result = TypeScriptBackend().move_module("button.ts", "control.ts", str(tmp_path), False)
    assert result["success"]
    assert not source.exists()
    assert (tmp_path / "control.ts").read_text() == "export const button = 1;\n"


def test_dependency_probe_checks_installed_versions(tmp_path, monkeypatch):
    """An existing node_modules tree can still lack the parser or diff version required."""
    from backends import typescript

    required = {"ts-morph": "28.0.0", "diff": "9.0.0"}
    (tmp_path / "package.json").write_text(json.dumps({"dependencies": required}))
    for name, version in required.items():
        folder = tmp_path / "node_modules" / name
        folder.mkdir(parents=True)
        (folder / "package.json").write_text(json.dumps({"version": version}))
    marker = tmp_path / "node_modules/ts-morph/package.json"
    monkeypatch.setattr(typescript, "TSMORPH_DIR", tmp_path)
    monkeypatch.setattr(typescript, "TSMORPH_MODULE_MARKER", marker)
    assert TypeScriptBackend._check_dependencies() is None
    marker.write_text('{"version":"23.0.0"}')
    assert "ts-morph@28.0.0" in TypeScriptBackend._check_dependencies()
    marker.write_text('{"version":"28.0.0"}')
    (tmp_path / "node_modules/diff/package.json").unlink()
    assert "diff@9.0.0" in TypeScriptBackend._check_dependencies()
