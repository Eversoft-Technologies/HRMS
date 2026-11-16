"""Deepgram speech-to-text of interview videos (api/transcription.py).

The HTTP call is mocked — these tests never reach Deepgram.
"""
import os
import tempfile
from unittest import mock

from django.test import Client, TestCase, override_settings

from api import transcription
from api.models import AppUser, InterviewLink, InterviewRecording

TMP_MEDIA = tempfile.mkdtemp(prefix='hrms-stt-')


def deepgram_reply(words, paragraphs=None):
    """A /v1/listen JSON body: words = [(start, end, text), ...]."""
    ws = [{'word': t.lower().strip('.,?'), 'punctuated_word': t, 'start': s, 'end': e} for s, e, t in words]
    paras = paragraphs or [{'start': words[0][0], 'end': words[-1][1],
                            'sentences': [{'text': ' '.join(t for _, _, t in words)}]}]
    return {'results': {'channels': [{'alternatives': [{
        'transcript': ' '.join(t for _, _, t in words), 'words': ws,
        'paragraphs': {'paragraphs': paras}}]}]}}


class FakeResponse:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body
        self.text = str(body)

    def json(self):
        return self._body


WORDS = [(3.0, 3.4, 'I'), (3.4, 3.9, 'built'), (3.9, 4.5, 'pipelines'), (20.0, 20.5, 'and'),
         (20.5, 21.0, 'tuned'), (21.0, 21.6, 'indexes.'),               # all part of answer 1
         (40.0, 40.4, 'Yes,'), (40.4, 41.0, 'I'), (41.0, 41.8, 'am'), (41.8, 42.5, 'comfortable.')]


@override_settings(MEDIA_ROOT=TMP_MEDIA)
@mock.patch.dict(os.environ, {'DEEPGRAM_API_KEY': 'dg-test-key', 'HRMS_STT_SYNC': '1', 'HRMS_MEDIA_ROOT': TMP_MEDIA})
class TranscriptionTests(TestCase):
    def setUp(self):
        self.rec = InterviewRecording.objects.create(
            candidate_name='Cand', candidate_email='cand@example.com', role='qa',
            responses=[{'q': 'Tell me about SQL', 'transcript': 'I built', 'askedAtSec': 1.5},
                       {'q': 'Night shift ok?', 'transcript': '', 'askedAtSec': 35.0}])
        from api import video_processor
        path = video_processor.interviews_dir()
        path.mkdir(parents=True, exist_ok=True)
        (path / f'rec_{self.rec.id}.webm').write_bytes(b'fake-video')
        InterviewRecording.objects.filter(pk=self.rec.pk).update(
            video_file=f'interviews/rec_{self.rec.id}.webm', video_mime='video/webm', has_video=True)

    def reload(self):
        return InterviewRecording.objects.get(pk=self.rec.pk)

    def test_full_transcript_and_per_question_answers(self):
        with mock.patch('api.transcription.requests.post', return_value=FakeResponse(200, deepgram_reply(WORDS))) as post:
            self.assertEqual(transcription.transcribe_recording(self.rec.pk), 'done')
        r = self.reload()
        self.assertEqual(r.stt_status, 'done')
        self.assertIn('tuned indexes.', r.stt_transcript)
        self.assertEqual(r.stt_answers, ['I built pipelines and tuned indexes.', 'Yes, I am comfortable.'])
        self.assertEqual(r.stt_segments[0]['start'], 3.0)
        # sent the stored video with the key, Indian English by default
        kwargs = post.call_args.kwargs
        self.assertEqual(kwargs['headers']['Authorization'], 'Token dg-test-key')
        self.assertEqual(kwargs['headers']['Content-Type'], 'video/webm')
        self.assertEqual((kwargs['params']['model'], kwargs['params']['language']), ('nova-3', 'en-IN'))

    def test_old_recordings_without_question_times_keep_the_full_transcript(self):
        InterviewRecording.objects.filter(pk=self.rec.pk).update(responses=[{'q': 'x', 'transcript': 'y'}])
        with mock.patch('api.transcription.requests.post', return_value=FakeResponse(200, deepgram_reply(WORDS))):
            transcription.transcribe_recording(self.rec.pk)
        r = self.reload()
        self.assertEqual((r.stt_status, r.stt_answers), ('done', None))
        self.assertTrue(r.stt_transcript)

    def test_rejected_language_falls_back_to_plain_english(self):
        replies = [FakeResponse(400, {'err_msg': 'language not supported'}), FakeResponse(200, deepgram_reply(WORDS))]
        with mock.patch('api.transcription.requests.post', side_effect=replies) as post:
            self.assertEqual(transcription.transcribe_recording(self.rec.pk), 'done')
        self.assertEqual(post.call_args.kwargs['params']['language'], 'en')

    def test_bad_key_is_reported_not_raised(self):
        with mock.patch('api.transcription.requests.post', return_value=FakeResponse(401, {'err_msg': 'Invalid credentials'})):
            self.assertEqual(transcription.transcribe_recording(self.rec.pk), 'failed')
        r = self.reload()
        self.assertIn('401', r.stt_error)
        self.assertIn('Deepgram key', r.stt_error)

    def test_no_key_sends_nothing(self):
        with mock.patch.dict(os.environ, {'DEEPGRAM_API_KEY': ''}), \
                mock.patch('api.transcription.requests.post') as post:
            transcription.transcribe_async(self.rec.pk)
        post.assert_not_called()
        self.assertEqual(self.reload().stt_status, 'no_key')

    def test_video_upload_starts_the_transcription(self):
        InterviewLink.objects.create(name='Cand', email='cand@example.com', role='qa', status='Active')
        with mock.patch('api.video_processor.save_interview_video', return_value={'ok': True}), \
                mock.patch('api.transcription.requests.post', return_value=FakeResponse(200, deepgram_reply(WORDS))):
            r = Client().post(f'/api/interview-recordings/{self.rec.pk}/video', data=b'fake-webm', content_type='video/webm')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.reload().stt_status, 'done')

    def test_upload_succeeds_even_if_deepgram_is_down(self):
        import requests
        with mock.patch('api.video_processor.save_interview_video', return_value={'ok': True}), \
                mock.patch('api.transcription.requests.post', side_effect=requests.ConnectionError('down')):
            r = Client().post(f'/api/interview-recordings/{self.rec.pk}/video', data=b'fake-webm', content_type='video/webm')
        self.assertEqual(r.status_code, 200)
        r2 = self.reload()
        self.assertEqual(r2.stt_status, 'failed')
        self.assertIn('Could not reach Deepgram', r2.stt_error)

    def test_hr_can_retry_and_sees_it_in_the_detail(self):
        AppUser.objects.create(email='hr.stt@example.com', full_name='HR', password='x', role='admin', status='active')
        hr = Client(HTTP_X_USER_EMAIL='hr.stt@example.com')
        with mock.patch('api.transcription.requests.post', return_value=FakeResponse(200, deepgram_reply(WORDS))):
            r = hr.post(f'/api/interview-recordings/{self.rec.pk}/transcribe')
        self.assertEqual(r.status_code, 200, r.content)
        d = hr.get(f'/api/interview-recordings/{self.rec.pk}').json()
        self.assertEqual(d['sttStatus'], 'done')
        self.assertEqual(d['sttAnswers'][1], 'Yes, I am comfortable.')
        lst = hr.get('/api/interview-recordings').json()
        row = next(x for x in lst if x['id'] == self.rec.pk)
        self.assertEqual(row['sttStatus'], 'done')
        self.assertNotIn('sttTranscript', row)                      # the list stays light

    def test_retry_needs_permission(self):
        AppUser.objects.create(email='emp.stt@example.com', full_name='Emp', password='x', role='employee', status='active')
        r = Client(HTTP_X_USER_EMAIL='emp.stt@example.com').post(f'/api/interview-recordings/{self.rec.pk}/transcribe')
        self.assertEqual(r.status_code, 403)

    def test_command_picks_up_missing_and_failed(self):
        from django.core.management import call_command
        from io import StringIO
        InterviewRecording.objects.filter(pk=self.rec.pk).update(stt_status='failed')
        out = StringIO()
        with mock.patch('api.transcription.requests.post', return_value=FakeResponse(200, deepgram_reply(WORDS))):
            call_command('transcribe_interviews', stdout=out)
        self.assertIn(f'#{self.rec.pk}: done', out.getvalue())
        self.assertEqual(self.reload().stt_status, 'done')


class AlignTests(TestCase):
    def test_words_split_at_question_times(self):
        words = [{'start': s, 'end': e, 'text': t} for s, e, t in WORDS]
        self.assertEqual(transcription.align_answers(words, [{'askedAtSec': 0}, {'askedAtSec': 30}, {'askedAtSec': 41}]),
                         ['I built pipelines and tuned indexes.', 'Yes, I', 'am comfortable.'])

    def test_missing_times_gives_none(self):
        self.assertIsNone(transcription.align_answers([], [{'q': 'a'}]))
