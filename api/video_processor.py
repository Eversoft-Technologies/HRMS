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

logger = logging.getLogger(__name__)

# Base storage directories under media/
MEDIA_ROOT = Path(getattr(settings, 'MEDIA_ROOT', settings.BASE_DIR / 'media'))
INTERVIEWS_DIR = MEDIA_ROOT / 'interviews'
RAW_DIR = INTERVIEWS_DIR / 'raw'
THUMBS_DIR = INTERVIEWS_DIR / 'thumbs'

_RANGE_RE = re.compile(r'bytes=([0-9]*)-([0-9]*)', re.I)


def ensure_directories():
    """Ensure media storage folders exist."""
    INTERVIEWS_DIR.mkdir(parents=True, exist_ok=True)
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    THUMBS_DIR.mkdir(parents=True, exist_ok=True)


def find_binary(name):
    """Locate executable binary in PATH or standard system directories."""
    # 1. Check custom environment variable
    env_var = f"{name.upper()}_PATH"
    if os.environ.get(env_var) and os.path.exists(os.environ[env_var]):
        return os.environ[env_var]

    # 2. Check system PATH
    found = shutil.which(name) or shutil.which(f"{name}.exe")
    if found:
        return found

    # 3. Check common Windows paths
    candidates = [
        Path(f"C:/{name}/bin/{name}.exe"),
        Path(f"C:/Program Files/{name}/bin/{name}.exe"),
        Path(f"C:/Program Files (x86)/{name}/bin/{name}.exe"),
        Path(f"C:/ProgramData/chocolatey/bin/{name}.exe"),
    ]
    for c in candidates:
        if c.exists():
            return str(c)

    return None


def probe_video_duration(file_path):
    """Extract duration in seconds using ffprobe if available."""
    ffprobe_bin = find_binary('ffprobe')
    if not ffprobe_bin or not os.path.exists(file_path):
        return None
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
            '-preset', 'fast',
            '-crf', '23',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', '+faststart',
            str(output_path)
        ]
        logger.info(f"[VideoProcessor] Running FFmpeg transcode: {' '.join(cmd)}")
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=180)
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
    raw_path = RAW_DIR / raw_filename

    # Write raw incoming file to disk
    with open(raw_path, 'wb') as f:
        f.write(raw_bytes)

    target_mp4_filename = f"rec_{recording_id}.mp4"
    target_mp4_path = INTERVIEWS_DIR / target_mp4_filename
    thumb_filename = f"thumb_{recording_id}.jpg"
    thumb_path = THUMBS_DIR / thumb_filename

    # Attempt FFmpeg transcode
    transcode_ok, err_msg = transcode_to_mp4(raw_path, target_mp4_path, thumb_path)

    if transcode_ok and target_mp4_path.exists():
        final_rel_path = f"interviews/{target_mp4_filename}"
        final_abs_path = target_mp4_path
        final_mime = "video/mp4"
        thumb_rel_path = f"interviews/thumbs/{thumb_filename}" if thumb_path.exists() else None
    else:
        # Fallback to direct raw file storage if FFmpeg is not available
        final_target_filename = f"rec_{recording_id}{ext}"
        final_abs_path = INTERVIEWS_DIR / final_target_filename
        shutil.copyfile(raw_path, final_abs_path)
        final_rel_path = f"interviews/{final_target_filename}"
        final_mime = content_type or "video/webm"
        thumb_rel_path = None
        logger.info(f"[VideoProcessor] Saved native video to {final_rel_path} (FFmpeg transcode skipped: {err_msg})")

    file_size = os.path.getsize(final_abs_path) if final_abs_path.exists() else len(raw_bytes)
    duration = probe_video_duration(final_abs_path)

    # Update database record with metadata
    update_data = {
        'video_file': final_rel_path,
        'video_url': f"/api/interview-recordings/{recording_id}/video",
        'video_size': file_size,
        'video_mime': final_mime,
        'thumbnail_file': thumb_rel_path,
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
        'transcoded': transcode_ok
    }


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
