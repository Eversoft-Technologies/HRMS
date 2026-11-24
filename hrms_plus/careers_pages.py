"""Public careers HTML pages, served by Django (not the React app, whose
catch-all would boot the SPA and bounce a visitor to the login page).

  /careers               job list + filters (works without JavaScript)
  /careers/<code|id>     job detail + application form
  /careers/widget.js     the embeddable job widget
  /careers/logo          the company logo from Settings > General

``?embed=1`` renders either page without the site header/footer, for the
<iframe> embed. Pages may be framed only by the careers allowed origins
(Content-Security-Policy frame-ancestors).
"""
import base64
import re
from pathlib import Path

from django.conf import settings
from django.http import Http404, HttpResponse, HttpResponseRedirect
from django.shortcuts import render

from api.models import CompanyDetail

from . import careers as C

WIDGET_JS = Path(__file__).resolve().parent / 'templates' / 'careers' / 'widget.js'
_LOGO_RE = re.compile(r'^data:(image/(?:png|jpeg|jpg|gif|webp));base64,(.+)$', re.S)


def _finish(resp, s, cache='no-cache'):
    resp['Content-Security-Policy'] = C.frame_ancestors(s)
    resp['X-Content-Type-Options'] = 'nosniff'
    resp['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    resp['Cache-Control'] = cache
    return resp


def _ctx(request, s):
    company = C.company_info()
    embed = request.GET.get('embed') == '1'
    return {
        'company': company,
        'settings': s,
        'embed': embed,
        'embed_q': '?embed=1' if embed else '',
        'base': C.public_base(request),
    }


def _unavailable(request, s, status=404, title='Careers page unavailable',
                 text='This page is not available right now.'):
    ctx = _ctx(request, s)
    ctx.update({'title': title, 'text': text})
    return _finish(render(request, 'careers/unavailable.html', ctx, status=status), s)


def _days_since(jobs):
    """Adds 'ageDays' / 'isNew' (posted in the last 7 days) for the job cards."""
    from datetime import date
    today = date.today()
    for j in jobs:
        try:
            d = date.fromisoformat(j.get('postedAt') or '')
            j['ageDays'] = max((today - d).days, 0)
        except ValueError:
            j['ageDays'] = None
        j['isNew'] = j['ageDays'] is not None and j['ageDays'] <= 7


def careers_index(request):
    s = C.get_settings()
    if not s['enabled']:
        return _unavailable(request, s)
    ctx = _ctx(request, s)
    qs = C.filter_jobs(request.GET)
    jobs = [C.job_public(j, s) for j in qs[:200]]
    _days_since(jobs)
    f = C.facets()
    # Page summary: every open role (not just the filtered ones) by department.
    from django.db.models import Count
    dept_counts = [{'name': r['dept'], 'count': r['n']} for r in
                   C.public_jobs_qs().exclude(dept='').values('dept').annotate(n=Count('id')).order_by('-n', 'dept')]
    ctx['stats'] = {'roles': C.public_jobs_qs().count(), 'departments': len(dept_counts),
                    'locations': len(f.get('locations') or [])}
    ctx['dept_counts'] = dept_counts[:12]
    ctx.update({
        'jobs': jobs,
        'total': len(jobs),
        'facets': f,
        'q': C.clean_text(request.GET.get('q'), 100)[:100],
        'sel': {k: C.clean_text(request.GET.get(k), 120)[:120] for k in ('department', 'location', 'type', 'remote')},
        'filtered': any(request.GET.get(k) for k in ('q', 'department', 'location', 'type', 'remote')),
    })
    return _finish(render(request, 'careers/list.html', ctx), s, 'public, max-age=60')


def careers_detail(request, ident):
    s = C.get_settings()
    if not s['enabled']:
        return _unavailable(request, s)
    job = C.find_public_job(ident)
    if not job:
        return _unavailable(request, s, 404, 'Job not found',
                            'This job is no longer open. Have a look at our other openings.')
    ctx = _ctx(request, s)
    pj = C.job_public(job, s, full=True)
    desc = re.sub(r'\s+', ' ', job.description or '').strip()
    ctx.update({
        'job': pj,
        'posted': job.created_at,
        'meta_description': (desc[:155] + '…') if len(desc) > 155 else (desc or f'{job.title} at {ctx["company"]["name"]}'),
        'json_ld': C.json_ld(job, ctx['company'], ctx['base']),
        'form_token': C.form_token(job.id),
        'max_mb': C.RESUME_MAX_MB,
    })
    # The form token carries the time the form was served, so never cache it.
    return _finish(render(request, 'careers/detail.html', ctx), s, 'no-store')


def widget_js(request):
    try:
        body = WIDGET_JS.read_bytes()
    except OSError:
        raise Http404('widget missing')
    resp = HttpResponse(body, content_type='application/javascript; charset=utf-8')
    resp['Cache-Control'] = 'public, max-age=300'
    resp['X-Content-Type-Options'] = 'nosniff'
    return resp


def logo(request):
    c = CompanyDetail.objects.order_by('id').only('company_logo').first()
    raw = (c.company_logo or '').strip() if c else ''
    m = _LOGO_RE.match(raw)
    if m:
        try:
            data = base64.b64decode(m.group(2))
            mime = 'image/jpeg' if m.group(1) == 'image/jpg' else m.group(1)
            resp = HttpResponse(data, content_type=mime)
            resp['Cache-Control'] = 'public, max-age=3600'
            resp['X-Content-Type-Options'] = 'nosniff'
            return resp
        except Exception:
            pass
    if raw.startswith('https://') or raw.startswith('http://'):
        return HttpResponseRedirect(raw)
    path = Path(getattr(settings, 'REACT_BUILD_DIR', '')) / 'logo.jpg'
    if path.is_file():
        resp = HttpResponse(path.read_bytes(), content_type='image/jpeg')
        resp['Cache-Control'] = 'public, max-age=3600'
        return resp
    raise Http404('no logo')
