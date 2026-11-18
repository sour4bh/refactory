"""Track static file URL loaders and acknowledge only their unbounded alternatives."""

import pytest

from tests.test_workspace_batch import run, snapshot
from tests.test_workspace_resolution import write


@pytest.fixture
def urls(tmp_path):
    write(tmp_path, "package.json", '{"workspaces":["packages/*"]}')
    for pkg in ("host", "tools"):
        write(tmp_path, f"packages/{pkg}/package.json", f'{{"name":"@acme/{pkg}","exports":{{}}}}')
        write(tmp_path, f"packages/{pkg}/tsconfig.json", '{"compilerOptions":{"module":"ESNext","moduleResolution":"bundler"}}')
    write(tmp_path, "packages/tools/src/fixture.ts", "export const fixture = 1;")
    write(tmp_path, "packages/host/src/other.ts", "export const value = 1;")
    return tmp_path


SOURCE = "packages/tools/src/fixture.ts"
TARGET = "packages/tools/src/moved fixture.ts"
LOADER = "packages/host/src/use.ts"
LITERAL = '"../../tools/src/fixture.ts"'
CONSTRUCT = f"new URL({LITERAL}, import.meta.url)"


@pytest.mark.parametrize(("imports", "expression"), [
    ("", CONSTRUCT + ".href"),
    ("", CONSTRUCT + ".pathname"),
    ('import {fileURLToPath as toPath} from "node:url";', f"toPath({CONSTRUCT})"),
    ('import * as urls from "node:url";', f"urls.fileURLToPath({CONSTRUCT})"),
    (f"const u = {CONSTRUCT};", "u.href"),
])
def test_urls_follow_static_targets_through_local_bindings(urls, imports, expression):
    original = f"{imports}\nconst source = {expression};\nconst fixture = source;\nexport const read = () => import(fixture);"
    use = write(urls, LOADER, original)
    for op in ("delete_module", "move_module"):
        options = {"target": "packages/host/src/later.ts"} if op == "move_module" else {}
        result = run(urls, op, source="packages/host/src/other.ts", **options)
        assert not result.get("accepted_computed_imports")
    before = snapshot(urls)
    error = run(urls, "delete_module", source=SOURCE, external_computed_files=["packages/host/**/*.ts"], refused=True, apply=True)
    assert LOADER in error and "Still imported by" in error and snapshot(urls) == before
    fields = {"source": SOURCE, "target": TARGET, "diff": True}
    preview = run(urls, "move_module", **fields)
    assert snapshot(urls) == before
    applied = run(urls, "move_module", **fields, apply=True)
    assert preview["diff"] == applied["diff"] and LOADER in applied["affected_files"]
    assert use.read_text() == original.replace(LITERAL, '"../../tools/src/moved%20fixture.ts"')


def test_unbounded_computed_acknowledgment_allows_unknown_part_only(urls):
    write(urls, LOADER, 'declare function resolve(input: string): string;\n'
          'declare const flag: boolean;\nimport(flag ? "./other" : resolve("external"));')
    before = snapshot(urls)
    strict = run(urls, "delete_module", source=SOURCE, refused=True, apply=True)
    assert "external_computed_files" in strict and LOADER + ":3" in strict and snapshot(urls) == before
    opts = {"external_computed_files": ["packages/host/**/*.ts"]}
    accepted = run(urls, "delete_module", source=SOURCE, **opts)
    assert accepted["accepted_computed_imports"] == [
        {"file": LOADER, "line": 3, "expression": 'flag ? "./other" : resolve("external")'},
    ]
    error = run(urls, "delete_module", source="packages/host/src/other.ts", **opts, refused=True, apply=True)
    assert LOADER in error and "computed module reference" in error and snapshot(urls) == before


@pytest.mark.parametrize("prefix, expression", [
    ('const fileURLToPath = (value: URL) => "external";', f"fileURLToPath({CONSTRUCT})"),
    ('class URL { constructor(path: string, base: string) {{}} href = "external"; }', f"{CONSTRUCT}.href"),
    (f'const u = {CONSTRUCT}; u.pathname = "external";', "u.href"),
])
def test_shadowed_or_mutable_url_projection_needs_acknowledgment(urls, prefix, expression):
    write(urls, LOADER, prefix + f'\nexport const read = () => import({expression});')
    error = run(urls, "delete_module", source="packages/host/src/other.ts", refused=True)
    assert "external_computed_files" in error and LOADER in error
    result = run(urls, "delete_module", source="packages/host/src/other.ts", external_computed_files=[LOADER])
    assert result["accepted_computed_imports"][0]["expression"] == expression
