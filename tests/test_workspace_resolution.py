"""Cross-package module resolution and manifest edits on a source-shipping workspace."""
import json
import subprocess
from pathlib import Path

import pytest


CLI = Path(__file__).resolve().parents[1] / "server/tsmorph/refactor.js"


def write(root, file, text):
    """Write one file in the fixture."""
    target = root / file
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text)
    return target


def call(root, operation, ok=True, **params):
    """Run a public CLI operation against the synthetic workspace."""
    result = subprocess.run(
        ["node", str(CLI), operation, json.dumps({"projectRoot": str(root), **params})],
        capture_output=True, text=True, check=False,
    )
    if ok:
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)
    assert result.returncode != 0
    return result.stderr


@pytest.fixture
def workspace(tmp_path):
    """Build two libraries and an app, each with an inherited per-member config."""
    write(tmp_path, "package.json", '{"private":true,"workspaces":["apps/*","packages/*"]}\n')
    write(tmp_path, "tsconfig.base.json", json.dumps({"compilerOptions": {
        "module": "ESNext", "moduleResolution": "bundler", "strict": True, "jsx": "preserve",
    }}))
    manifests = {
        "packages/old": {"name": "@acme/old", "exports": {"./button-compact": "./src/button-compact.tsx",
                                                          "./theme": "./src/theme.ts"}},
        "packages/ui": {"name": "@acme/ui", "exports": {"./icon": "./src/icon.tsx"}},
        "apps/site": {"name": "@acme/site", "dependencies": {"@acme/old": "workspace:^"}},
    }
    for directory, manifest in manifests.items():
        write(tmp_path, f"{directory}/package.json", json.dumps(manifest, indent=2) + "\n")
        write(tmp_path, f"{directory}/tsconfig.json", json.dumps({
            "extends": "../../tsconfig.base.json",
            "compilerOptions": {"baseUrl": ".", "paths": {"~/*": ["src/*"]}},
        }))
    write(tmp_path, "packages/old/src/theme.ts", 'export const theme = "bright";\n')
    write(tmp_path, "packages/old/src/button-compact.tsx", 'import {theme} from "~/theme";\nexport const Button = theme;\n')
    write(tmp_path, "packages/ui/src/icon.tsx", 'export const Icon = 1;\n')
    write(tmp_path, "apps/site/src/main.tsx", 'import {Button} from "@acme/old/button-compact";\nexport {Button};\n')
    return tmp_path


@pytest.mark.parametrize("member_root", [False, True])
def test_member_resolution_through_exports_and_inherited_config(workspace, member_root):
    """Rename across the public package boundary from either supported entry root."""
    root = workspace / "packages/old" if member_root else workspace
    call(root, "rename_symbol", file="src/button-compact.tsx" if member_root else "packages/old/src/button-compact.tsx",
         oldName="Button", newName="Action", apply=True)
    assert 'import {Action} from "@acme/old/button-compact"' in (workspace / "apps/site/src/main.tsx").read_text()


def test_same_package_preserves_relative_alias_and_extension(workspace):
    """Resolve identical alias prefixes against the importer's own tsconfig."""
    write(workspace, "packages/ui/src/theme.ts", "export const theme = 2;\n")
    consumer = write(workspace, "packages/old/src/barrel.ts", 'export {theme} from "./theme.js";\n')
    ui = write(workspace, "packages/ui/src/view.ts", 'import {theme} from "~/theme";\nexport {theme};\n')
    call(workspace, "move_module", source="packages/old/src/theme.ts", target="packages/old/src/sub/theme.ts", apply=True)
    assert '"~/sub/theme"' in (workspace / "packages/old/src/button-compact.tsx").read_text()
    assert '"./sub/theme.js"' in consumer.read_text()
    assert '"~/theme"' in ui.read_text()
    assert json.loads((workspace / "packages/old/package.json").read_text())["exports"]["./theme"] == "./src/sub/theme.ts"


def test_cross_package_inferred_export_deps_cycle_and_format(workspace):
    """Preserve manifest layout and dependency style and surface obsolete edges and cycles."""
    old = workspace / "packages/old/package.json"
    old.write_text('{ "name" : "@acme/old", "exports" : { "./button-compact" : "./src/button-compact.tsx", '
                   '"./theme" : "./src/theme.ts" }, "dependencies" : { "@acme/ui" : "workspace:*" } }\n')
    args = {"source": "src/button-compact.tsx", "target": "../ui/src/button.tsx"}
    preview = call(workspace / "packages/old", "move_module", **args)
    assert (workspace / "packages/old/src/button-compact.tsx").exists()
    result = call(workspace / "packages/old", "move_module", **args, apply=True)
    assert result["affected_files"] == preview["affected_files"]
    assert result["warnings"] == preview["warnings"]
    assert old.read_text() == ('{ "name" : "@acme/old", "exports" : { "./theme" : "./src/theme.ts" }, '
                               '"dependencies" : { "@acme/ui" : "workspace:*" } }\n')
    ui = json.loads((workspace / "packages/ui/package.json").read_text())
    assert list(ui["exports"].items()) == [("./button", "./src/button.tsx"), ("./icon", "./src/icon.tsx")]
    assert ui["dependencies"] == {"@acme/old": "workspace:*"}
    assert json.loads((workspace / "apps/site/package.json").read_text())["dependencies"] == {
        "@acme/old": "workspace:^", "@acme/ui": "workspace:^",
    }
    assert '"@acme/old/theme"' in (workspace / "packages/ui/src/button.tsx").read_text()
    assert '"@acme/ui/button"' in (workspace / "apps/site/src/main.tsx").read_text()
    assert any("cycle" in message.lower() and "@acme/ui" in message for message in result["warnings"])
    assert any("no longer imports @acme/old" in message for message in result["warnings"])


def test_explicit_export_and_refusals(workspace):
    """Fail atomically on ambiguous exports and list every private dependency."""
    source = workspace / "packages/old/src/button-compact.tsx"
    manifest = workspace / "packages/ui/package.json"
    manifest.write_text('{"name":"@acme/ui","exports":{"./icon":"./src/icon.tsx","./special":"./src/other.ts"}}\n')
    args = {"source": "packages/old/src/button-compact.tsx", "target": "packages/ui/src/button.tsx", "apply": True}
    assert "exportAs" in call(workspace, "move_module", ok=False, **args)
    assert source.is_file()
    text = source.read_text()
    source.write_text(text + '\nimport "./one";\nimport "./two";\n')
    for name in ["one", "two"]:
        write(workspace, f"packages/old/src/{name}.ts", "export {};")
    error = call(workspace, "move_module", ok=False, exportAs="./action", **args)
    assert "one.ts" in error and "two.ts" in error
    assert "action" not in manifest.read_text()
    source.write_text(text)
    call(workspace, "move_module", exportAs="./action", **args)
    assert '"@acme/ui/action"' in (workspace / "apps/site/src/main.tsx").read_text()


@pytest.mark.parametrize("key", ["types", "main"])
def test_bare_package_entry_point_fallback(workspace, key):
    """Resolve main/types when the package has no exports map."""
    write(workspace, "packages/old/package.json", json.dumps({"name": "@acme/old", key: "./src/theme.ts"}))
    main = write(workspace, "apps/site/src/main.tsx", 'export {theme} from "@acme/old";\n')
    call(workspace, "rename_symbol", file="packages/old/src/theme.ts", oldName="theme", newName="palette", apply=True)
    assert 'export {palette}' in main.read_text()


def test_checked_relative_jsx_extension_and_shadowed_target(workspace):
    """Keep explicit source extensions and refuse an extensionless import shadowed by another file."""
    consumer = write(workspace, "packages/old/src/barrel.ts", 'export {theme} from "./theme.ts";\n')
    call(workspace, "move_module", source="packages/old/src/theme.ts", target="packages/old/src/palette.tsx", apply=True)
    assert '"./palette.tsx"' in consumer.read_text()
    consumer.write_text('export {theme} from "./palette";\n')
    write(workspace, "packages/old/src/conflict.ts", "export const unrelated = 1;\n")
    result = call(workspace, "move_module", source="packages/old/src/palette.tsx",
                  target="packages/old/src/conflict.tsx", apply=True, ok=False)
    assert "unambiguous" in result
    assert (workspace / "packages/old/src/palette.tsx").exists()
    assert not (workspace / "packages/old/src/conflict.tsx").exists()


def test_missing_asset_despite_declaration_and_valid_json(workspace):
    """Separate physical assets from their typings and bind JSON with resolveJsonModule."""
    config = workspace / "apps/site/tsconfig.json"
    settings = json.loads(config.read_text())
    settings["compilerOptions"]["resolveJsonModule"] = True
    config.write_text(json.dumps(settings))
    write(workspace, "apps/site/src/labels.json", '{"primary": "action"}')
    write(workspace, "apps/site/src/theme.css.d.ts", 'declare const theme: string; export default theme;\n')
    write(workspace, "apps/site/src/page.ts", 'import labels from "./labels.json";\n'
                                              'import theme from "./theme.css";\nexport {labels,theme};\n')
    errors = call(workspace, "validate_imports")["errors"]
    assert any("theme.css" in error["error"] for error in errors)
    assert not any("labels.json" in error["error"] for error in errors)


def test_inherited_root_dirs_and_module_suffixes(workspace):
    """Use TypeScript's resolver with the declaring package's virtual directories and suffixes."""
    config = workspace / "packages/old/tsconfig.json"
    settings = json.loads(config.read_text())
    settings["compilerOptions"].update({"rootDirs": ["src", "generated"], "moduleSuffixes": [".client", ""]})
    config.write_text(json.dumps(settings))
    write(workspace, "packages/old/generated/widget.client.ts", "export const Label = 1;\n")
    caller = write(workspace, "packages/old/src/usage.ts", 'import {Label} from "./widget";\nexport {Label};\n')
    call(workspace, "rename_symbol", file="packages/old/generated/widget.client.ts",
         oldName="Label", newName="Title", apply=True)
    assert '{Title}' in caller.read_text()


@pytest.mark.parametrize(("source_ext", "runtime_ext"), [("mts", "mjs"), ("cts", "cjs")])
def test_explicit_esm_and_commonjs_suffixes(workspace, source_ext, runtime_ext):
    """Map explicit runtime suffixes back to TypeScript modules after a move."""
    source = f"packages/ui/src/entry.{source_ext}"
    target = f"packages/ui/src/component.{source_ext}"
    write(workspace, source, "export const value = 2;\n")
    caller = write(workspace, f"packages/ui/src/view.{source_ext}", f'export {{value}} from "./entry.{runtime_ext}";\n')
    call(workspace, "move_module", source=source, target=target, apply=True)
    assert f'"./component.{runtime_ext}"' in caller.read_text()


def test_explicit_export_wins_over_existing_alias(workspace):
    """Use the requested spelling when multiple public routes lead to the new path."""
    write(workspace, "packages/ui/package.json",
          '{"name":"@acme/ui","exports":{"./legacy-link":"./src/new.tsx"}}')
    call(workspace, "move_module", source="packages/old/src/button-compact.tsx", target="packages/ui/src/new.tsx",
         export_as="./action", apply=True)
    assert '"@acme/ui/action"' in (workspace / "apps/site/src/main.tsx").read_text()
