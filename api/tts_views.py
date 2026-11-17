"""
Eva's voice for the AI interview.

The interview page used to speak Eva's questions with the browser's own
speechSynthesis. That audio never reaches a MediaRecorder, so recordings held
only the candidate's microphone: with the speakers on, a faint echo of Eva;
with earphones or Bluetooth, nothing of Eva at all.

This endpoint turns Eva's lines into real audio (MP3) that the page plays
through the Web Audio graph it also records from, so Eva is on the recording
whatever the candidate is listening with.

    POST /api/eva-tts   {"text": "..."}   ->   audio/mpeg

Two voice sources, no API key for either:

1. the ``edge-tts`` package (Microsoft neural voices) when it is installed;
2. otherwise Google's public text-to-speech over plain HTTPS (the same
   request the ``gTTS`` package makes), which needs nothing but ``requests``
   and outbound internet - so Eva is recorded even on a server where nothing
   extra could be installed.

Results are cached on disk under media/tts/<sha1>.mp3, so a question that was
asked once costs nothing afterwards. The endpoint is reachable without a login
because the candidate is not logged in; it only ever reads short text and
returns audio.
"""
import asyncio
import hashlib
import logging
import os
import re

import requests
from django.http import FileResponse, JsonResponse
from rest_framework.decorators import api_view

from .video_processor import media_root

log = logging.getLogger(__name__)

VOICE = os.environ.get('EVA_TTS_VOICE', 'en-US-AriaNeural')
RATE = os.environ.get('EVA_TTS_RATE', '-5%')
MAX_CHARS = 1500

GOOGLE_TTS_URL = 'https://translate.google.com/translate_tts'
GOOGLE_TTS_LANG = os.environ.get('EVA_TTS_LANG', 'en')
GOOGLE_TTS_CHUNK = 190                      # the service answers one short phrase per request
GOOGLE_TTS_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    'Referer': 'https://translate.google.com/',
}


def chunk_text(text, limit=GOOGLE_TTS_CHUNK):
    """Split ``text`` into pieces of at most ``limit`` characters, breaking at
    sentence ends where possible and at spaces otherwise."""
    pieces, current = [], ''
    for sentence in re.split(r'(?<=[.!?])\s+', text):
        while len(sentence) > limit:                      # a single over-long sentence: cut at a space
            cut = sentence.rfind(' ', 0, limit)
            cut = cut if cut > 0 else limit
            if current:
                pieces.append(current)
                current = ''
            pieces.append(sentence[:cut].strip())
            sentence = sentence[cut:].strip()
        candidate = f'{current} {sentence}'.strip() if current else sentence
        if len(candidate) <= limit:
            current = candidate
        else:
            pieces.append(current)
            current = sentence
    if current:
        pieces.append(current)
    return [p for p in pieces if p]


def google_tts(text, out_path, lang=GOOGLE_TTS_LANG):
    """Fetch ``text`` as MP3 from Google's public TTS, one request per short
    chunk, concatenated (MP3 frames join cleanly). Raises on any failure."""
    audio = bytearray()
    for piece in chunk_text(text):
        r = requests.get(GOOGLE_TTS_URL, params={'ie': 'UTF-8', 'tl': lang, 'client': 'tw-ob', 'q': piece},
                         headers=GOOGLE_TTS_HEADERS, timeout=20)
        if r.status_code != 200 or not r.content or 'audio' not in (r.headers.get('Content-Type') or ''):
            raise RuntimeError(f'Google TTS answered {r.status_code} {r.headers.get("Content-Type", "")}')
        audio += r.content
    tmp = out_path.with_name(out_path.stem + '.part' + out_path.suffix)
    tmp.write_bytes(bytes(audio))
    os.replace(tmp, out_path)


def normalize(text):
    """Collapse whitespace so the same line always hits the same cache file."""
    return re.sub(r'\s+', ' ', str(text or '')).strip()


def tts_dir():
    d = media_root() / 'tts'
    d.mkdir(parents=True, exist_ok=True)
    return d


def cache_path(text, voice=VOICE, rate=RATE):
    key = hashlib.sha1(f'{voice}|{rate}|{text}'.encode('utf-8')).hexdigest()
    return tts_dir() / f'{key}.mp3'


def edge_tts_synthesize(text, out_path, voice=VOICE, rate=RATE):
    """Write an MP3 of ``text`` with the edge-tts package. Raises ImportError
    when it is not installed, or any other error when synthesis fails."""
    import edge_tts  # noqa: WPS433 - optional dependency, see requirements.txt

    tmp = out_path.with_name(out_path.stem + '.part' + out_path.suffix)

    async def run():
        await edge_tts.Communicate(text, voice, rate=rate).save(str(tmp))

    asyncio.run(run())
    if not tmp.exists() or tmp.stat().st_size == 0:
        raise RuntimeError('no audio produced')
    os.replace(tmp, out_path)


def synthesize(text, out_path):
    """Write an MP3 of ``text`` to ``out_path`` with whichever voice source
    works: edge-tts first, Google's public TTS otherwise. Returns the source
    name. Raises RuntimeError when neither produced audio."""
    errors = []
    try:
        edge_tts_synthesize(text, out_path)
        return 'edge'
    except ImportError:
        errors.append('edge-tts not installed')
    except Exception as exc:
        errors.append(f'edge-tts: {exc}')
    try:
        google_tts(text, out_path)
        return 'google'
    except Exception as exc:
        errors.append(f'google: {exc}')
    raise RuntimeError('; '.join(errors))


@api_view(['POST'])
def eva_tts(request):
    text = normalize(request.data.get('text') if isinstance(request.data, dict) else '')
    if not text:
        return JsonResponse({'error': 'text is required'}, status=400)
    if len(text) > MAX_CHARS:
        return JsonResponse({'error': f'text is too long (max {MAX_CHARS} characters)'}, status=400)

    path = cache_path(text)
    source = 'cache'
    if not path.exists():
        try:
            source = synthesize(text, path)
        except Exception as exc:  # no voice source worked: network, service, disk
            log.warning('Eva TTS failed: %s', exc)
            return JsonResponse({'error': f'text-to-speech failed: {exc}'}, status=502)

    response = FileResponse(open(path, 'rb'), content_type='audio/mpeg')
    response['Cache-Control'] = 'public, max-age=31536000'
    response['X-Eva-Voice'] = source
    return response
