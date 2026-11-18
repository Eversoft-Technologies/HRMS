"""Transcribe interview videos with Deepgram (api/transcription.py).

    python manage.py transcribe_interviews              # everything still missing a transcript
    python manage.py transcribe_interviews --id 42      # one recording (re-runs even if done)
    python manage.py transcribe_interviews --dry-run    # list what would be sent
    python manage.py transcribe_interviews --skip-failed

Each upload is transcribed automatically on a background thread; this picks up
the rest — recordings from before DEEPGRAM_API_KEY was set, failures, and jobs
interrupted by a server restart. Safe to run from cron (e.g. every 15 minutes).
"""
from django.core.management.base import BaseCommand, CommandError

from api import transcription


class Command(BaseCommand):
    help = 'Transcribe interview recordings with Deepgram.'

    def add_arguments(self, parser):
        parser.add_argument('--id', type=int, help='Only this recording id.')
        parser.add_argument('--dry-run', action='store_true', help='List, do not send anything.')
        parser.add_argument('--skip-failed', action='store_true', help='Do not retry earlier failures.')
        parser.add_argument('--limit', type=int, default=0, help='At most this many recordings.')

    def handle(self, *args, **opts):
        if not transcription.is_configured() and not opts['dry_run']:
            raise CommandError('No Deepgram key: add it in Settings › AI Settings › Speech-to-text (or DEEPGRAM_API_KEY in .env).')
        ids = [opts['id']] if opts['id'] else transcription.pending_ids(include_failed=not opts['skip_failed'])
        if opts['limit']:
            ids = ids[:opts['limit']]
        if not ids:
            self.stdout.write('Nothing to transcribe.')
            return
        if opts['dry_run']:
            self.stdout.write('Would transcribe: ' + ', '.join(map(str, ids)))
            return
        counts = {}
        for pk in ids:
            status = transcription.transcribe_recording(pk)
            counts[status] = counts.get(status, 0) + 1
            line = f'#{pk}: {status}'
            if status != 'done':
                from api.models import InterviewRecording
                err = InterviewRecording.objects.filter(pk=pk).values_list('stt_error', flat=True).first()
                line += f' — {err}'
            self.stdout.write(line)
        self.stdout.write(self.style.SUCCESS(
            'Done: ' + ', '.join(f'{v} {k}' for k, v in sorted(counts.items(), key=lambda kv: str(kv[0])))))
