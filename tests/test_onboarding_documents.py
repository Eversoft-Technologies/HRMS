"""Onboarding document uploads: I-9 / E-Verify types, requested custom slots,
the candidate portal's "requested only" rule, and one slug rule everywhere."""
import base64

from django.test import Client, TestCase

from api import onboarding_views as ov
from api.models import AppUser, CandidateDocument, OnboardingCandidate

PDF = base64.b64encode(b'%PDF-1.4 fake').decode()


class OnboardingDocumentTests(TestCase):
    def setUp(self):
        AppUser.objects.create(email='hr.docs@example.com', full_name='HR', password='x', role='admin', status='active')
        self.hr = Client(HTTP_X_USER_EMAIL='hr.docs@example.com')
        self.cand = OnboardingCandidate.objects.create(
            first_name='Cand', last_name='One', email='cand.docs@example.com', portal_token='tok-docs',
            requested_docs=[
                {'type': 'ssn', 'label': 'SSN', 'required': True, 'sendToCandidate': True},
                {'type': 'permanent_resident_card', 'label': 'Green Card', 'required': True, 'sendToCandidate': True},
                {'type': 'custom_nda_agreement', 'label': 'NDA Agreement', 'required': False, 'sendToCandidate': True},
            ])

    def upload(self, **body):
        body.setdefault('fileName', 'f.pdf')
        body.setdefault('fileMime', 'application/pdf')
        body.setdefault('fileData', PDF)
        return self.hr.post(f'/api/onboarding/candidates/{self.cand.id}/documents', body, content_type='application/json')

    def portal(self, **body):
        body.update({'token': 'tok-docs', 'fileName': 'f.pdf', 'fileMime': 'application/pdf', 'fileData': PDF})
        return Client().post('/api/public/onboarding/upload-document', body, content_type='application/json')

    def test_hr_uploads_every_i9_type(self):
        for key, (label, _group) in ov.I9_DOC_TYPES.items():
            r = self.upload(docType=key)
            self.assertEqual(r.status_code, 201, (key, r.content))
            doc = CandidateDocument.objects.get(candidate=self.cand, doc_type=key, is_active=True)
            # a slot HR requested keeps HR's own name for it ("Green Card")
            self.assertEqual(doc.label, 'Green Card' if key == 'permanent_resident_card' else label)
            self.assertTrue(doc.is_custom)             # verified through custom_verified

    def test_hr_uploads_a_requested_custom_slot_picked_from_the_dropdown(self):
        # the bug: the dropdown sends the slot's type with isCustom false
        r = self.upload(docType='custom_nda_agreement', isCustom=False)
        self.assertEqual(r.status_code, 201, r.content)
        doc = CandidateDocument.objects.get(candidate=self.cand, doc_type='custom_nda_agreement')
        self.assertEqual((doc.label, doc.is_custom), ('NDA Agreement', True))

    def test_reupload_versions_the_same_slot(self):
        self.upload(docType='ead')
        self.upload(docType='ead')
        self.assertEqual(list(CandidateDocument.objects.filter(candidate=self.cand, doc_type='ead')
                              .order_by('version').values_list('version', 'is_active')), [(1, False), (2, True)])
        r = self.hr.get(f'/api/onboarding/candidates/{self.cand.id}/document-versions/ead')
        self.assertEqual(len(r.json()), 2)

    def test_hr_custom_named_document_still_works(self):
        r = self.upload(docType='__custom__', isCustom=True, label='Degree Certificate (B.Tech)')
        self.assertEqual(r.status_code, 201, r.content)
        self.assertTrue(CandidateDocument.objects.filter(doc_type='custom_degree_certificate_b_tech').exists())

    def test_custom_name_cannot_hijack_a_built_in_type(self):
        r = self.upload(docType='__custom__', isCustom=True, label='EAD')
        self.assertEqual(r.status_code, 400)

    def test_unknown_type_gets_a_clear_message(self):
        r = self.upload(docType='made_up_thing')
        self.assertEqual(r.status_code, 400)
        self.assertIn('Unknown document type', r.json()['message'])
        self.assertEqual(self.upload(docType='bad type!').status_code, 400)

    def test_portal_accepts_requested_i9_and_custom_slots(self):
        self.assertEqual(self.portal(docType='permanent_resident_card').status_code, 200)
        self.assertEqual(self.portal(docType='custom_nda_agreement', isCustom=True, label='NDA Agreement').status_code, 200)
        self.assertTrue(CandidateDocument.objects.filter(candidate=self.cand, doc_type='custom_nda_agreement').exists())

    def test_portal_rejects_what_was_not_requested(self):
        r = self.portal(docType='ead')
        self.assertEqual(r.status_code, 400)
        self.assertIn('not requested', r.json()['message'])

    def test_file_checks_still_apply(self):
        r = self.upload(docType='ead', fileMime='application/zip')
        self.assertEqual(r.status_code, 400)

    def test_slug_rule(self):
        self.assertEqual(ov.custom_doc_slug('  NDA -- Agreement!! ')[0], 'custom_nda_agreement')
        self.assertEqual(len(ov.custom_doc_slug('x' * 100)[0]), 40)
        self.assertEqual(ov.custom_doc_slug('***')[0], '')
