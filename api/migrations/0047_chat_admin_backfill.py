"""Backfill chat channel admins.

0045_chat_tables ported the schema out of chat_migrations*.sql but stopped at
CREATE TABLE and ADD COLUMN. The v3 file also ends with two UPDATE statements,
and they are not decoration: is_admin was added to chat_members *after* the
table already existed in some environments, so every room created before that
has members with is_admin = 0 — including the person who made the channel.

The effect is a channel nobody can administer. Nobody can add a member, remove
one, or promote anyone, and there is no way out from inside the product.

Two passes, matching the SQL:

  1. the room's creator becomes an admin of that room, where they are still a
     member. This is the normal case and restores the intended owner.
  2. any GROUP room still left without a single admin promotes its earliest
     member. Rooms whose creator has left the company would otherwise stay
     permanently unmanageable, which is exactly the case pass 1 cannot reach.

Both passes are restricted to GROUP rooms, which is one deliberate difference
from the SQL. The v3 backfill promotes the creator of every room including 1:1
directs, but chat_rooms POST creates members with
``is_admin=(is_group and e == creator)`` — so the SQL writes rows the
application itself would never write. A 1:1 has no membership to administer, so
an admin flag there means nothing; following the app keeps backfilled data
indistinguishable from data created normally.

Idempotent — it only ever sets is_admin to 1 for rows that qualify, so running
it twice changes nothing the second time. Reverse is a no-op: un-setting admin
flags wholesale would take channels away from people legitimately holding them.
"""
from django.db import migrations


def backfill_admins(apps, schema_editor):
    ChatMember = apps.get_model('api', 'ChatMember')
    ChatRoom = apps.get_model('api', 'ChatRoom')

    promoted_creators = 0
    for room in ChatRoom.objects.filter(is_group=True).iterator():
        creator_member = ChatMember.objects.filter(room_id=room.id, employee_email=room.created_by).order_by('id').first()
        if creator_member and not creator_member.is_admin:
            creator_member.is_admin = True
            creator_member.save(update_fields=['is_admin'])
            promoted_creators += 1

    promoted_orphans = 0
    for room in ChatRoom.objects.filter(is_group=True).iterator():
        if ChatMember.objects.filter(room_id=room.id, is_admin=True).exists():
            continue

        earliest_member = ChatMember.objects.filter(room_id=room.id).order_by('id').first()
        if earliest_member and not earliest_member.is_admin:
            earliest_member.is_admin = True
            earliest_member.save(update_fields=['is_admin'])
            promoted_orphans += 1

    if promoted_creators or promoted_orphans:
        print('  chat admins backfilled: %d creator(s), %d orphaned channel(s)'
              % (promoted_creators, promoted_orphans))


def noop(apps, schema_editor):
    """Deliberately does nothing — see the module docstring."""


class Migration(migrations.Migration):
    dependencies = [('api', '0046_chat_model_state')]

    operations = [migrations.RunPython(backfill_admins, noop)]
