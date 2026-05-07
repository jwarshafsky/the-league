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

# 1. ESPN snapshot (rosters, draft, trade events)
bash "${SCRIPT_DIR}/sync_espn.sh"

# 2. MLB Stats API career hitting/pitching for callups + minors
python3 "${SCRIPT_DIR}/sync_player_stats.py"

# 3. Push to GitHub if anything changed.
if [[ -n "$(git status --porcelain js/)" ]]; then
  echo "Committing snapshot changes..."
  git add js/espn-snapshot.js js/player-stats-snapshot.js scripts/mlb_ids.json
  GIT_AUTHOR_NAME="Jeff Warshafsky" \
    GIT_AUTHOR_EMAIL="jwarshafsky@gmail.com" \
    GIT_COMMITTER_NAME="Jeff Warshafsky" \
    GIT_COMMITTER_EMAIL="jwarshafsky@gmail.com" \
    git commit -m "Nightly snapshot sync"
  git push
  echo "Pushed."
else
  echo "No snapshot changes; skipping commit."
fi

echo "=== Done: $(date) ==="

# ---------------------------------------------------------------------------
# Schedule via cron (run `crontab -e` and add this line):
#
#   0 4 * * * /Users/jwars/Desktop/Claude/fantasy-league/scripts/nightly_sync.sh >> /tmp/fantasy-league-sync.log 2>&1
#
# Runs every night at 4:00 AM. Output log at /tmp/fantasy-league-sync.log
# ---------------------------------------------------------------------------
