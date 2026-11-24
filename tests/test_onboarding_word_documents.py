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


class WordPreviewTests(TestCase):
    """A Word document is turned into safe HTML so it can be shown in the app."""

    def setUp(self):
        AppUser.objects.create(email='hr.prev@example.com', full_name='HR', password='x', role='admin', status='active')
        self.hr = Client(HTTP_X_USER_EMAIL='hr.prev@example.com')
        self.cand = OnboardingCandidate.objects.create(
            first_name='Cand', last_name='Prev', email='cand.prev@example.com', portal_token='tok-prev')

    def docx(self, document_xml):
        import io, zipfile
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w') as z:
            z.writestr('word/document.xml',
                       '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                       '<w:body>' + document_xml + '</w:body></w:document>')
        return buf.getvalue()

    def store(self, raw, name='a.docx', mime=DOCX):
        return CandidateDocument.objects.create(
            candidate=self.cand, doc_type='ssn', file_name=name, file_mime=mime, file_size=len(raw),
            file_data=base64.b64encode(raw).decode())

    def preview(self, doc):
        return self.hr.get(f'/api/onboarding/candidates/{self.cand.id}/documents/{doc.id}/preview')

    def test_text_formatting_lists_and_tables_come_through(self):
        raw = self.docx(
            '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Offer Letter</w:t></w:r></w:p>'
            '<w:p><w:r><w:t>Plain line</w:t></w:r></w:p>'
            '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell A</w:t></w:r></w:p></w:tc>'
            '<w:tc><w:p><w:r><w:t>Cell B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>')
        r = self.preview(self.store(raw))
        self.assertEqual(r.status_code, 200, r.content)
        page = r.json()['html']
        for needle in ('<b>Offer Letter</b>', 'text-align:center', 'Plain line', '<table>', 'Cell A', 'Cell B'):
            self.assertIn(needle, page)

    def test_markup_in_the_file_is_escaped_never_run(self):
        raw = self.docx('<w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;</w:t></w:r></w:p>')
        page = self.preview(self.store(raw)).json()['html']
        self.assertNotIn('<script>', page)
        self.assertNotIn('<img src=x', page)
        self.assertIn('&lt;script&gt;', page)

    def test_a_file_with_entity_tricks_is_refused_not_expanded(self):
        raw = self.docx('<w:p/>').replace(b'<w:document', b'<!DOCTYPE x [<!ENTITY a "boom">]><w:document')
        self.assertEqual(self.preview(self.store(raw)).status_code, 422)

    def test_damaged_and_fake_files_give_a_clear_message_not_a_server_error(self):
        for raw, name, mime in ((b'PK\x03\x04 not really a zip', 'a.docx', DOCX),
                                (b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1' + b'\x00' * 600, 'a.doc', DOC),
                                (b'just text', 'b.doc', DOC)):
            r = self.preview(self.store(raw, name, mime))
            self.assertEqual(r.status_code, 422, (name, r.content))
            self.assertTrue(r.json()['message'])

    def test_only_word_documents_have_a_preview(self):
        pdf = self.store(b'%PDF-1.4 x', 'a.pdf', 'application/pdf')
        self.assertEqual(self.preview(pdf).status_code, 400)
        self.assertEqual(self.hr.get(f'/api/onboarding/candidates/{self.cand.id}/documents/99999/preview').status_code, 404)


class OldDocFormatReaderTests(TestCase):
    """The pieces the .doc (Word 97-2003) reader is built from."""

    def test_property_lists_are_split_by_operand_size(self):
        from api import word_preview as wp
        import struct
        grp = (struct.pack('<HB', 0x0835, 1)                    # bold on (1-byte operand)
               + struct.pack('<HH', 0x4A43, 44)                 # size 22pt (2-byte operand)
               + struct.pack('<H', 0x6870) + bytes([255, 0, 0, 0]))   # colour red (4-byte operand)
        props = wp._apply_char({}, grp)
        self.assertEqual((props['b'], props['size'], props['color']), (True, 22.0, '#ff0000'))

    def test_bold_toggle_values_follow_the_style(self):
        from api import word_preview as wp
        import struct
        on, flip, keep = (struct.pack('<HB', 0x0835, v) for v in (1, 0x81, 0x80))
        self.assertFalse(wp._apply_char({'b': True}, flip)['b'])     # 0x81: the opposite of the style
        self.assertTrue(wp._apply_char({'b': True}, keep)['b'])      # 0x80: same as the style
        self.assertTrue(wp._apply_char({}, on)['b'])

    def test_paragraph_alignment_and_indent(self):
        from api import word_preview as wp
        import struct
        grp = struct.pack('<HB', 0x2461, 1) + struct.pack('<Hh', 0x845E, 720)
        props = wp._apply_para({}, grp)
        self.assertEqual((props['jc'], props['left']), ('center', 720))

    def test_an_embedded_png_is_found_inside_the_picture_record(self):
        from api import word_preview as wp
        import struct
        png = b'\x89PNG\r\n\x1a\n' + b'x' * 40
        blip = struct.pack('<HHI', 0x6E0 << 4, 0xF01E, 17 + len(png)) + b'u' * 16 + b'\xff' + png
        fbse = struct.pack('<HHI', 0x62 << 4, 0xF007, 36 + len(blip)) + b'\x06\x06' + b'u' * 16 + b'\x00' * 2 + \
            struct.pack('<IIIBBBB', len(blip), 1, 0, 0, 0, 0, 0) + blip
        doc = wp._Doc.__new__(wp._Doc)
        mime, raw = doc._find_blip(fbse, 0, len(fbse), 0)
        self.assertEqual((mime, raw), ('image/png', png))

    def test_a_record_that_is_not_a_picture_shows_nothing(self):
        from api import word_preview as wp
        doc = wp._Doc.__new__(wp._Doc)
        doc.data = b'\x00' * 400
        self.assertEqual(doc.picture(0), '')
