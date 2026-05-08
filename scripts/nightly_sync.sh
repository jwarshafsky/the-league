#!/usr/bin/env bash
# Runs ESPN + MLB player stats syncs and pushes any changes to GitHub so the
# deployed site stays current. Schedule via cron (see end of this file).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

# Use absolute paths for tools so cron's stripped PATH works.
PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

echo "=== Nightly sync: $(date) ==="

# Surface failure via macOS notification + sentinel file so silent push
# failures (expired token, SSH agent missing) don't leave snapshots stale.
notify_failure() {
  local stage="$1"
  echo "$(date) FAILURE in $stage" >&2
  echo "$(date) failed: $stage" > /tmp/fantasy-league-sync-failed
  /usr/bin/osascript -e "display notification \"Nightly sync failed: $stage\" with title \"The League\"" 2>/dev/null || true
}

# 1. ESPN snapshot (rosters, draft, trade events)
bash "${SCRIPT_DIR}/sync_espn.sh" || { notify_failure "sync_espn.sh"; exit 1; }

# 2. MLB Stats API career hitting/pitching for callups + minors
python3 "${SCRIPT_DIR}/sync_player_stats.py" || { notify_failure "sync_player_stats.py"; exit 1; }

# 3. Push to GitHub if anything changed.
if [[ -n "$(git status --porcelain js/)" ]]; then
  echo "Committing snapshot changes..."
  git add js/espn-snapshot.js js/player-stats-snapshot.js scripts/mlb_ids.json
  GIT_AUTHOR_NAME="Jeff Warshafsky" \
    GIT_AUTHOR_EMAIL="jwarshafsky@gmail.com" \
    GIT_COMMITTER_NAME="Jeff Warshafsky" \
    GIT_COMMITTER_EMAIL="jwarshafsky@gmail.com" \
    git commit -m "Nightly snapshot sync" || { notify_failure "git commit"; exit 1; }
  if ! git push; then
    notify_failure "git push"
    exit 1
  fi
  echo "Pushed."
else
  echo "No snapshot changes; skipping commit."
fi

# Clear the sentinel on success.
rm -f /tmp/fantasy-league-sync-failed

echo "=== Done: $(date) ==="

# ---------------------------------------------------------------------------
# Schedule via cron (run `crontab -e` and add this line):
#
#   0 4 * * * /Users/jwars/Desktop/Claude/fantasy-league/scripts/nightly_sync.sh >> /tmp/fantasy-league-sync.log 2>&1
#
# Runs every night at 4:00 AM. Output log at /tmp/fantasy-league-sync.log
# ---------------------------------------------------------------------------
