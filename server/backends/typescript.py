"""TypeScript refactoring backend using ts-morph via subprocess."""
import json
import logging
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from validation import validate_identifier, validate_position_selector

logger = logging.getLogger("refactory.typescript")

TSMORPH_DIR = Path(__file__).parent.parent / "tsmorph"
TSMORPH_SCRIPT = TSMORPH_DIR / "refactor.js"
TSMORPH_MODULE_MARKER = TSMORPH_DIR / "node_modules" / "ts-morph" / "package.json"


class TypeScriptBackend:
    """TypeScript refactoring using ts-morph library."""

    def __init__(self) -> None:
        self._dependency_error: str | None = self._check_dependencies()

    @staticmethod
    def _check_dependencies() -> str | None:
        """Check for the engine and its pinned dependencies."""
        if not TSMORPH_SCRIPT.exists():
            return (
                f"ts-morph script not found at {TSMORPH_SCRIPT}. "
                f"Reinstall the refactory plugin or run: "
                f"cd {TSMORPH_DIR} && pnpm install"
            )
        if not TSMORPH_MODULE_MARKER.exists():
            return (
                f"ts-morph is not installed. "
                f"Run: cd {TSMORPH_DIR} && pnpm install "
                f"(or: npm install). The SessionStart hook normally handles this "
                f"automatically; run it manually if the hook did not fire."
            )
        dependencies = json.loads((TSMORPH_DIR / "package.json").read_text())["dependencies"]
        for name, required in dependencies.items():
            manifest = TSMORPH_DIR / "node_modules" / name / "package.json"
            try:
                installed = json.loads(manifest.read_text())["version"]
            except (OSError, ValueError, KeyError):
                installed = None
            if installed != required:
                return f"{name}@{required} is required; run npm install or pnpm install in {TSMORPH_DIR}"
        return None

    def _install_dependencies(self) -> str | None:
        """Install missing or stale engine dependencies on demand."""
        if not TSMORPH_SCRIPT.exists():
            return self._dependency_error
        modules = TSMORPH_DIR / "node_modules"
        prefer_npm = (modules / ".package-lock.json").is_file() and not (modules / ".pnpm").is_dir()
        managers = ("npm", "pnpm") if prefer_npm else ("pnpm", "npm")
        manager = shutil.which(managers[0]) or shutil.which(managers[1])
        if manager is None:
            return f"{self._dependency_error} (neither pnpm nor npm is on PATH)"
        logger.info("ts-morph missing; running %s install in %s", manager, TSMORPH_DIR)
        try:
            command = [manager, "install"]
            if Path(manager).name in {"npm", "npm.cmd"}:
                command += ["--no-package-lock", "--no-audit", "--no-fund"]
            proc = subprocess.run(
                command,
                cwd=str(TSMORPH_DIR),
                capture_output=True,
                text=True,
                timeout=300,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            return f"{self._dependency_error} (automatic install failed: {exc})"
        if proc.returncode != 0 or not TSMORPH_MODULE_MARKER.exists():
            detail = proc.stderr.strip().splitlines()[-1:] or ["unknown installer error"]
            return f"{self._dependency_error} (automatic install failed: {detail[0]})"
        return self._check_dependencies()

    def _run_tsmorph(self, operation: str, args: dict[str, Any]) -> dict[str, Any]:
        """Run ts-morph refactoring script."""
        if self._dependency_error is not None:
            self._dependency_error = self._install_dependencies()
        if self._dependency_error is not None:
            raise RuntimeError(self._dependency_error)

        try:
            timeout = int(os.environ.get("REFACTORY_TIMEOUT_SECONDS", "120"))
            if timeout < 1:
                raise ValueError
        except ValueError:
            raise ValueError("REFACTORY_TIMEOUT_SECONDS must be a positive integer") from None

        with subprocess.Popen(
            ["node", str(TSMORPH_SCRIPT), operation, "-"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        ) as process:
            try:
                stdout, stderr = process.communicate(json.dumps(args), timeout=timeout)
            except subprocess.TimeoutExpired as exc:
                process.terminate()
                stdout, stderr = process.communicate()
                if process.returncode and not stdout and not stderr:
                    raise RuntimeError(f"{operation} timed out after {timeout} seconds (REFACTORY_TIMEOUT_SECONDS)") from exc

        if process.returncode != 0:
            detail = stderr.strip()
            try:
                message = json.loads(detail)["error"]
            except (ValueError, KeyError, TypeError):
                message = detail or f"node exited with status {process.returncode}"
            raise RuntimeError(message)

        return json.loads(stdout)

    def run_operation(
        self,
        operation: str,
        arguments: dict[str, Any],
        project_root: str,
        dry_run: bool,
    ) -> dict[str, Any]:
        """Run a TypeScript workspace operation with the MCP field names."""
        return self._run_tsmorph(operation, {
            **arguments,
            "project_root": self._prepare_project_root(project_root),
            "apply": not dry_run,
        })

    def _prepare_project_root(self, project_root: str) -> str:
        """Resolve an explicit absolute project_root."""
        raw_root = Path(project_root).expanduser()
        if not raw_root.is_absolute():
            raise ValueError(f"project_root must be an absolute path: {project_root}")
        root = raw_root.resolve()
        if not root.exists():
            raise ValueError(f"Project root does not exist: {project_root}")
        if not root.is_dir():
            raise ValueError(f"project_root is not a directory: {project_root}")
        return str(root)

    def move_module(
        self,
        source: str,
        target: str,
        project_root: str,
        dry_run: bool,
        overwrite: bool = False,
    ) -> dict[str, Any]:
        """Move a TypeScript module and update all imports."""
        project_root = self._prepare_project_root(project_root)
        return self._run_tsmorph("move_module", {
            "source": source,
            "target": target,
            "projectRoot": project_root,
            "dryRun": dry_run,
            "overwrite": overwrite,
        })

    def move_symbol(
        self,
        source_file: str,
        symbol_name: str,
        target_file: str,
        project_root: str,
        dry_run: bool,
    ) -> dict[str, Any]:
        """Move a symbol (function/class) to another module."""
        validate_identifier(symbol_name, "typescript")
        project_root = self._prepare_project_root(project_root)
        return self._run_tsmorph("move_symbol", {
            "sourceFile": source_file,
            "symbolName": symbol_name,
            "targetFile": target_file,
            "projectRoot": project_root,
            "dryRun": dry_run,
        })

    def rename_symbol(
        self,
        file: str,
        old_name: str,
        new_name: str,
        project_root: str,
        dry_run: bool,
        line: int | None = None,
        column: int | None = None,
    ) -> dict[str, Any]:
        """Rename a symbol across the codebase."""
        validate_identifier(new_name, "typescript")
        line, column = validate_position_selector(line, column)
        project_root = self._prepare_project_root(project_root)
        return self._run_tsmorph("rename_symbol", {
            "file": file,
            "oldName": old_name,
            "newName": new_name,
            "projectRoot": project_root,
            "dryRun": dry_run,
            "line": line,
            "column": column,
        })

    def validate_imports(self, project_root: str) -> list[dict[str, Any]]:
        """Check for broken imports in TypeScript files."""
        project_root = self._prepare_project_root(project_root)
        result = self._run_tsmorph("validate_imports", {
            "projectRoot": project_root,
        })
        return result.get("errors", [])
