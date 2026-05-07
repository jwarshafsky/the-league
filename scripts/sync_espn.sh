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

curl -sf -H "Cookie: ${COOKIE}" "${BASE}?view=mRoster&view=mTeam"        -o "${TMP_DIR}/rosters.json"
curl -sf -H "Cookie: ${COOKIE}" "${BASE}?view=mDraftDetail"              -o "${TMP_DIR}/draft.json"
curl -sf -H "Cookie: ${COOKIE}" "${BASE}?view=mSettings"                 -o "${TMP_DIR}/settings.json"
curl -sf -H "Cookie: ${COOKIE}" \
  -H 'X-Fantasy-Filter: {"topics":{"limit":2000,"sortMessageDate":{"sortPriority":1,"sortAsc":false}}}' \
  "${BASE}/communication/?view=kona_league_communication"                -o "${TMP_DIR}/activity.json"

# Validate
jq -e '.teams | length' "${TMP_DIR}/rosters.json" > /dev/null
jq -e '.draftDetail.picks | length' "${TMP_DIR}/draft.json" > /dev/null
jq -e '.settings.tradeSettings.deadlineDate' "${TMP_DIR}/settings.json" > /dev/null
jq -e '.topics | length' "${TMP_DIR}/activity.json" > /dev/null

echo "Building snapshot..."

# Map ESPN team IDs to our local team IDs (defined by abbreviation matching)
SNAPSHOT_JSON=$(jq -n \
  --slurpfile rosters  "${TMP_DIR}/rosters.json" \
  --slurpfile draft    "${TMP_DIR}/draft.json" \
  --slurpfile settings "${TMP_DIR}/settings.json" \
  --slurpfile activity "${TMP_DIR}/activity.json" \
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
  ]) as $events |

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
    events: $events
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
echo "  Trade deadline: $(date -r $((DEADLINE/1000)) +"%Y-%m-%d %H:%M %Z")"

# Mirror to /tmp for the running server
TMP_SERVER_DIR="/tmp/fantasy-league/js"
if [[ -d "${TMP_SERVER_DIR}" ]]; then
  cp "${OUT_FILE}" "${TMP_SERVER_DIR}/"
  echo "  Mirrored to ${TMP_SERVER_DIR}/"
fi
