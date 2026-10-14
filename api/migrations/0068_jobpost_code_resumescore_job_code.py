# Job Code on job posts (+ the code a resume was scored against).

from django.db import migrations, models


def backfill_job_codes(apps, schema_editor):
    """Existing posts get JOB-101, JOB-102, ... in id order, matching what
    JobPost.next_code() would have handed out had the column always existed."""
    JobPost = apps.get_model('api', 'JobPost')
    n = 101
    for pk in JobPost.objects.order_by('id').values_list('id', flat=True):
        JobPost.objects.filter(pk=pk).update(code='JOB-%d' % n)
        n += 1


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0067_interviewrecording_video_file_fields'),
    ]

    operations = [
        # Added without the unique constraint, backfilled, then made unique:
        # a fresh unique column defaulting to '' would clash on the second row.
        migrations.AddField(
            model_name='jobpost',
            name='code',
            field=models.CharField(blank=True, default='', max_length=40),
        ),
        migrations.RunPython(backfill_job_codes, migrations.RunPython.noop),
        migrations.AlterField(
            model_name='jobpost',
            name='code',
            field=models.CharField(blank=True, default='', max_length=40, unique=True),
        ),
        migrations.AddField(
            model_name='resumescore',
            name='job_code',
            field=models.CharField(blank=True, db_index=True, default='', max_length=40),
        ),
    ]
