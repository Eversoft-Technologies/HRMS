"""Phase 2: "Meet now" — a 1-click instant video meeting from a conversation."""
from api.models import ChatMeeting, ChatMessage, Notification

from tests.test_chat_access_and_extras import ChatTestBase


class InstantMeetingTests(ChatTestBase):
    def start(self, client, **extra):
        return client.post('/api/chat/meetings', {'room_id': self.room.id, 'instant': True, **extra},
                           content_type='application/json')

    def test_meet_now_creates_a_private_link_posts_it_and_rings_everyone(self):
        r = self.start(self.ann, created_by='ann@co.com', created_by_name='Ann Lee')
        self.assertEqual(r.status_code, 201, r.content)
        url = r.json()['join_url']
        self.assertTrue(url.startswith('https://meet.jit.si/hrms-'), url)
        m = ChatMeeting.objects.get()
        self.assertEqual(m.title, 'Instant meeting')
        msg = ChatMessage.objects.filter(room=self.room).last()
        self.assertIn('started a video meeting', msg.message)
        self.assertIn(url, msg.message)
        # bob (the other member) is notified; ann (who started it) is not
        self.assertTrue(Notification.objects.filter(recipient='bob@co.com', title__contains='started a video meeting').exists())
        self.assertFalse(Notification.objects.filter(recipient='ann@co.com', title__contains='started a video meeting').exists())

    def test_each_meeting_gets_its_own_link(self):
        a = self.start(self.ann, created_by='ann@co.com').json()['join_url']
        b = self.start(self.bob, created_by='bob@co.com').json()['join_url']
        self.assertNotEqual(a, b)

    def test_outsider_cannot_start_a_meeting_in_the_room(self):
        r = self.start(self.cat, created_by='cat@co.com')
        self.assertIn(r.status_code, (403, 404))
        self.assertFalse(ChatMeeting.objects.exists())

    def test_scheduled_meetings_still_need_a_time(self):
        r = self.ann.post('/api/chat/meetings', {'room_id': self.room.id, 'title': 'Sync'},
                          content_type='application/json')
        self.assertEqual(r.status_code, 400)
