"""Measure validation against separate large member dependency graphs."""
import json
import os

import pytest

from tests.test_migration_scale import measure, scale_project


def distinct_graphs(root):
    """Add one distinct declaration package per configured member beside the shared package."""
    moves = scale_project(root)[:20]
    members = sorted([*root.glob("apps/*"), *root.glob("packages/*")])
    assert len(members) == 35
    for i, member in enumerate(members):
        name = f"@acme/graph-{i}"
        pkg = member / "node_modules" / name
        pkg.mkdir(parents=True)
        (pkg / "package.json").write_text(json.dumps({"name": name, "types": "index.d.ts"}))
        declarations = "".join(
            f"export interface Graph{i}Row{j} {{ channel: 'group-{i}-item-{j}'; "
            "metadata: Readonly<Record<string, string>>; tags: readonly string[]; "
            "label: string; quantity: number; optional?: boolean; }\n"
            for j in range(17_000)
        )
        assert len(declarations) >= 3_000_000
        (pkg / "index.d.ts").write_text(declarations)
        manifest = member / "package.json"
        data = json.loads(manifest.read_text())
        data["dependencies"][name] = "^1.0.0"
        manifest.write_text(json.dumps(data, indent=2) + "\n")
        with (member / "src/types.ts").open("a") as source:
            source.write(f'export type {{Graph{i}Row0}} from "{name}";\n')
    split = {"operation": "replace_module", "source": "@acme/ui/public", "names": {
        "Action": {"target": "@acme/ui/button", "name": "Button"},
    }}
    return [
        ("validate_imports", {}),
        ("move_module", {**{k: v for k, v in moves[0].items() if k != "operation"}, "fail_on_new_errors": True}),
        ("batch", {"operations": moves, "fail_on_new_errors": True}),
        ("batch", {"operations": [*moves, split]}),
    ]


@pytest.mark.performance
@pytest.mark.skipif(not hasattr(os, "wait4"), reason="per-child peak RSS requires wait4")
def test_distinct_member_dependency_graphs(tmp_path):
    """Check complete guarded plans and a split package replacement at the default heap limit."""
    for operation, fields in distinct_graphs(tmp_path):
        result, peak = measure(tmp_path, operation, fields)
        assert peak < 1_500_000_000
        if operation == "validate_imports":
            assert result["errors"] == []
        else:
            assert result["dry_run"] is True
            assert "packages/ui/src/item-0.ts" in result["affected_files"]
            if operation == "batch":
                assert len(result["operations"]) == len(fields["operations"])
                assert ("apps/site/src/view.tsx" in result["affected_files"]) == (len(fields["operations"]) == 21)
