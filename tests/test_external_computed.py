"""Exercise explicit acknowledgments for opaque workspace loader calls."""
import pytest

from tests.test_e2e_mcp import call_json, open_mcp_session
from tests.test_workspace_batch import run, snapshot


@pytest.fixture
def loaders(tmp_path):
    """Create two independent runtime loaders and a module never referenced by them."""
    (tmp_path / "tsconfig.json").write_text('{"compilerOptions":{"module":"ESNext","moduleResolution":"bundler"}}')
    (tmp_path / "item.ts").write_text("export const item = 1;\n")
    (tmp_path / "runtime").mkdir()
    (tmp_path / "runtime/cli.ts").write_text(
        "declare const artifact: string; declare function pathToFileURL(path: string): {href: string};\n"
        "export const read = () => import(pathToFileURL(artifact).href);\n"
    )
    (tmp_path / "tools").mkdir()
    (tmp_path / "tools/fixture.ts").write_text(
        "declare const FIXTURE_URL: string;\nexport const fixture = () => import(FIXTURE_URL);\n"
    )
    return tmp_path


SITES = [
    {"file": "runtime/cli.ts", "line": 2, "expression": "pathToFileURL(artifact).href"},
    {"file": "tools/fixture.ts", "line": 2, "expression": "FIXTURE_URL"},
]


@pytest.mark.parametrize(("operation", "args"), [
    ("move_module", {"source": "item.ts", "target": "moved.ts"}),
    ("delete_module", {"source": "item.ts"}),
    ("rename_symbol", {"file": "item.ts", "old_name": "item", "new_name": "renamed"}),
    ("batch", {"operations": [{"operation": "delete_module", "source": "item.ts"}]}),
])
def test_unacknowledged_loaders_list_sites_once(loaders, operation, args):
    before = snapshot(loaders)
    for apply in (False, True):
        error = run(loaders, operation, refused=True, apply=apply, **args)
        assert "external_computed_files" in error
        for site in SITES:
            assert error.count(f"{site['file']}:{site['line']}") == 1
            assert site["expression"] in error
        assert "Still imported by" not in error
        assert snapshot(loaders) == before


def test_file_scoped_acknowledgment_and_batch_plan(loaders):
    args = {"operations": [
        {"operation": "move_module", "source": "item.ts", "target": "moved.ts"},
        {"operation": "delete_module", "source": "moved.ts"},
    ]}
    before = snapshot(loaders)
    error = run(loaders, "batch", **args, external_computed_files=["runtime/*.ts"], refused=True, apply=True)
    assert "external_computed_files" in error and "tools/fixture.ts:2" in error
    assert "runtime/cli.ts:2" not in error
    assert snapshot(loaders) == before

    args["external_computed_files"] = ["runtime/**/cli.ts", "tools/fixture.ts"]
    preview = run(loaders, "batch", **args, diff=True)
    assert preview["accepted_computed_imports"] == SITES
    assert snapshot(loaders) == before
    applied = run(loaders, "batch", **args, diff=True, apply=True)
    for field in ("accepted_computed_imports", "affected_files", "diff", "stats"):
        assert applied[field] == preview[field]
    assert applied["affected_files"] == ["item.ts"]
    assert not (loaders / "item.ts").exists()


@pytest.mark.parametrize("expression", [
    'import("./" + name)', 'import(flag ? "./item" : "./other")',
    'import(flag ? "./item" : name)', 'import("./".concat(name))', 'import(["./item", "./other"][Number(flag)])',
])
def test_file_acknowledgment_preserves_static_checks(tmp_path, expression):
    (tmp_path / "item.ts").write_text("export const item = 1;")
    (tmp_path / "use.ts").write_text(
        f'declare const name: string, flag: boolean; export const load = () => {expression};'
    )
    before = snapshot(tmp_path)
    error = run(tmp_path, "move_module", source="item.ts", target="renamed.ts", apply=True,
                external_computed_files=["use.ts"], refused=True)
    assert "computed module reference" in error and "use.ts:1" in error
    assert "external_computed_files" not in error
    assert snapshot(tmp_path) == before


@pytest.mark.parametrize(("options", "expression"), [
    ('"paths":{"~/*":["./src/*"]}', '"~/data/" + name'),
    ('"paths":{"~/*":["./src/*"]}', '`~/data/it${name}`'),
    ('"paths":{"~data":["./src/data/index.ts"],"~/*":["./src/*"]}', '"~d" + name'),
    ('"baseUrl":"./src"', '"data/" + name'),
])
def test_mapped_prefix_bounds_a_loader(tmp_path, options, expression):
    """A tsconfig alias in the static prefix bounds the loader as a relative prefix does."""
    (tmp_path / "tsconfig.json").write_text('{"compilerOptions":{"module":"ESNext","moduleResolution":"bundler",'
                                            + options + "}}")
    for name in ("src/data/item.ts", "src/data/index.ts", "src/other.ts"):
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / name).write_text("export const value = 1;\n")
    (tmp_path / "src/load.ts").write_text(f"declare const name: string;\nexport const load = () => import({expression});\n")
    result = run(tmp_path, "move_module", source="src/other.ts", target="src/more/other.ts")
    assert "accepted_computed_imports" not in result
    before = snapshot(tmp_path)
    for acknowledged in ([], ["src/load.ts"]):
        error = run(tmp_path, "move_module", source="src/data/item.ts", target="src/item.ts",
                    external_computed_files=acknowledged, apply=True, refused=True)
        assert "src/load.ts:2" in error and "computed module reference" in error
        assert snapshot(tmp_path) == before


def test_literal_suffix_without_location_needs_acknowledgment(tmp_path):
    """A literal extension does not bound where the module is, so an acknowledgment can cover it."""
    (tmp_path / "item.ts").write_text("export const item = 1;")
    (tmp_path / "use.ts").write_text('declare const name: string; export const load = () => import(name + ".ts");')
    fields = {"source": "item.ts", "target": "renamed.ts"}
    before = snapshot(tmp_path)
    error = run(tmp_path, "move_module", **fields, apply=True, refused=True)
    assert "external_computed_files" in error and 'use.ts:1 (name + ".ts")' in error
    assert snapshot(tmp_path) == before
    accepted = run(tmp_path, "move_module", **fields, external_computed_files=["use.ts"])
    assert accepted["accepted_computed_imports"] == [{"file": "use.ts", "line": 1, "expression": 'name + ".ts"'}]


def test_acknowledgment_does_not_prove_loader_relocation_safe(loaders):
    before = snapshot(loaders)
    error = run(loaders, "move_module", source="runtime/cli.ts", target="cli.ts",
                external_computed_files=["runtime/cli.ts", "tools/fixture.ts"], refused=True, apply=True)
    assert "runtime/cli.ts:2" in error and "relocat" in error.lower()
    assert snapshot(loaders) == before


def test_batch_checks_new_sites_in_unacknowledged_files(loaders):
    steps = [{"operation": "move_symbol", "source_file": "tools/fixture.ts",
              "target_file": "tools/sibling.ts", "symbol_name": "fixture"}]
    (loaders / "tools/fixture.ts").write_text("export function fixture(url: string) { return import(url); }\n")
    before = snapshot(loaders)
    error = run(loaders, "batch", operations=steps, apply=True, refused=True,
                external_computed_files=["runtime/cli.ts", "tools/fixture.ts"])
    assert "external_computed_files" in error and "tools/sibling.ts:1" in error and "batch[0]" in error
    assert snapshot(loaders) == before


def test_renamed_loader_requires_its_current_path_to_match(loaders):
    args = {"source": "runtime/cli.ts", "target": "runtime/moved.ts"}
    before = snapshot(loaders)
    error = run(loaders, "move_module", **args, apply=True, refused=True,
                external_computed_files=["runtime/cli.ts", "tools/*.ts"])
    assert "runtime/moved.ts:2" in error and "external_computed_files" in error
    assert snapshot(loaders) == before
    preview = run(loaders, "move_module", **args, external_computed_files=["runtime/*.ts", "tools/*.ts"])
    assert preview["accepted_computed_imports"] == [
        SITES[0], {**SITES[0], "file": "runtime/moved.ts"}, SITES[1],
    ]


@pytest.mark.asyncio
async def test_mcp_accepts_computed_files_for_each_workspace_tool(loaders):
    async with open_mcp_session() as session:
        schemas = {tool.name: tool.inputSchema for tool in (await session.list_tools()).tools}
        for name in ("move_module", "delete_module", "rename_symbol", "move_symbol", "replace_module",
                     "rewrite_props", "batch", "validate_imports"):
            assert "external_computed_files" in schemas[name]["properties"]
        request = {"project_root": str(loaders), "external_computed_files": ["runtime/*.ts", "tools/*.ts"]}
        result = await call_json(session, "delete_module", {**request, "source": "item.ts"})
        validation = await call_json(session, "validate_imports", {**request, "language": "typescript"})
        assert result["accepted_computed_imports"] == validation["accepted_computed_imports"] == SITES
        assert validation["valid"] and (loaders / "item.ts").exists()


def test_member_uses_workspace_relative_acknowledgments(loaders):
    (loaders / "package.json").write_text('{"workspaces":["runtime","tools"]}')
    for member in ("runtime", "tools"):
        (loaders / member / "package.json").write_text(f'{{"name":"@acme/{member}"}}')
    path = loaders / "runtime/plain.ts"
    path.write_text("export const value = 1;")
    result = run(loaders / "runtime", "move_module", source="plain.ts", target="next.ts",
                 external_computed_files=["runtime/*.ts", "tools/*.ts"])
    assert result["accepted_computed_imports"] == SITES
    assert path.is_file() and not (loaders / "runtime/next.ts").exists()


def test_validation_can_inspect_acknowledgments_without_requiring_them(loaders):
    assert run(loaders, "validate_imports")["errors"] == []
    result = run(loaders, "validate_imports", external_computed_files=["runtime/cli.ts"])
    assert result["errors"] == [] and result["accepted_computed_imports"] == SITES[:1]


def test_empty_batch_preflight_has_no_fictitious_step(loaders):
    error = run(loaders, "batch", operations=[], refused=True)
    assert "external_computed_files" in error and "batch[" not in error


@pytest.mark.parametrize("initializer", ['"./item"', 'flag ? "./item" : "./other"', '"./" + part', 'part || "./item"'])
def test_acknowledgment_cannot_hide_a_static_local_const(tmp_path, initializer):
    (tmp_path / "item.ts").write_text("export const value = 1;")
    (tmp_path / "use.ts").write_text(
        f'declare const flag: boolean, part: string; const path = {initializer}; '
        'const alias = path; export const load = () => import(alias);'
    )
    before = snapshot(tmp_path)
    error = run(tmp_path, "move_module", source="item.ts", target="new.ts", apply=True,
                external_computed_files=["use.ts"], refused=True)
    assert "computed module reference" in error and "use.ts:1" in error
    assert snapshot(tmp_path) == before


def test_static_const_and_shadowed_runtime_parameter_are_distinct(tmp_path):
    (tmp_path / "item.ts").write_text("export const value = 1;")
    (tmp_path / "use.ts").write_text(
        'const path = "./item";\nexport const load = (path: string) => import(path);'
    )
    preview = run(tmp_path, "move_module", source="item.ts", target="new.ts", external_computed_files=["use.ts"])
    assert preview["accepted_computed_imports"] == [{"file": "use.ts", "line": 2, "expression": "path"}]


@pytest.mark.parametrize("field", [True, "../outside.ts", ["../outside.ts"], [None]])
def test_external_computed_files_rejects_invalid_scope(loaders, field):
    before = snapshot(loaders)
    error = run(loaders, "delete_module", source="item.ts", external_computed_files=field, refused=True, apply=True)
    assert "external_computed_files" in error and snapshot(loaders) == before
