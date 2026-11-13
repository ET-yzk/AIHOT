#!/bin/bash
# Runs node from the nvm default version, so systemd units do not hardcode a version.
set -euo pipefail
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
NODE_BIN="$(nvm which default)"
export PATH="$(dirname "$NODE_BIN"):$PATH"
exec "$NODE_BIN" "$@"
