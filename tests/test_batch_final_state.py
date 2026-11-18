"""Check that imports and dependency rows of a batch follow its final state."""

import json

import pytest

from tests.test_workspace_batch import run, snapshot
from tests.test_workspace_resolution import write

FILES = ("app-frame", "part", "view", "menu")
DESTINATION = {"app-frame": "screens", "part": "parts", "view": "screens", "menu": "screens"}


@pytest.fixture
def kiln(tmp_path):
    """Create a member that exports every file, and two empty destination members."""
    write(tmp_path, "package.json", '{"name":"@acme/root","workspaces":["packages/*"]}')
    for name in ("kiln", "screens", "parts"):
        rows = {f"./{file}": f"./src/{file}.ts" for file in FILES} if name == "kiln" else {}
        write(tmp_path, f"packages/{name}/package.json", json.dumps({"name": f"@acme/{name}", "exports": rows}, indent=2))
        write(tmp_path, f"packages/{name}/tsconfig.json", '{"compilerOptions":{"module":"ESNext","moduleResolution":"bundler"}}')
    write(tmp_path, "packages/kiln/src/app-frame.ts", 'import { part } from "./part";\nexport const shell = part;\n')
    write(tmp_path, "packages/kiln/src/part.ts", "export const part = 1;\n")
    write(tmp_path, "packages/kiln/src/view.ts", 'import { shell } from "./app-frame";\nexport const view = shell;\n')
    write(tmp_path, "packages/kiln/src/menu.ts",
          'import { view } from "./view";\nimport { part } from "./part";\nexport const menu = [view, part];\n')
    return tmp_path


def moves(order):
    """Move each kiln file to its destination member with an explicit public subpath."""
    return [{"operation": "move_module", "source": f"packages/kiln/src/{name}.ts",
             "target": f"packages/{DESTINATION[name]}/src/{name}.ts", "export_as": f"./{name}"} for name in order]


# Each target moves before its importer, so the importer first imports it through the new member's name.
ORDERS = [FILES, ("app-frame", "view", "menu", "part")]


@pytest.mark.parametrize("order", ORDERS)
def test_imports_between_files_of_one_member_stay_relative(kiln, order):
    fields = {"operations": moves(order), "diff": True, "fail_on_new_errors": True}
    preview = run(kiln, "batch", **fields)
    applied = run(kiln, "batch", apply=True, **fields)
    assert applied["diff"] == preview["diff"]
    screens = kiln / "packages/screens/src"
    assert 'from "./app-frame"' in (screens / "view.ts").read_text()
    assert 'from "./view"' in (screens / "menu.ts").read_text()
    assert not any("@acme/screens" in file.read_text() for file in screens.iterdir())
    assert 'from "@acme/parts/part"' in (screens / "menu.ts").read_text()


@pytest.mark.parametrize("order", ORDERS)
def test_dependency_rows_and_warnings_follow_final_state(kiln, order):
    before = snapshot(kiln)
    applied = run(kiln, "batch", operations=moves(order), apply=True)
    assert json.loads((kiln / "packages/kiln/package.json").read_text()) == {"name": "@acme/kiln", "exports": {}}
    assert json.loads((kiln / "packages/screens/package.json").read_text())["dependencies"] == {
        "@acme/parts": "workspace:*",
    }
    assert "dependencies" not in json.loads((kiln / "packages/parts/package.json").read_text())
    assert (kiln / "packages/parts/package.json").read_bytes() != before["packages/parts/package.json"]
    assert not [warning for warning in applied["warnings"] if "retained" in warning or "cycle" in warning]
    assert [warning for warning in applied["warnings"] if "package install" in warning] == [
        "A package install is necessary before a type check. Updated dependencies in packages/screens/package.json",
    ]


def test_row_declared_before_batch_is_retained_with_warning(kiln):
    write(kiln, "packages/screens/src/home.ts", "export const home = 1;\n")
    manifest = kiln / "packages/screens/package.json"
    manifest.write_text(json.dumps({"name": "@acme/screens", "exports": {"./home": "./src/home.ts"}}))
    kiln_manifest = kiln / "packages/kiln/package.json"
    data = json.loads(kiln_manifest.read_text())
    kiln_manifest.write_text(json.dumps({**data, "dependencies": {"@acme/screens": "workspace:*"}}))
    write(kiln, "packages/kiln/src/legacy.ts", 'import { home } from "@acme/screens/home";\nexport const legacy = home;\n')
    steps = [{"operation": "delete_module", "source": "packages/kiln/src/legacy.ts"}, *moves(FILES)]
    applied = run(kiln, "batch", operations=steps, apply=True)
    assert json.loads(kiln_manifest.read_text())["dependencies"] == {"@acme/screens": "workspace:*"}
    assert applied["warnings"].count("@acme/kiln no longer imports @acme/screens; dependency retained") == 1
    assert not [warning for warning in applied["warnings"] if "cycle" in warning or "@acme/parts;" in warning]


def test_cycle_refusal_uses_final_state(tmp_path):
    """A redirected public re-export may pass through a cycle that a later step removes."""
    write(tmp_path, "package.json", '{"workspaces":["packages/*"]}')
    write(tmp_path, "packages/old/package.json",
          json.dumps({"name": "@acme/old", "exports": {".": "./entry.ts", "./helper": "./helper.ts"}}))
    write(tmp_path, "packages/old/entry.ts", 'export * from "./private";')
    write(tmp_path, "packages/old/private.ts", 'import { help } from "./helper";\nexport const x = help;\n')
    write(tmp_path, "packages/old/helper.ts", "export const help = 1;")
    write(tmp_path, "packages/new/package.json", '{"name":"@acme/new","exports":{}}')
    write(tmp_path, "packages/new/helper.ts", "export const help = 2;")
    move = {"operation": "move_module", "source": "packages/old/private.ts", "target": "packages/new/x.ts",
            "export_as": "./x"}
    replace = {"operation": "replace_module", "source": "packages/old/helper.ts", "target": "packages/new/helper.ts"}
    before = snapshot(tmp_path)
    error = run(tmp_path, "batch", operations=[move], apply=True, refused=True)
    assert "batch[0]" in error and "cycle" in error.lower() and snapshot(tmp_path) == before
    applied = run(tmp_path, "batch", operations=[move, replace], apply=True, fail_on_new_errors=True)
    assert not [warning for warning in applied["warnings"] if "cycle" in warning.lower()]
    assert 'from "./helper"' in (tmp_path / "packages/new/x.ts").read_text()
    assert json.loads((tmp_path / "packages/old/package.json").read_text())["dependencies"] == {
        "@acme/new": "workspace:*",
    }
    assert "dependencies" not in json.loads((tmp_path / "packages/new/package.json").read_text())
