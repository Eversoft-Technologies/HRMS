"""
api/video_processor.py
---------------------------------------------------------------------------
Video storage, FFmpeg transcoding (H.264 + AAC MP4 with +faststart),
snapshot thumbnail generation, and HTTP Range streaming engine for HRMS
Interview Recordings.
"""

import os
import re
import shutil
import subprocess
import logging
from pathlib import Path
from django.conf import settings
from django.http import HttpResponse, StreamingHttpResponse, Http404

from . import mp4_index

logger = logging.getLogger(__name__)

_RANGE_RE = re.compile(r'bytes=([0-9]*)-([0-9]*)', re.I)


def media_root():
    """Absolute directory that ``InterviewRecording.video_file`` paths are relative to.

    Read from settings on every call (not at import) so ``override_settings``
    works in tests and so an empty MEDIA_ROOT can never silently mean "the
    process working directory" — that is what Django's default ('') does, and
    it wrote recordings beside the code, where each deploy's fresh release
    directory lost them.
    """
    root = getattr(settings, 'MEDIA_ROOT', None)
    return Path(root) if root else Path(settings.BASE_DIR) / 'media'


def interviews_dir():
    return media_root() / 'interviews'


def raw_dir():
    return interviews_dir() / 'raw'


def thumbs_dir():
    return interviews_dir() / 'thumbs'


def ensure_directories():
    """Ensure media storage folders exist."""
    interviews_dir().mkdir(parents=True, exist_ok=True)
    raw_dir().mkdir(parents=True, exist_ok=True)
    thumbs_dir().mkdir(parents=True, exist_ok=True)


def shared_bin_dir():
    """``<shared>/bin`` on the deployed host.

    The deploy workflow symlinks ``<release>/media`` to ``<shared>/media``;
    a static ffmpeg/ffprobe placed in ``<shared>/bin`` is therefore found by
    resolving the media folder's real parent, from any release.
    """
    try:
        return Path(os.path.realpath(media_root())).parent / 'bin'
    except Exception:
        return None


def find_binary(name):
    """Locate an executable: ``<NAME>_PATH`` env var, PATH, the deploy's shared
    bin folder, ``<BASE_DIR>/bin``, then common Windows install paths."""
    # 1. Check custom environment variable
    env_var = f"{name.upper()}_PATH"
    if os.environ.get(env_var) and os.path.exists(os.environ[env_var]):
        return os.environ[env_var]

    # 2. Check system PATH
    found = shutil.which(name) or shutil.which(f"{name}.exe")
    if found:
        return found

    # 3. Deploy-provided binaries (cPanel has no system ffmpeg), then the repo's own bin/
    candidates = []
    shared = shared_bin_dir()
    if shared:
        candidates += [shared / name, shared / f"{name}.exe"]
    candidates += [Path(settings.BASE_DIR) / 'bin' / name, Path(settings.BASE_DIR) / 'bin' / f"{name}.exe"]

    # 4. Common Windows paths
    candidates += [
        Path(f"C:/{name}/bin/{name}.exe"),
        Path(f"C:/Program Files/{name}/bin/{name}.exe"),
        Path(f"C:/Program Files (x86)/{name}/bin/{name}.exe"),
        Path(f"C:/ProgramData/chocolatey/bin/{name}.exe"),
    ]
    for c in candidates:
        if c.exists() and (os.name == 'nt' or os.access(c, os.X_OK)):
            return str(c)

    return None


def _read_box_headers(data):
    """Top-level ISO-BMFF boxes in ``data`` as [(type, size), ...]."""
    out, i = [], 0
    while i + 8 <= len(data):
        size = int.from_bytes(data[i:i + 4], 'big')
        typ = data[i + 4:i + 8]
        if not typ.isalnum():
            break
        if size == 1 and i + 16 <= len(data):
            size = int.from_bytes(data[i + 8:i + 16], 'big')
        if size == 0:
            size = len(data) - i
        if size < 8:
            break
        out.append((typ.decode('ascii'), size))
        i += size
    return out


def needs_index(file_path):
    """True when the browser cannot seek the file without reading all of it.

    MediaRecorder output is exactly that: Chrome writes a fragmented MP4
    (``moov`` carries ``mvex`` and a zero duration, no ``sidx``/``mfra``) and
    Firefox a WebM without Cues. Both play, but the ``<video>`` element must
    scan the whole file to learn the duration and to seek, which shows up as
    a long "Buffering..." before playback starts.
    """
    file_path = Path(file_path)
    if not file_path.exists():
        return False
    ext = file_path.suffix.lower()
    if ext in ('.webm', '.mkv', '.mov'):
        return True
    if ext != '.mp4':
        return False
    with open(file_path, 'rb') as f:
        head = f.read(4 * 1024 * 1024)
    boxes = _read_box_headers(head)
    types = [t for t, _ in boxes]
    if 'moof' in types:
        return True
    offset = 0
    for t, size in boxes:
        if t == 'mdat':
            return True      # moov after the media (no faststart): full download before play
        if t == 'moov':
            return b'mvex' in head[offset:offset + size]
        offset += size
    return True              # no moov within the first 4 MB


def remux_to_mp4(input_path, output_path):
    """Rewrite an H.264/AAC file as a flat, indexed MP4 (+faststart) without
    re-encoding. Seconds of work even on a shared host. Returns (ok, error)."""
    ffmpeg_bin = find_binary('ffmpeg')
    if not ffmpeg_bin:
        return False, "FFmpeg not installed in system PATH."
    cmd = [ffmpeg_bin, '-y', '-i', str(input_path), '-c', 'copy', '-movflags', '+faststart', str(output_path)]
    try:
        logger.info(f"[VideoProcessor] Running FFmpeg remux: {' '.join(cmd)}")
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=300)
        if res.returncode != 0 or not Path(output_path).exists():
            logger.warning(f"[VideoProcessor] FFmpeg remux failed with code {res.returncode}: {res.stderr[-800:]}")
            return False, res.stderr
        return True, ""
    except Exception as exc:
        logger.error(f"[VideoProcessor] Remux error: {exc}")
        return False, str(exc)


def extract_thumbnail(input_path, thumb_path):
    """Poster frame at 1s; best effort."""
    ffmpeg_bin = find_binary('ffmpeg')
    if not ffmpeg_bin or not thumb_path:
        return False
    cmd = [ffmpeg_bin, '-y', '-ss', '00:00:01', '-i', str(input_path), '-vframes', '1', '-q:v', '2', str(thumb_path)]
    try:
        subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    except Exception as exc:
        logger.warning(f"[VideoProcessor] Thumbnail extraction failed: {exc}")
    return Path(thumb_path).exists()


def index_video(input_path, output_path, thumb_path=None):
    """Produce a seekable MP4 from a recorder upload.

    MP4/MOV input (Chrome, Safari: already H.264 + AAC) keeps its media and
    only gets a proper index: FFmpeg remux when FFmpeg is there, otherwise
    the pure-Python rewrite in ``mp4_index`` (same result, no dependency).
    WebM input needs a transcode and therefore FFmpeg. Returns
    (ok, method, error) with method one of 'remux', 'index', 'transcode', ''.
    """
    input_path = Path(input_path)
    if input_path.suffix.lower() in ('.mp4', '.mov', '.m4v'):
        have_ffmpeg = bool(find_binary('ffmpeg'))
        if have_ffmpeg:
            ok, err = remux_to_mp4(input_path, output_path)
            if ok:
                extract_thumbnail(output_path, thumb_path)
                return True, 'remux', ''
        ok, method, err, _duration = mp4_index.index_mp4(input_path, output_path)
        if ok:
            extract_thumbnail(output_path, thumb_path)
            return True, 'index', ''
        if not have_ffmpeg:
            return False, '', f'cannot index without FFmpeg: {err}'
    ok, err = transcode_to_mp4(input_path, output_path, thumb_path)
    return ok, ('transcode' if ok else ''), err


def probe_video_duration(file_path):
    """Duration in whole seconds: ffprobe when available, else read from the
    MP4 header (an indexed MP4 carries it; a fragmented one does not)."""
    if not os.path.exists(file_path):
        return None
    ffprobe_bin = find_binary('ffprobe')
    if not ffprobe_bin:
        secs = mp4_index.read_duration(file_path)
        return int(round(secs)) if secs else None
    try:
        cmd = [
            ffprobe_bin,
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            str(file_path)
        ]
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
        if result.returncode == 0 and result.stdout.strip():
            val = float(result.stdout.strip())
            return int(round(val))
    except Exception as exc:
        logger.warning(f"[VideoProcessor] ffprobe duration check failed: {exc}")
    return None


def transcode_to_mp4(input_path, output_path, thumb_path=None):
    """
    Transcodes input video to web-standard H.264 + AAC MP4 with +faststart.
    Optionally extracts a 1-second thumbnail snapshot.
    Returns (success: bool, error_msg: str).
    """
    ffmpeg_bin = find_binary('ffmpeg')
    if not ffmpeg_bin:
        return False, "FFmpeg not installed in system PATH."

    try:
        # 1. Transcode video: H.264 video, AAC audio, faststart header for instant web playback
        cmd = [
            ffmpeg_bin,
            '-y',
            '-i', str(input_path),
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '23',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', '+faststart',
            str(output_path)
        ]
        logger.info(f"[VideoProcessor] Running FFmpeg transcode: {' '.join(cmd)}")
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=900)
        if res.returncode != 0:
            logger.error(f"[VideoProcessor] FFmpeg failed with code {res.returncode}: {res.stderr}")
            return False, res.stderr

        # 2. Extract snapshot poster thumbnail
        if thumb_path:
            thumb_cmd = [
                ffmpeg_bin,
                '-y',
                '-ss', '00:00:01',
                '-i', str(input_path),
                '-vframes', '1',
                '-q:v', '2',
                str(thumb_path)
            ]
            subprocess.run(thumb_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)

        return True, ""
    except Exception as exc:
        logger.error(f"[VideoProcessor] Transcode error: {exc}")
        return False, str(exc)


def save_interview_video(recording_id, raw_bytes, content_type='video/webm'):
    """
    Saves binary video to disk storage, runs FFmpeg transcode if available,
    and updates the database InterviewRecording record with metadata.
    """
    from .models import InterviewRecording

    ensure_directories()

    # Determine file extensions
    ext = '.webm'
    if 'mp4' in (content_type or '').lower():
        ext = '.mp4'
    elif 'quicktime' in (content_type or '').lower() or 'mov' in (content_type or '').lower():
        ext = '.mov'

    raw_filename = f"rec_{recording_id}_raw{ext}"
    raw_path = raw_dir() / raw_filename

    # Write raw incoming file to disk
    with open(raw_path, 'wb') as f:
        f.write(raw_bytes)

    target_mp4_filename = f"rec_{recording_id}.mp4"
    target_mp4_path = interviews_dir() / target_mp4_filename
    thumb_filename = f"thumb_{recording_id}.jpg"
    thumb_path = thumbs_dir() / thumb_filename

    # Make it seekable: remux (MP4/MOV) or transcode (WebM) into an indexed MP4.
    transcode_ok, method, err_msg = index_video(raw_path, target_mp4_path, thumb_path)

    if transcode_ok and target_mp4_path.exists():
        final_rel_path = f"interviews/{target_mp4_filename}"
        final_abs_path = target_mp4_path
        final_mime = "video/mp4"
        thumb_rel_path = f"interviews/thumbs/{thumb_filename}" if thumb_path.exists() else None
    else:
        # Fallback to direct raw file storage if FFmpeg is not available
        final_target_filename = f"rec_{recording_id}{ext}"
        final_abs_path = interviews_dir() / final_target_filename
        shutil.copyfile(raw_path, final_abs_path)
        final_rel_path = f"interviews/{final_target_filename}"
        final_mime = content_type or "video/webm"
        thumb_rel_path = None
        logger.warning(f"[VideoProcessor] Saved native video to {final_rel_path} without an index "
                       f"(FFmpeg step skipped: {err_msg}) - playback will buffer until the whole file loads.")

    file_size = os.path.getsize(final_abs_path) if final_abs_path.exists() else len(raw_bytes)
    duration = probe_video_duration(final_abs_path)

    # Update database record with metadata
    update_data = {
        'video_file': final_rel_path,
        'video_url': f"/api/interview-recordings/{recording_id}/video",
        'video_size': file_size,
        'video_mime': final_mime,
        'thumbnail_file': thumb_rel_path,
        'has_video': True,
    }
    if duration and duration > 0:
        update_data['duration'] = duration

    InterviewRecording.objects.filter(pk=recording_id).update(**update_data)

    return {
        'ok': True,
        'video_file': final_rel_path,
        'video_mime': final_mime,
        'video_size': file_size,
        'thumbnail_file': thumb_rel_path,
        'transcoded': transcode_ok,
        'method': method if transcode_ok else '',
    }


def index_existing_recording(recording, replace=True):
    """Rebuild one stored recording as an indexed MP4 (the ``index_recordings``
    command). Uses the raw upload in ``raw/`` when it is still there, else the
    served file itself. Returns (changed: bool, message: str)."""
    from .models import InterviewRecording

    rel = recording.video_file or ''
    if not rel:
        return False, 'no file'
    current = media_root() / rel
    if not current.exists():
        return False, f'missing on disk: {rel}'
    if not needs_index(current):
        return False, 'already indexed'
    ensure_directories()
    raw_candidates = sorted(raw_dir().glob(f"rec_{recording.pk}_raw.*"))
    if raw_candidates:
        source = raw_candidates[0]
    elif replace:
        # No raw copy kept for this one: the served file becomes the raw backup,
        # in the same place new uploads keep theirs.
        source = raw_dir() / f"rec_{recording.pk}_raw{current.suffix.lower()}"
        shutil.move(str(current), str(source))
        current = source
    else:
        source = current
    target_name = f"rec_{recording.pk}.mp4"
    tmp_out = interviews_dir() / f"rec_{recording.pk}.indexing.mp4"
    thumb_path = thumbs_dir() / f"thumb_{recording.pk}.jpg"
    ok, method, err = index_video(source, tmp_out, thumb_path)
    if not ok:
        if tmp_out.exists():
            tmp_out.unlink()
        return False, f'failed: {(err or "").strip()[-200:]}'
    target = interviews_dir() / target_name
    if not replace:
        tmp_out.unlink()
        return True, f'would {method} -> {target_name}'
    # The raw upload is the safety copy and is kept. The old served file goes
    # once the new one is in place, unless it is that raw copy or the target.
    os.replace(tmp_out, target)
    if current.resolve() != target.resolve() and current.resolve() != source.resolve():
        try:
            current.unlink()
        except OSError:
            pass
    duration = probe_video_duration(target)
    update = {
        'video_file': f"interviews/{target_name}",
        'video_url': f"/api/interview-recordings/{recording.pk}/video",
        'video_size': os.path.getsize(target),
        'video_mime': 'video/mp4',
        'thumbnail_file': f"interviews/thumbs/thumb_{recording.pk}.jpg" if thumb_path.exists() else recording.thumbnail_file,
        'has_video': True,
    }
    if duration and duration > 0:
        update['duration'] = duration
    InterviewRecording.objects.filter(pk=recording.pk).update(**update)
    return True, f'{method} -> {target_name}'


def stream_file_range(file_path, content_type, request):
    """
    High-performance HTTP Range streaming response (206 Partial Content / 200 OK)
    for video files on disk.
    """
    file_path = Path(file_path)
    if not file_path.exists():
        raise Http404("Video file not found on server disk.")

    size = file_path.stat().st_size
    range_header = request.headers.get('Range') or request.META.get('HTTP_RANGE') or ''
    match = _RANGE_RE.match(range_header.strip()) if range_header else None

    if match:
        first, last = match.group(1), match.group(2)
        if first == '':
            length = int(last or 0)
            start = max(0, size - length)
            end = size - 1
        else:
            start = int(first)
            end = size - 1 if last == '' else min(int(last), size - 1)

        if start >= size or start > end:
            resp = HttpResponse(status=416)
            resp['Content-Range'] = f'bytes */{size}'
            resp['Accept-Ranges'] = 'bytes'
            return resp

        chunk_length = end - start + 1

        def file_iterator(path, offset, length, chunk_size=65536):
            with open(path, 'rb') as f:
                f.seek(offset)
                remaining = length
                while remaining > 0:
                    read_size = min(chunk_size, remaining)
                    data = f.read(read_size)
                    if not data:
                        break
                    remaining -= len(data)
                    yield data

        resp = StreamingHttpResponse(
            file_iterator(file_path, start, chunk_length),
            status=206,
            content_type=content_type
        )
        resp['Content-Range'] = f'bytes {start}-{end}/{size}'
        resp['Content-Length'] = str(chunk_length)
        resp['Accept-Ranges'] = 'bytes'
        return resp
    else:
        def full_iterator(path, chunk_size=65536):
            with open(path, 'rb') as f:
                while True:
                    data = f.read(chunk_size)
                    if not data:
                        break
                    yield data

        resp = StreamingHttpResponse(full_iterator(file_path), status=200, content_type=content_type)
        resp['Content-Length'] = str(size)
        resp['Accept-Ranges'] = 'bytes'
        return resp
