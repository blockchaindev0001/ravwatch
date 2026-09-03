# Deploying RAV Watch & Earn (and getting Turnstile keys)

This app is an **always-on Node server** with a database, so it needs a real
server host — **not** Netlify (static/functions only). Recommended: **Render**
(free tier, gives you a public URL). Railway and Fly.io also work.

## Why not Netlify
Netlify runs static files + short-lived serverless functions with no persistent
process or writable disk. This app keeps live state (sessions, rotating watch
tokens, live-stream cache) and writes accounts/points to disk — Netlify can't do
that without a full rewrite to functions + an external database.

---

## Deploy on Render (≈5 minutes)

1. Put this folder in a **GitHub repo** (see "Push to GitHub" below).
2. Go to https://render.com → sign up (free) → **New + → Blueprint**.
3. Connect your GitHub and pick the repo. Render reads `render.yaml` and creates
   the service with a persistent disk.
4. Click **Apply**. When it finishes you get a URL like
   `https://ravwatch.onrender.com`. **That's the URL you want.**

Note: the free plan sleeps after ~15 min idle and cold-starts on the next visit.

### Then get Cloudflare Turnstile keys
1. https://dash.cloudflare.com → **Turnstile** → **Add site**.
2. Domain: your Render hostname, e.g. `ravwatch.onrender.com`.
   (Add `localhost` too if you want to test locally.)
3. Widget mode: **Managed** (or **Invisible**).
4. Copy the **Site Key** and **Secret Key**.
5. In Render → your service → **Environment** → add/edit:
   - `TURNSTILE_SITE_KEY` = your site key
   - `TURNSTILE_SECRET_KEY` = your secret key
6. **Save** → Render redeploys. The "for testing only" banner is now gone and
   the CAPTCHA does real bot detection.

---

## Push to GitHub
From this folder:

```bash
git init
git add .
git commit -m "RAV Watch & Earn"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

`node_modules/` and `data/` are gitignored (Render installs deps and provides
the disk).

---

## Environment variables (set on the host)
| Var | Purpose |
|-----|---------|
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Your real Cloudflare Turnstile keys |
| `SESSION_SECRET` | Stable secret so logins survive restarts (Render can auto-generate) |
| `COOKIE_SECURE` | `true` in production (HTTPS) |
| `DATA_DIR` | `/data` to use the persistent disk |
| `ALCHEMY_ASSET_TRANSFERS_URL` | Optional: Alchemy Robinhood-Chain URL for true 24h wallet-age |
| `REQUIRE_WALLET_AGE` | `false` to disable the Robinhood-Chain history gate while testing |
| `PORT` | Set automatically by the host |

Everything else has a sensible default in `config.js`.
