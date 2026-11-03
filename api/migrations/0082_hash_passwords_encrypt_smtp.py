"""Every stored login password becomes a hash; SMTP passwords get encrypted.

* ``app_users.password``: any value that is not already a Django password hash
  is replaced by ``make_password(value)``. Users sign in with the same password
  as before; nobody (admins included) can read it back any more. From now on
  ``AppUser.save()`` hashes on write, so plain text cannot come back.
* ``user_email_config.smtp_password``: widened to fit ciphertext and encrypted
  with HRMS_SECRETS_KEY (it is re-used to log in to the mail server, so it
  cannot be hashed). If the key is not set when this runs, the values are left
  as they are and ``python manage.py hash_existing_passwords`` encrypts them
  once the key has been set.

Not reversible: a hash cannot be turned back into the password.
"""
from django.contrib.auth.hashers import identify_hasher, make_password
from django.db import migrations, models


def _is_hash(value):
    try:
        identify_hasher(value)
        return True
    except ValueError:
        return False


def forwards(apps, schema_editor):
    AppUser = apps.get_model('api', 'AppUser')
    for pk, pw in AppUser.objects.exclude(password='').values_list('pk', 'password'):
        if pw and not _is_hash(pw):
            AppUser.objects.filter(pk=pk).update(password=make_password(pw))

    from api.secret_box import encrypt, encryption_ready, is_encrypted
    if not encryption_ready():
        return
    UserEmailConfig = apps.get_model('api', 'UserEmailConfig')
    for pk, pw in UserEmailConfig.objects.exclude(smtp_password='').values_list('pk', 'smtp_password'):
        if pw and not is_encrypted(pw):
            UserEmailConfig.objects.filter(pk=pk).update(smtp_password=encrypt(pw))


class Migration(migrations.Migration):
    dependencies = [('api', '0081_ai_settings_and_notification_prefs')]

    operations = [
        migrations.AlterField(
            model_name='useremailconfig',
            name='smtp_password',
            field=models.CharField(blank=True, default='', max_length=512),
        ),
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
