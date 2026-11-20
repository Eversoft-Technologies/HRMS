"""Stored recordings must be seekable: MediaRecorder uploads (fragmented MP4,
WebM without Cues) are remuxed/transcoded into an indexed MP4 on arrival, and
``index_recordings`` does the same for files uploaded before FFmpeg existed.
FFmpeg itself is mocked - these tests check the decisions around it."""
import os
import sys
import tempfile
from io import StringIO
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')

import django
from django.core.management import call_command
from django.test import TestCase, override_settings

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
django.setup()

from api import video_processor
from api.models import InterviewRecording


def box(typ, payload=b''):
    size = 8 + len(payload)
    return size.to_bytes(4, 'big') + typ + payload


FRAGMENTED_MP4 = (box(b'ftyp', b'isom')
                  + box(b'moov', box(b'mvhd', b'\0' * 20) + box(b'mvex', box(b'trex', b'\0' * 8)))
                  + box(b'moof', b'\0' * 16) + box(b'mdat', b'\xff' * 64))
FLAT_MP4 = (box(b'ftyp', b'isom')
            + box(b'moov', box(b'mvhd', b'\0' * 20) + box(b'trak', b'\0' * 8))
            + box(b'mdat', b'\xff' * 64))
MOOV_AT_END_MP4 = box(b'ftyp', b'isom') + box(b'mdat', b'\xff' * 64) + box(b'moov', box(b'mvhd', b'\0' * 20))
WEBM_HEAD = b'\x1a\x45\xdf\xa3' + b'\0' * 32


def fake_ffmpeg_success(input_path, output_path, *args, **kwargs):
    Path(output_path).write_bytes(FLAT_MP4)
    return True, ''


class NeedsIndexTests(TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def _file(self, name, data):
        p = Path(self.tmp.name) / name
        p.write_bytes(data)
        return p

    def test_chrome_fragmented_mp4_needs_an_index(self):
        self.assertTrue(video_processor.needs_index(self._file('a.mp4', FRAGMENTED_MP4)))

    def test_moov_at_the_end_needs_an_index(self):
        self.assertTrue(video_processor.needs_index(self._file('b.mp4', MOOV_AT_END_MP4)))

    def test_flat_faststart_mp4_is_left_alone(self):
        self.assertFalse(video_processor.needs_index(self._file('c.mp4', FLAT_MP4)))

    def test_webm_always_needs_an_index(self):
        self.assertTrue(video_processor.needs_index(self._file('d.webm', WEBM_HEAD)))

    def test_missing_file_is_not_flagged(self):
        self.assertFalse(video_processor.needs_index(Path(self.tmp.name) / 'nope.mp4'))


class IndexOnUploadTests(TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.rec = InterviewRecording.objects.create(candidate_name='srikanth', role='qa', verdict='HOLD', responses=[])

    def test_mp4_upload_is_remuxed_not_transcoded(self):
        with override_settings(MEDIA_ROOT=Path(self.tmp.name)), \
                patch.object(video_processor, 'find_binary', return_value='/fake/ffmpeg'), \
                patch.object(video_processor, 'remux_to_mp4', side_effect=fake_ffmpeg_success) as remux, \
                patch.object(video_processor, 'transcode_to_mp4') as transcode, \
                patch.object(video_processor, 'extract_thumbnail', return_value=False), \
                patch.object(video_processor, 'probe_video_duration', return_value=None):
            result = video_processor.save_interview_video(self.rec.id, FRAGMENTED_MP4, 'video/mp4')
        self.assertTrue(result['transcoded'])
        self.assertEqual(result['method'], 'remux')
        remux.assert_called_once()
        transcode.assert_not_called()
        self.rec.refresh_from_db()
        self.assertEqual(self.rec.video_mime, 'video/mp4')
        self.assertFalse(video_processor.needs_index(Path(self.tmp.name) / self.rec.video_file))

    def test_webm_upload_is_transcoded(self):
        with override_settings(MEDIA_ROOT=Path(self.tmp.name)), \
                patch.object(video_processor, 'remux_to_mp4') as remux, \
                patch.object(video_processor, 'transcode_to_mp4', side_effect=fake_ffmpeg_success) as transcode, \
                patch.object(video_processor, 'probe_video_duration', return_value=None):
            result = video_processor.save_interview_video(self.rec.id, WEBM_HEAD, 'video/webm')
        self.assertEqual(result['method'], 'transcode')
        remux.assert_not_called()
        transcode.assert_called_once()

    def test_without_ffmpeg_an_mp4_upload_is_indexed_in_python(self):
        def fake_index(src, dst):
            Path(dst).write_bytes(FLAT_MP4)
            return True, 'defragment', '', 12.0
        with override_settings(MEDIA_ROOT=Path(self.tmp.name)), \
                patch.object(video_processor, 'find_binary', return_value=None), \
                patch.object(video_processor.mp4_index, 'index_mp4', side_effect=fake_index) as idx:
            result = video_processor.save_interview_video(self.rec.id, FRAGMENTED_MP4, 'video/mp4')
        self.assertTrue(result['transcoded'])
        self.assertEqual(result['method'], 'index')
        idx.assert_called_once()
        self.rec.refresh_from_db()
        self.assertEqual(self.rec.video_mime, 'video/mp4')
        self.assertFalse(video_processor.needs_index(Path(self.tmp.name) / self.rec.video_file))

    def test_when_nothing_can_index_it_the_raw_file_is_still_served(self):
        with override_settings(MEDIA_ROOT=Path(self.tmp.name)), \
                patch.object(video_processor, 'find_binary', return_value=None), \
                patch.object(video_processor.mp4_index, 'index_mp4', return_value=(False, '', 'no tracks', None)):
            result = video_processor.save_interview_video(self.rec.id, FRAGMENTED_MP4, 'video/mp4')
        self.assertFalse(result['transcoded'])
        self.rec.refresh_from_db()
        self.assertTrue((Path(self.tmp.name) / self.rec.video_file).exists())
        self.assertTrue(self.rec.has_video)


class IndexRecordingsCommandTests(TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.media = Path(self.tmp.name)
        (self.media / 'interviews' / 'raw').mkdir(parents=True)
        self.old = InterviewRecording.objects.create(
            candidate_name='old', role='qa', verdict='HOLD', responses=[],
            video_file='interviews/rec_old.mp4', video_mime='video/mp4', has_video=True)
        (self.media / 'interviews' / 'rec_old.mp4').write_bytes(FRAGMENTED_MP4)
        self.good = InterviewRecording.objects.create(
            candidate_name='good', role='qa', verdict='HOLD', responses=[],
            video_file='interviews/rec_good.mp4', video_mime='video/mp4', has_video=True)
        (self.media / 'interviews' / 'rec_good.mp4').write_bytes(FLAT_MP4)

    def _run(self, *args):
        out, err = StringIO(), StringIO()
        with override_settings(MEDIA_ROOT=self.media), \
                patch.object(video_processor, 'find_binary', return_value='/fake/ffmpeg'), \
                patch.object(video_processor, 'remux_to_mp4', side_effect=fake_ffmpeg_success), \
                patch.object(video_processor, 'transcode_to_mp4', side_effect=fake_ffmpeg_success), \
                patch.object(video_processor, 'extract_thumbnail', return_value=False), \
                patch.object(video_processor, 'probe_video_duration', return_value=123):
            call_command('index_recordings', *args, stdout=out, stderr=err)
        return out.getvalue(), err.getvalue()

    def test_dry_run_reports_without_writing(self):
        out, _ = self._run('--dry-run')
        self.assertIn('would change 1', out)
        self.assertTrue(video_processor.needs_index(self.media / 'interviews' / 'rec_old.mp4'))

    def test_only_unindexed_recordings_are_rebuilt(self):
        out, err = self._run()
        self.assertIn('changed 1, skipped 1, failed 0', out)
        self.old.refresh_from_db()
        self.good.refresh_from_db()
        self.assertEqual(self.old.video_file, f'interviews/rec_{self.old.id}.mp4')
        self.assertEqual(self.old.duration, 123)
        self.assertFalse(video_processor.needs_index(self.media / self.old.video_file))
        self.assertFalse((self.media / 'interviews' / 'rec_old.mp4').exists())   # replaced
        self.assertEqual(self.good.video_file, 'interviews/rec_good.mp4')          # untouched

    def test_remux_only_skips_webm(self):
        webm = InterviewRecording.objects.create(
            candidate_name='ff', role='qa', verdict='HOLD', responses=[],
            video_file='interviews/rec_ff.webm', video_mime='video/webm', has_video=True)
        (self.media / 'interviews' / 'rec_ff.webm').write_bytes(WEBM_HEAD)
        out, _ = self._run('--remux-only')
        self.assertIn('needs a transcode', out)
        webm.refresh_from_db()
        self.assertEqual(webm.video_file, 'interviews/rec_ff.webm')

    def test_without_ffmpeg_mp4s_are_still_indexed_and_webm_is_skipped(self):
        webm = InterviewRecording.objects.create(
            candidate_name='ff', role='qa', verdict='HOLD', responses=[],
            video_file='interviews/rec_ff.webm', video_mime='video/webm', has_video=True)
        (self.media / 'interviews' / 'rec_ff.webm').write_bytes(WEBM_HEAD)

        def fake_index(src, dst):
            Path(dst).write_bytes(FLAT_MP4)
            return True, 'defragment', '', 12.0
        out, err = StringIO(), StringIO()
        with override_settings(MEDIA_ROOT=self.media), \
                patch.object(video_processor, 'find_binary', return_value=None), \
                patch.object(video_processor.mp4_index, 'index_mp4', side_effect=fake_index):
            call_command('index_recordings', stdout=out, stderr=err)
        self.assertIn('ffmpeg not found', err.getvalue())
        self.assertIn('changed 1, skipped 2, failed 0', out.getvalue())   # old mp4 fixed; good mp4 + webm skipped
        self.assertIn('needs FFmpeg', out.getvalue())
        self.old.refresh_from_db()
        self.assertFalse(video_processor.needs_index(self.media / self.old.video_file))
        webm.refresh_from_db()
        self.assertEqual(webm.video_file, 'interviews/rec_ff.webm')


class SharedBinLookupTests(TestCase):
    def test_ffmpeg_in_the_deploys_shared_bin_is_found(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        shared = Path(tmp.name)
        (shared / 'media').mkdir()
        (shared / 'bin').mkdir()
        exe = shared / 'bin' / ('ffmpeg.exe' if os.name == 'nt' else 'ffmpeg')
        exe.write_bytes(b'')
        exe.chmod(0o755)
        env = {k: v for k, v in os.environ.items() if k != 'FFMPEG_PATH'}
        with override_settings(MEDIA_ROOT=shared / 'media'), patch.dict(os.environ, env, clear=True), \
                patch('shutil.which', return_value=None):
            self.assertEqual(video_processor.find_binary('ffmpeg'), str(exe))
