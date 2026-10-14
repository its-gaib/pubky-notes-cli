#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$repo_dir"
command -v flock >/dev/null || { echo 'Install util-linux (flock) first.' >&2; exit 1; }
npm ci
npm run build
chmod u+x "$repo_dir/dist/cli.js"
mkdir -p "$HOME/.local/bin"
cli_link="$HOME/.local/bin/pubky-notes"
if [[ -e "$cli_link" || -L "$cli_link" ]]; then
  if [[ "$(readlink -- "$cli_link" || true)" != "$repo_dir/dist/cli.js" ]]; then
    echo "Refusing to replace an existing $cli_link" >&2
    exit 1
  fi
else
  ln -s -- "$repo_dir/dist/cli.js" "$cli_link"
fi
echo "Installed $cli_link"
