"""POST /api/eva-tts turns Eva's spoken lines into cached MP3 audio so the
interview recording can include her voice. Both voice sources (edge-tts and
Google's public TTS) are mocked here."""
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

import django
from django.test import TestCase, override_settings

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
django.setup()

from api import tts_views


def fake_edge(text, out_path, **kwargs):
    Path(out_path).write_bytes(b'ID3edge:' + text.encode('utf-8'))


class FakeResponse:
    def __init__(self, content, status=200, ctype='audio/mpeg'):
        self.content, self.status_code, self.headers = content, status, {'Content-Type': ctype}


def fake_google_get(url, params=None, headers=None, timeout=None):
    return FakeResponse(b'[' + params['q'].encode('utf-8') + b']')


class EvaTtsTests(TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.media = Path(self.tmp.name)

    def _post(self, text):
        with override_settings(MEDIA_ROOT=self.media):
            return self.client.post('/api/eva-tts', {'text': text}, content_type='application/json')

    def _body(self, r):
        body = b''.join(r.streaming_content)
        r.close()
        return body

    def test_returns_audio_and_caches_it_on_disk(self):
        with patch.object(tts_views, 'edge_tts_synthesize', side_effect=fake_edge) as synth:
            r1 = self._post('Please introduce   yourself.')
            self.assertEqual(r1.status_code, 200)
            self.assertEqual(r1['Content-Type'], 'audio/mpeg')
            self.assertEqual(r1['X-Eva-Voice'], 'edge')
            self.assertIn(b'Please introduce yourself.', self._body(r1))      # whitespace collapsed
            r2 = self._post('Please introduce yourself.')
            self.assertEqual(r2.status_code, 200)
            self.assertEqual(r2['X-Eva-Voice'], 'cache')
            self._body(r2)
            synth.assert_called_once()                                        # second call served from cache
        self.assertEqual(len(list((self.media / 'tts').glob('*.mp3'))), 1)

    def test_without_edge_tts_google_voice_is_used(self):
        with patch.object(tts_views, 'edge_tts_synthesize', side_effect=ImportError('No module named edge_tts')), \
                patch.object(tts_views.requests, 'get', side_effect=fake_google_get) as get:
            r = self._post('Two final questions. One, the night shift.')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r['X-Eva-Voice'], 'google')
        self.assertEqual(self._body(r), b'[Two final questions. One, the night shift.]')
        self.assertEqual(get.call_count, 1)

    def test_long_lines_are_fetched_in_short_chunks_and_joined(self):
        line = ('For this data analyst position: explain why, not what, you would architect a high-traffic '
                'production system serving one million users using Python. I want to understand the specific '
                'trade-offs you considered, what alternatives you rejected and why, and critically, in what '
                'scenarios would you not use Python?')
        with patch.object(tts_views, 'edge_tts_synthesize', side_effect=ImportError()), \
                patch.object(tts_views.requests, 'get', side_effect=fake_google_get) as get:
            r = self._post(line)
        self.assertEqual(r.status_code, 200)
        pieces = [c.kwargs['params']['q'] for c in get.call_args_list]
        self.assertGreater(len(pieces), 1)
        self.assertTrue(all(len(p) <= tts_views.GOOGLE_TTS_CHUNK for p in pieces))
        self.assertEqual(' '.join(pieces), line)                              # nothing dropped, split at spaces
        self.assertEqual(self._body(r), b''.join(b'[' + p.encode() + b']' for p in pieces))

    def test_chunking_never_splits_inside_a_word(self):
        words = ['supercalifragilistic'] * 30
        for piece in tts_views.chunk_text(' '.join(words), limit=50):
            self.assertTrue(all(w == 'supercalifragilistic' for w in piece.split(' ')), piece)

    def test_empty_and_oversized_text_are_rejected(self):
        self.assertEqual(self._post('   ').status_code, 400)
        self.assertEqual(self._post('x' * (tts_views.MAX_CHARS + 1)).status_code, 400)

    def test_when_no_voice_source_works_it_is_a_502_not_a_crash(self):
        with patch.object(tts_views, 'edge_tts_synthesize', side_effect=ImportError()), \
                patch.object(tts_views.requests, 'get', return_value=FakeResponse(b'', status=429, ctype='text/html')):
            r = self._post('Hello candidate')
        self.assertEqual(r.status_code, 502)
        self.assertIn('google: Google TTS answered 429', r.json()['error'])
        self.assertFalse((self.media / 'tts').exists() and list((self.media / 'tts').glob('*.mp3')))

    def test_endpoint_needs_no_login(self):
        # The candidate is not logged in: the test client sends no token either.
        with patch.object(tts_views, 'edge_tts_synthesize', side_effect=fake_edge):
            r = self._post('Two final questions.')
            self.assertEqual(r.status_code, 200)
            self._body(r)
