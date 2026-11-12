"""Team chat: access control, reactions, mentions, threads, unread, channel settings."""
from datetime import timedelta

from django.db import connection
from django.test import Client, TestCase

from api.chat_extras import attachment_url, make_ws_ticket, read_ws_ticket
from api.models import (AppUser, ChatMeeting, ChatMember, ChatMessage, ChatReaction, ChatRoom,
                        Notification)
from api.views import _chat_now

UNMANAGED = (ChatRoom, ChatMember, ChatMessage, ChatMeeting)


class ChatTestBase(TestCase):
    @classmethod
    def setUpClass(cls):
        # The chat tables are unmanaged (created by raw-SQL migrations), so the
        # SQLite test database does not have them: create them for this class.
        with connection.schema_editor() as se:
            for model in UNMANAGED:
                if model._meta.db_table not in connection.introspection.table_names():
                    se.create_model(model)
        super().setUpClass()

    def setUp(self):
        for e, n in (('ann@co.com', 'Ann Lee'), ('bob@co.com', 'Bob Ray'), ('cat@co.com', 'Cat Doe')):
            AppUser.objects.create(email=e, full_name=n, password='x', role='recruitment')
        self.ann = Client(HTTP_X_USER_EMAIL='ann@co.com')
        self.bob = Client(HTTP_X_USER_EMAIL='bob@co.com')
        self.cat = Client(HTTP_X_USER_EMAIL='cat@co.com')
        now = _chat_now()
        self.room = ChatRoom.objects.create(name='Eng', is_group=True, created_by='ann@co.com',
                                            created_at=now, is_private=True)
        ChatMember.objects.create(room=self.room, employee_email='ann@co.com', joined_at=now, is_admin=True)
        ChatMember.objects.create(room=self.room, employee_email='bob@co.com', joined_at=now)

    def post_msg(self, client, text, **extra):
        return client.post(f'/api/chat/messages/{self.room.id}', {'message': text, **extra},
                           content_type='application/json')


class ChatAccessTests(ChatTestBase):
    def test_anonymous_and_outsiders_are_refused(self):
        self.assertEqual(Client().get(f'/api/chat/messages/{self.room.id}').status_code, 401)
        self.assertEqual(self.cat.get(f'/api/chat/messages/{self.room.id}?email=cat@co.com').status_code, 403)
        self.assertEqual(self.post_msg(self.cat, 'hi').status_code, 403)

    def test_cannot_act_as_someone_else(self):
        r = self.post_msg(self.bob, 'hi', sender_email='ann@co.com')
        self.assertEqual(r.status_code, 403)
        r = self.bob.get('/api/chat/rooms?email=ann@co.com')
        self.assertEqual(r.status_code, 403)

    def test_member_sends_as_themselves(self):
        r = self.post_msg(self.bob, 'hello team')
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(ChatMessage.objects.get().sender_email, 'bob@co.com')

    def test_attachment_needs_membership_or_a_signed_link(self):
        msg = ChatMessage.objects.create(room=self.room, sender_email='ann@co.com', sender_name='Ann',
                                         message='', created_at=_chat_now(), attachment_name='a.txt',
                                         attachment_type='text/plain', attachment_data='data:text/plain;base64,aGk=')
        self.assertEqual(Client().get(f'/api/chat/attachment/{msg.id}').status_code, 401)
        self.assertEqual(self.cat.get(f'/api/chat/attachment/{msg.id}').status_code, 403)
        self.assertEqual(Client().get(attachment_url(msg.id)).status_code, 200)
        self.assertEqual(Client().get(f'/api/chat/attachment/{msg.id}?t=forged').status_code, 401)

    def test_ws_ticket_is_bound_to_member_and_room(self):
        t = self.bob.get(f'/api/chat/ws-ticket/{self.room.id}').json()['ticket']
        self.assertEqual(read_ws_ticket(t, self.room.id), 'bob@co.com')
        self.assertIsNone(read_ws_ticket(t, self.room.id + 1))
        self.assertIsNone(read_ws_ticket('garbage', self.room.id))
        self.assertIsNone(read_ws_ticket(make_ws_ticket('cat@co.com', self.room.id), self.room.id))
        self.assertEqual(self.cat.get(f'/api/chat/ws-ticket/{self.room.id}').status_code, 403)


class ChatExtrasTests(ChatTestBase):
    def test_reactions_toggle_and_show_in_the_list(self):
        mid = self.post_msg(self.ann, 'ship it').json()['id']
        r = self.bob.post(f'/api/chat/message/{mid}/react', {'emoji': '👍'}, content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()['reactions'][0]['count'], 1)
        self.ann.post(f'/api/chat/message/{mid}/react', {'emoji': '👍'}, content_type='application/json')
        listed = self.ann.get(f'/api/chat/messages/{self.room.id}').json()[0]['reactions']
        self.assertEqual((listed[0]['emoji'], listed[0]['count']), ('👍', 2))
        self.bob.post(f'/api/chat/message/{mid}/react', {'emoji': '👍'}, content_type='application/json')  # toggle off
        self.assertEqual(ChatReaction.objects.count(), 1)
        bad = self.bob.post(f'/api/chat/message/{mid}/react', {'emoji': '<b>'}, content_type='application/json')
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(self.cat.post(f'/api/chat/message/{mid}/react', {'emoji': '👍'},
                                       content_type='application/json').status_code, 403)

    def test_mentions_notify_members_only(self):
        self.post_msg(self.ann, '@Bob Ray can you check? also @cat@co.com', mentions=['bob@co.com', 'cat@co.com'])
        self.assertTrue(Notification.objects.filter(recipient='bob@co.com', title__contains='mentioned you').exists())
        self.assertFalse(Notification.objects.filter(recipient='cat@co.com').exists())   # not in the room
        self.assertFalse(Notification.objects.filter(recipient='ann@co.com').exists())   # never the sender
        n = Notification.objects.get(recipient='bob@co.com')
        self.assertIn(f'room={self.room.id}', n.link)

    def test_threads_and_reply_counts(self):
        parent = self.post_msg(self.ann, 'plan for friday?').json()['id']
        self.post_msg(self.bob, 'works for me', reply_to_id=parent)
        self.post_msg(self.ann, 'great', reply_to_id=parent)
        threads = self.bob.get('/api/chat/threads').json()
        self.assertEqual(len(threads), 1)
        self.assertEqual((threads[0]['parent']['id'], threads[0]['reply_count']), (parent, 2))
        self.assertEqual(threads[0]['room_label'], '#Eng')
        msgs = self.ann.get(f'/api/chat/messages/{self.room.id}').json()
        self.assertEqual(next(m for m in msgs if m['id'] == parent)['reply_count'], 2)
        self.assertEqual(self.cat.get('/api/chat/threads').json(), [])

    def test_unread_is_per_member(self):
        self.post_msg(self.ann, 'one')
        self.post_msg(self.ann, 'two')
        self.assertEqual(self.bob.get('/api/chat/unread').json()['total'], 2)
        ChatMember.objects.filter(employee_email='bob@co.com').update(last_read_at=_chat_now() - timedelta(days=1))
        # someone else reading must not clear Bob's badge
        AppUser.objects.create(email='dan@co.com', full_name='Dan', password='x')
        ChatMember.objects.create(room=self.room, employee_email='dan@co.com', joined_at=_chat_now() - timedelta(days=2))
        Client(HTTP_X_USER_EMAIL='dan@co.com').get(f'/api/chat/messages/{self.room.id}')
        rooms = self.bob.get('/api/chat/rooms').json()
        self.assertEqual(rooms[0]['unread'], 2)
        self.bob.get(f'/api/chat/messages/{self.room.id}')
        self.assertEqual(self.bob.get('/api/chat/unread').json()['total'], 0)

    def test_channel_settings_admin_only(self):
        url = f'/api/chat/rooms/{self.room.id}'
        self.assertEqual(self.bob.patch(url, {'name': 'X'}, content_type='application/json').status_code, 403)
        r = self.ann.patch(url, {'name': 'Engineering', 'is_private': False}, content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()['name'], r.json()['is_private']), ('Engineering', False))

    def test_browse_and_join_public_channels_only(self):
        self.assertEqual(self.cat.get('/api/chat/channels/browse').json(), [])          # private
        self.assertEqual(self.cat.post(f'/api/chat/rooms/{self.room.id}/join').status_code, 403)
        ChatRoom.objects.filter(id=self.room.id).update(is_private=False)
        listed = self.cat.get('/api/chat/channels/browse').json()
        self.assertEqual([c['id'] for c in listed], [self.room.id])
        self.assertEqual(self.cat.post(f'/api/chat/rooms/{self.room.id}/join').status_code, 200)
        self.assertEqual(self.post_msg(self.cat, 'hi all').status_code, 201)

    def test_my_pins_lists_only_my_active_pins(self):
        m1 = self.post_msg(self.ann, 'keep this').json()['id']
        m2 = self.post_msg(self.ann, 'and this').json()['id']
        self.bob.post(f'/api/chat/message/{m1}/pin', {'pin': True}, content_type='application/json')
        self.ann.post(f'/api/chat/message/{m2}/pin', {'pin': True}, content_type='application/json')
        mine = self.bob.get('/api/chat/pins').json()
        self.assertEqual([x['id'] for x in mine], [m1])
        self.assertEqual(mine[0]['room_label'], '#Eng')
        ChatMessage.objects.filter(id=m1).update(pin_expires_at=_chat_now() - timedelta(days=1))
        self.assertEqual(self.bob.get('/api/chat/pins').json(), [])
        self.assertEqual(Client().get('/api/chat/pins').status_code, 401)
