# Employee Chat — integration into this repo

The Employee Chat module (direct messages, channels with admins, scheduled
meetings, file sharing, message edit/delete, search, voice-to-text) has been
added to this project. Changes were made **additively** so the rest of the app
is untouched.

## Files added
- `api/consumers.py`, `api/routing.py` — WebSocket (realtime) endpoint
- `dist/dist/assets/hrms-chat.js` — the chat UI (self-contained add-on module)
- `chat_migrations.sql`, `chat_migrations_v2.sql`, `chat_migrations_v3.sql` — DB tables/columns
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
2. Create the chat tables — run all three, in order, against your DB:
   ```
   mysql -u <user> -p <db_name> < chat_migrations.sql
   mysql -u <user> -p <db_name> < chat_migrations_v2.sql
   mysql -u <user> -p <db_name> < chat_migrations_v3.sql
   mysql -u <user> -p <db_name> < chat_migrations_v4.sql
   mysql -u <user> -p <db_name> < chat_migrations_v5sql

   ```
   (All use `IF NOT EXISTS`, safe to re-run.)
3. Restart the server. With `daphne` installed, `python manage.py runserver`
   serves ASGI (so WebSockets work); in production run under daphne/uvicorn.

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
