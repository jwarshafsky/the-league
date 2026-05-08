#!/usr/bin/env bash
# Frequent ESPN sync — refresh rosters/drops/trades and push if anything
# changed. Runs every 15 minutes via cron. Stats sync stays nightly.
#
# Schedule via cron (run `crontab -e`):
#   */15 * * * * /Users/jwars/Desktop/Claude/fantasy-league/scripts/frequent_espn_sync.sh >> /tmp/fantasy-league-espn-sync.log 2>&1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# Surface failure via a macOS notification and a sentinel file. The sentinel
# at /tmp/fantasy-league-sync-failed makes silent failure visible even if Jeff
# misses the notification.
notify_failure() {
  local stage="$1"
  echo "$(date) FAILURE in $stage" >&2
  echo "$(date) failed: $stage" > /tmp/fantasy-league-sync-failed
  /usr/bin/osascript -e "display notification \"ESPN sync failed: $stage\" with title \"The League\"" 2>/dev/null || true
}

bash "${SCRIPT_DIR}/sync_espn.sh" > /dev/null 2>&1 || {
  notify_failure "sync_espn.sh"
  exit 1
}

# Only commit/push if the snapshot file actually changed.
if [[ -n "$(git status --porcelain js/espn-snapshot.js)" ]]; then
  echo "$(date) ESPN snapshot changed; pushing..."
  git add js/espn-snapshot.js
  GIT_AUTHOR_NAME="Jeff Warshafsky" \
    GIT_AUTHOR_EMAIL="jwarshafsky@gmail.com" \
    GIT_COMMITTER_NAME="Jeff Warshafsky" \
    GIT_COMMITTER_EMAIL="jwarshafsky@gmail.com" \
    git commit -m "ESPN sync (auto)" > /dev/null || { notify_failure "git commit"; exit 1; }
  if ! git push 2>&1; then
    notify_failure "git push"
    exit 1
  fi
  echo "$(date) Pushed."
fi

# Clear the sentinel on success.
rm -f /tmp/fantasy-league-sync-failed
