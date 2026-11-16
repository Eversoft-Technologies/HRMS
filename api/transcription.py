"""Server-side speech-to-text for AI interview recordings (Deepgram).

The interview screen transcribes live with the browser's own recognizer, which
stops listening on pauses / network blips and loses whatever is said until the
next question. Once the interview video reaches the server we send it to
Deepgram and keep the complete transcript:

  stt_transcript  full plain text
  stt_segments    [{start, end, text}]  paragraphs with real timestamps
  stt_answers     [text, ...]           one answer per question, cut from the
                                        word timings with the "askedAtSec" the
                                        interview screen records per question

Configuration:
  The key            Settings › AI Settings › Speech-to-text (stored encrypted,
                     api/stt_settings.py); falls back to DEEPGRAM_API_KEY in the
                     server .env. Without either nothing is sent (status no_key).
Optional (server .env):
  DEEPGRAM_MODEL        default nova-3
  DEEPGRAM_LANGUAGE     default en-IN (Indian English); "multi" or en-US also work

The upload request never waits for this: transcribe_async() runs it on a
background thread. ``manage.py transcribe_interviews`` picks up anything that
failed, was interrupted, or predates the key (run it from cron as a safety net).
"""
import logging
import os
import tempfile
import threading

import requests
from django.db import close_old_connections
from django.utils import timezone

logger = logging.getLogger(__name__)

DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen'
REQUEST_TIMEOUT_S = 900          # a long video uploads + transcribes well inside this
STALE_PROCESSING_MIN = 20        # "processing" older than this was interrupted
NO_KEY_MSG = 'No Deepgram key: add it in Settings › AI Settings › Speech-to-text.'


def api_key():
    """The key saved in Settings › AI Settings (encrypted), else DEEPGRAM_API_KEY."""
    from . import stt_settings
    return (stt_settings.active_key() or '').strip()


def is_configured():
    return bool(api_key())


def _params(model, language):
    return {
        'model': model,
        'language': language,
        'smart_format': 'true',
        'punctuate': 'true',
        'paragraphs': 'true',
    }


class TranscriptionError(Exception):
    pass


def _call_deepgram(fileobj, mime):
    """POST the media to Deepgram and return the parsed JSON. Retries once
    with a plainer model/language if the configured pair is rejected (400)."""
    key = api_key()
    if not key:
        raise TranscriptionError(NO_KEY_MSG)
    model = os.environ.get('DEEPGRAM_MODEL') or 'nova-3'
    language = os.environ.get('DEEPGRAM_LANGUAGE') or 'en-IN'
    attempts = [(model, language)]
    if (model, language) != ('nova-2', 'en'):
        attempts.append(('nova-2', 'en'))
    last = None
    for i, (m, lang) in enumerate(attempts):
        fileobj.seek(0)
        try:
            r = requests.post(DEEPGRAM_URL, params=_params(m, lang), data=fileobj, timeout=REQUEST_TIMEOUT_S,
                              headers={'Authorization': 'Token ' + key, 'Content-Type': mime or 'video/webm'})
        except requests.RequestException as exc:
            raise TranscriptionError(f'Could not reach Deepgram: {exc}') from exc
        if r.status_code == 200:
            return r.json()
        detail = ''
        try:
            j = r.json()
            detail = j.get('err_msg') or j.get('message') or j.get('reason') or ''
        except ValueError:
            detail = (r.text or '')[:200]
        last = f'Deepgram returned HTTP {r.status_code}' + (f': {detail}' if detail else '')
        if r.status_code in (401, 403):
            raise TranscriptionError(last + ' — check the Deepgram key in Settings › AI Settings.')
        if r.status_code == 402:
            raise TranscriptionError(last + ' — the Deepgram account is out of credit.')
        if r.status_code != 400 or i == len(attempts) - 1:
            raise TranscriptionError(last)
        logger.warning('[STT] %s with model=%s language=%s; retrying with nova-2/en', last, m, lang)
    raise TranscriptionError(last or 'Deepgram transcription failed')


def parse_result(data):
    """(full_text, segments, words) from a Deepgram /listen response."""
    try:
        alt = data['results']['channels'][0]['alternatives'][0]
    except (KeyError, IndexError, TypeError):
        return '', [], []
    words = [{'start': float(w.get('start') or 0), 'end': float(w.get('end') or 0),
              'text': w.get('punctuated_word') or w.get('word') or ''}
             for w in (alt.get('words') or [])]
    segments = []
    for p in ((alt.get('paragraphs') or {}).get('paragraphs') or []):
        text = ' '.join(s.get('text', '') for s in (p.get('sentences') or [])).strip()
        if text:
            segments.append({'start': round(float(p.get('start') or 0), 2),
                             'end': round(float(p.get('end') or 0), 2), 'text': text})
    full = (alt.get('transcript') or '').strip()
    if not segments and full:
        segments = [{'start': words[0]['start'] if words else 0,
                     'end': words[-1]['end'] if words else 0, 'text': full}]
    return full, segments, words


def align_answers(words, responses):
    """One answer per question: the words spoken between the moment question i
    was asked and the moment question i+1 was. Needs ``askedAtSec`` on every
    response (recorded by the interview screen); returns None otherwise —
    older recordings keep just the full transcript."""
    if not responses or not isinstance(responses, list):
        return None
    starts = []
    for r in responses:
        t = r.get('askedAtSec') if isinstance(r, dict) else None
        if not isinstance(t, (int, float)):
            return None
        starts.append(float(t))
    answers = []
    for i, st in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else float('inf')
        answers.append(' '.join(w['text'] for w in words if st <= w['start'] < end).strip())
    return answers


def _media_for(rec):
    """(open file, mime, cleanup path or None) for the recording's video."""
    from . import video_processor
    if rec.video_file:
        path = video_processor.media_root() / rec.video_file
        if path.exists():
            return open(path, 'rb'), rec.video_mime or 'video/mp4', None
    from .models import InterviewRecording
    buf = (InterviewRecording.objects.filter(pk=rec.pk).values_list('video_buffer', flat=True).first())
    if buf:
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.webm')
        tmp.write(bytes(buf))
        tmp.close()
        return open(tmp.name, 'rb'), rec.video_mime or 'video/webm', tmp.name
    return None, None, None


def transcribe_recording(pk):
    """Transcribe one recording now (blocking). Returns the final stt_status."""
    from .models import InterviewRecording
    Q = InterviewRecording.objects.filter(pk=pk)
    rec = Q.defer('video_buffer', 'recording_data').first()
    if rec is None:
        return None
    if not is_configured():
        Q.update(stt_status='no_key', stt_error=NO_KEY_MSG)
        return 'no_key'
    Q.update(stt_status='processing', stt_error='', stt_at=timezone.now())
    fh, mime, tmp = _media_for(rec)
    if fh is None:
        Q.update(stt_status='failed', stt_error='No video is stored for this interview.', stt_at=timezone.now())
        return 'failed'
    try:
        with fh:
            data = _call_deepgram(fh, mime)
        full, segments, words = parse_result(data)
        answers = align_answers(words, rec.responses)
        Q.update(stt_status='done', stt_transcript=full, stt_segments=segments, stt_answers=answers,
                 stt_error='' if full else 'No speech was detected in the video.', stt_at=timezone.now())
        logger.info('[STT] recording %s transcribed: %d words', pk, len(words))
        return 'done'
    except TranscriptionError as exc:
        Q.update(stt_status='failed', stt_error=str(exc)[:500], stt_at=timezone.now())
        logger.warning('[STT] recording %s failed: %s', pk, exc)
        return 'failed'
    except Exception as exc:                                    # never let a bad reply crash a worker
        Q.update(stt_status='failed', stt_error=f'Unexpected error: {exc}'[:500], stt_at=timezone.now())
        logger.exception('[STT] recording %s failed', pk)
        return 'failed'
    finally:
        if tmp:
            try:
                os.remove(tmp)
            except OSError:
                pass


def transcribe_async(pk):
    """Queue a transcription without holding up the caller (the video upload)."""
    from .models import InterviewRecording
    if not is_configured():
        InterviewRecording.objects.filter(pk=pk).update(
            stt_status='no_key', stt_error=NO_KEY_MSG)
        return
    InterviewRecording.objects.filter(pk=pk).update(stt_status='queued', stt_error='', stt_at=timezone.now())
    if os.environ.get('HRMS_STT_SYNC') == '1':              # tests / debugging
        transcribe_recording(pk)
        return

    def run():
        close_old_connections()
        try:
            transcribe_recording(pk)
        finally:
            close_old_connections()
    threading.Thread(target=run, name=f'stt-{pk}', daemon=True).start()


def pending_ids(include_failed=True):
    """Recordings with a video that still need a transcript."""
    from datetime import timedelta
    from django.db.models import Q
    from .models import InterviewRecording
    stale = timezone.now() - timedelta(minutes=STALE_PROCESSING_MIN)
    cond = Q(stt_status__in=['', 'no_key']) | Q(stt_status__in=['queued', 'processing'], stt_at__lt=stale)
    if include_failed:
        cond |= Q(stt_status='failed')
    return list(InterviewRecording.objects.filter(has_video=True).filter(cond)
                .order_by('id').values_list('id', flat=True))
