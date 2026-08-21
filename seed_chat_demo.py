"""
Seed demo chat + presence data so the online dots, channel "Seen-by-all", and
direct chats are visible on localhost.

Run from the repo root with your virtualenv:
    python seed_chat_demo.py                 # auto-detect the viewer (first real user)
    python seed_chat_demo.py you@company.com # or pass the email you log in with

Safe to re-run: it reuses demo users/rooms by email/name instead of duplicating.
"""
import os
import sys
from datetime import datetime, timedelta, date

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "hrms_project.settings")
django.setup()

from api.models import (  # noqa: E402
    AppUser, ChatRoom, ChatMember, ChatMessage, EmployeeAttendance,
)

NOW = datetime.now()
TODAY = date.today()

DEMO = [
    # email, name, online-today?
    ("aisha.demo@eversoftit.com",  "Aisha Khan",     True),
    ("rohit.demo@eversoftit.com",  "Rohit Sharma",   False),
    ("meera.demo@eversoftit.com",  "Meera Nair",     True),
    ("karan.demo@eversoftit.com",  "Karan Patel",    False),
    ("divya.demo@eversoftit.com",  "Divya Rao",      True),
]
DEMO_EMAILS = [d[0] for d in DEMO]


def initials(name):
    p = name.split()
    return (p[0][0] + (p[-1][0] if len(p) > 1 else "")).upper()


def get_viewer():
    if len(sys.argv) > 1 and sys.argv[1].strip():
        return sys.argv[1].strip().lower()
    u = (AppUser.objects.exclude(email__in=DEMO_EMAILS).order_by("id").first())
    if u:
        return u.email
    print("No real user found — pass the email you log in with: python seed_chat_demo.py you@company.com")
    sys.exit(1)


def ensure_user(email, name):
    u = AppUser.objects.filter(email=email).first()
    if u:
        return u
    return AppUser.objects.create(
        full_name=name, email=email, password="demo1234",
        initials=initials(name), role="hr", status="active",
    )


def ensure_room(name, is_group, created_by):
    r = ChatRoom.objects.filter(name=name, is_group=is_group).first()
    if r:
        return r, False
    return ChatRoom.objects.create(
        name=name, is_group=is_group, created_by=created_by,
        created_at=NOW, is_private=True,
    ), True


def ensure_member(room, email, is_admin=False, last_read_at=None):
    m = ChatMember.objects.filter(room_id=room.id, employee_email=email).first()
    if not m:
        m = ChatMember.objects.create(
            room=room, employee_email=email, joined_at=NOW, is_admin=is_admin,
        )
    m.last_read_at = last_read_at
    m.save(update_fields=["last_read_at"])
    return m


def add_msg(room, sender, name, text, minutes_ago):
    ts = NOW - timedelta(minutes=minutes_ago)
    return ChatMessage.objects.create(
        room=room, sender_email=sender, sender_name=name,
        message=text, is_read=True, created_at=ts,
    )


def set_checkin(email, online):
    att = EmployeeAttendance.objects.filter(email=email, date=TODAY).first()
    if not att:
        att = EmployeeAttendance(email=email, date=TODAY)
    if online:
        att.check_in = NOW - timedelta(hours=2)
        att.check_out = None
        att.status = "present"
    else:
        att.check_in = None
        att.check_out = None
        att.status = "absent"
    att.save()


def main():
    viewer = get_viewer()
    vuser = AppUser.objects.filter(email=viewer).first()
    vname = (vuser.full_name if vuser and vuser.full_name else viewer.split("@")[0])
    print("Viewer:", viewer)

    # 1) demo colleague accounts
    for email, name, _ in DEMO:
        ensure_user(email, name)

    # 2) attendance (drives the online/offline dots) — viewer online too
    set_checkin(viewer, True)
    for email, name, online in DEMO:
        set_checkin(email, online)

    # 3) a 5-member channel: viewer + first 4 demo users
    chan, _ = ensure_room("Demo Team", True, viewer)
    chan_members = [viewer] + DEMO_EMAILS[:4]
    ensure_member(chan, viewer, is_admin=True, last_read_at=NOW)

    # First channel message (from viewer) is SEEN BY ALL: every other member read
    # after it. A later one is NOT seen by all yet (some members read before it).
    m_old = add_msg(chan, viewer, vname, "Morning team — standup at 10?", 120)
    add_msg(chan, DEMO[0][0], DEMO[0][1], "Works for me 👍", 110)
    add_msg(chan, DEMO[2][0], DEMO[2][1], "See you there", 100)
    m_new = add_msg(chan, viewer, vname, "Also please update your tickets today.", 20)

    read_all = NOW - timedelta(minutes=90)   # after m_old, before m_new
    read_recent = NOW - timedelta(minutes=5)  # after m_new
    # aisha + meera + karan read everything → but only ALL-read makes m_new "Seen".
    ensure_member(chan, DEMO[0][0], last_read_at=read_recent)   # aisha - read m_new
    ensure_member(chan, DEMO[1][0], last_read_at=read_all)      # rohit - not yet m_new
    ensure_member(chan, DEMO[2][0], last_read_at=read_recent)   # meera - read m_new
    ensure_member(chan, DEMO[3][0], last_read_at=read_all)      # karan - not yet m_new
    # => m_old: seen by all (everyone read after it). m_new: NOT seen (rohit/karan behind).

    # 4) a few direct chats
    for email, name, _ in DEMO[:3]:
        dm, _ = ensure_room("dm:%s|%s" % (viewer, email), False, viewer)
        ensure_member(dm, viewer, last_read_at=NOW)
        # other side read the viewer's message → shows "Seen" in a 1:1
        ensure_member(dm, email, last_read_at=NOW - timedelta(minutes=1))
        add_msg(dm, email, name, "Hi %s!" % vname.split()[0], 40)
        add_msg(dm, viewer, vname, "Hey %s, how's it going?" % name.split()[0], 30)

    print("Seeded: 1 channel (5 members), 3 direct chats, messages, and today's check-ins.")
    print("Online (green): viewer, Aisha, Meera, Divya  |  Offline (gray): Rohit, Karan")
    print("Channel: first message shows 'Seen', the newer one stays a single tick until all read.")


if __name__ == "__main__":
    main()
