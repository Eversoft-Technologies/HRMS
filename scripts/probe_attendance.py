import os
import django
import jwt
import urllib.request
import urllib.error
import urllib.parse
import datetime

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'hrms_project.settings')
django.setup()

from api.models import AppUser

user = AppUser.objects.first()
if not user:
    print('No AppUser found in DB; create one via admin or seed data')
    raise SystemExit(1)

secret = os.environ.get('DJANGO_SECRET_KEY', 'dev-insecure-change-me')
exp = datetime.datetime.utcnow() + datetime.timedelta(minutes=60)
try:
    token = jwt.encode({'email': user.email, 'exp': exp}, secret, algorithm='HS256')
except Exception as e:
    print('JWT encode failed:', e)
    raise

print('Using user:', user.email)
print('Token:', token)

headers = {'Authorization': f'Bearer {token}'}

def call(url):
    req = urllib.request.Request(url)
    for k,v in headers.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=6) as r:
            body = r.read(2000).decode(errors='replace')
            print(url, '=>', r.getcode())
            print(body[:800])
    except urllib.error.HTTPError as e:
        print(url, '=> HTTP', e.code)
        try:
            print(e.read(800).decode(errors='replace'))
        except Exception:
            pass
    except Exception as e:
        print(url, '=> ERROR', e)

base = 'http://127.0.0.1:8000'
call(base + '/api/attendance/today/?email=' + urllib.parse.quote(user.email))
call(base + '/api/attendance/breaks/today/?email=' + urllib.parse.quote(user.email))
call(base + '/api/attendance/check-in/')
