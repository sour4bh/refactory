#!/bin/bash
# Auto-install refactory dependencies if missing

set -e

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$(dirname "$0")")}"

# Check and install Python dependencies
if ! python -c "import rope" 2>/dev/null; then
    echo "Installing rope for Python refactoring..."
    pip install --quiet rope
fi

if ! python -c "import mcp" 2>/dev/null; then
    echo "Installing mcp for MCP server..."
    pip install --quiet mcp
fi

# Check and install Node dependencies for ts-morph
TSMORPH_DIR="$PLUGIN_ROOT/server/tsmorph"
if [ -d "$TSMORPH_DIR" ] && ! PYTHONPATH="$PLUGIN_ROOT/server" python -c \
    'from backends.typescript import TypeScriptBackend; raise SystemExit(TypeScriptBackend._check_dependencies() is not None)'; then
    if [ -f "$TSMORPH_DIR/node_modules/.package-lock.json" ] && [ ! -d "$TSMORPH_DIR/node_modules/.pnpm" ] && command -v npm &>/dev/null; then
        (cd "$TSMORPH_DIR" && npm install --no-package-lock --silent)
    elif command -v pnpm &>/dev/null; then
        echo "Installing ts-morph dependencies with pnpm..."
        (cd "$TSMORPH_DIR" && pnpm install --silent)
    elif command -v npm &>/dev/null; then
        echo "Installing ts-morph dependencies with npm..."
        (cd "$TSMORPH_DIR" && npm install --silent)
    else
        echo "Warning: No package manager found (pnpm/npm). TypeScript refactoring will not work."
    fi
fi

echo "Refactory dependencies ready."
