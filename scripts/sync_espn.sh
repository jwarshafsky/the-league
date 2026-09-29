#!/usr/bin/env bash
# Fetches the current ESPN league state and writes js/espn-snapshot.js.
# Re-run whenever you want fresh data: bash scripts/sync_espn.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT_FILE="${ROOT_DIR}/js/espn-snapshot.js"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Load secrets from scripts/.env (gitignored). See scripts/.env.example.
if [[ -f "${SCRIPT_DIR}/.env" ]]; then
  set -a
  source "${SCRIPT_DIR}/.env"
  set +a
fi

LEAGUE_ID="${ESPN_LEAGUE_ID:-1200}"
SEASON="${ESPN_SEASON:-2026}"
SWID="${ESPN_SWID:?ESPN_SWID not set. Copy scripts/.env.example to scripts/.env and fill in your cookies.}"
S2="${ESPN_S2:?ESPN_S2 not set. Copy scripts/.env.example to scripts/.env and fill in your cookies.}"

BASE="https://lm-api-reads.fantasy.espn.com/apis/v3/games/flb/seasons/${SEASON}/segments/0/leagues/${LEAGUE_ID}"
COOKIE="SWID=${SWID}; espn_s2=${S2}"

echo "Fetching ESPN data for league ${LEAGUE_ID}, season ${SEASON}..."

# Retry transient network errors / 5xx / 429 (a single blip used to abort the
# run or — in the transaction walk — silently empty the whole txLog).
CURL=(curl -sSf --retry 3 --retry-delay 2 --retry-all-errors -H "Cookie: ${COOKIE}")

"${CURL[@]}" "${BASE}?view=mRoster&view=mTeam"        -o "${TMP_DIR}/rosters.json"
"${CURL[@]}" "${BASE}?view=mDraftDetail"              -o "${TMP_DIR}/draft.json"
"${CURL[@]}" "${BASE}?view=mSettings"                 -o "${TMP_DIR}/settings.json"

# Activity feed. ESPN DELETES a season's communication group once the league
# is renewed for the next season (seasons/2025 → 404 "This Communication Group
# does not exist" as of Sep 2026). With ESPN_SEASON still pinned to the old
# season that 404 used to abort every run. On 404 only, carry the previous
# snapshot's events forward (they're a frozen season by then); any other
# failure is still fatal.
ACTIVITY_CODE=$(curl -s --retry 3 --retry-delay 2 --retry-all-errors -H "Cookie: ${COOKIE}" \
  -H 'X-Fantasy-Filter: {"topics":{"limit":2000,"sortMessageDate":{"sortPriority":1,"sortAsc":false}}}' \
  -o "${TMP_DIR}/activity.json" -w '%{http_code}' \
  "${BASE}/communication/?view=kona_league_communication") || ACTIVITY_CODE=000
USE_PREV_EVENTS=0
echo "[]" > "${TMP_DIR}/prev_events.json"
if [[ "${ACTIVITY_CODE}" == "404" ]]; then
  if [[ -f "${OUT_FILE}" ]] && sed '1,2d; 3s/^const ESPN_SNAPSHOT = //; $s/;$//' "${OUT_FILE}" \
       | jq -e --arg season "${SEASON}" '(.season | tostring) == $season and (.events | type == "array")' > /dev/null 2>&1; then
    sed '1,2d; 3s/^const ESPN_SNAPSHOT = //; $s/;$//' "${OUT_FILE}" | jq '.events' > "${TMP_DIR}/prev_events.json"
    USE_PREV_EVENTS=1
    echo "  activity feed gone (404, season ${SEASON} likely rolled over) — carrying forward $(jq length "${TMP_DIR}/prev_events.json") previous events"
  else
    echo "  activity feed gone (404) and no previous season-${SEASON} snapshot to carry forward — shipping empty events"
  fi
  echo '{"topics":[]}' > "${TMP_DIR}/activity.json"
elif [[ "${ACTIVITY_CODE}" != "200" ]]; then
  echo "ERROR: activity feed fetch failed (HTTP ${ACTIVITY_CODE})" >&2
  exit 1
fi

# Validate. Require the keys to actually EXIST (an ESPN 200-with-error-JSON
# body has none of them; `.teams | length` would pass on it because a missing
# key yields null|length = 0 and jq -e treats 0 as truthy).
# Also require the response to be for the season we asked for and to have at
# least one rostered player — an empty-roster response (ESPN glitch, or a
# freshly renewed pre-draft season) must never overwrite the snapshot.
jq -e --arg season "${SEASON}" \
  'has("teams") and (.teams | length > 0) and ((.seasonId | tostring) == $season)
   and ([.teams[].roster.entries // [] | length] | add > 0)' "${TMP_DIR}/rosters.json" > /dev/null \
  || { echo "ERROR: rosters response invalid, wrong season, or no rostered players" >&2; exit 1; }
jq -e 'has("draftDetail") and (.draftDetail | has("picks")) and (.draftDetail.picks | length > 0)' "${TMP_DIR}/draft.json" > /dev/null \
  || { echo "ERROR: draft response has no picks (pre-draft season?)" >&2; exit 1; }
jq -e '.settings.tradeSettings.deadlineDate' "${TMP_DIR}/settings.json" > /dev/null
jq -e 'has("topics")' "${TMP_DIR}/activity.json" > /dev/null

# Full-season transaction log. The activity feed above is a ~2000-message
# window that permanently ages out older adds/drops; mTransactions2 per
# scoring period is COMPLETE (every executed add/drop/draft all season), which
# resolveCostBasis needs to price acquisition chains (drafted→dropped→FAABed→
# traded) correctly. ~110-185 small requests, 8 in parallel (~5s).
echo "Walking transaction log..."
SCORING_PERIOD=$(jq -r '.scoringPeriodId // 0' "${TMP_DIR}/rosters.json")
mkdir -p "${TMP_DIR}/tx"
# -P 8 parallel with per-request retries; || true so one failed period doesn't
# abort under pipefail — completeness is validated explicitly below.
#
# ESPN OMITS the "transactions" key for a scoring period with no transactions
# (it doesn't send []). That happens (a) every morning when ESPN rolls to a new
# day's period (~3-4 AM ET) until its first transaction, and (b) permanently
# once the season ends: after finalScoringPeriod (187 in 2026) ESPN keeps
# advancing scoringPeriodId (188+) and those periods never get transactions.
# The old check treated a missing key as a failed fetch and shipped txLog: []
# — the log went empty ~1h every morning all September and permanently from
# 2026-09-28 07:45 UTC, silently reverting salaries to the acquisitionType
# heuristic. A response that echoes this league/season/period is a real (empty)
# answer; anything else (error JSON, truncated body, failed curl) is a failure.
if [ "${SCORING_PERIOD}" -ge 1 ]; then
  seq 1 "${SCORING_PERIOD}" | xargs -P 8 -I {} \
    curl -sSf --retry 3 --retry-delay 2 --retry-all-errors -H "Cookie: ${COOKIE}" \
    "${BASE}?view=mTransactions2&scoringPeriodId={}" \
    -o "${TMP_DIR}/tx/{}.json" || true

  TX_BAD=0
  for period in $(seq 1 "${SCORING_PERIOD}"); do
    if ! jq -e --argjson lid "${LEAGUE_ID}" --argjson season "${SEASON}" --argjson p "${period}" \
         '.id == $lid and .seasonId == $season and .scoringPeriodId == $p
          and ((has("transactions") | not) or (.transactions | type == "array"))' \
         "${TMP_DIR}/tx/${period}.json" > /dev/null 2>&1; then
      TX_BAD=$((TX_BAD + 1))
      echo "  warning: transaction period ${period} missing/unparseable"
    fi
  done

  # A PARTIAL log is worse than none (a missing DRAFT or manual-trade DROP
  # reprices a keeper), and an EMPTY log silently reverts every chain price to
  # the heuristic. So an incomplete walk is FATAL: the run fails, the previous
  # (internally consistent) snapshot stays live, and the failure is surfaced —
  # same policy the Apps Script adopted on 2026-07-11.
  if [ "${TX_BAD}" -gt 0 ]; then
    echo "ERROR: transaction log incomplete (${TX_BAD} of ${SCORING_PERIOD} periods failed) — keeping previous snapshot" >&2
    exit 1
  fi

  jq -s '[ .[].transactions[]?
           | select(.status == "EXECUTED" and (.isPending | not))
           | . as $t
           | ($t.processDate // $t.proposedDate // 0) as $date
           | $t.items[]?
           | select(.type == "ADD" or .type == "DROP" or .type == "DRAFT")
           | { playerId, date: $date, kind: .type,
               isWaiverAdd: ($t.type == "WAIVER"),
               # League rule: only a commissioner can add a player outside FAAB,
               # so a manual-trade add leg is always league-manager-executed
               # (WAIVER/FAAB adds never are). txContractRoot uses this to tell a
               # manual trade from an owner FAAB pickup of a just-dropped player.
               byLeagueManager: ($t.isLeagueManager // false),
               toTeamId: (.toTeamId // 0), fromTeamId: (.fromTeamId // 0) } ]
         | sort_by(.date)' "${TMP_DIR}"/tx/*.json > "${TMP_DIR}/txlog.json"
  jq -e 'length > 0' "${TMP_DIR}/txlog.json" > /dev/null \
    || { echo "ERROR: transaction log walked cleanly but is empty (draft events alone should make it > 0)" >&2; exit 1; }
else
  # Pre-season (no scoring period yet): there is genuinely no log.
  echo "  no scoring period yet (scoringPeriodId=${SCORING_PERIOD}) — empty txLog"
  echo "[]" > "${TMP_DIR}/txlog.json"
fi

echo "Building snapshot..."

# Map ESPN team IDs to our local team IDs (defined by abbreviation matching)
SNAPSHOT_JSON=$(jq -n \
  --slurpfile rosters  "${TMP_DIR}/rosters.json" \
  --slurpfile draft    "${TMP_DIR}/draft.json" \
  --slurpfile settings "${TMP_DIR}/settings.json" \
  --slurpfile activity "${TMP_DIR}/activity.json" \
  --slurpfile txlog    "${TMP_DIR}/txlog.json" \
  --slurpfile prevEvents "${TMP_DIR}/prev_events.json" \
  --arg usePrevEvents "${USE_PREV_EVENTS}" \
  --arg syncedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg season  "${SEASON}" \
  '
  ($rosters[0].teams) as $teams |
  ($draft[0].draftDetail.picks) as $picks |
  ($settings[0].settings.tradeSettings.deadlineDate) as $deadline |
  ($settings[0].settings.draftSettings.date) as $draftDate |

  # Build team owners map: { teamId: [memberId, memberId, ...] }
  ([$teams[] | {key: (.id | tostring), value: .owners}] | from_entries) as $teamOwners |

  # Flatten all activity messages into transaction events
  # 178 = FA add, 180 = waiver add, 179/181/239 = drop, 244 = trade
  ([$activity[0].topics[]?.messages[]? |
    select(.messageTypeId == 178 or .messageTypeId == 180 or
           .messageTypeId == 179 or .messageTypeId == 181 or .messageTypeId == 239 or
           .messageTypeId == 244) |
    {
      type: (
        if .messageTypeId == 178 or .messageTypeId == 180 then "ADD"
        elif .messageTypeId == 244 then "TRADE"
        else "DROP" end
      ),
      msgType: .messageTypeId,
      date: .date,
      playerId: .targetId,
      teamId: (if .to and .to != -1 then .to else .from end),
      fromTeamId: .from,
      toTeamId: .to,
      author: .author,
      isWaiverAdd: (.messageTypeId == 180)
    }
  ]) as $rawEvents |

  # Build a set of all real human memberIds across all teams
  ([$teams[].owners[]] | unique) as $allOwnerIds |

  # Annotate ADD events with isCommishWorkaround + recentDropWithin24h flags
  ([$rawEvents[] |
    . as $ev |
    if $ev.type == "ADD" and $ev.toTeamId != null and $ev.toTeamId != -1 then
      ($teamOwners[($ev.toTeamId | tostring)] // []) as $owners |
      ($owners | index($ev.author) != null) as $authorIsOwner |
      # Author must be a real owner of SOME team (not WaiverTaskProcessor or other automation)
      ($allOwnerIds | index($ev.author) != null) as $authorIsRealHuman |
      # Most recent drop of the player within last 24h before this add
      ([$rawEvents[] | select(.type == "DROP" and .playerId == $ev.playerId and .date < $ev.date and ($ev.date - .date) <= 86400000)]
        | sort_by(.date) | last) as $recentDrop |
      $ev + {
        isCommishWorkaround: ($authorIsRealHuman and ($authorIsOwner | not)),
        recentDropWithin24h: ($recentDrop != null),
        recentDropTeamId: ($recentDrop.teamId // null)
      }
    else
      $ev + { isCommishWorkaround: false, recentDropWithin24h: false }
    end
  ]) as $computedEvents |
  # Season rolled over and the feed is gone: keep the previous snapshot events.
  (if $usePrevEvents == "1" then $prevEvents[0] else $computedEvents end) as $events |

  {
    syncedAt:      $syncedAt,
    season:        ($season | tonumber),
    tradeDeadline: $deadline,
    draftDate:     $draftDate,
    teams: [
      $teams[] | {
        espnId:   .id,
        abbrev:   .abbrev,
        roster:   [
          .roster.entries[]? | {
            playerId:        .playerId,
            name:            .playerPoolEntry.player.fullName,
            acquisitionType: .acquisitionType,
            acquisitionDate: .acquisitionDate,
            injuryStatus:    .playerPoolEntry.player.injuryStatus,
            eligibleSlots:   .playerPoolEntry.player.eligibleSlots
          }
        ]
      }
    ],
    draftPicks: [
      $picks[] | {
        playerId:    .playerId,
        teamId:      .teamId,
        bidAmount:   .bidAmount,
        keeper:      .keeper,
        overallPick: .overallPickNumber
      }
    ],
    events: $events,
    txLog: $txlog[0]
  }
  ')

echo "// Auto-generated by scripts/sync_espn.sh — do not edit by hand."   > "${OUT_FILE}"
echo "// Re-run \`bash scripts/sync_espn.sh\` to refresh."               >> "${OUT_FILE}"
echo "const ESPN_SNAPSHOT = ${SNAPSHOT_JSON};"                           >> "${OUT_FILE}"

# Stats summary
TEAM_COUNT=$(echo "${SNAPSHOT_JSON}" | jq '.teams | length')
ROSTER_TOTAL=$(echo "${SNAPSHOT_JSON}" | jq '[.teams[].roster | length] | add')
PICK_COUNT=$(echo "${SNAPSHOT_JSON}" | jq '.draftPicks | length')
EVENT_COUNT=$(echo "${SNAPSHOT_JSON}" | jq '.events | length')
TXLOG_COUNT=$(echo "${SNAPSHOT_JSON}" | jq '.txLog | length')
ADD_COUNT=$(echo "${SNAPSHOT_JSON}" | jq '[.events[] | select(.type=="ADD")] | length')
DROP_COUNT=$(echo "${SNAPSHOT_JSON}" | jq '[.events[] | select(.type=="DROP")] | length')
TRADE_COUNT=$(echo "${SNAPSHOT_JSON}" | jq '[.events[] | select(.type=="TRADE")] | length')
DEADLINE=$(echo "${SNAPSHOT_JSON}" | jq -r '.tradeDeadline')

echo ""
echo "Wrote ${OUT_FILE}"
echo "  ${TEAM_COUNT} teams"
echo "  ${ROSTER_TOTAL} total roster entries"
echo "  ${PICK_COUNT} draft picks"
echo "  ${EVENT_COUNT} events (${ADD_COUNT} adds, ${DROP_COUNT} drops, ${TRADE_COUNT} trade-legs)"
echo "  ${TXLOG_COUNT} full-season transaction-log events"
# GNU date (CI runners, Beelink) uses -d @epoch; BSD/macOS date uses -r epoch.
DEADLINE_STR=$(date -u -d "@$((DEADLINE/1000))" +"%Y-%m-%d %H:%M UTC" 2>/dev/null \
  || date -u -r "$((DEADLINE/1000))" +"%Y-%m-%d %H:%M UTC" 2>/dev/null || echo "${DEADLINE}")
echo "  Trade deadline: ${DEADLINE_STR}"

# Mirror to /tmp for the running server
TMP_SERVER_DIR="/tmp/fantasy-league/js"
if [[ -d "${TMP_SERVER_DIR}" ]]; then
  cp "${OUT_FILE}" "${TMP_SERVER_DIR}/"
  echo "  Mirrored to ${TMP_SERVER_DIR}/"
fi
