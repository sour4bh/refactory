#!/bin/bash
# Run refactory tests
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

# Install test dependencies if needed
if ! python -c "import pytest" 2>/dev/null; then
    echo "Installing test dependencies..."
    pip install pytest pytest-asyncio
fi

# Install project dependencies if needed
if ! python -c "import rope" 2>/dev/null; then
    echo "Installing rope..."
    pip install rope
fi

if ! python -c "import mcp" 2>/dev/null; then
    echo "Installing mcp..."
    pip install mcp
fi

# Run tests. pyproject.toml sets testpaths=["tests"], so a bare run covers
# the full suite while explicit paths and -k filters pass through unchanged.
echo "Running tests..."
if [ "$#" -gt 0 ]; then
    PYTHONPATH="$PROJECT_ROOT/server:$PYTHONPATH" pytest "$@"
else
    PYTHONPATH="$PROJECT_ROOT/server:$PYTHONPATH" pytest -v
fi

# Gate the plugin packaging whenever the claude CLI is available.
if command -v claude >/dev/null 2>&1; then
    echo "Validating plugin packaging..."
    claude plugin validate "$PROJECT_ROOT" --strict
fi
