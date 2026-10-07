#!/bin/bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")" && pwd)"
if [ -x "$project_dir/.runtime/bin/node" ]; then
  export PATH="$project_dir/.runtime/bin:$PATH"
fi
cd "$project_dir/sprink"
if ! command -v node >/dev/null 2>&1; then
  echo "Install Node 22.19.0 and pnpm 10.17.1, then try again."
  exit 1
fi
if [ "$(node -p 'process.versions.node.split(".")[0]')" != "22" ]; then
  echo "Select Node 22 before running SprinkMate. See sprink/docs/boston-setup.md."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Run pnpm install --frozen-lockfile in the sprink folder first."
  exit 1
fi
if [ -f "$project_dir/.runtime/pnpm/bin/pnpm.cjs" ]; then
  package_runner=(node "$project_dir/.runtime/pnpm/bin/pnpm.cjs")
else
  package_runner=(pnpm)
fi
if [ ! -f apps/web/dist/index.html ]; then
  "${package_runner[@]}" build
fi
echo "SprinkMate: http://127.0.0.1:4310/codes"
echo "The connection token is in sprink/.data/access-token. Keep this terminal open."
exec "${package_runner[@]}" start
