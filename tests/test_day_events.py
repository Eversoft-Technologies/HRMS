"""HR's attendance edit and the hours recalculation keep the policy engine in
step (api/attendance_ext/day_events.py): day status follows the hours,
overtime is re-evaluated (so payroll never pays unapproved overtime), and a
status HR sets by hand is respected."""
from datetime import date, datetime, time

from django.test import Client, TestCase

from api.models import AppUser, EmployeeAttendance, OvertimeRecord, Shift, ShiftAssignment

DAY = date(2026, 11, 3)          # a Tuesday


class DayEventsTests(TestCase):
    def setUp(self):
        AppUser.objects.create(email='hr@x.com', full_name='HR', role='admin', status='active')   # super admin
        AppUser.objects.create(email='emp@x.com', full_name='Emp', role='employee', status='active')
        self.shift = Shift.objects.create(name='Day', start_time=time(9, 0), end_time=time(18, 0), grace_minutes=15,
                                          break_minutes=0, overtime_after_minutes=540)
        ShiftAssignment.objects.create(email='emp@x.com', shift=self.shift, effective_from=date(2026, 1, 1))
        self.att = EmployeeAttendance.objects.create(
            email='emp@x.com', employee_name='Emp', date=DAY, shift_id=self.shift.id,
            check_in=datetime(2026, 11, 3, 9, 0), check_out=datetime(2026, 11, 3, 18, 0),
            worked_minutes=540, status='present')
        self.hr = Client(HTTP_X_USER_EMAIL='hr@x.com')

    def edit(self, **body):
        return self.hr.put(f'/api/attendance/{self.att.id}', body, content_type='application/json')

    def row(self):
        return EmployeeAttendance.objects.get(pk=self.att.pk)

    def test_hr_shortening_the_day_reclassifies_it(self):
        r = self.edit(check_out='2026-11-03T11:00:00')          # 2 h worked
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.row().worked_minutes, 120)
        self.assertEqual(self.row().status, 'absent')            # below the 4h30 half-day minimum
        self.assertEqual(r.json()['status'], 'absent')           # the response shows it too
        r = self.edit(check_out='2026-11-03T15:00:00')           # 6 h
        self.assertEqual(self.row().status, 'half-day')

    def test_hr_set_status_is_respected(self):
        r = self.edit(check_out='2026-11-03T11:00:00', status='present')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.row().status, 'present')

    def test_hr_lengthening_the_day_creates_pending_overtime_not_paid_yet(self):
        r = self.edit(check_out='2026-11-03T21:00:00')           # 12 h, 3 h over the shift threshold
        self.assertEqual(r.status_code, 200, r.content)
        rec = OvertimeRecord.objects.get(email='emp@x.com', date=DAY)
        self.assertEqual((rec.status, rec.overtime_minutes), ('Pending', 180))
        self.assertEqual(self.row().overtime_minutes, 0)        # payroll pays only approved overtime

    def test_hours_recalculation_reclassifies(self):
        from api import attendance_recalc
        self.att.check_out = datetime(2026, 11, 3, 11, 0)
        self.att.save()
        attendance_recalc.apply([(self.row(), 120, 0)], actor='hr@x.com')
        self.assertEqual(self.row().status, 'absent')
