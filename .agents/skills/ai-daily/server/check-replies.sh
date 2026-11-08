#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/share/ai-daily/node/bin:$HOME/.local/share/ai-daily/npm/bin:$PATH"
exec 8>"${XDG_RUNTIME_DIR:-/tmp}/ai-daily-review.lock"
flock -n 8 || { echo "[review] another mailbox check is running"; exit 75; }
exec node "${AI_DAILY_SKILL:-$HOME/.agents/skills/ai-daily}/scripts/review-replies.mjs" "$@"
