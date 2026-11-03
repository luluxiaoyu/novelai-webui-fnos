#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

echo "Building NovelAI fnOS Package..."

# 1. Build frontend
cd frontend
npx vite build
cd ..

# 2. Check if fnpack is installed in system
if command -v fnpack >/dev/null 2>&1; then
    echo "Using system fnpack to build .fpk..."
    fnpack build --directory .
else
    echo "fnpack not found in PATH, using node packaging script..."
    node scripts/build_fpk.js
fi
