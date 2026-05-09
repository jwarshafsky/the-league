# rules-bot setup (one-time, ~10 minutes)

This is a free AI chatbot that answers league rules + how-to-use-the-site
questions, plus questions about your own team's data. It uses Google's
Gemini Flash (free tier: 1,500 requests/day) via a Supabase Edge Function.

## 1. Create a Gemini API key

1. Go to <https://aistudio.google.com/app/apikey>
2. Sign in with any Google account (it doesn't have to be the league one)
3. Click **Create API key** → **Create API key in new project** is fine
4. Copy the key (looks like `AIzaSy...`)

## 2. Add the key to Supabase Edge Function secrets

1. Open <https://supabase.com/dashboard/project/fbllfkrtjsihrkwnbmlw/functions/secrets>
2. Click **New secret**
3. Name: `GEMINI_API_KEY`
4. Value: paste the key from step 1
5. **Save**

## 3. Deploy the edge function

1. Open <https://supabase.com/dashboard/project/fbllfkrtjsihrkwnbmlw/functions>
2. Click **Deploy a new function**
3. Function name: `rules-bot`
4. Pick **Via Editor** (no CLI install needed)
5. Replace the default code with the contents of `index.ts` from this folder
   (open it in any editor, copy-all, paste in the dashboard editor)
6. Click **Deploy**

The dashboard will show **Active** and a green dot once it's live (a few seconds).

## 4. Test it

1. Open <https://jwarshafsky.github.io/the-league/?v=74> (or whatever the
   current cache version is)
2. Sign in
3. A 💬 button should appear bottom-right. Click it.
4. Try: "What's the maximum minor league roster size?"
5. You should get an answer citing the constitution within a few seconds.

## Troubleshooting

- **No 💬 button appears**: not signed in, or the FAB is hidden behind your
  browser's chrome — try a different page or zoom out.
- **"Error: HTTP 401"**: you're not signed in. Refresh and sign in.
- **"Error: GEMINI_API_KEY not configured"**: secret didn't save. Check
  step 2.
- **"Error: gemini 429 ..."**: you hit the free-tier daily limit. Resets
  at midnight Pacific.
- **"Error: gemini 400 ... API_KEY_INVALID"**: the key is wrong or the
  Gemini API isn't enabled on the Google Cloud project. Make a new key
  per step 1.

## Cost / quotas

- Gemini Flash free tier: **1,500 requests/day** per project. For 12 owners
  asking <10 questions each per day, you're at ~10% of the limit.
- Supabase Edge Functions free tier: 500K invocations/month. We'll never
  approach this.
- Total cost: **$0/month** at expected usage.

## Privacy

- The bot has read-only access to:
  - The constitution (public)
  - All teams' keeper selections, trades, roster moves, callup prices
    (already public to all owners in the app)
  - **Only the asker's** trade proposals + messages — other teams' inboxes
    are never sent to the model
- Each request is sent to Google. They retain prompt data for 24h on the
  free tier per their policy. Do not paste anything into the chat that
  shouldn't leave the league.
