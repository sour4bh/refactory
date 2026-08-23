"""Release metadata must stay consistent across every packaging file."""
import json
import tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def _json_version(rel_path: str) -> str:
    return json.loads((REPO_ROOT / rel_path).read_text())["version"]


def test_versions_match_across_manifests():
    """All four version declarations must be identical."""
    versions = {
        ".claude-plugin/plugin.json": _json_version(".claude-plugin/plugin.json"),
        ".codex-plugin/plugin.json": _json_version(".codex-plugin/plugin.json"),
        "server/tsmorph/package.json": _json_version("server/tsmorph/package.json"),
        "pyproject.toml": tomllib.loads((REPO_ROOT / "pyproject.toml").read_text())["project"]["version"],
    }
    assert len(set(versions.values())) == 1, f"version drift: {versions}"


def test_declared_license_file_exists():
    """The Codex manifest declares MIT; the license file must ship with it."""
    manifest = json.loads((REPO_ROOT / ".codex-plugin/plugin.json").read_text())
    assert manifest["license"] == "MIT"
    assert "MIT License" in (REPO_ROOT / "LICENSE").read_text()
