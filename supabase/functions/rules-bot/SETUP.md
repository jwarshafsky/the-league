# rules-bot setup (one-time, ~10 minutes)

CommishAI: AI chatbot for league rules + site how-to + per-team data
questions. Currently uses Groq's free tier with Llama 3.1 8B Instant.

## 1. Create a Groq API key

1. Go to <https://console.groq.com/keys>
2. Sign in with Google (free, no card required)
3. Click **Create API Key** → name it anything (e.g. "the-league")
4. Copy the key (starts with `gsk_`)

## 2. Add the key to Supabase Edge Function secrets

1. Open <https://supabase.com/dashboard/project/fbllfkrtjsihrkwnbmlw/functions/secrets>
2. Click **Add new secret**
3. Name: `GROQ_API_KEY`
4. Value: paste the key from step 1
5. **Save**

### Optional: customize the daily token cap

The function enforces a per-day token cap as a backstop. Default is
**2,000,000 tokens/day**. Set `COMMISHAI_DAILY_TOKEN_CAP` to override
or `0` to disable.

## 3. Deploy the edge function

If `rules-bot` already exists:

1. <https://supabase.com/dashboard/project/fbllfkrtjsihrkwnbmlw/functions/rules-bot>
2. Click **Code** / **Edit**, select all, delete
3. `pbcopy < /Users/jwars/Desktop/Claude/fantasy-league/supabase/functions/rules-bot/index.ts`
4. Paste, **Deploy**

## 4. Test it

1. Open <https://jwarshafsky.github.io/the-league/?v=89> (or current `?v=N`)
2. Sign in
3. Click 💬 button bottom-right
4. Ask: "How many MiL keepers can I have?"

## Error handling

When the bot fails (free-tier TPM hit, model error, etc.):
- **Commissioners** see the full error text (so they can debug)
- **Non-commissioners** see: *"I don't have the answer. Please ask the
  commissioner."*

## Monitoring

```sql
SELECT state FROM league_state WHERE key='commishai_usage';
```

## If you hit Groq's free tier ceiling

Groq's free tier has tight TPM limits (6k on 8B, 12k on 70B). If users
hit these often, options:
- Upgrade to Groq Dev Tier (when available again)
- Switch provider — see commit `12d2eb3` for a Gemini swap reference
