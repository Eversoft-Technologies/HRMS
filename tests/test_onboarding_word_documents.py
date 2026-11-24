"""A candidate's own documents (the Work Authorization panel and the candidate
portal) accept Word files as well as PDF/PNG/JPG. Form and payroll templates
keep their original PDF/image-only rule."""
import base64

from django.test import Client, TestCase

from api import onboarding_views as ov
from api.models import AppUser, CandidateDocument, OnboardingCandidate

DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
DOC = 'application/msword'
# a .docx is a zip, a .doc an OLE file: the first bytes are enough for a stand-in
DOCX_DATA = base64.b64encode(b'PK\x03\x04 fake docx').decode()
DOC_DATA = base64.b64encode(b'\xd0\xcf\x11\xe0 fake doc').decode()


class WordDocumentUploadTests(TestCase):
    def setUp(self):
        AppUser.objects.create(email='hr.word@example.com', full_name='HR', password='x', role='admin', status='active')
        self.hr = Client(HTTP_X_USER_EMAIL='hr.word@example.com')
        self.cand = OnboardingCandidate.objects.create(
            first_name='Cand', last_name='Word', email='cand.word@example.com', portal_token='tok-word',
            requested_docs=[{'type': 'ssn', 'label': 'SSN', 'required': True, 'sendToCandidate': True}])

    def upload(self, name, mime, data, doc_type='ssn'):
        return self.hr.post(f'/api/onboarding/candidates/{self.cand.id}/documents',
                            {'docType': doc_type, 'fileName': name, 'fileMime': mime, 'fileData': data},
                            content_type='application/json')

    def test_hr_can_upload_a_docx(self):
        r = self.upload('ssn.docx', DOCX, DOCX_DATA)
        self.assertEqual(r.status_code, 201, r.content)
        doc = CandidateDocument.objects.get(candidate=self.cand, doc_type='ssn', is_active=True)
        self.assertEqual((doc.file_name, doc.file_mime), ('ssn.docx', DOCX))

    def test_hr_can_upload_a_doc(self):
        r = self.upload('ssn.doc', DOC, DOC_DATA)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(CandidateDocument.objects.get(candidate=self.cand, is_active=True).file_mime, DOC)

    def test_the_candidate_portal_accepts_word_too(self):
        r = Client().post('/api/public/onboarding/upload-document',
                          {'token': 'tok-word', 'docType': 'ssn', 'fileName': 'ssn.docx', 'fileMime': DOCX,
                           'fileData': DOCX_DATA}, content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)

    def test_pdf_and_images_still_work(self):
        pdf = base64.b64encode(b'%PDF-1.4 fake').decode()
        self.assertEqual(self.upload('a.pdf', 'application/pdf', pdf).status_code, 201)
        self.assertEqual(self.upload('a.png', 'image/png', pdf).status_code, 201)
        self.assertEqual(self.upload('a.jpg', 'image/jpeg', pdf).status_code, 201)

    def test_other_types_are_refused_with_a_message_that_names_word(self):
        for mime in ('application/zip', 'text/plain', 'application/vnd.ms-excel', 'application/octet-stream', ''):
            r = self.upload('x.bin', mime, DOCX_DATA)
            self.assertEqual(r.status_code, 400, mime)
            self.assertIn('Word', r.json()['message'])

    def test_the_size_limit_and_base64_checks_still_apply_to_word(self):
        big = base64.b64encode(b'PK' + b'0' * (ov.MAX_DOC_BYTES + 1)).decode()
        self.assertEqual(self.upload('big.docx', DOCX, big).status_code, 400)
        self.assertEqual(self.upload('bad.docx', DOCX, '***not base64***').status_code, 400)


class DecodeDocumentRulesTests(TestCase):
    def test_templates_and_forms_still_refuse_word(self):
        size, cleaned, error = ov.decode_document(DOCX_DATA, DOCX)             # the default rule
        self.assertEqual((size, cleaned), (0, ''))
        self.assertIn('PDF, PNG and JPG', error)

    def test_candidate_documents_accept_word(self):
        size, cleaned, error = ov.decode_document(DOCX_DATA, DOCX, allowed=ov.CANDIDATE_DOC_MIMES)
        self.assertEqual(error, '')
        self.assertGreater(size, 0)


class WordWorksForEveryDocumentTypeTests(TestCase):
    """Word is not tied to one slot: every built-in type, every I-9 / E-Verify
    type, requested custom slots and HR's own custom names all take it."""

    def setUp(self):
        AppUser.objects.create(email='hr.all@example.com', full_name='HR', password='x', role='admin', status='active')
        self.hr = Client(HTTP_X_USER_EMAIL='hr.all@example.com')
        self.cand = OnboardingCandidate.objects.create(
            first_name='Cand', last_name='All', email='cand.all@example.com', portal_token='tok-all',
            requested_docs=[{'type': 'custom_nda_agreement', 'label': 'NDA Agreement', 'required': False,
                             'sendToCandidate': True}])

    def upload(self, mime=DOCX, data=DOCX_DATA, **body):
        body.update({'fileName': 'doc.docx', 'fileMime': mime, 'fileData': data})
        return self.hr.post(f'/api/onboarding/candidates/{self.cand.id}/documents', body,
                            content_type='application/json')

    def test_every_built_in_and_i9_type_accepts_word(self):
        keys = list(ov.DOC_TYPES) + list(ov.I9_DOC_TYPES)
        self.assertGreaterEqual(len(keys), 25)
        for key in keys:
            r = self.upload(docType=key)
            self.assertEqual(r.status_code, 201, (key, r.content))
            self.assertEqual(CandidateDocument.objects.get(candidate=self.cand, doc_type=key,
                                                           is_active=True).file_mime, DOCX, key)

    def test_a_requested_custom_slot_and_a_custom_name_accept_word(self):
        self.assertEqual(self.upload(docType='custom_nda_agreement').status_code, 201)
        r = self.upload(docType='__custom__', isCustom=True, label='Degree Certificate')
        self.assertEqual(r.status_code, 201, r.content)

    def test_word_can_replace_a_pdf_and_the_old_version_is_kept(self):
        pdf = base64.b64encode(b'%PDF-1.4 fake').decode()
        self.assertEqual(self.upload(mime='application/pdf', data=pdf, docType='visa').status_code, 201)
        self.assertEqual(self.upload(docType='visa').status_code, 201)                # Replace with a Word file
        versions = list(CandidateDocument.objects.filter(candidate=self.cand, doc_type='visa')
                        .order_by('version').values_list('version', 'file_mime', 'is_active'))
        self.assertEqual(versions, [(1, 'application/pdf', False), (2, DOCX, True)])
