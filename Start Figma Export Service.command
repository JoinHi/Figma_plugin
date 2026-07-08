#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Please install Node.js or run this from a shell where node is available."
  read -r -p "Press Enter to close..."
  exit 1
fi

node scripts/service-control.mjs start

echo
echo "The export service is ready. You can now run the Figma plugin."
echo "This window can be closed."
read -r -p "Press Enter to close..."
