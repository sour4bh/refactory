"""Exercise a complete migration with built packages, source exports and runtime loaders."""
import json

import pytest

from tests.test_workspace_batch import run, snapshot


def write(root, name, text):
    """Write a fixture file, creating its parent directories."""
    file = root / name
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(text)
    return file


@pytest.fixture
def built_workspace(tmp_path):
    root = tmp_path
    write(root, "package.json", '{"workspaces":["packages/*","apps/*"]}')
    write(root, "tsconfig.base.json", json.dumps({"compilerOptions": {
        "module": "ESNext", "moduleResolution": "bundler", "jsx": "react-jsx",
        "strict": True, "isolatedModules": True,
    }}))
    config = '{"extends":"../../tsconfig.base.json","include":["src"]}'
    rows = {
        "effects": {".": {"import": "./dist/index.js", "types": "./dist/index.d.ts"}},
        "hooks": {
            ".": {"types": "./dist/index.d.ts", "import": "./dist/index.js"},
            "./client": {"import": "./dist/client/index.js", "types": "./dist/client/index.d.ts"},
        },
        "palette": {".": {"types": "./dist/index.d.ts", "import": "./dist/index.js"}},
        "inputs": {"./button": "./src/button.ts", "./unused": "./src/unused.ts"},
        "motion": {"./icon": "./src/icon.ts"},
    }
    for name, exports in rows.items():
        manifest = {"name": "@acme/" + name, "exports": exports}
        if name in ("effects", "hooks", "palette"):
            manifest.update({"main": "./dist/index.js", "types": "./dist/index.d.ts"})
        if name == "inputs":
            manifest["dependencies"] = {"@acme/hooks": "workspace:*", "@acme/palette": "workspace:*"}
        write(root, "packages/" + name + "/package.json", json.dumps(manifest, indent=2))
        write(root, "packages/" + name + "/tsconfig.json", config)
    write(root, "apps/site/package.json", json.dumps({
        "name": "@acme/site", "dependencies": {"@acme/" + name: "workspace:*" for name in rows},
    }))
    write(root, "apps/site/tsconfig.json", config)
    write(root, "packages/effects/src/index.ts",
          'export { Fade, type FadeProps } from "./fade";\nexport { Slide } from "./slide";\n')
    write(root, "packages/effects/src/fade.tsx", "export type FadeProps = {tone: string};\nexport const Fade = 1;")
    write(root, "packages/effects/src/slide.tsx", "export const Slide = 2;\nexport {Slide as Ticker};")
    write(root, "packages/effects/dist/index.d.ts",
          "export type FadeProps = {tone: string};\nexport declare const Fade = 1, Slide = 2;")
    write(root, "packages/effects/dist/index.js", "export const Fade = 1, Slide = 2;")
    write(root, "packages/palette/src/index.ts", "export const tone = 'dark';")
    write(root, "packages/palette/dist/index.d.ts", "export declare const tone: string;")
    write(root, "packages/palette/dist/index.js", "export const tone = 'dark';")
    write(root, "packages/hooks/src/client/index.ts", "export const start = 1;")
    write(root, "packages/hooks/src/index.ts", 'export {start} from "./client";')
    write(root, "packages/inputs/src/button.ts",
          'import { start } from "@acme/hooks/client";\nimport { tone } from "@acme/palette";\n'
          "export const Button = [start, tone];")
    write(root, "packages/inputs/src/unused.ts", "export const unused = 1;")
    write(root, "packages/motion/src/icon.ts", "export const Icon = 3;")
    write(root, "apps/site/src/section.tsx",
          'import { Fade as PageFade, Slide, type FadeProps } from "@acme/effects";\n'
          'import { start } from "@acme/hooks/client";\nimport { tone } from "@acme/palette";\n'
          'import { Button } from "@acme/inputs/button";\nimport { Icon } from "@acme/motion/icon";\n'
          'export type Props = FadeProps;\nexport const section = [PageFade, Slide, start, tone, Button, Icon];\n')
    write(root, "apps/site/src/load-artifact.ts",
          'declare const artifact: string, pathToFileURL: (path: string) => URL;\n'
          'export const load = () => import(pathToFileURL(artifact).href);')
    write(root, "apps/site/src/load-fixture.ts",
          'declare const FIXTURE_URL: string;\nexport const load = () => import(FIXTURE_URL);')
    return root


LOADERS = ["apps/site/src/load-*.ts"]


def test_mixed_workspace_validates_once_per_unbuilt_package(built_workspace):
    result = run(built_workspace, "validate_imports")
    assert result["errors"] == []
    warnings = [w for w in result["warnings"] if "@acme/hooks" in w]
    assert len(warnings) == 1 and "dist/client/index.d.ts" in warnings[0]


def test_complete_built_workspace_batch_preview_equals_apply(built_workspace):
    root = built_workspace
    ops = [
        {"operation": "move_module", "source": "packages/inputs/src/button.ts",
         "target": "packages/motion/src/button.ts", "export_as": "./button"},
        *[{"operation": "move_module", "source": f"packages/effects/src/{name}.tsx",
           "target": f"packages/motion/src/{name}.tsx", "export_as": "./" + name} for name in ("fade", "slide")],
        {"operation": "replace_module", "source": "@acme/effects", "names": {
            "Fade": {"target": "@acme/motion/fade"}, "FadeProps": {"target": "@acme/motion/fade"},
            "Slide": {"target": "@acme/motion/slide", "name": "Ticker"},
        }},
        {"operation": "delete_module", "source": "packages/inputs/src/unused.ts"},
    ]
    opts = {"operations": ops, "fail_on_new_errors": True, "external_computed_files": LOADERS, "diff": True}
    before = snapshot(root)
    preview = run(root, "batch", **opts)
    assert snapshot(root) == before
    applied = run(root, "batch", apply=True, **opts)
    for field in ("diff", "affected_files", "stats", "warnings", "operations", "accepted_computed_imports"):
        assert preview[field] == applied[field]
    assert {site["file"] for site in applied["accepted_computed_imports"]} == {
        "apps/site/src/load-artifact.ts", "apps/site/src/load-fixture.ts",
    }
    after = snapshot(root)
    assert set(applied["affected_files"]) == {f for f in before.keys() | after.keys() if before.get(f) != after.get(f)}
    barrel = after["packages/effects/src/index.ts"].decode()
    assert 'export { Fade, type FadeProps } from "@acme/motion/fade"' in barrel
    assert 'export { Slide } from "@acme/motion/slide"' in barrel
    assert json.loads(after["packages/effects/package.json"])["dependencies"]["@acme/motion"] == "workspace:*"
    assert json.loads(after["packages/motion/package.json"])["dependencies"] == {
        "@acme/hooks": "workspace:*", "@acme/palette": "workspace:*",
    }
    assert after["packages/motion/src/button.ts"] == before["packages/inputs/src/button.ts"]
    caller = after["apps/site/src/section.tsx"].decode()
    assert "@acme/effects" not in caller and "Fade as PageFade" in caller and "type FadeProps" in caller
    assert "Ticker as Slide" in caller
    assert all(f'"@acme/motion/{name}"' in caller for name in ("fade", "slide", "button"))
    assert "packages/inputs/src/unused.ts" not in after
    assert all(after[file] == before[file] for file in before if "/dist/" in file)
    assert run(root, "validate_imports")["errors"] == []


def test_standalone_move_preserves_built_entry_consumers(built_workspace):
    root = built_workspace
    before = snapshot(root)
    args = {"source": "packages/effects/src/fade.tsx", "target": "packages/motion/src/fade.tsx",
            "export_as": "./fade", "external_computed_files": LOADERS, "diff": True}
    preview = run(root, "move_module", **args)
    assert snapshot(root) == before
    applied = run(root, "move_module", **args, apply=True)
    assert preview["diff"] == applied["diff"]
    after = snapshot(root)
    assert before["apps/site/src/section.tsx"] == after["apps/site/src/section.tsx"]
    assert 'from "@acme/motion/fade"' in after["packages/effects/src/index.ts"].decode()
    assert json.loads(after["packages/effects/package.json"])["dependencies"] == {"@acme/motion": "workspace:*"}
    assert run(root, "validate_imports")["errors"] == []


def test_built_barrel_cycle_refuses_complete_batch(built_workspace):
    root = built_workspace
    path = root / "packages/motion/package.json"
    manifest = json.loads(path.read_text())
    manifest["dependencies"] = {"@acme/effects": "workspace:*"}
    path.write_text(json.dumps(manifest))
    before = snapshot(root)
    steps = [
        {"operation": "delete_module", "source": "packages/inputs/src/unused.ts"},
        {"operation": "move_module", "source": "packages/effects/src/fade.tsx",
         "target": "packages/motion/src/fade.tsx", "export_as": "./fade"},
    ]
    for apply in [False, True]:
        message = run(root, "batch", operations=steps, apply=apply, external_computed_files=LOADERS, refused=True)
        assert "batch[1]" in message and "cycle" in message.lower()
        assert "@acme/effects" in message and "@acme/motion" in message
        assert snapshot(root) == before


@pytest.mark.parametrize("barrel", ['export {x} from "./private";',
                                    'import {x as local} from "./private"; export {local as x};'])
@pytest.mark.parametrize("public_entry", ["./entry.ts", {"import": "./entry.ts", "require": "./legacy.ts"}])
def test_reexport_cycle_through_source_barrels_refuses(tmp_path, barrel, public_entry):
    write(tmp_path, "package.json", '{"workspaces":["packages/*"]}')
    write(tmp_path, "packages/old/package.json", json.dumps({"name": "@acme/old", "exports": {".": public_entry}}))
    write(tmp_path, "packages/old/entry.ts", 'export * from "./barrel";')
    write(tmp_path, "packages/old/barrel.ts", barrel)
    write(tmp_path, "packages/old/private.ts", "export const x = 1;")
    write(tmp_path, "packages/new/package.json",
          '{"name":"@acme/new","exports":{},"dependencies":{"@acme/old":"workspace:*"}}')
    before = snapshot(tmp_path)
    error = run(tmp_path, "move_module", source="packages/old/private.ts", target="packages/new/x.ts",
                export_as="./x", apply=True, refused=True)
    assert "cycle" in error.lower() and "@acme/new" in error and "@acme/old" in error
    assert snapshot(tmp_path) == before
