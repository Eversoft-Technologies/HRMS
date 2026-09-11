"""Seed sample data for the F2F employee-detail popup.

Populates attendance, tasks (To Do / In Progress / Review / Done),
work submissions and leave requests for several employees, so the popup on
Recruit > F2F Interview > Schedule & Links shows real, varied content when
you click different candidate rows.

    .venv/bin/python seed_f2f_demo.py                      # default set
    .venv/bin/python seed_f2f_demo.py alice@x.com "Alice"  # one specific person

Idempotent: re-running replaces each person's demo tasks / submissions / leave
and upserts their attendance.
"""
import os
import sys
import django
from datetime import datetime, date, time, timedelta

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "hrms_project.settings")
django.setup()

from api.models import (  # noqa: E402
    EmployeeAttendance, EmployeeTask, WorkSubmission, LeaveRequest,
    AttendanceLocationPunch,
)

today = date.today()

# Default set: the internal employee already in the interview list, plus a few
# candidate rows so several rows have data. Override with CLI args for one.
EMPLOYEES = [
    ("sushanthchowdary.marni@eversoftit.com", "Sushanth Chowdary"),
    ("fharookmulla570@gmail.com", "Fharook Mulla"),
    ("nabirasool926@gmail.com", "Nabi Rasool"),
    ("suresh.chebolu789@gmail.com", "CH Suresh"),
]
if len(sys.argv) > 1:
    EMPLOYEES = [(sys.argv[1].strip().lower(), sys.argv[2] if len(sys.argv) > 2 else sys.argv[1].split('@')[0])]


def weekdays(n):
    out, d = [], today
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d -= timedelta(days=1)
    return out


def seed_attendance(email, name, v):
    days = weekdays(22)
    # different absence/late pattern per person
    late_idx = {(3 + v) % 22, (11 + v) % 22}
    absent_idx = set() if v == 1 else {(7 + v) % 22, (16 + v) % 22}
    half_idx = {(14 + v) % 22} if v != 2 else set()
    for i, d in enumerate(days):
        if i in absent_idx:
            EmployeeAttendance.objects.update_or_create(
                email=email, date=d,
                defaults=dict(employee_name=name, status='absent',
                              check_in=None, check_out=None,
                              worked_minutes=0, overtime_minutes=0))
            continue
        status = 'late' if i in late_idx else ('half-day' if i in half_idx else 'present')
        ci = datetime.combine(d, time(9, 40) if status == 'late' else time(9, 8))
        if status == 'half-day':
            co, worked, ot = datetime.combine(d, time(13, 30)), 250, 0
        else:
            co = datetime.combine(d, time(18, 20 if (i + v) % 4 == 0 else 5))
            worked = int((co - ci).total_seconds() // 60) - 60
            ot = 20 if (i + v) % 4 == 0 else 0
        EmployeeAttendance.objects.update_or_create(
            email=email, date=d,
            defaults=dict(employee_name=name, status=status, check_in=ci,
                          check_out=co, worked_minutes=max(0, worked),
                          overtime_minutes=ot, break_minutes=60))
    # today: person v==0 stays checked IN (live open session); others completed
    if v == 0:
        EmployeeAttendance.objects.update_or_create(
            email=email, date=today,
            defaults=dict(employee_name=name, status='present',
                          check_in=datetime.combine(today, time(9, 12)),
                          check_out=None, worked_minutes=0, overtime_minutes=0,
                          break_minutes=0))
    else:
        ci = datetime.combine(today, time(9, 30) if v == 1 else time(9, 6))
        co = datetime.combine(today, time(18, 2))
        EmployeeAttendance.objects.update_or_create(
            email=email, date=today,
            defaults=dict(employee_name=name, status='late' if v == 1 else 'present',
                          check_in=ci, check_out=co,
                          worked_minutes=int((co - ci).total_seconds() // 60) - 60,
                          overtime_minutes=0, break_minutes=60))


TASK_POOL = [
    ("Build candidate profile screen", "high"),
    ("Wire attendance summary API", "medium"),
    ("Fix WFH approval race condition", "high"),
    ("Refactor check-in geofence check", "medium"),
    ("Employee popup - Task Tracker tab", "high"),
    ("Leave balance calculation", "medium"),
    ("Dark-mode polish on dashboards", "low"),
    ("Onboarding email template", "medium"),
    ("Resume parser edge cases", "high"),
    ("Payroll export formatting", "low"),
]
STAGES = ["todo", "inprogress", "review", "done"]


def seed_tasks(email, name, v):
    EmployeeTask.objects.filter(assignee_email=email).delete()
    count = 6 + (v % 4)
    for i in range(count):
        title, prio = TASK_POOL[(i + v * 2) % len(TASK_POOL)]
        stage = STAGES[(i + v) % 4]
        prog = 100 if stage in ("done", "review") else (0 if stage == "todo" else 40 + (i * 10) % 55)
        rej = "Out of scope for this sprint" if (i == count - 1 and v % 2 == 0) else ""
        EmployeeTask.objects.create(
            title=title, assignee=name, assignee_email=email,
            due=str(today + timedelta(days=2 + i)), priority=prio, stage=stage,
            progress=prog, reject_reason=rej, task_code="TASK-%d%d" % (v, 100 + i),
            created_by="demo")


SUB_STATES = ["Approved", "In Review", "Pending", "Rejected"]


def seed_submissions(email, name, v):
    WorkSubmission.objects.filter(email=email).delete()
    titles = ["Sprint deliverable", "Test report", "Design analysis", "Prototype (old)"]
    for i in range(3 + (v % 2)):
        st = SUB_STATES[(i + v) % 4]
        WorkSubmission.objects.create(
            email=email, employee_name=name,
            title="%s %d" % (titles[i % len(titles)], i + 1),
            type="Code" if i % 2 == 0 else "Document",
            date=today - timedelta(days=i * 2 + v), status=st,
            ai_score=[92, 87, 0, 61][(i + v) % 4],
            reviewer="HR Manager" if st in ("Approved", "Rejected") else "",
            reviewer_note=("Clean work, merged." if st == "Approved" else
                           ("Superseded by the new build." if st == "Rejected" else "")),
            summary="Demo submission for the popup.")


def seed_leave(email, name, v):
    LeaveRequest.objects.filter(email=email).delete()
    plans = [
        ("Casual Leave", 6, 7, "Family function", "Pending", ""),
        ("Sick Leave", -9, -9, "Fever", "Approved", "HR Manager"),
        ("Earned Leave", -30, -28, "Vacation", "Rejected" if v % 2 == 0 else "Approved", "HR Manager"),
    ]
    for typ, a, b, reason, st, appr in plans[: 2 + (v % 2)]:
        fd, td = today + timedelta(days=a), today + timedelta(days=b)
        LeaveRequest.objects.create(
            email=email, employee_name=name, type=typ, from_date=fd, to_date=td,
            days=(td - fd).days + 1, reason=reason, status=st, approver=appr)


def seed_location_punches(email, name, v):
    """Hourly location samples for today, so the Check In/Out tab shows the
    location-punch list with map pins. Coordinates jitter around a city point."""
    AttendanceLocationPunch.objects.filter(email=email, date=today).delete()
    base_lat, base_lng = 17.4239 + v * 0.012, 78.4738 + v * 0.010   # Hyderabad-ish
    for i, h in enumerate(range(9, 17)):   # 09:00 .. 16:00, hourly
        cap = datetime.combine(today, time(h, 5 + (i % 3)))
        AttendanceLocationPunch.objects.create(
            email=email, employee_name=name, date=today, captured_at=cap,
            latitude=base_lat + i * 0.0006, longitude=base_lng + i * 0.0004,
            accuracy=18.0, label="Hyderabad, Telangana", source="web")


if __name__ == "__main__":
    for v, (email, name) in enumerate(EMPLOYEES):
        seed_attendance(email, name, v)
        seed_location_punches(email, name, v)
        seed_tasks(email, name, v)
        seed_submissions(email, name, v)
        seed_leave(email, name, v)
        print("seeded %-42s %s" % (email, name))
    print("\nDone. Restart Django, hard-refresh /recruit/interview > Schedule & Links,")
    print("and click any of these rows:")
    for email, _ in EMPLOYEES:
        print("  - " + email)
    print("\n(%s stays checked-IN today for a live Check In/Out demo.)" % EMPLOYEES[0][0])
