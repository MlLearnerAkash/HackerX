#!/usr/bin/env bash
# Serve the workspace so dev/harness.html can load ES modules and the dock CSS.
# Usage: ./dev/serve.sh [port]
set -euo pipefail
PORT="${1:-8765}"
cd "$(dirname "$0")/.."
echo "HackerX harness -> http://localhost:${PORT}/dev/harness.html"
exec python3 -m http.server "$PORT" --bind 127.0.0.1
