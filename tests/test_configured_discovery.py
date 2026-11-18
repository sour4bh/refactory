"""Configured source directories and write protection follow each member's tsconfig."""
import json

import pytest

from tests.test_workspace_batch import run, snapshot
from tests.test_workspace_resolution import write


def test_build_named_sources_are_validated_moved_and_updated(tmp_path):
    write(tmp_path, "package.json", '{"workspaces":["packages/*"]}')
    write(tmp_path, "packages/deploy/package.json", '{"name":"@acme/deploy"}')
    root = tmp_path / "packages/deploy"
    write(root, "base.json", '{"compilerOptions":{"module":"ESNext","moduleResolution":"bundler"},'
                              '"include":["src/**/*.ts","build/**/*.ts"]}')
    write(root, "tsconfig.json", '{"extends":"./base.json"}')
    write(root, "src/build/contracts.ts", "export const contract = 1;")
    use = write(root, "src/build/check.ts", 'export {contract} from "./contracts";')
    public = write(root, "src/common/index.ts", 'export {contract} from "../build/contracts";')
    assert run(root, "validate_imports")["errors"] == []
    fields = {"source": "src/build/contracts.ts", "target": "build/schema.ts", "fail_on_new_errors": True}
    preview = run(root, "move_module", **fields)
    applied = run(root, "move_module", apply=True, **fields)
    assert preview["affected_files"] == applied["affected_files"] == [
        "packages/deploy/build/schema.ts", "packages/deploy/src/build/check.ts",
        "packages/deploy/src/build/contracts.ts", "packages/deploy/src/common/index.ts",
    ]
    assert all('../../build/schema' in importer.read_text() for importer in [use, public])


@pytest.mark.parametrize("folder", ["src/hidden", "src/private/code", "output", "declarations",
                                     "src/node_modules", "src/.git"])
def test_config_excluded_outputs_and_reserved_paths_cannot_receive_writes(tmp_path, folder):
    write(tmp_path, "tsconfig.json", json.dumps({
        "compilerOptions": {"outDir": "./output", "declarationDir": "./declarations", "declaration": True},
        "include": ["**/*.ts"], "exclude": ["src/hidden", "**/private/**"],
    }))
    write(tmp_path, "src/item.ts", "export const item = 1;")
    write(tmp_path, folder + "/ignored.ts", 'import "./absent";')
    before = snapshot(tmp_path)
    assert run(tmp_path, "validate_imports")["errors"] == []
    error = run(tmp_path, "move_module", source="src/item.ts", target=folder + "/new.ts", apply=True, refused=True)
    assert folder in error and any(word in error for word in ("skipped", "excluded", "output"))
    assert snapshot(tmp_path) == before


def test_member_config_applies_below_an_excluded_workspace_container(tmp_path):
    write(tmp_path, "package.json", '{"workspaces":["packages/*"]}')
    write(tmp_path, "tsconfig.json", '{"exclude":["packages/**"]}')
    write(tmp_path, "packages/build/package.json", '{"name":"@acme/build"}')
    write(tmp_path, "packages/build/tsconfig.json", '{"include":["src"]}')
    write(tmp_path, "packages/build/src/item.ts", "export const item = 1;")
    use = write(tmp_path, "packages/build/src/view.ts", 'export {item} from "./item";')
    run(tmp_path, "move_module", source="packages/build/src/item.ts",
        target="packages/build/src/new.ts", apply=True, fail_on_new_errors=True)
    assert './new' in use.read_text()


def test_configured_source_beside_a_published_build_artifact(tmp_path):
    write(tmp_path, "package.json", '{"name":"@acme/deploy","exports":{".":'
          '{"import":"./build/index.js","types":"./build/index.d.ts"}}}')
    write(tmp_path, "tsconfig.json", '{"include":["build/**/*.ts"]}')
    artifact = write(tmp_path, "build/index.d.ts", "export declare const api: boolean;")
    write(tmp_path, "build/contracts.ts", "export const contract = 1;")
    use = write(tmp_path, "build/use.ts", 'export {contract} from "./contracts";')
    run(tmp_path, "move_module", source="build/contracts.ts", target="build/new.ts", apply=True)
    assert "./new" in use.read_text()
    assert artifact.read_text() == "export declare const api: boolean;"
    error = run(tmp_path, "delete_module", source="build/index.d.ts", apply=True, refused=True)
    assert "build/index.d.ts" in error and "output" in error


def test_case_alias_cannot_bypass_skipped_directory_on_insensitive_filesystem(tmp_path):
    write(tmp_path, "tsconfig.json", '{"compilerOptions":{"outDir":"output"},"include":["**/*"]}')
    write(tmp_path, "src/item.ts", "export const item = 1;")
    (tmp_path / "node_modules").mkdir()
    if not (tmp_path / "NODE_MODULES").is_dir():
        pytest.skip("host distinguishes case")
    for target in ("NODE_MODULES/new.ts", "OUTPUT/new.ts"):
        before = snapshot(tmp_path)
        error = run(tmp_path, "move_module", source="src/item.ts", target=target, refused=True, apply=True)
        assert target in error
        assert snapshot(tmp_path) == before
