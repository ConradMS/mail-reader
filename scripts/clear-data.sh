#!/usr/bin/env bash
#
# clear-data.sh — wipe all Mail Reader local databases (TESTING ONLY)
#
# This deletes every per-account SQLite database (and its -wal/-shm sidecars)
# from the app's data directory, giving you a clean slate on next launch.
#
# It is intentionally a standalone terminal script — there is no in-app button
# for this, so it can't be triggered by accident while using the app.
#
# Usage:
#   ./scripts/clear-data.sh          # prompts for confirmation
#   ./scripts/clear-data.sh --yes    # skip the prompt
#
set -euo pipefail

DATA_DIR="$HOME/Library/Application Support/com.conrad.tauri-app"

if [ ! -d "$DATA_DIR" ]; then
  echo "No data directory found at:"
  echo "  $DATA_DIR"
  echo "Nothing to clear."
  exit 0
fi

echo "This will permanently delete the following from:"
echo "  $DATA_DIR"
echo ""
shopt -s nullglob
files=("$DATA_DIR"/*.db "$DATA_DIR"/*.db-wal "$DATA_DIR"/*.db-shm)
if [ ${#files[@]} -eq 0 ]; then
  echo "  (no database files found)"
  echo "Nothing to clear."
  exit 0
fi
for f in "${files[@]}"; do
  echo "  - $(basename "$f")"
done
echo ""

if [ "${1:-}" != "--yes" ]; then
  read -r -p "Delete these files? [y/N] " reply
  case "$reply" in
    [yY][eE][sS]|[yY]) ;;
    *) echo "Aborted."; exit 0 ;;
  esac
fi

for f in "${files[@]}"; do
  rm -f "$f"
done

echo "Done — all Mail Reader data cleared. Relaunch the app for a fresh start."
