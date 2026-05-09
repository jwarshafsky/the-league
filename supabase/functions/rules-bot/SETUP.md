# rules-bot setup (one-time, ~10 minutes)

CommishAI: a free AI chatbot that answers league rules + how-to-use-the-site
questions, plus questions about your own team's data. Uses Groq's free
tier (Llama 3.3 70B; 14,400 requests/day, $0/month at expected usage).

## 1. Create a Groq API key

1. Go to <https://console.groq.com/keys>
2. Sign in with Google (free, no card required)
3. Click **Create API Key** → name it anything (e.g. "the-league")
4. Copy the key (looks like `gsk_...`)

## 2. Add the key to Supabase Edge Function secrets

1. Open <https://supabase.com/dashboard/project/fbllfkrtjsihrkwnbmlw/functions/secrets>
2. Click **Add new secret**
3. Name: `GROQ_API_KEY`
4. Value: paste the key from step 1
5. **Save**

(If you already added a `GEMINI_API_KEY` from the old setup, you can leave
or delete it — the function ignores it now.)

## 3. Deploy the edge function

If the function is already deployed (the URL `/functions/v1/rules-bot`
already exists), you only need to re-paste the updated code:

1. Open <https://supabase.com/dashboard/project/fbllfkrtjsihrkwnbmlw/functions/rules-bot>
2. Click **Code** / **Edit**
3. Select all (Cmd-A) and delete
4. In your terminal: `pbcopy < /Users/jwars/Desktop/Claude/fantasy-league/supabase/functions/rules-bot/index.ts`
5. Paste (Cmd-V) into the editor
6. Click **Deploy**

If deploying for the first time:

1. Open <https://supabase.com/dashboard/project/fbllfkrtjsihrkwnbmlw/functions>
2. Click **Deploy a new function** → **Via Editor**
3. Function name: `rules-bot` (lowercase, hyphenated)
4. Paste the contents of `index.ts`
5. Click **Deploy**

## 4. Test it

1. Open <https://jwarshafsky.github.io/the-league/?v=77> (or the current `?v=N`)
2. Sign in
3. A 💬 button appears bottom-right. Click it.
4. Try: "What's the maximum minor league roster size?"
5. You should get an answer citing the constitution within ~1 second.

## Troubleshooting

- **No 💬 button appears**: not signed in, or the FAB is hidden by browser chrome
- **`Error: HTTP 401`**: not signed in — refresh and sign in
- **`Error: GROQ_API_KEY not configured`**: secret didn't save — check step 2
- **`Error: groq 401 invalid_api_key`**: the key is wrong — make a new one (step 1)
- **`Error: all groq models exhausted: ... 429`**: hit the daily limit (14,400 req/day) — wait until midnight UTC

## Cost / quotas

- **Groq free tier**: 14,400 requests/day, 30 req/min. For 12 owners
  asking ~10 questions each per day, you're at 1% of the limit
- **Supabase Edge Functions**: 500K invocations/month free
- **Total**: $0/month at expected usage

## Privacy

- The bot has read-only access to:
  - The constitution (public)
  - All teams' keeper selections, trades, roster moves, callup prices
    (already public to all owners in the app)
  - **Only the asker's** trade proposals + messages — other teams'
    inboxes are never sent to the model
- Each request is sent to Groq, which routes through their inference
  servers. Per their terms, prompts aren't used to train models. Don't
  paste anything into the chat that shouldn't leave the league.
