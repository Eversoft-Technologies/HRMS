"""Resume parsing that pre-fills the careers apply form
(hrms_plus/resume_parser.py + POST /api/public/careers/parse-resume)."""
import io
import json
import zipfile
from unittest import mock

from django.test import Client, SimpleTestCase, override_settings

from hrms_plus import careers as C
from hrms_plus.models import JobApplication
from hrms_plus.resume_parser import parse_resume_text
from tests.test_careers import PNG, Base, b64

CLASSIC = """
RAVI KUMAR TEJA
Senior Java Developer
Hyderabad, Telangana | +91 98765 43210 | ravi.teja@gmail.com
linkedin.com/in/ravi-kumar-teja | github.com/raviteja
PROFESSIONAL SUMMARY
Java developer with 6+ years of experience building Spring Boot microservices on AWS.
SKILLS
Java, Spring Boot, Hibernate, MySQL, Kafka, Docker, Kubernetes, AWS, Git
EXPERIENCE
Eversoft Technologies  2019 - 2024
"""

US_STYLE = """
Jane A. Doe
Location: Austin, TX
Phone: (512) 555-0147   Email: jane.doe@outlook.com
https://janedoe.dev
Summary
Frontend engineer, 4 years experience with React, TypeScript and Node.js.
"""

HEADER_ONE_LINE = "Priya Sharma | priya.sharma@yahoo.co.in | 080-4567-8910 | Bengaluru\nResume\nPython, Django"

NO_NAME = """CURRICULUM VITAE
Objective
To work in a challenging environment.
Contact: sam.wilson@example.com
"""


class ParserTests(SimpleTestCase):
    def test_classic_layout(self):
        d = parse_resume_text(CLASSIC)
        self.assertEqual(d['fullName'], 'Ravi Kumar Teja')           # all-caps name is title-cased
        self.assertEqual(d['email'], 'ravi.teja@gmail.com')
        self.assertEqual(d['phone'], '+91 98765 43210')
        self.assertEqual(d['location'], 'Hyderabad, Telangana')
        self.assertEqual(d['linkedinUrl'], 'https://www.linkedin.com/in/ravi-kumar-teja')
        self.assertEqual(d['githubUrl'], 'https://github.com/raviteja')
        self.assertEqual(d['experienceYears'], 6)
        for s in ('Java', 'Spring Boot', 'Kafka', 'AWS', 'Docker'):
            self.assertIn(s, d['skills'])
        self.assertNotIn('Spring', d['skills'])                         # implied by Spring Boot

    def test_us_layout_with_labels(self):
        d = parse_resume_text(US_STYLE)
        self.assertEqual(d['fullName'], 'Jane A. Doe')
        self.assertEqual(d['location'], 'Austin, TX')
        self.assertEqual(d['phone'], '(512) 555-0147')
        self.assertEqual(d['email'], 'jane.doe@outlook.com')
        self.assertEqual(d['portfolioUrl'], 'https://janedoe.dev')
        self.assertEqual(d['experienceYears'], 4)
        self.assertIn('React', d['skills'])

    def test_single_header_line(self):
        d = parse_resume_text(HEADER_ONE_LINE)
        self.assertEqual(d['fullName'], 'Priya Sharma')
        self.assertEqual(d['email'], 'priya.sharma@yahoo.co.in')
        self.assertEqual(d['phone'], '080-4567-8910')
        self.assertEqual(d['location'], 'Bengaluru')

    def test_headings_are_not_names_and_email_fallback(self):
        d = parse_resume_text(NO_NAME)
        self.assertEqual(d['fullName'], 'Sam Wilson')                   # from sam.wilson@…
        self.assertEqual(d['linkedinUrl'], '')
        self.assertIsNone(d['experienceYears'])

    def test_years_and_dates_are_not_phone_numbers(self):
        d = parse_resume_text('John Smith\nWorked 2015 - 2019 2020 at ACME\nID 12345')
        self.assertEqual(d['phone'], '')

    def test_empty_text(self):
        d = parse_resume_text('')
        self.assertEqual((d['fullName'], d['email'], d['skills']), ('', '', []))


def _pdf_with_text(lines):
    from reportlab.pdfgen import canvas
    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    y = 800
    for line in lines:
        c.drawString(72, y, line)
        y -= 18
    c.save()
    return buf.getvalue()


def _docx_with_text(lines):
    buf = io.BytesIO()
    body = ''.join(f'<w:p><w:r><w:t>{l}</w:t></w:r></w:p>' for l in lines)
    with zipfile.ZipFile(buf, 'w') as z:
        z.writestr('[Content_Types].xml', '<Types/>')
        z.writestr('word/document.xml', f'<w:document><w:body>{body}</w:body></w:document>')
    return buf.getvalue()


class ParseEndpointTests(Base):
    URL = '/api/public/careers/parse-resume'

    def post(self, resume, client=None):
        return (client or self.public).post(self.URL, data=json.dumps({'resume': resume}),
                                            content_type='application/json')

    def test_pdf_is_parsed_and_nothing_is_stored(self):
        raw = _pdf_with_text(['Asha Rao', 'Pune, Maharashtra | asha.rao@example.com | +91 91234 56789',
                              'linkedin.com/in/asha-rao', '5 years of experience in Python and Django'])
        r = self.post({'name': 'asha.pdf', 'mime': 'application/pdf', 'data': b64(raw)})
        self.assertEqual(r.status_code, 200, r.content)
        d = r.json()
        self.assertTrue(d['readable'])
        f = d['fields']
        self.assertEqual(f['fullName'], 'Asha Rao')
        self.assertEqual(f['email'], 'asha.rao@example.com')
        self.assertEqual(f['phone'], '+91 91234 56789')
        self.assertEqual(f['location'], 'Pune, Maharashtra')
        self.assertEqual(f['linkedinUrl'], 'https://www.linkedin.com/in/asha-rao')
        self.assertEqual(f['experienceYears'], 5)
        self.assertEqual(r['Cache-Control'], 'no-store')
        self.assertFalse(JobApplication.objects.exists())

    def test_docx_is_parsed(self):
        raw = _docx_with_text(['Mohan Das', 'mohan.das@example.com', 'Chennai'])
        r = self.post({'name': 'cv.docx', 'mime': '', 'data': b64(raw)})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()['fields']['fullName'], 'Mohan Das')
        self.assertEqual(r.json()['fields']['location'], 'Chennai')

    def test_disguised_or_wrong_files_are_refused(self):
        r = self.post({'name': 'cv.pdf', 'mime': 'application/pdf', 'data': b64(PNG)})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()['code'], 'BAD_RESUME')
        r = self.post({'name': 'cv.exe', 'mime': 'application/pdf', 'data': b64(b'MZ')})
        self.assertEqual(r.status_code, 400)

    def test_unreadable_pdf_says_so(self):
        from tests.test_careers import PDF
        r = self.post({'name': 'scan.pdf', 'mime': 'application/pdf', 'data': b64(PDF)})
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()['readable'])
        self.assertEqual(r.json()['fields'], {})

    def test_rate_limited(self):
        raw = _docx_with_text(['A B', 'a@b.co'])
        with mock.patch.object(C, 'PARSES_PER_HOUR', 2):
            codes = [self.post({'name': 'cv.docx', 'data': b64(raw)}).status_code for _ in range(3)]
        self.assertEqual(codes, [200, 200, 429])

    def test_disabled_careers(self):
        self.settings_set(enabled=False)
        raw = _docx_with_text(['A B'])
        self.assertNotEqual(self.post({'name': 'cv.docx', 'data': b64(raw)}).status_code, 200)

    @override_settings(CORS_ALLOW_ALL_ORIGINS=False)
    def test_widget_origin_rules_apply(self):
        self.settings_set(allowedOrigins=['https://eversoftit.com'])
        raw = _docx_with_text(['Asha Rao'])
        ok = self.post({'name': 'cv.docx', 'data': b64(raw)}, client=Client(HTTP_ORIGIN='https://eversoftit.com'))
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(ok['Access-Control-Allow-Origin'], 'https://eversoftit.com')
        bad = self.post({'name': 'cv.docx', 'data': b64(raw)}, client=Client(HTTP_ORIGIN='https://evil.example'))
        self.assertEqual(bad.status_code, 403)
