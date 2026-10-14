from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, Client

from api.models import AppUser, BenchSalesCertificate, BenchSalesProfile


class BenchSalesUploadApiTests(TestCase):
    """Profile text is saved as JSON, then each PDF goes to /upload as
    multipart — one file per request (a single JSON body carrying every PDF as
    base64 hit HTTP 413 on the live server)."""

    def setUp(self):
        AppUser.objects.create(
            email='admin@example.com', full_name='Admin User',
            password='password', role='admin',
        )
        self.client = Client(HTTP_X_USER_EMAIL='admin@example.com')
        response = self.client.post(
            '/api/recruit/bench-sales',
            data={'name': 'Jane Doe', 'techStack': 'Java', 'experience': '5',
                  'workAuthorization': 'TN Visa', 'email': 'jane@example.com',
                  'contactNo': '5550100'},
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 201)
        self.pk = response.json()['id']

    def upload(self, field, name='doc.pdf', content=b'%PDF-1.4 test', mime='application/pdf'):
        return self.client.post(
            f'/api/recruit/bench-sales/{self.pk}/upload',
            data={'field': field, 'file': SimpleUploadedFile(name, content, content_type=mime)},
        )

    def test_custom_work_authorization_is_saved(self):
        self.assertEqual(BenchSalesProfile.objects.get(pk=self.pk).work_authorization, 'TN Visa')

    def test_upload_single_documents_and_certificates(self):
        response = self.upload('resume', 'resume.pdf')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['resumeFileName'], 'resume.pdf')
        self.assertEqual(self.upload('i94', 'i94.pdf').status_code, 200)
        self.assertEqual(self.upload('certificate', 'a.pdf').status_code, 200)
        response = self.upload('certificate', 'b.pdf')
        self.assertEqual([c['fileName'] for c in response.json()['certificates']], ['a.pdf', 'b.pdf'])

        download = self.client.get(f'/api/recruit/bench-sales/{self.pk}/file/resume')
        self.assertEqual(download.status_code, 200)
        self.assertEqual(download.content, b'%PDF-1.4 test')

    def test_rejects_non_pdf_and_unknown_field(self):
        self.assertEqual(self.upload('resume', 'cv.docx', b'x', 'application/msword').status_code, 400)
        self.assertEqual(self.upload('photo').status_code, 400)

    def test_certificate_limit(self):
        profile = BenchSalesProfile.objects.get(pk=self.pk)
        BenchSalesCertificate.objects.bulk_create([
            BenchSalesCertificate(profile=profile, file_name=f'{i}.pdf') for i in range(10)
        ])
        self.assertEqual(self.upload('certificate').status_code, 400)
