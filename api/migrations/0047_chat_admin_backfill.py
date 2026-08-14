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
    with schema_editor.connection.cursor() as cursor:
        # 1. the creator of each GROUP room, where they are a member of it.
        cursor.execute(
            """
            UPDATE `chat_members` m
              JOIN `chat_rooms` r ON m.room_id = r.id
               SET m.is_admin = 1
             WHERE m.employee_email = r.created_by
               AND r.is_group = 1
               AND m.is_admin = 0
            """
        )
        promoted_creators = cursor.rowcount

        # 2. any group room with no admin at all → its earliest member.
        #    The inner SELECT is materialised into a derived table because
        #    MySQL will not let a subquery read the table being updated.
        cursor.execute(
            """
            UPDATE `chat_members` cm
              JOIN (
                    SELECT mm.room_id, MIN(mm.id) AS first_id
                      FROM `chat_members` mm
                      JOIN `chat_rooms` rr
                        ON rr.id = mm.room_id AND rr.is_group = 1
                     WHERE mm.room_id NOT IN (
                           SELECT room_id FROM (
                                  SELECT room_id FROM `chat_members`
                                   WHERE is_admin = 1
                           ) AS held
                     )
                     GROUP BY mm.room_id
              ) x ON cm.id = x.first_id
               SET cm.is_admin = 1
            """
        )
        promoted_orphans = cursor.rowcount

    if promoted_creators or promoted_orphans:
        print('  chat admins backfilled: %d creator(s), %d orphaned channel(s)'
              % (promoted_creators, promoted_orphans))


def noop(apps, schema_editor):
    """Deliberately does nothing — see the module docstring."""


class Migration(migrations.Migration):
    dependencies = [('api', '0046_chat_model_state')]

    operations = [migrations.RunPython(backfill_admins, noop)]
