#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${1:-$HOME/.local/bin}"
BIN_PATH="$BIN_DIR/boon"

pnpm --dir "$ROOT" --filter @boon/normalize build
pnpm --dir "$ROOT" --filter boon-cli build

mkdir -p "$BIN_DIR"
cat > "$BIN_PATH" <<WRAPPER
#!/usr/bin/env bash
exec node "$ROOT/cli/dist/index.js" "\$@"
WRAPPER
chmod +x "$BIN_PATH"

printf 'Linked boon CLI to %s\n' "$BIN_PATH"
printf 'Make sure %s is on PATH, then run: boon doctor\n' "$BIN_DIR"
