#!/usr/bin/env bash
set -euo pipefail

# Installs the pi-dev-review workflow into ~/.pi/agent.
# Only touches dev-review files. Never replaces other Pi extensions,
# auth settings, models, sessions, local.json, or notify.json.

SOURCE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
TARGET_ROOT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
BACKUP_ROOT="$TARGET_ROOT/.backups"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$TARGET_ROOT/extensions" "$TARGET_ROOT/prompts" "$BACKUP_ROOT"

backup_if_exists() {
  local source="$1"
  local label="$2"
  if [ -e "$source" ]; then
    local destination="$BACKUP_ROOT/${label}-${STAMP}"
    mkdir -p "$(dirname "$destination")"
    cp -R "$source" "$destination"
    printf 'Backed up existing %s to %s\n' "$label" "$destination"
  fi
}

backup_if_exists "$TARGET_ROOT/dev-review" "dev-review"
backup_if_exists "$TARGET_ROOT/extensions/dev-review-loop" "dev-review-loop-extension"
backup_if_exists "$TARGET_ROOT/prompts/dev-review-plan.md" "dev-review-plan-prompt"

mkdir -p "$TARGET_ROOT/dev-review/prompts" "$TARGET_ROOT/dev-review/tests" "$TARGET_ROOT/extensions/dev-review-loop"

# Versioned files only: personal files (local.json / notify.json) stay untouched.
cp "$SOURCE_DIR/README.md" "$TARGET_ROOT/dev-review/README.md"
for file in workflow.mjs defaults.json local.json.example notify.json.example \
            discipline.md policy.md discipline-router.mjs discipline-runtime.mjs; do
  cp "$SOURCE_DIR/agent/dev-review/$file" "$TARGET_ROOT/dev-review/$file"
done
cp "$SOURCE_DIR/agent/dev-review/prompts/developer.md" "$TARGET_ROOT/dev-review/prompts/developer.md"
cp "$SOURCE_DIR/agent/dev-review/prompts/reviewer.md" "$TARGET_ROOT/dev-review/prompts/reviewer.md"
cp "$SOURCE_DIR/agent/dev-review/tests/"*.test.mjs "$TARGET_ROOT/dev-review/tests/"
cp "$SOURCE_DIR/agent/extensions/dev-review-loop/index.ts" "$TARGET_ROOT/extensions/dev-review-loop/index.ts"
cp "$SOURCE_DIR/agent/prompts/dev-review-plan.md" "$TARGET_ROOT/prompts/dev-review-plan.md"

printf '\nInstalled pi-dev-review in %s\n' "$TARGET_ROOT"
if [ ! -f "$TARGET_ROOT/dev-review/local.json" ]; then
  printf 'Next, configure models once:\n  cp %s/dev-review/local.json.example %s/dev-review/local.json\n' "$TARGET_ROOT" "$TARGET_ROOT"
fi
printf 'Verify:  start pi and run /dev-review help\n'
printf 'Tests:   node --test %s/dev-review/tests/*.test.mjs\n' "$TARGET_ROOT"
printf 'Restart pi (or /reload) after installing for changes to take effect.\n'
