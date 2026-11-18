"""Measure separate Node processes on a workspace with shared installed declarations."""
import json
import os
import subprocess
import sys
import tempfile
import time

import pytest

from tests.test_workspace_batch import ENGINE


def scale_project(root):
    """Create 35 configured members and 3,100 sources, with one JSX consumer."""
    def write(file, text):
        name = root / file
        name.parent.mkdir(parents=True, exist_ok=True)
        name.write_text(text)

    def manifest(file, data):
        write(file, json.dumps(data, indent=2) + "\n")

    manifest("package.json", {"workspaces": ["packages/*", "apps/*"]})
    manifest("tsconfig.base.json", {"compilerOptions": {
        "module": "ESNext", "moduleResolution": "bundler", "jsx": "react-jsx",
        "target": "ESNext", "strict": True, "skipLibCheck": True,
    }})
    manifest("node_modules/@types/big/package.json", {"name": "@types/big", "types": "index.d.ts"})
    declarations = "".join(
        f"export interface Entry{i} {{ identifier: string; category: 'entry-{i}'; "
        "attributes: Readonly<Record<string, string>>; color: string; enabled: boolean; weight: number; }\n"
        for i in range(20_000)
    )
    assert len(declarations) >= 3_000_000
    write("node_modules/@types/big/index.d.ts", declarations)
    manifest("node_modules/big/package.json", {"name": "big", "version": "1.0.0", "main": "index.js"})
    write("node_modules/big/index.js", "module.exports = {};")
    manifest("node_modules/react/package.json", {"name": "react", "exports": {"./jsx-runtime": "./jsx-runtime.d.ts"}})
    write("node_modules/react/jsx-runtime.d.ts", "export function jsx(type: unknown, props: unknown): unknown;")
    units = {f"./item-{i}": f"./src/item-{i}.ts" for i in range(500)}
    members = ["packages/old", "packages/ui", "apps/site", *[f"packages/lib-{i}" for i in range(32)]]
    for member in members:
        name = member.split("/")[1]
        rows = units if name == "old" else {}
        if name == "ui":
            rows = {"./button": "./src/button.tsx", "./public": "./src/index.ts", "./new": "./src/new.ts"}
        manifest(f"{member}/package.json", {
            "name": "@acme/" + name, "exports": rows,
            "dependencies": {"big": "^1.0.0", "@types/big": "^1.0.0", **({"@acme/old": "workspace:*", "@acme/ui": "workspace:*"}
                             if name == "site" else {})},
        })
        manifest(f"{member}/tsconfig.json", {"extends": "../../tsconfig.base.json", "include": ["src"],
                                             "compilerOptions": {"outDir": "dist"}})
        write(f"{member}/src/types.ts", 'export type {Entry0} from "big";\n')
    for i in range(500):
        write(f"packages/old/src/item-{i}.ts", f"export const value = {i};\n")
        write(f"apps/site/src/use-{i}.ts", f'export {{value}} from "@acme/old/item-{i}";\n')
    write("apps/site/src/registry.ts", "export const rows = {\n" + "".join(
        f'  "item-{i}": () => import("@acme/old/item-{i}"),\n' for i in range(500)) + "};\n")
    write("packages/ui/src/button.tsx", 'import type {Entry0} from "big";\n'
          'export const Button = (p: {variant: string; data?: Entry0}) => null;')
    write("packages/ui/src/index.ts", 'export {Button as Action} from "./button";')
    write("apps/site/src/view.tsx", 'import {Action} from "@acme/ui/public";\n'
                                     'export const view = <Action variant="destructive"/>;')
    write("packages/ui/src/new.ts", 'import type {Entry1} from "big"; export const value = (p: Entry1) => p.color;')
    write("packages/ui/src/old.ts", 'import type {Entry1} from "big"; export const value = (p: Entry1) => p.identifier;')
    write("packages/ui/src/use-old.ts", 'export {value} from "./old";')
    write("packages/ui/src/build/contracts.ts", 'import type {Entry2} from "big"; export const contract = (p: Entry2) => p.weight;')
    write("packages/ui/src/build/use.ts", 'export { contract } from "./contracts";')
    write("packages/ui/src/from-build.ts", 'import {contract} from "./build/contracts"; export {contract};')
    write("packages/ui/src/__tests__/load.ts", 'declare const entry: string;\n'
          'export const artifact = new URL(`../../dist/${entry}`, import.meta.url);')
    write("apps/site/src/assets.ts", 'for (const dir of ["./fixtures/", "../../dist/console/"]) {\n'
          '  new URL(dir, import.meta.url);\n}\nexport const root = new URL(".", import.meta.url);\n'
          'export const executable = new URL("./fixtures/runner", import.meta.url);\n'
          'export const built = new URL("../dist/start.js", import.meta.url);')
    write("apps/site/src/fixtures/runner", "#!/bin/sh\nexit 0\n")
    (root / "apps/site/src/fixtures/runner").chmod(0o755)
    sources = sum(1 for folder in members for _ in (root / folder).rglob("*.ts*"))
    for i in range(3100 - sources):
        write(f"packages/lib-{i % 32}/src/view-{i}.ts", f'import type {{Entry{i}}} from "big";\n'
              f'export function read(value: Entry{i}) {{return value.color;}}\n')
    return [{"operation": "move_module", "source": f"packages/old/src/item-{i}.ts",
             "target": f"packages/ui/src/item-{i}.ts", "export_as": f"./item-{i}"} for i in range(500)]


def measure(root, operation, fields, engine=ENGINE):
    """Return JSON, elapsed time and the kernel's peak RSS for this individual Node process."""
    args = {"project_root": str(root), **fields}
    with tempfile.TemporaryFile() as request, tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        request.write(json.dumps(args).encode())
        request.seek(0)
        env = dict(os.environ)
        env.pop("NODE_OPTIONS", None)
        start = time.monotonic()
        with subprocess.Popen(["node", str(engine), operation, "-"], stdin=request, stdout=out,
                              stderr=err, env=env) as child:
            while True:
                pid, status, usage = os.wait4(child.pid, os.WNOHANG)
                if pid:
                    child.returncode = os.waitstatus_to_exitcode(status)
                    break
                if time.monotonic() - start > 120:
                    child.kill()
                    pytest.fail(f"{operation} exceeded the 120-second wrapper deadline")
                time.sleep(0.02)
        elapsed = time.monotonic() - start
        peak = usage.ru_maxrss * (1 if sys.platform == "darwin" else 1024)
        guard = " with import guard" if fields.get("fail_on_new_errors") else ""
        print(f"{operation}{guard}: {elapsed:.2f}s, peak RSS {peak / 1_000_000:.1f} MB", flush=True)
        err.seek(0)
        assert child.returncode == 0, err.read().decode()
        out.seek(0)
        return json.load(out), peak


@pytest.mark.performance
@pytest.mark.skipif(not hasattr(os, "wait4"), reason="per-child peak RSS requires wait4")
@pytest.mark.parametrize("guard", [False, True], ids=["default", "guarded"])
def test_declaration_heavy_workspace(tmp_path, guard):
    steps = scale_project(tmp_path)
    if not guard:
        validated, peak = measure(tmp_path, "validate_imports", {})
        assert peak < 1_500_000_000
        assert validated["errors"] == []
    operations = [
        ("move_module", {"source": "packages/ui/src/build/contracts.ts", "target": "packages/lib-0/src/build/schema.ts",
                         "export_as": "./schema"}),
        ("replace_module", {"source": "packages/ui/src/old.ts", "target": "packages/ui/src/new.ts"}),
        ("rewrite_props", {"module": "packages/ui/src/button.tsx", "export_name": "Button",
                           "rules": [{"prop": "variant", "equals": "destructive",
                                      "replace": [{"prop": "variant", "value": "danger"}]}]}),
        ("batch", {"operations": steps}),
    ]
    for operation, fields in operations:
        result, peak = measure(tmp_path, operation, {**fields, "apply": True, "fail_on_new_errors": guard})
        assert peak < 1_500_000_000
        assert result["affected_files"]
        if operation == "rewrite_props":
            assert result["matched"] == result["rewritten"] == 1
        if operation == "batch":
            assert len(result["operations"]) == 500
    assert 'variant="danger"' in (tmp_path / "apps/site/src/view.tsx").read_text()
    assert 'from "./new"' in (tmp_path / "packages/ui/src/use-old.ts").read_text()
    assert 'from "@acme/lib-0/schema"' in (tmp_path / "packages/ui/src/build/use.ts").read_text()
    assert 'from "@acme/lib-0/schema"' in (tmp_path / "packages/ui/src/from-build.ts").read_text()
    assert (tmp_path / "apps/site/src/registry.ts").read_text().count("@acme/ui/") == 500
