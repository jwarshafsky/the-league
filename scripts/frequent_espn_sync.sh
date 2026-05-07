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

bash "${SCRIPT_DIR}/sync_espn.sh" > /dev/null 2>&1 || {
  echo "$(date) sync_espn.sh failed — bailing"
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
    git commit -m "ESPN sync (auto)" > /dev/null
  git push > /dev/null 2>&1
  echo "$(date) Pushed."
fi
