"""IT asset life-cycle (hrms_plus/assets*.py): register validation, status
transitions, single holder vs licence seats, acknowledgement + reminders,
onboarding allocation -> assignment, separation -> IT clearance items ->
return clears / lost sets the recovery used by the F&F computation, expiry
alerts, CSV formula-injection escaping, permissions."""
from datetime import date, timedelta
from decimal import Decimal
from unittest import mock

from django.core.management import call_command
from django.test import TestCase

from api.models import (AppUser, ClearanceItem, ItAssetAllocation, Notification, OnboardingCandidate, Permission,
                        PayrollRun, Role, RolePermission, Separation, Ticket)
from hrms_plus import assets as svc
from hrms_plus import assets_links as links
from hrms_plus.models import Asset, AssetAssignment, AssetEvent
from tests.test_payroll_ess import EssBase, client, make_payslip

J = 'application/json'


def perm(code):
    return Permission.objects.get_or_create(code=code, defaults={'name': code})[0]


class AssetBase(EssBase):
    IT, VIEWER, ONB = 'it@co.com', 'viewer@co.com', 'onb@co.com'

    def setUp(self):
        super().setUp()
        it = Role.objects.create(name='IT Admin')
        for c in ('assets.view', 'assets.manage'):
            RolePermission.objects.create(role=it, permission=perm(c))
        viewer = Role.objects.create(name='Asset Viewer')
        RolePermission.objects.create(role=viewer, permission=perm('assets.view'))
        onb = Role.objects.create(name='Onboarding')
        for c in ('onboarding.view', 'onboarding.assets'):
            RolePermission.objects.create(role=onb, permission=perm(c))
        for e, n, r in ((self.IT, 'Ira Tech', it), (self.VIEWER, 'Vic View', viewer), (self.ONB, 'Olga Onb', onb)):
            AppUser.objects.create(email=e, full_name=n, password='x', role='employee', role_ref=r)
        self.it = client(self.IT)
        svc._LAZY['day'] = svc.today()          # page-load trigger off; tests call run_alerts directly

    def new_asset(self, tag='EV-LAP-0042', **kw):
        body = {'assetTag': tag, 'category': 'laptop', 'name': 'MacBook Pro 14', 'serialNumber': 'C02XYZ',
                'purchaseCost': '150000', 'purchaseDate': '2025-01-10'}
        body.update(kw)
        r = self.it.post('/api/assets', body, content_type=J)
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def assign(self, aid, email=None, who=None):
        return (who or self.it).post(f'/api/assets/{aid}/assign', {'email': email or self.EMP}, content_type=J)


class RegisterTests(AssetBase):
    def test_create_validation_and_serial_warning(self):
        a = self.new_asset()
        self.assertEqual(a['status'], 'in_stock')
        self.assertEqual(a['events'][0]['kind'], 'created')
        dup = self.it.post('/api/assets', {'assetTag': 'ev-lap-0042', 'category': 'laptop'}, content_type=J)
        self.assertEqual(dup.status_code, 409)
        future = (date.today() + timedelta(days=5)).isoformat()
        self.assertEqual(self.it.post('/api/assets', {'assetTag': 'X1', 'purchaseDate': future}, content_type=J).status_code, 400)
        self.assertEqual(self.it.post('/api/assets', {'assetTag': 'X2', 'purchaseDate': '2025-05-01',
                                                      'warrantyUntil': '2025-01-01'}, content_type=J).status_code, 400)
        self.assertEqual(self.it.post('/api/assets', {'assetTag': 'L1', 'category': 'license'}, content_type=J).status_code, 400)
        self.assertEqual(self.it.post('/api/assets', {'assetTag': '', 'category': 'laptop'}, content_type=J).status_code, 400)
        r = self.it.post('/api/assets', {'assetTag': 'EV-LAP-0043', 'category': 'laptop', 'serialNumber': 'c02xyz'},
                         content_type=J)
        self.assertEqual(r.status_code, 201)
        self.assertTrue(r.json()['warnings'])                       # same serial, same category: warn, still saved
        r = self.it.post('/api/assets', {'assetTag': 'MON-1', 'category': 'monitor', 'serialNumber': 'C02XYZ'}, content_type=J)
        self.assertEqual(r.json()['warnings'], [])                  # other category: no warning

    def test_status_transitions(self):
        a = self.new_asset()
        url = f'/api/assets/{a["id"]}/status'
        self.assertEqual(self.it.post(url, {'status': 'assigned'}, content_type=J).status_code, 400)
        self.assertEqual(self.it.post(url, {'status': 'repair'}, content_type=J).json()['status'], 'repair')
        self.assertEqual(self.assign(a['id']).status_code, 409)     # in repair: cannot assign
        self.assertEqual(self.it.post(url, {'status': 'in_stock'}, content_type=J).json()['status'], 'in_stock')
        self.assertEqual(self.assign(a['id']).status_code, 201)
        r = self.it.post(url, {'status': 'retired'}, content_type=J)
        self.assertEqual((r.status_code, r.json()['code']), (409, 'HELD'))   # held: return first
        aid = AssetAssignment.objects.get(asset_id=a['id']).id
        self.it.post(f'/api/assets/assignments/{aid}/lost', {'recoveryAmount': '20000'}, content_type=J)
        self.assertEqual(Asset.objects.get(id=a['id']).status, 'lost')
        self.assertEqual(self.it.post(url, {'status': 'in_stock'}, content_type=J).json()['status'], 'in_stock')  # found
        self.assertEqual(self.it.post(url, {'status': 'retired'}, content_type=J).json()['status'], 'retired')
        r = self.it.post(url, {'status': 'in_stock'}, content_type=J)
        self.assertEqual((r.status_code, r.json()['code']), (409, 'BAD_TRANSITION'))     # retired is terminal
        kinds = list(AssetEvent.objects.filter(asset_id=a['id']).order_by('id').values_list('kind', flat=True))
        self.assertEqual(kinds, ['created', 'sent_to_repair', 'back_from_repair', 'assigned', 'lost', 'found', 'retired'])

    def test_single_holder_vs_license_seats(self):
        a = self.new_asset()
        self.assertEqual(self.assign(a['id']).status_code, 201)
        r = self.assign(a['id'], self.OTHER)
        self.assertEqual((r.status_code, r.json()['code']), (409, 'NOT_AVAILABLE'))
        lic = self.new_asset('LIC-ADOBE', category='license', name='Adobe CC', serialNumber='', licenseSeats=2)
        self.assertEqual(self.assign(lic['id'], self.EMP).status_code, 201)
        self.assertEqual(self.assign(lic['id'], self.EMP).status_code, 409)          # one seat per person
        self.assertEqual(self.assign(lic['id'], self.OTHER).status_code, 201)
        r = self.assign(lic['id'], self.MGR)
        self.assertEqual((r.status_code, r.json()['code']), (409, 'NO_SEATS'))
        r = self.it.patch(f'/api/assets/{lic["id"]}', {'licenseSeats': 1}, content_type=J)
        self.assertEqual((r.status_code, r.json()['code']), (409, 'SEATS_IN_USE'))
        self.assertEqual(Asset.objects.get(id=lic['id']).status, 'assigned')
        for asg in AssetAssignment.objects.filter(asset_id=lic['id']):
            self.it.post(f'/api/assets/assignments/{asg.id}/return', {}, content_type=J)
        self.assertEqual(Asset.objects.get(id=lic['id']).status, 'in_stock')
        lic_rows = self.it.get('/api/assets/licenses').json()['licenses']
        self.assertEqual((lic_rows[0]['seats'], lic_rows[0]['used']), (2, 0))
        self.assertEqual(self.assign(a['id'], 'nobody@co.com').status_code, 400)   # not an employee

    def test_return_damaged_goes_to_repair_and_history(self):
        a = self.new_asset()
        self.assign(a['id'])
        asg = AssetAssignment.objects.get(asset_id=a['id'])
        r = self.it.post(f'/api/assets/assignments/{asg.id}/return', {'condition': 'damaged', 'receivedBy': self.IT,
                                                                       'recoveryAmount': '3000'}, content_type=J)
        self.assertEqual(r.status_code, 200, r.content)
        asg.refresh_from_db()
        self.assertEqual((asg.status, asg.return_condition, asg.received_by, asg.recovery_amount),
                         ('returned', 'damaged', self.IT, Decimal('3000.00')))
        self.assertEqual(Asset.objects.get(id=a['id']).status, 'repair')
        self.assertEqual(self.it.post(f'/api/assets/assignments/{asg.id}/return', {}, content_type=J).status_code, 409)
        d = self.it.get(f'/api/assets/{a["id"]}').json()
        self.assertEqual(len(d['assignments']), 1)
        self.assertIn('returned', [e['kind'] for e in d['events']])

    def test_write_off_and_delete(self):
        a = self.new_asset()
        self.assign(a['id'])
        r = self.it.post(f'/api/assets/{a["id"]}/write-off', {'recoveryAmount': '5000', 'note': 'Stolen'}, content_type=J)
        self.assertEqual(r.json()['status'], 'retired')
        asg = AssetAssignment.objects.get(asset_id=a['id'])
        self.assertEqual((asg.status, asg.recovery_amount), ('written_off', Decimal('5000.00')))
        self.assertEqual(self.it.delete(f'/api/assets/{a["id"]}').status_code, 409)    # has history
        b = self.new_asset('TMP-1', serialNumber='')
        self.assertEqual(self.it.delete(f'/api/assets/{b["id"]}').status_code, 200)

    def test_permissions(self):
        a = self.new_asset()
        v = client(self.VIEWER)
        self.assertEqual(v.get('/api/assets').status_code, 200)
        self.assertEqual(v.get(f'/api/assets/{a["id"]}').status_code, 200)
        self.assertEqual(v.post('/api/assets', {'assetTag': 'Z'}, content_type=J).status_code, 403)
        self.assertEqual(self.assign(a['id'], who=v).status_code, 403)
        e = client(self.EMP)
        self.assertEqual(e.get('/api/assets').status_code, 403)
        self.assertEqual(e.get('/api/assets/export.csv').status_code, 403)
        self.assertEqual(e.get('/api/assets/stock').status_code, 403)
        self.assertEqual(client(self.ONB).get('/api/assets/stock').status_code, 200)   # onboarding picker
        self.assertEqual(client('').get('/api/assets/my').status_code, 401)
        self.assertEqual(client(self.HR).get('/api/assets').status_code, 403)          # F&F role: no register
        m = self.it.get('/api/assets/meta').json()
        self.assertTrue(m['canManage'])
        self.assertFalse(v.get('/api/assets/meta').json()['canManage'])


class EmployeeTests(AssetBase):
    def test_acknowledge_and_report_issue(self):
        a = self.new_asset()
        self.assign(a['id'])
        self.assertTrue(Notification.objects.filter(recipient=self.EMP, title='Asset assigned to you').exists())
        e = client(self.EMP)
        mine = e.get('/api/assets/my').json()['assignments']
        self.assertEqual(len(mine), 1)
        aid = mine[0]['id']
        self.assertIsNone(mine[0]['acknowledgedAt'])
        self.assertEqual(client(self.OTHER).post(f'/api/assets/my/{aid}/acknowledge', {}, content_type=J).status_code, 404)
        r = e.post(f'/api/assets/my/{aid}/acknowledge', {}, content_type=J)
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()['acknowledgedAt'])
        self.assertEqual(e.post(f'/api/assets/my/{aid}/report', {'description': 'x'}, content_type=J).status_code, 400)
        r = e.post(f'/api/assets/my/{aid}/report', {'description': 'Battery swells', 'priority': 'High'}, content_type=J)
        self.assertEqual(r.status_code, 201, r.content)
        t = Ticket.objects.get(id=r.json()['ticket']['id'])
        self.assertEqual((t.category, t.requester_email, t.priority), ('IT', self.EMP, 'High'))
        self.assertIn('EV-LAP-0042', t.subject)
        self.assertEqual(client(self.OTHER).post(f'/api/assets/my/{aid}/report', {'description': 'Hello there'},
                                                 content_type=J).status_code, 404)

    def test_ack_reminder_after_three_days_once(self):
        a = self.new_asset()
        self.assign(a['id'])
        AssetAssignment.objects.update(assigned_at=svc.local_now() - timedelta(days=4))
        with mock.patch('api.mailer.send_email', return_value={'ok': True}):
            self.assertEqual(svc.run_alerts()['reminders'], 1)
            self.assertEqual(svc.run_alerts()['reminders'], 0)                       # not again within 3 days
        self.assertTrue(Notification.objects.filter(recipient=self.EMP, title='Please confirm your asset').exists())


class AlertCsvTests(AssetBase):
    def test_expiry_alerts_once_with_digest(self):
        soon = (date.today() + timedelta(days=10)).isoformat()
        self.new_asset('W1', warrantyUntil=soon)
        self.new_asset('L1', category='license', serialNumber='', licenseSeats=5, licenseExpiry=soon, purchaseDate='')
        self.new_asset('W2', serialNumber='', warrantyUntil=(date.today() + timedelta(days=90)).isoformat())
        with mock.patch('api.mailer.send_email', return_value={'ok': True}) as m:
            out = StringIOCmd.run('asset_alerts')
            self.assertIn('2 new expiry alert(s)', out)
            self.assertTrue(m.called)
            self.assertIn(self.IT, [c.args[0] for c in m.call_args_list])
            m.reset_mock()
            self.assertEqual(svc.run_alerts()['alerts'], 0)                          # once per end date
            self.assertFalse(m.called)
        self.assertTrue(Notification.objects.filter(recipient=self.IT, title__contains='expiry alert').exists())
        self.assertFalse(Notification.objects.filter(recipient=self.VIEWER, title__contains='expiry alert').exists())
        self.assertEqual(len(self.it.get('/api/assets/expiring').json()['items']), 2)
        k = self.it.get('/api/assets/meta').json()['kpis']
        self.assertEqual((k['warrantyExpiring'], k['licenseExpiring']), (1, 1))
        svc._LAZY['day'] = None                    # the lazy trigger finds nothing new
        self.assertEqual(self.it.get('/api/assets/meta').status_code, 200)
        self.assertEqual(AssetEvent.objects.filter(kind__startswith='alert_').count(), 2)

    def test_csv_export_escapes_formulas_and_import(self):
        self.new_asset('EV-1', name='=HYPERLINK("http://evil","x")', serialNumber='+1-555', vendor='@SUM(A1)')
        body = self.it.get('/api/assets/export.csv').content.decode('utf-8-sig')
        self.assertIn('"\'=HYPERLINK(""http://evil"",""x"")"', body)
        self.assertIn("'+1-555", body)
        self.assertIn("'@SUM(A1)", body)
        self.assertEqual(svc.csv_safe('-12.5'), '-12.5')
        self.assertEqual(svc.csv_safe('-cmd'), "'-cmd")
        csv_text = ('asset_tag,category,name,serial_number,license_seats\n'
                    'NEW-1,monitor,Dell 27,SN1,\n'
                    'EV-1,laptop,Renamed,,\n'
                    'BAD-1,spaceship,,,\n'
                    'LIC-9,license,Figma,,3\n')
        r = self.it.post('/api/assets/import', {'csv': csv_text, 'dryRun': True}, content_type=J).json()
        self.assertEqual((r['created'], r['updated'], len(r['errors'])), (2, 1, 1))
        self.assertFalse(Asset.objects.filter(asset_tag='NEW-1').exists())           # dry run keeps nothing
        r = self.it.post('/api/assets/import', {'csv': csv_text, 'dryRun': False}, content_type=J).json()
        self.assertEqual((r['created'], r['updated']), (2, 1))
        self.assertEqual(Asset.objects.get(asset_tag='EV-1').name, 'Renamed')
        self.assertEqual(Asset.objects.get(asset_tag='LIC-9').license_seats, 3)
        # round trip: an escaped value comes back unescaped
        r = self.it.post('/api/assets/import', {'csv': "asset_tag,name\nNEW-1,'=1+1\n", 'dryRun': False},
                         content_type=J).json()
        self.assertEqual(Asset.objects.get(asset_tag='NEW-1').name, '=1+1')
        self.assertEqual(client(self.VIEWER).post('/api/assets/import', {'csv': csv_text}, content_type=J).status_code, 403)


class StringIOCmd:
    @staticmethod
    def run(name, *args):
        import io
        buf = io.StringIO()
        call_command(name, *args, stdout=buf)
        return buf.getvalue()


class OnboardingTests(AssetBase):
    def setUp(self):
        super().setUp()
        self.cand = OnboardingCandidate.objects.create(email='new.hire@co.com', first_name='Nina', last_name='Hire')
        self.onb = client(self.ONB)

    def allocate(self, **kw):
        body = {'assetSource': 'Eversoft', 'assets': ['Laptop', 'Mouse'], 'assetId': '', 'status': 'Assigned'}
        body.update(kw)
        return self.onb.post(f'/api/onboarding/candidates/{self.cand.id}/assets', body, content_type=J)

    def test_allocation_links_stock_asset_and_placeholders(self):
        a = self.new_asset()
        r = self.allocate(assetId='EV-LAP-0042', assetTags=['EV-LAP-0042'])
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()['register']['linked'], ['EV-LAP-0042'])
        al = ItAssetAllocation.objects.get()
        asg = AssetAssignment.objects.get(asset_id=a['id'])
        self.assertEqual((asg.email, asg.allocation_id, asg.status), ('new.hire@co.com', al.id, 'active'))
        self.assertEqual(Asset.objects.get(id=a['id']).status, 'assigned')
        mouse = Asset.objects.get(asset_tag=f'ONB{al.id}-MOUSE')                     # untagged item → placeholder
        self.assertEqual(mouse.category, 'peripheral')
        self.assertTrue(AssetAssignment.objects.filter(asset=mouse, email='new.hire@co.com', status='active').exists())
        self.assertFalse(Asset.objects.filter(asset_tag=f'ONB{al.id}-LAPTOP').exists())  # covered by the tag
        # the same asset cannot be allocated to another candidate
        other = OnboardingCandidate.objects.create(email='second@co.com', first_name='Sec')
        r = self.onb.post(f'/api/onboarding/candidates/{other.id}/assets',
                          {'assetSource': 'Eversoft', 'assets': ['Laptop'], 'assetId': 'EV-LAP-0042'}, content_type=J)
        self.assertEqual(r.status_code, 409)
        # unknown typed tag becomes a register asset
        r = self.onb.post(f'/api/onboarding/candidates/{other.id}/assets',
                          {'assetSource': 'Client', 'clientName': 'Acme', 'assets': [], 'assetId': 'ACME-77'}, content_type=J)
        self.assertEqual(r.json()['register']['created'], ['ACME-77'])
        acme = Asset.objects.get(asset_tag='ACME-77')
        self.assertEqual((acme.ownership, acme.client_name, acme.status), ('client', 'Acme', 'assigned'))
        # status Returned on the allocation returns the register custody
        r = self.onb.patch(f'/api/onboarding/candidates/{self.cand.id}/assets/{al.id}', {'status': 'Returned'}, content_type=J)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(Asset.objects.get(id=a['id']).status, 'in_stock')
        # employee-side: after activation the same email holds it (custody follows the email)
        self.assertEqual(client(self.ONB).get('/api/assets/stock?q=EV-LAP').json()['assets'][0]['assetTag'], 'EV-LAP-0042')

    def test_returning_in_register_updates_allocation_and_delete_undoes(self):
        self.new_asset()
        self.allocate(assets=['Laptop'], assetId='EV-LAP-0042')
        al = ItAssetAllocation.objects.get()
        asg = AssetAssignment.objects.get(allocation_id=al.id)
        self.it.post(f'/api/assets/assignments/{asg.id}/lost', {}, content_type=J)
        al.refresh_from_db()
        self.assertEqual(al.status, 'Lost')
        self.new_asset('EV-LAP-0050', serialNumber='S50')
        r = self.allocate(assets=['Laptop'], assetId='EV-LAP-0050')
        al2 = ItAssetAllocation.objects.get(id=r.json()['id'])
        self.onb.delete(f'/api/onboarding/candidates/{self.cand.id}/assets/{al2.id}')
        self.assertEqual(Asset.objects.get(asset_tag='EV-LAP-0050').status, 'in_stock')

    def test_backfill_command_dry_run_then_apply(self):
        ItAssetAllocation.objects.create(candidate=self.cand, asset_source='Eversoft', assets=['Laptop', 'Monitor'],
                                         asset_id='OLD-55', status='Assigned')
        out = StringIOCmd.run('assets_backfill_from_onboarding')
        self.assertIn('DRY RUN', out)
        self.assertFalse(Asset.objects.exists())
        out = StringIOCmd.run('assets_backfill_from_onboarding', '--apply')
        self.assertIn('APPLIED', out)
        self.assertEqual(Asset.objects.get(asset_tag='OLD-55').category, 'laptop')
        self.assertTrue(Asset.objects.filter(category='monitor', asset_tag__startswith='ONB').exists())
        self.assertEqual(AssetAssignment.objects.filter(email='new.hire@co.com', status='active').count(), 2)
        StringIOCmd.run('assets_backfill_from_onboarding', '--apply')                 # idempotent
        self.assertEqual(AssetAssignment.objects.count(), 2)


class SeparationTests(AssetBase):
    def setUp(self):
        super().setUp()
        run = PayrollRun.objects.create(period_label='2026-11', period_start=date(2026, 11, 1),
                                        period_end=date(2026, 11, 30), status='approved')
        make_payslip(run, self.EMP, basic=30000, hra=30000, net=55000)
        self.lap = self.new_asset()
        self.lic = self.new_asset('LIC-1', category='license', name='Adobe CC', serialNumber='', licenseSeats=3)
        self.assign(self.lap['id'])
        self.assign(self.lic['id'])

    def initiate(self):
        body = {'email': self.EMP, 'separationType': 'resignation', 'resignationDate': '2026-10-16',
                'lastWorkingDay': '2026-11-15', 'noticeDaysRequired': 30, 'noticeDaysServed': 30}
        r = client(self.HR).post('/api/payroll/fnf/separations', body, content_type=J)
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def test_clearance_items_return_and_lost_recovery_in_fnf(self):
        s = self.initiate()
        self.assertEqual(s['clearanceTotal'], 8)                                    # 6 default + 2 assets
        items = [c['item'] for c in s['clearances']]
        self.assertIn('Return MacBook Pro 14 — tag EV-LAP-0042, S/N C02XYZ', items)
        self.assertTrue(any(i.startswith('Revoke licence seat: Adobe CC') for i in items))
        lap_asg = AssetAssignment.objects.get(asset_id=self.lap['id'])
        self.assertEqual(lap_asg.separation_id, s['id'])
        base = f'/api/payroll/fnf/separations/{s["id"]}'

        # the leaver may not clear their own items
        self.assertEqual(client(self.EMP).post(f'/api/assets/assignments/{lap_asg.id}/return', {},
                                               content_type=J).status_code, 403)
        # a stale sign-in is not enough for an F&F-linked return
        self.assertEqual(client(self.IT, fresh=False).post(f'/api/assets/assignments/{lap_asg.id}/return', {},
                                                           content_type=J).status_code, 401)
        # IT records the return → the clearance item clears
        r = self.it.post(f'/api/assets/assignments/{lap_asg.id}/return', {'condition': 'good'}, content_type=J)
        self.assertEqual(r.status_code, 200, r.content)
        c = links.clearance_for(AssetAssignment.objects.get(id=lap_asg.id))
        self.assertEqual((c.status, c.cleared_by, c.recovery_amount), ('cleared', self.IT, Decimal('0')))

        # an asset handed over mid-exit is added on the next look
        phone = self.new_asset('PH-1', category='phone', name='iPhone 15', serialNumber='IMEI1', purchaseCost='70000')
        self.assign(phone['id'])
        d = client(self.HR).get(f'/api/assets/separations/{s["id"]}').json()
        self.assertEqual(len(d['assets']), 3)
        ph_asg = AssetAssignment.objects.get(asset_id=phone['id'])
        self.assertEqual(ph_asg.separation_id, s['id'])
        # lost → recovery on the clearance item; the F&F manager can record it from the separation screen
        r = client(self.HR).post(f'/api/assets/assignments/{ph_asg.id}/lost', {'recoveryAmount': '45000'}, content_type=J)
        self.assertEqual(r.status_code, 200, r.content)
        c = links.clearance_for(AssetAssignment.objects.get(id=ph_asg.id))
        self.assertEqual((c.status, c.recovery_amount), ('cleared', Decimal('45000.00')))

        # clearing the licence item in the F&F checklist releases the seat
        lic_asg = AssetAssignment.objects.get(asset_id=self.lic['id'])
        lic_item = links.clearance_for(lic_asg)
        r = client(self.HR).post(f'{base}/clearances/{lic_item.id}', {'status': 'cleared'}, content_type=J)
        self.assertEqual(r.status_code, 200, r.content)
        lic_asg.refresh_from_db()
        self.assertEqual(lic_asg.status, 'returned')
        self.assertEqual(Asset.objects.get(id=self.lic['id']).status, 'in_stock')

        # the F&F computation picks up the recovery
        r = client(self.HR).post(f'{base}/compute', {}, content_type=J)
        self.assertEqual(r.status_code, 200, r.content)
        rec = [i for i in r.json()['computation']['items'] if i['code'] == 'CLEARANCE_RECOVERY'][0]
        self.assertEqual(Decimal(rec['amount']), Decimal('45000.00'))

    def test_damaged_return_recovery_and_cancel_unlinks(self):
        s = self.initiate()
        lap_asg = AssetAssignment.objects.get(asset_id=self.lap['id'])
        self.it.post(f'/api/assets/assignments/{lap_asg.id}/return', {'condition': 'damaged', 'recoveryAmount': '8000'},
                     content_type=J)
        c = links.clearance_for(AssetAssignment.objects.get(id=lap_asg.id))
        self.assertEqual((c.status, c.recovery_amount), ('cleared', Decimal('8000.00')))
        self.assertEqual(Asset.objects.get(id=self.lap['id']).status, 'repair')
        r = client(self.HR2).post(f'/api/payroll/fnf/separations/{s["id"]}/cancel', {}, content_type=J)
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(AssetAssignment.objects.get(asset_id=self.lic['id']).separation_id)

    def test_no_assets_keeps_default_checklist(self):
        AssetAssignment.objects.update(status='returned')
        self.assertEqual(self.initiate()['clearanceTotal'], 6)
        self.assertEqual(client(self.EMP).get('/api/assets/separations/1').status_code, 403)
