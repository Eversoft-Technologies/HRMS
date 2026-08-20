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
| `VITE_ANTHROPIC_API_KEY` | Optional. If unset, AI questions use the built-in local generator. |

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
