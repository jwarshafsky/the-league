# rules-bot setup (one-time, ~10 minutes)

CommishAI: AI chatbot for league rules + site how-to + per-team data
questions. Uses Google's Gemini 2.5 Flash-Lite (~$0.10/M input + $0.40/M
output → typically <$1/month for a 12-team league).

## 1. Create a Gemini API key (paid tier)

1. Go to <https://aistudio.google.com/app/apikey>
2. Sign in with Google
3. Click **Create API Key** → pick **Create API key in new project** (or
   select an existing Cloud project that has billing enabled)
4. Make sure billing is set up on the linked Google Cloud project so the
   key isn't restricted to free-tier-only quota
   - Cloud Console → Billing → link a payment method to the project
5. Copy the key (starts with `AIzaSy`)

## 2. Add the key to Supabase Edge Function secrets

1. Open <https://supabase.com/dashboard/project/fbllfkrtjsihrkwnbmlw/functions/secrets>
2. Click **Add new secret**
3. Name: `GEMINI_API_KEY`
4. Value: paste the key from step 1
5. **Save**

(If `GROQ_API_KEY` exists from the old setup, you can leave or delete
it — the function ignores it now.)

### Optional: customize the daily token cap

The function enforces a per-day token cap to prevent runaway spend.
Default is **2,000,000 tokens/day** (well under $1/day at Flash-Lite
pricing; <$30/mo even if hit every day).

To override, add another secret:
- Name: `COMMISHAI_DAILY_TOKEN_CAP`
- Value: a number, e.g. `500000` for ~$0.20/day max, or `0` to disable

## 3. Deploy the edge function

If `rules-bot` already exists:

1. Open <https://supabase.com/dashboard/project/fbllfkrtjsihrkwnbmlw/functions/rules-bot>
2. Click **Code** / **Edit**
3. Select all (Cmd-A) and delete
4. In your terminal: `pbcopy < /Users/jwars/Desktop/Claude/fantasy-league/supabase/functions/rules-bot/index.ts`
5. Paste (Cmd-V) into the editor
6. Click **Deploy**

## 4. Test it

1. Open <https://jwarshafsky.github.io/the-league/?v=89> (or current `?v=N`)
2. Sign in
3. Click 💬 button bottom-right
4. Ask: "How many MiL keepers can I have?"
5. Should answer within ~1 second.

## Monitoring usage

Run in the Supabase SQL editor any time:
```sql
SELECT state FROM league_state WHERE key='commishai_usage';
```
Returns `{day, total, input, output, requests}` for today (UTC).

You can also see live billing in:
<https://console.cloud.google.com/billing>

## Troubleshooting

- **`Error: GEMINI_API_KEY not configured`** — secret didn't save
- **`Error: gemini 401`** — bad/expired key; create a new one
- **`Error: gemini 429: ... quota`** — hit a per-minute or daily quota.
  Possible causes:
  - Free-tier quota only (the project doesn't have billing enabled)
  - Hit Google's project-level limits
- **`CommishAI daily token cap reached`** — your function-level cap was
  hit. Resets at UTC midnight. Adjust the cap secret if needed.

## Cost expectations

At Gemini 2.5 Flash-Lite pricing:
- 30 questions/day → ~$0.60/month
- 60 questions/day → ~$1.25/month
- 150 questions/day → ~$3/month

To compare quality / cost with Flash (smarter, ~3× the price), edit
`MODELS` in `index.ts` and put `gemini-2.5-flash` first.
