# Cheap "is there a video / legacy recording" flags for the Recordings list.
#
# The list used to decide hasVideo with ``video_buffer > ''`` and
# ``recording_data > ''`` per row, which makes MySQL read every stored video
# blob on every listing. The flags are computed once here (the only scan),
# then kept current by InterviewRecording.save() and the video upload paths.

from django.db import migrations, models


def backfill_flags(apps, schema_editor):
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(
            "UPDATE interview_recordings SET "
            "has_recording = (recording_data IS NOT NULL AND LENGTH(recording_data) > 0), "
            "has_video = ("
            "(video_file IS NOT NULL AND video_file <> '') "
            "OR (video_buffer IS NOT NULL AND LENGTH(video_buffer) > 0) "
            "OR (recording_data IS NOT NULL AND LENGTH(recording_data) > 0))"
        )


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0069_merge_20261014_1908'),
    ]

    operations = [
        migrations.AddField(
            model_name='interviewrecording',
            name='has_video',
            field=models.BooleanField(db_index=True, default=False),
        ),
        migrations.AddField(
            model_name='interviewrecording',
            name='has_recording',
            field=models.BooleanField(default=False),
        ),
        migrations.RunPython(backfill_flags, migrations.RunPython.noop),
    ]
