"""
index_recordings - make stored interview videos seekable.

MediaRecorder uploads (fragmented MP4 from Chrome, WebM from Firefox) carry no
seek index, so the Recordings player sits on "Buffering..." until the browser
has read the whole file. New uploads are fixed on arrival by
video_processor.index_video; this command does the same for recordings that
were uploaded before that existed.

MP4 recordings need nothing installed: the index is rebuilt in pure Python
(api/mp4_index.py). WebM recordings need a transcode, which needs FFmpeg
(FFMPEG_PATH, PATH, or a static build in <shared>/bin).

    python manage.py index_recordings            # every recording that needs it
    python manage.py index_recordings --dry-run  # report only
    python manage.py index_recordings --ids 66 67
    python manage.py index_recordings --remux-only   # MP4 only, skip slow WebM transcodes

Safe to re-run: files that are already indexed are skipped, and the raw
upload in media/interviews/raw/ is never removed.
"""
from django.core.management.base import BaseCommand

from api import video_processor
from api.models import InterviewRecording

MP4_EXTS = ('.mp4', '.mov', '.m4v')


class Command(BaseCommand):
    help = 'Rebuild stored interview recordings as seekable MP4s.'

    def add_arguments(self, parser):
        parser.add_argument('--dry-run', action='store_true', help='Report what would change, write nothing.')
        parser.add_argument('--ids', nargs='*', type=int, default=None, help='Only these recording ids.')
        parser.add_argument('--remux-only', action='store_true',
                            help='Only MP4/MOV sources (seconds each); leave WebM transcodes for a later run.')

    def handle(self, *args, **opts):
        have_ffmpeg = bool(video_processor.find_binary('ffmpeg'))
        if not have_ffmpeg:
            self.stderr.write('ffmpeg not found - MP4 recordings are indexed in pure Python; '
                              'WebM ones are skipped until FFmpeg is installed (FFMPEG_PATH or <shared>/bin).')
        qs = InterviewRecording.objects.exclude(video_file='').exclude(video_file__isnull=True)
        if opts['ids']:
            qs = qs.filter(pk__in=opts['ids'])
        qs = qs.only('id', 'video_file', 'thumbnail_file').order_by('id')
        changed = skipped = failed = 0
        for rec in qs.iterator():
            path = video_processor.media_root() / rec.video_file
            if path.suffix.lower() not in MP4_EXTS and (opts['remux_only'] or not have_ffmpeg):
                skipped += 1
                why = 'run without --remux-only' if have_ffmpeg else 'needs FFmpeg'
                self.stdout.write(f'  #{rec.id}: skipped ({path.suffix} needs a transcode; {why})')
                continue
            did, msg = video_processor.index_existing_recording(rec, replace=not opts['dry_run'])
            if did:
                changed += 1
                self.stdout.write(f'  #{rec.id}: {msg}')
            elif msg.startswith(('failed', 'ffmpeg failed', 'missing')):
                failed += 1
                self.stderr.write(f'  #{rec.id}: {msg}')
            else:
                skipped += 1
        self.stdout.write(f'{"would change" if opts["dry_run"] else "changed"} {changed}, skipped {skipped}, failed {failed}')
