import getpass
from django.core.management.base import BaseCommand
from api.models import AppUser, UserProfile
from api.views import make_initials, norm_email, generate_next_employee_id
from api.secret_box import hash_password


class Command(BaseCommand):
    help = 'Create or promote an AppUser account with Super Admin god-mode privileges.'

    def add_arguments(self, parser):
        parser.add_argument('--email', type=str, help='Email address of the super admin')
        parser.add_argument('--password', type=str, help='Password for the super admin')
        parser.add_argument('--name', type=str, help='Full name of the super admin')

    def handle(self, *args, **options):
        email = norm_email(options.get('email') or '')
        if not email:
            email = norm_email(input('Super Admin Email Address: '))
        if not email:
            self.stderr.write(self.style.ERROR('Email address is required.'))
            return

        name = (options.get('name') or '').strip()
        if not name:
            name = input('Full Name [Root Super Administrator]: ').strip() or 'Root Super Administrator'

        raw_password = options.get('password')
        if not raw_password:
            raw_password = getpass.getpass('Password: ')
            if not raw_password:
                self.stderr.write(self.style.ERROR('Password is required.'))
                return
            password_confirm = getpass.getpass('Password (again): ')
            if raw_password != password_confirm:
                self.stderr.write(self.style.ERROR('Passwords do not match.'))
                return

        user = AppUser.objects.filter(email=email).first()
        if user:
            user.is_superadmin = True
            user.role = 'admin'
            user.role_ref = None  # Super admin is decoupled from roles
            user.status = 'active'
            if name:
                user.full_name = name
            user.password = raw_password  # save() will hash it via secret_box
            user.save()
            self.stdout.write(self.style.SUCCESS(f'Successfully promoted existing user {email} to Super Admin.'))
        else:
            emp_id = generate_next_employee_id()
            user = AppUser.objects.create(
                email=email,
                full_name=name,
                password=raw_password,
                initials=make_initials(name),
                role='admin',
                role_ref=None,
                is_superadmin=True,
                status='active',
                employee_id=emp_id,
            )
            self.stdout.write(self.style.SUCCESS(f'Successfully created new Super Admin account {email}.'))

        # Ensure UserProfile exists
        UserProfile.objects.update_or_create(
            email=email,
            defaults={
                'first_name': name.split()[0] if name else '',
                'last_name': ' '.join(name.split()[1:]) if len(name.split()) > 1 else '',
                'designation': 'System Administrator',
                'department': 'Executive',
            }
        )
        self.stdout.write(self.style.SUCCESS(f'Super Admin URL: /superadmin'))
