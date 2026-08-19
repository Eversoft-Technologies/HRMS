# Employee Chat — integration into this repo

The Employee Chat module (direct messages, channels with admins, scheduled
meetings, file sharing, message edit/delete, search, voice-to-text) has been
added to this project. Changes were made **additively** so the rest of the app
is untouched.

## Files added
- `api/consumers.py`, `api/routing.py` — WebSocket (realtime) endpoint
- `dist/dist/assets/hrms-chat.js` — the chat UI (self-contained add-on module)
- `api/migrations/0045_chat_tables.py`, `0046_chat_model_state.py`,
  `0047_chat_admin_backfill.py` — DB tables/columns (was: three hand-run .sql files)
- `dist/dist/assets/index-DCh6bk0Rv4.js.prechat.bak` — backup of the app bundle before patching

## Files changed (chat code appended / merged; existing code untouched)
- `api/models.py` — ChatRoom, ChatMember, ChatMessage, ChatMeeting (appended)
- `api/serializers.py` — chat serializers (appended)
- `api/views.py` — chat endpoints (appended)
- `api/urls.py` — chat routes (`urlpatterns += [...]` appended)
- `hrms_project/settings.py` — added `daphne` + `channels` to INSTALLED_APPS and a CHANNEL_LAYERS block
- `hrms_project/asgi.py` — HTTP + WebSocket ProtocolTypeRouter
- `requirements.txt` — `channels`, `daphne`
- `dist/dist/index.html` — loads `hrms-chat.js`
- `dist/dist/assets/index-DCh6bk0Rv4.js` — added the **Chat** nav item + `/employees/chat`
  route (three small insertions). A `.prechat.bak` backup sits beside it.

## Setup steps (run once)
1. Install deps: `pip install -r requirements.txt`  (adds channels + daphne)
<<<<<<< HEAD
2. Create the chat tables — run all three, in order, against your DB:
   ```
   mysql -u <user> -p <db_name> < chat_migrations.sql
   mysql -u <user> -p <db_name> < chat_migrations_v2.sql
   mysql -u <user> -p <db_name> < chat_migrations_v3.sql
   mysql -u <user> -p <db_name> < chat_migrations_v4.sql
   mysql -u <user> -p <db_name> < chat_migrations_v5sql

   ```
   (All use `IF NOT EXISTS`, safe to re-run.)
=======
2. `python manage.py migrate` — creates the chat tables.
>>>>>>> fix/chat-admin-backfill
3. Restart the server. With `daphne` installed, `python manage.py runserver`
   serves ASGI (so WebSockets work); in production run under daphne/uvicorn.

### The chat schema is a migration now — the .sql files are gone
Chat used to ship `chat_migrations.sql`, `_v2` and `_v3`, run by hand over SSH.
That put the schema outside the deploy pipeline, which runs `migrate` in each
release and refuses to flip the symlink if it fails. `migrate` passed, the
release went live, and every chat endpoint returned 500 until somebody
remembered three manual commands — which is what happened on production, on
every deploy, until this was changed.

`managed = False` on the chat models only stops `makemigrations` from
*generating* schema operations (a generated migration creates zero tables and
drops every ForeignKey). It does not stop a migration from *executing* DDL, so
the same statements now live in:

- `0045_chat_tables` — the four tables plus the columns v2/v3 added. Idempotent:
  `CREATE TABLE IF NOT EXISTS`, and columns added only when `information_schema`
  says they are missing, so it is safe on databases where the SQL was already
  run by hand.
- `0046_chat_model_state` — records the `managed = False` models in migration
  state. No database operations; it silences the "models have changes not yet
  reflected in a migration" warning `migrate` printed on every run.
- `0047_chat_admin_backfill` — the two `UPDATE`s that ended v3, which restore
  admins to channels created before `is_admin` existed. Without them a channel
  can end up with nobody able to manage it, and no way out from inside the app.

One deliberate difference from the old SQL: the backfill only promotes admins in
**group** rooms. The v3 `UPDATE` promoted the creator of every room including
1:1 directs, but `chat_rooms` POST creates members with
`is_admin=(is_group and e == creator)` — so the SQL wrote rows the application
never would.

## Notes
- Chat needs a **writable `media/` folder** (created automatically at
  `media/chat_uploads/` for file attachments).
- Colleagues appear in the directory from `app_users` / `user_profiles` /
  `onboarding_candidates`; a person can send but only receives/replies if they
  have a login account.
- Realtime uses the in-memory channel layer (fine for a single process). For
  multiple workers, switch `CHANNEL_LAYERS` to `channels_redis`.
- **Frontend patch caveat:** the Chat nav item + route were injected into the
  prebuilt bundle `index-DCh6bk0Rv4.js`. If the frontend is later rebuilt from
  its React source, re-apply the patch (or add the `/employees/chat` route to
  that source). Restore `*.prechat.bak` to undo.
