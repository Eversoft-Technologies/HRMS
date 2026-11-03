# HRMS — Django backend

A Python/Django port of the original Node/Express API. Django now does **two**
jobs from a single process:

1. Serves the REST API under `/api/*` (same routes, same JSON shapes the React
   app already expects — nothing in the frontend changes).
2. Serves the built React app (Vite `dist/`) for every other route via
   WhiteNoise, so the whole thing is one deployment.

The MySQL database is unchanged: the models map onto the **same tables**
(`job_posts`, `interview_links`, `resume_scores`, `interview_recordings`,
`question_sets`, `user_profiles`, `user_email_config`, `user_documents`).

> Note: login/signup/password-reset are handled entirely client-side in React
> (localStorage), exactly as before — there are no auth endpoints to port.

## Layout

```
hrms_django/
  manage.py
  requirements.txt
  .env.example          # copy to .env
  hrms_project/         # settings, urls, wsgi/asgi
  api/
    models.py           # 8 tables
    views.py            # all 25 endpoints
    urls.py
    ai.py               # Claude proxy + local question fallback
    seed.py             # base jobs/interviews
    management/commands/seed_data.py
    migrations/
```

## Local development

```bash
cd hrms_django

# 1. Virtual env + dependencies
python -m venv .venv
.venv\Scripts\activate            # Windows
# source .venv/bin/activate       # macOS/Linux
pip install -r requirements.txt

# 2. Config
copy .env.example .env            # then edit DB_* to match your MySQL
                                  # (same values as the old server/.env.local)

# 3. Build the React frontend (run in the PROJECT ROOT, one level up)
cd ..
npm install
npm run build                     # produces ../dist, which Django serves
cd hrms_django

# 4. Database
#    Fresh/empty DB — create tables and seed base data:
python manage.py migrate
#    EXISTING DB that already has the tables + data (your production case):
python manage.py migrate --fake-initial   # adopts existing tables, no data loss

# 5. Run
python manage.py runserver 0.0.0.0:8000
```

Open http://localhost:8000 — the React app and the API are both served there.

### Running the React dev server separately (optional)
If you prefer Vite's hot reload during development, run `npm run dev` (port
3000) and Django on 8000. `CORS_ALLOW_ALL_ORIGINS` is enabled while
`DJANGO_DEBUG=true`, so the dev server can call the API cross-origin. Point the
frontend at the API with `VITE_API_BASE_URL=http://localhost:8000` in the
project-root `.env.local`.

## Environment variables (`.env`)

| Var | Purpose |
|-----|---------|
| `DJANGO_SECRET_KEY` | Random secret. Required in production. |
| `DJANGO_DEBUG` | `true` locally, `false` in production. |
| `DJANGO_ALLOWED_HOSTS` | Comma list, e.g. `hrms.eversoftit.com`. |
| `DB_HOST/PORT/USER/PASSWORD/NAME` | MySQL connection (same as the old Node `.env.local`). |
| `REACT_BUILD_DIR` | Optional. Absolute path to the Vite `dist/`. Defaults to `../dist`. |
| `ANTHROPIC_API_KEY` | AI provider key, server-side only. Used when no key is saved in Settings › AI Settings. |
| `HRMS_SECRETS_KEY` | Fernet key that encrypts secrets saved from the UI (the AI key). Required to save/rotate the AI key from the UI. Keep it outside the database and its backups. |
| `VITE_ANTHROPIC_API_KEY` | **Deprecated — do not use.** Still read as a last-resort fallback so old deployments keep working, but `VITE_` values can be compiled into browser code. Move the value to `ANTHROPIC_API_KEY` and delete this variable. |

## AI provider key (Settings › AI Settings)

The AI key lives on the server only. Browsers never see it, never store it, and
can no longer send their own (`x-api-key` request headers are ignored).

**Where the key comes from, in order**

1. The key saved in **Settings › AI Settings** — stored encrypted (Fernet) in
   `ai_provider_settings`, using `HRMS_SECRETS_KEY` from the environment.
2. `ANTHROPIC_API_KEY` in the server environment / host secret manager.
3. `VITE_ANTHROPIC_API_KEY` (deprecated fallback; the page shows a warning).

The page always shows which source is active, the provider, the model and a
short key *fingerprint* (a SHA-256 prefix, not the key).

**Who can use it**

| Permission | Allows |
|-----------|--------|
| `ai.settings.view` | See status, source, provider, model and the change history. |
| `ai.settings.manage` | Test, save, rotate and remove the key. Also requires a valid sign-in token for the same user, so a stale session must sign in again. |

Both permissions are granted to **Super Admin** only (migration 0081). They are
deliberately separate from `settings.view` / `settings.manage`; grant them to
another role explicitly from Settings › Access Control if needed. Recommended:
keep two named Super Admin accounts and use narrower roles for routine HR work.

**Rotate the key**

1. Create the new key in the Anthropic console.
2. Settings › AI Settings → paste it → **Test key** → **Rotate key**. It is
   checked with a 1-token request first; a rejected key is never activated.
3. Revoke the old key in the Anthropic console.

If you manage the key in the environment instead, change `ANTHROPIC_API_KEY`
and restart the app (cPanel: *Restart* on the Python app).

**Remove the key** — *Remove saved key* deletes the encrypted copy. AI then
falls back to `ANTHROPIC_API_KEY` if it is set; otherwise AI features switch
off. Every save, rotation, test and removal is recorded in `ai_settings_audit`
(who, when, action, fingerprint). The key itself is never stored there or logged.

**Recovery**

* *No administrator available:* set `ANTHROPIC_API_KEY` on the server and
  restart; it is used whenever no saved key exists. To discard the saved key
  without the UI: `python manage.py shell -c "from api.models import
  AIProviderSetting; AIProviderSetting.objects.update(encrypted_key='', key_fingerprint='')"`.
* *`HRMS_SECRETS_KEY` lost or changed:* the saved key can no longer be
  decrypted. AI falls back to the environment key and the page says so. Set a
  new `HRMS_SECRETS_KEY` and save the AI key again.
* *Generate `HRMS_SECRETS_KEY`:*
  `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`

## Production deployment

### Option A — gunicorn (Linux/VPS/AiroApp-style)
```bash
pip install -r requirements.txt
python manage.py migrate --fake-initial   # first deploy against existing DB
python manage.py collectstatic --noinput  # optional; WhiteNoise also serves dist directly
gunicorn hrms_project.wsgi:application --bind 0.0.0.0:$PORT --workers 3 --timeout 120
```
Set the same `DB_*` env vars. WhiteNoise serves the React build, so no nginx
static config is required (a reverse proxy for TLS is still recommended).

### Option B — GoDaddy cPanel "Setup Python App" (Passenger)
1. cPanel → **Setup Python App** → Create Application
   - Python 3.10+; Application root = the uploaded `hrms_django` folder;
     Application startup file = `passenger_wsgi.py` (create one line:
     `from hrms_project.wsgi import application`).
2. Add the `DB_*`, `DJANGO_*` env vars in the app's Environment Variables.
3. Open the app's terminal: `pip install -r requirements.txt`, then
   `python manage.py migrate --fake-initial`.
4. Make sure the built `dist/` is uploaded and `REACT_BUILD_DIR` points to it.
5. Restart the app. Test: `https://your-domain/api/health` → JSON.

## Why `--fake-initial`?

Your production MySQL already contains the tables and rows created by the old
Node server. `migrate --fake-initial` tells Django "these tables already
exist — record the migration as applied without re-creating them," so **no
data is touched**. Only use a plain `migrate` on a brand-new empty database.

## Endpoint parity

All 25 routes are ported 1:1: `jobs`, `interviews` (+PUT), `resume-scores`,
`interview-recordings` (+ raw video upload/serve, PUT, DELETE), `question-sets`,
`ai/status`, `ai/generate-questions`, `user-settings/*` (profile, email-config,
documents incl. blob fetch/delete) and `health`. Verified end-to-end (42
request/response checks) against the same JSON shapes the React app consumes.
