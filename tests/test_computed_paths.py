"""Check physical URL targets and bounded computed references in workspace plans."""

import pytest

from tests.test_workspace_batch import run, snapshot
from tests.test_workspace_resolution import write


@pytest.fixture
def loader_project(tmp_path):
    """Create an unrelated source package and a package with artifact loaders."""
    write(tmp_path, "package.json", '{"workspaces":["packages/*"]}')
    for pkg in ["ui", "effects"]:
        write(tmp_path, f"packages/{pkg}/package.json", f'{{"name":"@acme/{pkg}"}}')
        write(tmp_path, f"packages/{pkg}/tsconfig.json",
              '{"compilerOptions":{"module":"ESNext","moduleResolution":"bundler"},"include":["src"]}')
    write(tmp_path, "packages/effects/src/fade.ts", "export const fade = 1;")
    write(tmp_path, "packages/ui/src/data/item.ts", "export const item = 1;")
    return tmp_path


@pytest.mark.parametrize("expression", [
    'import(`./data/${entry}`)',
    'require("./data/" + entry)',
    'new URL(`./data/${entry}`, import.meta.url)',
    'new URL(entry ? "./data/" : "../dist/", import.meta.url)',
    'import(["./data/", "../dist/"][choice])',
    'new URL((choice ? "./data/" : "./other/"), import.meta.url)',
])
def test_computed_paths_have_directory_boundaries(loader_project, expression):
    root = loader_project
    write(root, "packages/ui/src/load.ts", f"declare const choice: number, entry: string; export const load = () => {expression};")
    for op in ["move_module", "delete_module"]:
        opts = {"target": "packages/effects/src/next.ts"} if op == "move_module" else {}
        run(root, op, source="packages/effects/src/fade.ts", **opts)
        opts = {"target": "packages/ui/src/data/new.ts"} if op == "move_module" else {}
        before = snapshot(root)
        error = run(root, op, source="packages/ui/src/data/item.ts", external_computed_files=["**/*.ts"],
                    apply=True, refused=True, **opts)
        assert "packages/ui/src/load.ts:1" in error and "computed module reference" in error
        assert "Still imported by" not in error
        assert before == snapshot(root)


@pytest.mark.parametrize("setup", [
    'for (const candidate of ["./data/", "../dist/"]) { new URL(candidate, import.meta.url); }',
    'for (let candidate of ["./data/", "../dist/"]) { new URL(candidate, import.meta.url); }',
    'const dirs = ["./data/", "../dist/"]; dirs.map(candidate => new URL(candidate, import.meta.url));',
    '["./data/", "../dist/"].map(function (candidate) { return new URL(candidate, import.meta.url); });',
    'declare const choice: number; const dirs = ["./data/", "../dist/"]; new URL(dirs[choice], import.meta.url);',
    'declare const choice: boolean; const dir = choice ? "./data/" : "../dist/"; new URL(dir, import.meta.url);',
    'for (const dir of ["./data/", "./other/"]) { const later = () => new URL(dir, import.meta.url); later(); }',
    'const dir = "./data/"; const name = "item"; new URL(`${dir}${`${name}.ts`}`, import.meta.url);',
])
def test_array_and_conditional_bindings_have_finite_targets(loader_project, setup):
    path = "packages/ui/src/use.ts"
    write(loader_project, path, setup)
    run(loader_project, "delete_module", source="packages/effects/src/fade.ts")
    error = run(loader_project, "delete_module", source="packages/ui/src/data/item.ts",
                external_computed_files=[path], refused=True)
    assert path + ":1" in error and "computed" in error
    assert "external_computed_files" not in error


@pytest.mark.parametrize("operation", ["move_module", "delete_module"])
def test_refusal_combines_unknown_and_target_specific_sites(loader_project, operation):
    root = loader_project
    write(root, "packages/ui/src/load.ts", """declare const entry: string;
import(entry);
require(entry);
new URL(entry, import.meta.url);
new URL(`./data/${entry}`, import.meta.url);
""")
    opts = {"target": "packages/ui/src/new.ts"} if operation == "move_module" else {}
    error = run(root, operation, source="packages/ui/src/data/item.ts", refused=True, **opts)
    for line in range(2, 6):
        assert error.count(f"packages/ui/src/load.ts:{line} ") == 1
    assert "external_computed_files" in error
    assert "Still imported by" not in error
    preview = run(root, "delete_module", source="packages/effects/src/fade.ts",
                  external_computed_files=["packages/ui/**/load.ts"])
    assert [site["line"] for site in preview["accepted_computed_imports"]] == [2, 3, 4]


def test_validate_url_files_directories_and_generated_artifacts(loader_project):
    root = loader_project
    write(root, "packages/ui/bin/tool", "tool")
    (root / "packages/ui/dist").mkdir()
    (root / "packages/ui/dist/output.js").write_text("artifact")
    write(root, "packages/ui/src/use.ts", '\n'.join(
        f'new URL("{target}", import.meta.url);'
        for target in [".", "../..", "./data/", "../bin/tool", "../dist/output.js", "../dist/missing.js", "../dist/other.js"]
    ))
    write(root, "packages/effects/src/use.ts", 'new URL("../dist/missing.js", import.meta.url);')
    result = run(root, "validate_imports")
    assert result["errors"] == []
    assert len(result["warnings"]) == 2
    assert all("missing.js" in warning for warning in result["warnings"])
    assert any("packages/ui" in warning for warning in result["warnings"])
    opts = {"source": "packages/effects/src/fade.ts", "target": "packages/effects/src/new.ts",
            "fail_on_new_errors": True}
    run(root, "move_module", **opts)
    run(root, "move_module", **opts, apply=True)


def test_moving_a_url_owner_preserves_generated_and_directory_targets(loader_project):
    src = "packages/ui/src/use.ts"
    dst = "packages/ui/src/nested/use.ts"
    write(loader_project, src, """new URL("../dist/output.js?raw", import.meta.url);
new URL("./data/", import.meta.url);
new URL(".", import.meta.url);
""")
    applied = run(loader_project, "move_module", source=src, target=dst, fail_on_new_errors=True, apply=True)
    assert set(applied["affected_files"]) == {src, dst}
    assert (loader_project / dst).read_text().splitlines() == [
        'new URL("../../dist/output.js?raw", import.meta.url);',
        'new URL("../data/", import.meta.url);',
        'new URL("../", import.meta.url);',
    ]


def test_deleted_url_target_is_an_error_against_the_baseline(loader_project):
    asset = "packages/ui/src/data/icon.svg"
    use = "packages/ui/src/use.ts"
    write(loader_project, asset, "<svg/>")
    write(loader_project, use, 'new URL("./data/icon.svg", import.meta.url);')
    before = snapshot(loader_project)
    for apply in (False, True):
        error = run(loader_project, "batch", operations=[{"operation": "delete_module", "source": asset}],
                    fail_on_new_errors=True, apply=apply, refused=True)
        assert asset in error and use in error
        assert snapshot(loader_project) == before


LOADER = "packages/ui/src/load.ts"
ITEM_MOVE = {"source": "packages/ui/src/data/item.ts", "target": "packages/ui/src/new.ts"}


def test_mutable_directory_array_does_not_prove_a_loader_is_disjoint(loader_project):
    """The unknown entry needs an acknowledgment, which covers only that entry."""
    root = loader_project
    write(root, LOADER, """const dirs = ["../dist/"]; declare const input: string;
dirs.push(input);
for (const candidate of dirs) new URL(candidate, import.meta.url);
""")
    before = snapshot(root)
    error = run(root, "move_module", **ITEM_MOVE, apply=True, refused=True)
    assert f"{LOADER}:3 (candidate)" in error and "external_computed_files" in error
    assert snapshot(root) == before
    accepted = run(root, "move_module", **ITEM_MOVE, external_computed_files=[LOADER])
    assert accepted["accepted_computed_imports"] == [{"file": LOADER, "line": 3, "expression": "candidate"}]


@pytest.mark.parametrize("source", [
    'const dirs = ["../dist/"]; declare const input: string;\ndirs.push(input); dirs[1] = "./data/";\n'
    "for (const candidate of dirs) new URL(candidate, import.meta.url);",
    'const dirs = ["../dist/"]; declare const input: string;\ndirs.push(input); dirs.splice(0, 1, "./data/");\n'
    "for (const candidate of dirs) new URL(candidate, import.meta.url);",
    'const dirs = ["../dist/"]; declare const input: string;\ndirs.push(input); dirs.fill("./data/");\n'
    "for (const candidate of dirs) new URL(candidate, import.meta.url);",
    'const extra = ["./data/"]; declare const input: string;\nconst dirs = ["../dist/", input, ...extra];\n'
    "for (const candidate of dirs) new URL(candidate, import.meta.url);",
    'declare const input: string;\nlet dir = input; dir = "./data/";\nnew URL(dir, import.meta.url);',
    'export function load(dir = "../dist/") {\n  dir = "./data/";\n  return new URL(dir, import.meta.url);\n}',
    'const dirs = ["../dist/"];\nconst alias = dirs; alias.push("./data/");\n'
    "for (const candidate of dirs) new URL(candidate, import.meta.url);",
])
def test_acknowledgment_does_not_hide_a_path_that_the_file_writes(loader_project, source):
    root = loader_project
    write(root, LOADER, source)
    before = snapshot(root)
    error = run(root, "move_module", **ITEM_MOVE, external_computed_files=[LOADER], apply=True, refused=True)
    assert f"{LOADER}:3" in error and "computed module reference" in error
    assert "external_computed_files" not in error and snapshot(root) == before


# Loaders whose file changes or passes on the value that the loader reads.
UNLISTED = [
    'const dirs = ["../dist/"]; declare function register(list: string[]): void;\nregister(dirs);\n'
    "for (const candidate of dirs) new URL(candidate, import.meta.url);",
    'export {}; const plugins = ["../dist/a.js", "../dist/b.js"];\nconsole.log("loading", plugins);\n'
    "for (const plugin of plugins) await import(plugin);",
    'let dir = "../dist/"; declare const input: string;\ndir += input;\nnew URL(dir, import.meta.url);',
    'export function load(base: string, name: string) {\n  let file = base; file += "/fixtures/" + name;\n'
    "  return require(file);\n}",
]


@pytest.mark.parametrize(("source", "unlisted"), [
    *[(source, True) for source in UNLISTED],
    ('let dirs = ["../dist/"]; declare const input: string[];\ndirs = input;\n'
     "for (const candidate of dirs) new URL(candidate, import.meta.url);", False),
])
def test_unfollowed_writes_need_an_acknowledgment(loader_project, source, unlisted):
    root = loader_project
    write(root, LOADER, source)
    before = snapshot(root)
    for op, options in (("move_module", ITEM_MOVE), ("delete_module", {"source": ITEM_MOVE["source"]})):
        error = run(root, op, **options, apply=True, refused=True)
        assert f"{LOADER}:3" in error and "external_computed_files" in error
        assert ("changes or passes on a value" in error) == unlisted
        assert snapshot(root) == before
        accepted = run(root, op, **options, external_computed_files=[LOADER])
        assert [site["line"] for site in accepted["accepted_computed_imports"]] == [3]
        assert snapshot(root) == before
    run(root, "move_module", **ITEM_MOVE, external_computed_files=[LOADER], apply=True)
    assert (root / ITEM_MOVE["target"]).exists()


@pytest.mark.parametrize("source", [
    'const dirs = ["./data/"]; declare function register(list: string[]): void;\nregister(dirs);\n'
    "for (const candidate of dirs) new URL(candidate, import.meta.url);",
    'export {}; const plugins = ["./data/item.ts"];\nconsole.log("loading", plugins);\n'
    "for (const plugin of plugins) await import(plugin);",
    'const dirs = ["./data/"]; declare function register(list: string[]): void; declare const name: string;\n'
    "register(dirs);\nfor (const candidate of dirs) import(candidate + name);",
    'let dir = "./data/"; declare const input: string;\ndir += input;\nnew URL(dir, import.meta.url);',
    'declare const flag: boolean, input: string, name: string;\nconst dir = flag ? "./data/" : input;\n'
    "import(dir + name);",
    'declare const name: string;\nconst file = "../dist/" + name + "/../../src/data/item.ts";\n'
    "new URL(file, import.meta.url);",
])
def test_acknowledged_loader_keeps_visible_literals_checked(loader_project, source):
    """An acknowledgment covers what the engine cannot see; each listed literal still names its files."""
    root = loader_project
    write(root, LOADER, source)
    write(root, "packages/ui/src/view/panel.ts", "export const panel = 1;")
    before = snapshot(root)
    for op, options in (("move_module", ITEM_MOVE), ("delete_module", {"source": ITEM_MOVE["source"]})):
        error = run(root, op, **options, external_computed_files=[LOADER], apply=True, refused=True)
        assert f"{LOADER}:3" in error and "computed module reference" in error
        assert snapshot(root) == before
    elsewhere = {"source": "packages/ui/src/view/panel.ts", "target": "packages/ui/src/panel.ts"}
    accepted = run(root, "move_module", **elsewhere, external_computed_files=[LOADER], apply=True)
    assert [site["line"] for site in accepted["accepted_computed_imports"]] == [3]


def test_unlisted_loader_in_another_member_needs_only_an_acknowledgment(loader_project):
    root = loader_project
    write(root, LOADER, UNLISTED[1])
    fields = {"source": "packages/effects/src/fade.ts", "target": "packages/effects/src/next/fade.ts"}
    before = snapshot(root)
    error = run(root, "move_module", **fields, apply=True, refused=True)
    assert f"{LOADER}:3 (plugin)" in error and "external_computed_files" in error and snapshot(root) == before
    applied = run(root, "move_module", **fields, external_computed_files=[LOADER], apply=True)
    assert applied["accepted_computed_imports"] == [{"file": LOADER, "line": 3, "expression": "plugin"}]
    assert (root / fields["target"]).exists()


def test_plain_reassignment_lists_a_finite_choice(loader_project):
    write(loader_project, LOADER, 'let dir = "../dist/";\nif (Math.random()) dir = "./other/";\n'
          "new URL(dir, import.meta.url);")
    result = run(loader_project, "move_module", **ITEM_MOVE)
    assert "accepted_computed_imports" not in result
    error = run(loader_project, "move_module", source=ITEM_MOVE["source"], target="packages/ui/src/other/item.ts",
                refused=True)
    assert f"{LOADER}:3" in error and "computed module reference" in error


@pytest.mark.parametrize("expression", [
    'import(`./data/${name}`)',
    'import(flag ? "./data/item" : "./other")',
    'new URL(flag ? "./data/" : "./other/", import.meta.url)',
])
def test_overwriting_a_computed_target_lists_the_loader(loader_project, expression):
    src = "packages/ui/src/other-module.ts"
    write(loader_project, src, "export const changed = 2;")
    write(loader_project, "packages/ui/src/load.ts", f"declare const flag: boolean, name: string; {expression};")
    before = snapshot(loader_project)
    error = run(loader_project, "move_module", source=src, target="packages/ui/src/data/item.ts", overwrite=True,
                external_computed_files=["packages/ui/src/load.ts"], apply=True, refused=True)
    assert "packages/ui/src/load.ts:1" in error and "computed module reference" in error
    assert snapshot(loader_project) == before


def test_moving_into_a_directory_loader_can_enumerate_refuses(loader_project):
    write(loader_project, "packages/ui/src/load.ts", 'declare const name: string; import(`./data/${name}`);')
    src = "packages/ui/src/extra.ts"
    write(loader_project, src, "export const x = 1;")
    for dest in ["data2", "data"]:
        args = {"source": src, "target": f"packages/ui/src/{dest}/added.ts"}
        if dest == "data":
            error = run(loader_project, "move_module", **args, refused=True)
            assert "packages/ui/src/load.ts:1" in error
        else:
            run(loader_project, "move_module", **args)


@pytest.mark.parametrize("code", [
    'const dirs = ["./other/"]; dirs["push"]("./data/"); for (const dir of dirs) new URL(dir, import.meta.url);',
    '["./other/"].map(function visit(dir) { if (dir === "./other/") return visit("./data/"); '
    'return new URL(dir, import.meta.url); });',
    'function load(file = "./data/item.ts") { return new URL(file, import.meta.url); } load();',
    'declare const name: string; new URL(`./dist/${name}/../../data/item.ts`, import.meta.url);',
    'declare const name: string; new URL("./dist/" + name + "/%2e./%2e%2e/data/item.ts", import.meta.url);',
    'declare const name: string; const suffix = "../../data/item.ts"; '
    'new URL(`./dist/${name}/${suffix}`, import.meta.url);',
])
def test_static_loader_evidence_survives_mutation_recursion_defaults_and_traversal(loader_project, code):
    root = loader_project
    write(root, "packages/ui/src/loader.ts", code)
    before = snapshot(root)
    for apply in (False, True):
        error = run(root, "delete_module", source="packages/ui/src/data/item.ts",
                    external_computed_files=["packages/ui/src/loader.ts"], apply=apply, refused=True)
        assert "computed module reference" in error and "packages/ui/src/loader.ts:1" in error
        assert snapshot(root) == before


@pytest.mark.parametrize("base", ["((import.meta).url)", 'import.meta["url"]'])
def test_parenthesized_meta_url_keeps_its_target_on_delete_and_relocation(loader_project, base):
    use = "packages/ui/src/url.ts"
    dest = "packages/ui/src/deeper/url.ts"
    write(loader_project, use, f'export const entry = new (URL)("./data/item.ts", {base});')
    before = snapshot(loader_project)
    error = run(loader_project, "delete_module", source="packages/ui/src/data/item.ts", apply=True, refused=True)
    assert use in error and snapshot(loader_project) == before
    result = run(loader_project, "move_module", source=use, target=dest, apply=True)
    assert set(result["affected_files"]) == {use, dest}
    assert f'new (URL)("../data/item.ts", {base})' in (loader_project / dest).read_text()


def test_url_directory_created_by_the_plan_is_valid_in_preview(loader_project):
    root = loader_project
    write(root, "packages/ui/src/loader.ts", 'export const dir = new URL("./created/", import.meta.url);')
    fields = {"source": "packages/ui/src/data/item.ts", "target": "packages/ui/src/created/item.ts",
              "fail_on_new_errors": True}
    assert any("created" in w for w in run(root, "validate_imports")["warnings"])
    preview = run(root, "move_module", **fields)
    assert not (root / "packages/ui/src/created").exists()
    applied = run(root, "move_module", **fields, apply=True)
    assert preview["warnings"] == applied["warnings"] == run(root, "validate_imports")["warnings"] == []



def test_file_url_backslashes_bound_the_runtime_directory(loader_project):
    use = "packages/ui/src/deep/load.ts"
    write(loader_project, use, r'declare const name: string; new URL(`.\\..\\data\\${name}`, import.meta.url);')
    run(loader_project, "delete_module", source="packages/effects/src/fade.ts")
    error = run(loader_project, "delete_module", source="packages/ui/src/data/item.ts", refused=True)
    assert "computed module reference" in error and f"{use}:1" in error
