import urllib.request
import json

urls = [
    'http://127.0.0.1:8000/api/attendance/today/?email=employee@company.com',
    'http://127.0.0.1:8000/api/attendance/check-in/',
    'http://127.0.0.1:8000/api/attendance/breaks/today/?email=employee@company.com'
]

for u in urls:
    req = urllib.request.Request(u)
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            print(u, '=>', r.getcode())
            body = r.read(500).decode(errors='replace')
            print(body[:300])
    except urllib.error.HTTPError as e:
        print(u, '=> HTTP', e.code)
        try:
            print(e.read(300).decode())
        except Exception:
            pass
    except Exception as e:
        print(u, '=> ERROR', e)
