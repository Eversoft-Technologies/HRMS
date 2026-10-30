"""Employee profile endpoints behind HR > HRIS > /hr/hris/<key>.

GET  /api/employees/<key>/profile   aggregate read (key = AppUser id or email)
GET  /api/employees/<key>           plain UserProfile read
PATCH /api/employees/<key>          partial update, split into personal (self
                                    or employee.edit) and employment
                                    (employee.edit only) fields
"""
from datetime import date, timedelta
from decimal import Decimal

from django.test import Client, TestCase

from api.models import (
    AppUser,
    EmployeeAttendance,
    EmployeeCompensation,
    EmployeeTask,
    ItAssetAllocation,
    LeaveRequest,
    OnboardingCandidate,
    OnboardingStatus,
    Payslip,
    PayrollRun,
    Permission,
    Role,
    RolePermission,
    UserProfile,
)
from api.timeutil import local_today


def grant(role, *codes):
    for code in codes:
        perm, _ = Permission.objects.get_or_create(code=code, defaults={'name': code})
        RolePermission.objects.get_or_create(role=role, permission=perm)


class EmployeeProfileApiTests(TestCase):
    def setUp(self):
        AppUser.objects.create(email='admin@example.com', full_name='Admin User', password='x', role='admin')

        self.hr_role = Role.objects.create(name='HR Manager')
        grant(self.hr_role, 'employee.view', 'employee.edit', 'attendance.view', 'leave.view')
        AppUser.objects.create(email='hr@example.com', full_name='HR Person', password='x',
                               role='hr', role_ref=self.hr_role)

        self.emp_role = Role.objects.create(name='Employee')
        self.priya = AppUser.objects.create(
            email='priya@company.com', full_name='Priya Sharma', password='x',
            role='employee', role_ref=self.emp_role, employee_id='EV-0007', initials='PS',
        )
        UserProfile.objects.create(
            email='priya@company.com', first_name='Priya', last_name='Sharma',
            department='Engineering', designation='Software Engineer', manager='Ankit R',
            level='L4', location='Bengaluru', annual_ctc=Decimal('2800000'),
            start_date=date(2026, 1, 5), phone='+91 90000 00000',
        )
        self.ankit = AppUser.objects.create(
            email='ankit@company.com', full_name='Ankit R', password='x',
            role='employee', role_ref=self.emp_role,
        )
        UserProfile.objects.create(email='ankit@company.com', first_name='Ankit', last_name='R',
                                   designation='Engineering Manager', department='Engineering')
        AppUser.objects.create(email='other@company.com', full_name='Other One', password='x',
                               role='employee', role_ref=self.emp_role)

        self.admin = Client(HTTP_X_USER_EMAIL='admin@example.com')
        self.hr = Client(HTTP_X_USER_EMAIL='hr@example.com')
        self.priya_client = Client(HTTP_X_USER_EMAIL='priya@company.com')
        self.other = Client(HTTP_X_USER_EMAIL='other@company.com')

    # --- resolution -------------------------------------------------------

    def test_resolves_by_id_and_by_email_to_the_same_person(self):
        by_id = self.admin.get(f'/api/employees/{self.priya.id}/profile')
        by_email = self.admin.get('/api/employees/priya@company.com/profile')
        self.assertEqual(by_id.status_code, 200)
        self.assertEqual(by_email.status_code, 200)

        a, b = by_id.json(), by_email.json()
        self.assertEqual(a['email'], 'priya@company.com')
        self.assertEqual(a['email'], b['email'])
        self.assertEqual(a['key'], str(self.priya.id))
        self.assertEqual(b['key'], str(self.priya.id))
        self.assertEqual(a['person']['name'], 'Priya Sharma')
        self.assertEqual(a['person']['firstName'], 'Priya')
        self.assertEqual(a['person']['lastName'], 'Sharma')
        self.assertEqual(a['person']['employeeId'], 'EV-0007')
        self.assertEqual(a['person']['role'], 'Employee')
        self.assertEqual(a['person']['accountStatus'], 'active')
        self.assertEqual(a['employment']['department'], 'Engineering')
        self.assertEqual(a['employment']['startDate'], '2026-01-05')

    def test_email_lookup_is_case_insensitive(self):
        r = self.admin.get('/api/employees/PRIYA@Company.com/profile')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()['email'], 'priya@company.com')

    def test_profile_only_employee_resolves_by_email(self):
        # Added from the HRIS list: a UserProfile with no login account.
        UserProfile.objects.create(email='noacct@company.com', first_name='No', last_name='Account',
                                   department='Sales')
        r = self.admin.get('/api/employees/noacct@company.com/profile')
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body['key'], 'noacct@company.com')
        self.assertEqual(body['person']['accountStatus'], 'none')
        self.assertEqual(body['person']['name'], 'No Account')
        self.assertIsNone(body['account'])

    def test_unknown_key_is_404(self):
        self.assertEqual(self.admin.get('/api/employees/999999/profile').status_code, 404)
        self.assertEqual(self.admin.get('/api/employees/nobody@company.com/profile').status_code, 404)
        self.assertEqual(self.admin.patch('/api/employees/999999', data={'phone': '1'},
                                          content_type='application/json').status_code, 404)

    # --- access -----------------------------------------------------------

    def test_unidentified_caller_is_401(self):
        r = Client().get(f'/api/employees/{self.priya.id}/profile')
        self.assertEqual(r.status_code, 401)

    def test_employee_can_read_own_profile_but_not_a_colleague(self):
        own = self.priya_client.get(f'/api/employees/{self.priya.id}/profile')
        self.assertEqual(own.status_code, 200)
        self.assertTrue(own.json()['isSelf'])
        # Self-service: your own payroll and documents are visible even without
        # the module permissions, but editing employment details is not.
        self.assertFalse(own.json()['sections']['payroll'])        # My Profile shows no pay
        self.assertTrue(own.json()['sections']['documents'])
        self.assertTrue(own.json()['sections']['canEditPersonal'])
        self.assertFalse(own.json()['sections']['canEditEmployment'])

        colleague = self.priya_client.get(f'/api/employees/{self.ankit.id}/profile')
        self.assertEqual(colleague.status_code, 403)

    def test_payroll_section_hidden_without_permission(self):
        hr = self.hr.get(f'/api/employees/{self.priya.id}/profile').json()
        self.assertFalse(hr['sections']['payroll'])
        self.assertNotIn('annualCtc', hr['employment'])
        self.assertIsNone(hr['stats']['lastPayslip'])
        self.assertTrue(hr['sections']['attendance'])
        self.assertTrue(hr['sections']['canEditEmployment'])
        self.assertFalse(hr['sections']['account'])   # needs settings.view

        admin = self.admin.get(f'/api/employees/{self.priya.id}/profile').json()
        self.assertTrue(admin['sections']['payroll'])
        self.assertEqual(admin['employment']['annualCtc'], '2800000.00')
        self.assertEqual(admin['account']['role'], 'Employee')

    # --- aggregate content ------------------------------------------------

    def test_stats_today_and_last_payslip(self):
        today = local_today()
        EmployeeAttendance.objects.create(email='priya@company.com', date=today, status='present')
        EmployeeAttendance.objects.create(email='priya@company.com', date=today - timedelta(days=1), status='late')
        EmployeeAttendance.objects.create(email='priya@company.com', date=today - timedelta(days=2), status='absent')
        # Outside the 30-day window: must not count.
        EmployeeAttendance.objects.create(email='priya@company.com', date=today - timedelta(days=40), status='absent')

        EmployeeTask.objects.create(title='A', assignee_email='priya@company.com', stage='todo')
        EmployeeTask.objects.create(title='B', assignee_email='priya@company.com', stage='inprogress')
        EmployeeTask.objects.create(title='C', assignee_email='priya@company.com', stage='done')
        EmployeeTask.objects.create(title='D', assignee_email='ankit@company.com', stage='todo')

        LeaveRequest.objects.create(email='priya@company.com', from_date=today, to_date=today, status='Pending')
        LeaveRequest.objects.create(email='priya@company.com', from_date=today, to_date=today, status='Approved')

        run = PayrollRun.objects.create(period_label='2026-10', period_start=date(2026, 10, 1),
                                        period_end=date(2026, 10, 31))
        Payslip.objects.create(run=run, email='priya@company.com', net_pay=Decimal('185000.50'))

        body = self.admin.get(f'/api/employees/{self.priya.id}/profile').json()
        self.assertEqual(body['stats']['attendancePct'], 67)   # (1 present + 1 late) / 3
        self.assertEqual(body['stats']['openTasks'], 2)
        self.assertEqual(body['stats']['pendingLeave'], 1)
        self.assertEqual(body['stats']['lastPayslip']['period'], '2026-10')
        self.assertEqual(body['stats']['lastPayslip']['netPay'], 185000.5)
        self.assertEqual(body['today']['status'], 'present')

    def test_no_attendance_rows_gives_null_percentage(self):
        body = self.admin.get(f'/api/employees/{self.priya.id}/profile').json()
        self.assertIsNone(body['stats']['attendancePct'])
        self.assertIsNone(body['today'])

    def test_onboarding_summary_and_org_links(self):
        cand = OnboardingCandidate.objects.create(
            email='priya@company.com', first_name='Priya', last_name='Sharma',
            status='Onboarded', candidate_code='OB-0001',
        )
        OnboardingStatus.objects.create(candidate=cand, stage='documents', status='Completed')
        OnboardingStatus.objects.create(candidate=cand, stage='payroll', status='Pending')
        ItAssetAllocation.objects.create(candidate=cand, assets=['Laptop', 'Monitor'], asset_id='LT-0042')

        body = self.admin.get(f'/api/employees/{self.priya.id}/profile').json()
        ob = body['onboarding']
        self.assertEqual(ob['candidateId'], cand.id)
        self.assertEqual(ob['completed'], 1)
        self.assertEqual(ob['total'], 8)
        self.assertEqual(ob['assets'][0]['assetId'], 'LT-0042')
        self.assertEqual(ob['assets'][0]['assets'], ['Laptop', 'Monitor'])

        # Manager is a free-text name, resolved to the matching person.
        self.assertEqual(body['org']['manager']['email'], 'ankit@company.com')
        self.assertEqual(body['org']['manager']['key'], str(self.ankit.id))
        self.assertEqual(body['org']['reports'], [])

        ankit = self.admin.get(f'/api/employees/{self.ankit.id}/profile').json()
        self.assertEqual([r['email'] for r in ankit['org']['reports']], ['priya@company.com'])
        self.assertIsNone(ankit['org']['manager'])

    def test_unmatched_manager_name_is_kept_without_a_link(self):
        UserProfile.objects.filter(email='priya@company.com').update(manager='Someone Gone')
        body = self.admin.get(f'/api/employees/{self.priya.id}/profile').json()
        self.assertEqual(body['org']['manager']['name'], 'Someone Gone')
        self.assertEqual(body['org']['manager']['key'], '')

    # --- PATCH ------------------------------------------------------------

    def test_patch_employment_fields_need_employee_edit(self):
        own = self.priya_client.patch(f'/api/employees/{self.priya.id}', data={'department': 'Sales'},
                                      content_type='application/json')
        self.assertEqual(own.status_code, 403)
        self.assertEqual(UserProfile.objects.get(email='priya@company.com').department, 'Engineering')

        own_personal = self.priya_client.patch(f'/api/employees/{self.priya.id}', data={'phone': '+91 1'},
                                               content_type='application/json')
        self.assertEqual(own_personal.status_code, 200)
        self.assertEqual(UserProfile.objects.get(email='priya@company.com').phone, '+91 1')

        stranger = self.other.patch(f'/api/employees/{self.priya.id}', data={'phone': '+91 2'},
                                    content_type='application/json')
        self.assertEqual(stranger.status_code, 403)

        hr = self.hr.patch(f'/api/employees/{self.priya.id}', data={'department': 'Sales', 'level': 'L5'},
                           content_type='application/json')
        self.assertEqual(hr.status_code, 200)
        profile = UserProfile.objects.get(email='priya@company.com')
        self.assertEqual(profile.department, 'Sales')
        self.assertEqual(profile.level, 'L5')
        # Untouched fields survive a partial update (unlike the Settings PUT).
        self.assertEqual(profile.designation, 'Software Engineer')
        self.assertEqual(profile.manager, 'Ankit R')

    def test_patch_rejects_empty_body(self):
        r = self.hr.patch(f'/api/employees/{self.priya.id}', data={'unknown': 1},
                          content_type='application/json')
        self.assertEqual(r.status_code, 400)

    def test_patch_ctc_resyncs_compensation_without_wiping_statutory_fields(self):
        EmployeeCompensation.objects.create(
            email='priya@company.com', annual_ctc=Decimal('2800000'), base_amount=Decimal('116666.67'),
            pan_number='ABCDE1234F', uan_number='100200300400', bank_name='HDFC Bank',
            bank_account_number='1234567890', effective_from=date(2026, 1, 5),
        )
        r = self.hr.patch(f'/api/employees/{self.priya.id}', data={'annualCtc': '3000000'},
                          content_type='application/json')
        self.assertEqual(r.status_code, 200)
        comp = EmployeeCompensation.objects.get(email='priya@company.com')
        self.assertEqual(comp.annual_ctc, Decimal('3000000.00'))
        self.assertEqual(comp.pan_number, 'ABCDE1234F')
        self.assertEqual(comp.uan_number, '100200300400')
        self.assertEqual(comp.bank_name, 'HDFC Bank')
        self.assertEqual(comp.bank_account_number, '1234567890')

    def test_patch_keeps_login_account_name_and_employee_id_in_step(self):
        r = self.hr.patch(f'/api/employees/{self.priya.id}',
                          data={'firstName': 'Priyanka', 'employeeId': 'EV-0100'},
                          content_type='application/json')
        self.assertEqual(r.status_code, 200)
        self.priya.refresh_from_db()
        self.assertEqual(self.priya.full_name, 'Priyanka Sharma')
        self.assertEqual(self.priya.employee_id, 'EV-0100')

    def test_patch_creates_profile_for_account_without_one(self):
        # other@company.com has a login but no HRIS row yet.
        other = AppUser.objects.get(email='other@company.com')
        r = self.hr.patch(f'/api/employees/{other.id}', data={'department': 'Support'},
                          content_type='application/json')
        self.assertEqual(r.status_code, 200)
        profile = UserProfile.objects.get(email='other@company.com')
        self.assertEqual(profile.department, 'Support')
        self.assertEqual(profile.first_name, 'Other')
        self.assertEqual(profile.last_name, 'One')

    def test_plain_get_returns_profile_record(self):
        r = self.admin.get(f'/api/employees/{self.priya.id}')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()['designation'], 'Software Engineer')


class CompensationHistoryTests(EmployeeProfileApiTests):
    def test_ctc_change_with_several_compensation_rows_updates_the_latest(self):
        EmployeeCompensation.objects.create(email='priya@company.com', annual_ctc=Decimal('2000000'),
                                            base_amount=Decimal('1'), pan_number='OLDPAN',
                                            effective_from=date(2025, 1, 1))
        latest = EmployeeCompensation.objects.create(email='priya@company.com', annual_ctc=Decimal('2800000'),
                                                     base_amount=Decimal('1'), pan_number='NEWPAN',
                                                     effective_from=date(2026, 1, 5))
        r = self.hr.patch(f'/api/employees/{self.priya.id}', data={'annualCtc': '3000000'},
                          content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        latest.refresh_from_db()
        self.assertEqual(latest.annual_ctc, Decimal('3000000.00'))
        self.assertEqual(latest.pan_number, 'NEWPAN')
        self.assertEqual(EmployeeCompensation.objects.filter(email='priya@company.com').count(), 2)


class MyProfileAccessTests(EmployeeProfileApiTests):
    def test_own_profile_lists_role_permissions_and_what_can_be_edited(self):
        from api.models import Module, PermissionGroup
        mod = Module.objects.create(name='Leave')
        grp = PermissionGroup.objects.create(name='Leave Group', module=mod)
        Permission.objects.filter(code='employee.view').update(group=grp)
        grant(self.emp_role, 'employee.view')
        acc = self.priya_client.get(f'/api/employees/{self.priya.id}/profile').json()['access']
        self.assertEqual(acc['role'], 'Employee')
        self.assertFalse(acc['superAdmin'])
        self.assertIn('Leave', [m['module'] for m in acc['modules']])
        edits = {e['item']: e['allowed'] for e in acc['canEdit']}
        self.assertTrue(edits['Profile photo'])
        self.assertFalse(edits['Department, designation, level, location, start date'])
        self.assertFalse(edits['Role and permissions'])

    def test_colleagues_do_not_see_access_but_admins_do(self):
        self.assertIsNone(self.hr.get(f'/api/employees/{self.priya.id}/profile').json()['access'])
        acc = self.admin.get(f'/api/employees/{self.priya.id}/profile').json()['access']
        self.assertEqual(acc['role'], 'Employee')
        admin_own = self.admin.get('/api/employees/admin@example.com/profile')
        self.assertTrue(admin_own.json()['access']['superAdmin'])

    def test_employee_can_change_own_photo_but_not_a_colleagues(self):
        pic = 'data:image/png;base64,iVBORw0KGgo='
        r = self.priya_client.patch(f'/api/employees/{self.priya.id}', data={'profilePic': pic},
                                    content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        self.priya.refresh_from_db()
        self.assertEqual(self.priya.profile_pic, pic)
        r = self.priya_client.patch(f'/api/employees/{self.ankit.id}', data={'profilePic': pic},
                                    content_type='application/json')
        self.assertEqual(r.status_code, 403)


class MyProfileScopeTests(EmployeeProfileApiTests):
    """On your own profile: personal details only, and no pay information."""

    def _payslip(self, email):
        run = PayrollRun.objects.create(period_label='2026-10', period_start=date(2026, 10, 1),
                                        period_end=date(2026, 10, 31))
        Payslip.objects.create(run=run, email=email, net_pay=Decimal('99000'))

    def test_own_profile_shows_no_pay_but_payroll_hr_sees_a_colleagues(self):
        self._payslip('priya@company.com')
        own = self.priya_client.get(f'/api/employees/{self.priya.id}/profile').json()
        self.assertNotIn('annualCtc', own['employment'])
        self.assertIsNone(own['stats']['lastPayslip'])
        self.assertFalse(own['sections']['payroll'])
        admin = self.admin.get(f'/api/employees/{self.priya.id}/profile').json()   # super admin, colleague
        self.assertTrue(admin['sections']['payroll'])
        self.assertEqual(admin['stats']['lastPayslip']['netPay'], 99000.0)

    def test_hr_on_their_own_profile_edits_personal_details_only(self):
        AppUser.objects.filter(email='hr@example.com').update(employee_id='EV-0500')
        UserProfile.objects.create(email='hr@example.com', first_name='HR', department='People')
        prof = self.hr.get('/api/employees/hr@example.com/profile').json()
        self.assertFalse(prof['sections']['canEditEmployment'])
        self.assertTrue(prof['sections']['canEditPersonal'])
        for body in ({'department': 'Finance'}, {'managerEmail': 'ankit@company.com'}, {'annualCtc': '1'},
                     {'phone': '1', 'level': 'L9'}):
            r = self.hr.patch('/api/employees/hr@example.com', data=body, content_type='application/json')
            self.assertEqual(r.status_code, 403, body)
        self.assertEqual(UserProfile.objects.get(email='hr@example.com').department, 'People')
        r = self.hr.patch('/api/employees/hr@example.com', data={'phone': '+91 99'}, content_type='application/json')
        self.assertEqual(r.status_code, 200)
        # HR still edits a colleague's employment details.
        r = self.hr.patch(f'/api/employees/{self.priya.id}', data={'department': 'Sales'}, content_type='application/json')
        self.assertEqual(r.status_code, 200)

    def test_access_tab_says_employment_is_changed_by_hr(self):
        acc = self.priya_client.get(f'/api/employees/{self.priya.id}/profile').json()['access']
        rows = {e['item']: e for e in acc['canEdit']}
        self.assertFalse(rows['Manager']['allowed'])
        self.assertEqual(rows['Manager']['how'], 'Changed by HR from your HRIS record')
        self.assertIn('Payroll', rows['Annual CTC']['how'])
        self.assertTrue(rows['Profile photo']['allowed'])
