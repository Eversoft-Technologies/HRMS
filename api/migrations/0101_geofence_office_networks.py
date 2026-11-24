"""Office Wi-Fi / IP networks per company location (GeoFence.office_networks).
See api/attendance_ext/networks.py."""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0100_recheckin_approval'),
    ]

    operations = [
        migrations.AddField(
            model_name='geofence',
            name='office_networks',
            field=models.JSONField(blank=True, default=list),
        ),
    ]
