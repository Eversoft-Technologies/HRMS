# HRMS Attendance System - Quick Start Guide

## 🚀 Getting Started in 5 Minutes

### Step 1: Apply Migrations
```bash
cd /path/to/HRMS
python manage.py migrate
```

### Step 2: Seed Default Policies
```bash
python manage.py seed_attendance_policies
```

### Step 3: Create a Test Shift
```bash
python manage.py shell
```

```python
from api.models import Shift, ShiftAssignment
from datetime import date

# Create a shift
shift = Shift.objects.create(
    name='Standard 9-5',
    start_time='09:00:00',
    end_time='18:00:00',
    break_minutes=60,
    grace_minutes=15
)

# Assign to employee
assignment = ShiftAssignment.objects.create(
    email='john@company.com',
    shift=shift,
    effective_from=date.today()
)

print(f"Shift created: {shift.name}")
print(f"Assignment created for john@company.com")
```

### Step 4: Test Check-In API
```bash
curl -X POST http://localhost:8000/api/attendance/check-in/ \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john@company.com",
    "employeeName": "John Doe",
    "latitude": 28.5355,
    "longitude": 77.3910,
    "device": "mobile"
  }'
```

Expected Response:
```json
{
  "success": true,
  "message": "Checked in on time",
  "status": "on_time",
  "late_minutes": 0,
  "attendance_id": 1,
  "geo_verified": false
}
```

---

## 📚 Common Tasks

### Create an Office Location (Geofence)
```python
from api.models import GeoFence

geofence = GeoFence.objects.create(
    name='HQ Office',
    latitude=28.5355,
    longitude=77.3910,
    radius_meters=200,
    is_active=True,
    created_by='admin@company.com'
)
```

### Employee Requests WFH
```python
from api.models import WfhRequest
from datetime import date

wfh = WfhRequest.objects.create(
    email='john@company.com',
    employee_name='John Doe',
    from_date=date(2024, 7, 15),
    to_date=date(2024, 7, 16),
    reason='Doctor appointment',
    status='Pending'
)

# Manager can then approve:
wfh.status = 'Approved'
wfh.approver = 'manager@company.com'
wfh.save()
```

### Check Employee Overtime
```python
from api.models import Overtime
from datetime import date

overtime = Overtime.objects.filter(
    email='john@company.com',
    date=date.today()
).first()

if overtime:
    print(f"Overtime: {overtime.overtime_hours}h")
    print(f"Status: {overtime.status}")
```

### Get Attendance Summary
```python
from api.services.attendance_service import AttendanceService
from datetime import date

summary = AttendanceService.get_attendance_summary(
    email='john@company.com',
    from_date=date(2024, 7, 1),
    to_date=date(2024, 7, 31)
)

print(summary)
# Output: {
#   'total_days': 31,
#   'present': 21,
#   'late': 2,
#   'absent': 1,
#   'half_day': 0,
#   'total_worked_minutes': 10080,
#   'total_break_minutes': 840,
#   'total_overtime_minutes': 120
# }
```

---

## 🔧 API Endpoints Summary

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/attendance/check-in/` | POST | Record check-in |
| `/api/attendance/check-out/` | POST | Record check-out |
| `/api/attendance/today/` | GET | Get today's attendance |
| `/api/attendance/summary/` | GET | Get attendance summary |
| `/api/attendance/break/start/` | POST | Start break |
| `/api/attendance/break/end/` | POST | End break |
| `/api/attendance/late-alerts/` | GET | Get late alerts |
| `/api/attendance/overtime/daily/` | GET | Get daily overtime |
| `/api/attendance/overtime/monthly/` | GET | Get monthly overtime |
| `/api/attendance/correction/` | POST | Request correction |
| `/api/attendance/wfh/submit/` | POST | Submit WFH request |
| `/api/attendance/wfh/approve/` | POST | Approve WFH |
| `/api/shifts/` | GET/POST | Shift CRUD |

---

## 🎯 Use Cases

### Use Case 1: Employee Check-In Workflow
```
Employee opens mobile app
    ↓
Tap "Check In"
    ↓
GPS location captured
    ↓
System verifies geofence
    ↓
Attendance recorded
    ↓
If late:
    - Send notification
    - Create LateCheckInAlert
    - Update status to "late"
```

### Use Case 2: Break Tracking
```
Employee taps "Start Break"
    ↓
Break record created
    ↓
Employee returns & taps "End Break"
    ↓
Duration calculated
    ↓
Validated against BreakPolicy
    ↓
Break minutes deducted from worked time
```

### Use Case 3: Overtime Calculation (Daily)
```
Employee checks out
    ↓
System calculates: worked_time - break_time
    ↓
Compares with shift duration
    ↓
If worked > shift + threshold:
    - Create Overtime record
    - Set status to "calculated"
    - Classify type (regular/weekend)
```

### Use Case 4: Monthly Overtime Balance
```
End of month (via cron job)
    ↓
Fetch all approved OT records for month
    ↓
Calculate total OT hours
    ↓
Split 50/50 between:
    - Comp-off balance (can use for leave)
    - Cash payout balance (salary component)
    ↓
Create OvertimeBalance record
    ↓
Update in payroll system
```

---

## 📊 Data Flow Diagram

```
┌─────────────────────────────────────────────────────┐
│         Employee Mobile App / Web UI                │
└────────────────────┬────────────────────────────────┘
                     │
                     ├─→ Check-In (GPS + Geofence)
                     ├─→ Break Start/End
                     ├─→ Check-Out
                     └─→ WFH Request
                     │
        ┌────────────▼────────────┐
        │   Attendance Views      │
        │  (attendance_views.py)  │
        └────────────┬────────────┘
                     │
        ┌────────────▼────────────────────────────┐
        │        Service Layer                    │
        ├─────────────────────────────────────────┤
        │ • AttendanceService                     │
        │ • OvertimeService                       │
        │ • NotificationService                   │
        │ • GeofenceService                       │
        └────────────┬──────────────────────────┘
                     │
        ┌────────────▼────────────────────────────┐
        │     Django ORM (Models)                 │
        ├─────────────────────────────────────────┤
        │ • EmployeeAttendance                    │
        │ • Break                                 │
        │ • LateCheckInAlert                      │
        │ • Overtime                              │
        │ • WfhRequest                            │
        │ • AttendanceCorrection                  │
        └────────────┬──────────────────────────┘
                     │
        ┌────────────▼────────────────────────────┐
        │      MySQL Database                     │
        └────────────────────────────────────────┘
                     │
        ┌────────────▼────────────────────────────┐
        │    External Services                    │
        ├─────────────────────────────────────────┤
        │ • Email (SMTP)                          │
        │ • SMS (Twilio - optional)               │
        │ • Payroll System Integration            │
        └─────────────────────────────────────────┘
```

---

## 🐛 Debugging Tips

### Enable Debug Mode
```python
# settings.py
DEBUG = True
LOGGING = {
    'version': 1,
    'handlers': {
        'console': {'class': 'logging.StreamHandler'},
    },
    'root': {'handlers': ['console'], 'level': 'DEBUG'},
}
```

### Test Geofence Calculation
```python
from api.services.geofence_service import GeofenceService

distance = GeofenceService.haversine_distance(
    lat1=28.5355, lon1=77.3910,  # Employee
    lat2=28.5355, lon2=77.3910   # Geofence center
)
print(f"Distance: {distance}m")
```

### Check Notification Queue
```python
from api.models import Notification

# Get unread notifications
notifications = Notification.objects.filter(
    recipient='john@company.com',
    is_read=False
)

for n in notifications:
    print(f"{n.title}: {n.message}")
```

### View Attendance Records
```bash
# Via Django admin
python manage.py shell
>>> from api.models import EmployeeAttendance
>>> today_attendance = EmployeeAttendance.objects.filter(date='2024-07-08')
>>> for att in today_attendance:
>>>     print(f"{att.email}: {att.status} - {att.worked_minutes}m")
```

---

## 📈 Performance Metrics

| Operation | Time | Database Calls |
|-----------|------|----------------|
| Check-in | <100ms | 4-5 |
| Get daily OT | <50ms | 3 |
| Get monthly OT | <100ms | 2 |
| Send notification | <200ms | 2 |
| Geofence verify | <20ms | 1 |

---

## 🔐 Security Checklist

- [ ] HTTPS enabled for all API calls
- [ ] Email credentials stored in environment variables
- [ ] Database backups configured
- [ ] Rate limiting enabled
- [ ] CORS properly configured
- [ ] Authentication required for all endpoints
- [ ] Audit logging enabled
- [ ] GPS data encrypted in transit

---

## 📞 Support

**Issues?** Check:
1. Migration status: `python manage.py showmigrations api`
2. Policies exist: `python manage.py shell` → `Shift.objects.count()`
3. Logs: `tail -f logs/django.log`
4. Database: `mysql> SELECT * FROM employee_attendance LIMIT 1;`

---

**Happy Tracking! 📊**
