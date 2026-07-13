# HRMS Attendance System - Implementation Guide

## Overview
This document provides instructions for implementing and using the comprehensive HRMS Attendance Management System featuring shift-based check-in/out, break tracking, overtime management, work-from-home requests, and intelligent alerts.

## Project Structure

```
api/
├── models.py                           # Database models
├── serializers.py                      # DRF serializers
├── attendance_views.py                 # API ViewSets
├── urls.py                            # URL routing
├── services/
│   ├── __init__.py
│   ├── attendance_service.py          # Core check-in/out & break logic
│   ├── geofence_service.py            # GPS validation
│   ├── overtime_service.py            # Overtime calculations
│   └── notification_service.py        # Notifications
├── migrations/
│   └── 0015_attendance_advanced_features.py  # Database tables
└── management/
    └── commands/
        └── seed_attendance_policies.py       # Initialize policies
```

## Installation & Setup

### 1. Apply Migrations
Run the migration to create all necessary database tables:

```bash
python manage.py migrate
```

This creates:
- `break_policies` - Break configuration
- `employee_breaks` - Break records
- `late_checkin_policies` - Late arrival thresholds
- `late_checkin_alerts` - Late arrival alerts
- `overtime_policies` - Overtime configuration
- `overtimes` - Daily overtime records
- `overtime_balances` - Monthly overtime totals
- `wfh_policies` - Work-from-home policies

### 2. Seed Default Policies
Initialize default company policies:

```bash
python manage.py seed_attendance_policies
```

This creates default policies for breaks, late arrivals, overtime, and WFH requests.

### 3. Configure Email Service (Optional)
Add SMTP settings to `settings.py` for notifications:

```python
EMAIL_BACKEND = 'django.core.mail.backends.smtp.EmailBackend'
EMAIL_HOST = 'smtp.gmail.com'
EMAIL_PORT = 587
EMAIL_USE_TLS = True
EMAIL_HOST_USER = 'your-email@gmail.com'
EMAIL_HOST_PASSWORD = 'your-app-password'
DEFAULT_FROM_EMAIL = 'hrms@company.com'
```

## Core Features & API Endpoints

### 1. Shift Management

#### Create/Update Shift
```http
POST /api/shifts/
Content-Type: application/json

{
  "name": "Morning Shift",
  "startTime": "09:00:00",
  "endTime": "18:00:00",
  "breakMinutes": 60,
  "graceMinutes": 15,
  "isFlexible": false,
  "flexHoursPerDay": 8.0,
  "overtimeAfterMinutes": 540,
  "isNightShift": false,
  "isActive": true,
  "createdBy": "admin@company.com"
}
```

#### Get Active Shifts
```http
GET /api/shifts/active/
```

#### Assign Shift to Employee
```http
POST /shift-assignments/
{
  "email": "employee@company.com",
  "shift": 1,
  "effectiveFrom": "2024-07-08",
  "effectiveTo": null
}
```

---

### 2. Check-In/Check-Out with Location Verification

#### Employee Check-In
```http
POST /api/attendance/check-in/
Content-Type: application/json

{
  "email": "employee@company.com",
  "employeeName": "John Doe",
  "latitude": 28.5355,
  "longitude": 77.3910,
  "device": "mobile",
  "geofenceId": 1
}
```

**Response:**
```json
{
  "success": true,
  "message": "Checked in on time",
  "status": "on_time",
  "late_minutes": 0,
  "attendance_id": 123,
  "geo_verified": true
}
```

#### Employee Check-Out
```http
POST /api/attendance/check-out/
{
  "email": "employee@company.com",
  "employeeName": "John Doe",
  "latitude": 28.5355,
  "longitude": 77.3910,
  "device": "mobile"
}
```

#### Get Today's Attendance
```http
GET /api/attendance/today/?email=employee@company.com
```

#### Get Attendance Summary (Date Range)
```http
GET /api/attendance/summary/?email=employee@company.com&fromDate=2024-07-01&toDate=2024-07-31
```

---

### 3. Break Management

#### Start Break
```http
POST /api/attendance/break/start/
{
  "email": "employee@company.com",
  "employeeName": "John Doe",
  "breakType": "meal",
  "reason": "Lunch break"
}
```

**Response:**
```json
{
  "success": true,
  "break_id": 456,
  "message": "Break started (meal)"
}
```

#### End Break
```http
POST /api/attendance/break/end/
{
  "email": "employee@company.com",
  "breakId": 456
}
```

**Response:**
```json
{
  "success": true,
  "break_minutes": 60,
  "message": "Break ended. Duration: 60m"
}
```

#### Get Today's Breaks
```http
GET /api/attendance/breaks/today/?email=employee@company.com
```

---

### 4. Late Check-In Alerts

#### Get Late Alerts
```http
GET /api/attendance/late-alerts/?email=employee@company.com&date=2024-07-08
```

**Response:**
```json
[
  {
    "id": 1,
    "email": "employee@company.com",
    "employee": "John Doe",
    "date": "2024-07-08",
    "lateMinutes": 5,
    "checkInTime": "2024-07-08 09:05:00",
    "shiftStartTime": "2024-07-08 09:00:00",
    "reason": "",
    "isExcused": false,
    "excusedBy": "",
    "escalated": false
  }
]
```

#### Excuse Late Arrival
```http
POST /api/attendance/late-alerts/excuse/
{
  "alertId": 1,
  "excusedBy": "manager@company.com"
}
```

---

### 5. Overtime Management

#### Get Daily Overtime
```http
GET /api/attendance/overtime/daily/?email=employee@company.com&date=2024-07-08
```

**Response:**
```json
{
  "id": 1,
  "email": "employee@company.com",
  "employee": "John Doe",
  "date": "2024-07-08",
  "shiftHours": 8.0,
  "workedHours": 9.5,
  "overtimeHours": 1.5,
  "overtimeType": "regular",
  "status": "calculated",
  "approver": "",
  "approvedAt": null
}
```

#### Get Monthly Overtime Summary
```http
GET /api/attendance/overtime/monthly/?email=employee@company.com&period=2024-07
```

**Response:**
```json
{
  "month": "2024-07",
  "total_overtime_hours": 12.5,
  "total_worked_hours": 162.5,
  "by_type": {
    "regular": 8.5,
    "weekend": 4.0
  },
  "count": 21
}
```

#### Get Overtime Balance
```http
GET /api/attendance/overtime/balance/?email=employee@company.com&period=2024-07
```

**Response:**
```json
{
  "id": 1,
  "email": "employee@company.com",
  "employee": "John Doe",
  "period": "2024-07",
  "totalOvertimeHours": 12.5,
  "compOffHours": 6.25,
  "cashPayoutHours": 6.25
}
```

#### Approve Overtime
```http
POST /api/attendance/overtime/approve/
{
  "email": "employee@company.com",
  "date": "2024-07-08"
}
```

---

### 6. Attendance Corrections

#### Submit Correction Request
```http
POST /api/attendance/correction/
{
  "email": "employee@company.com",
  "attendanceDate": "2024-07-08",
  "requestedCheckIn": "2024-07-08 09:00:00",
  "requestedCheckOut": "2024-07-08 18:00:00",
  "reason": "System sync delay"
}
```

#### Get Pending Corrections (Manager Dashboard)
```http
GET /api/attendance/correction/pending/
```

#### Approve Correction
```http
POST /api/attendance/correction/approve/
{
  "correctionId": 1,
  "reviewerNote": "Approved based on office CCTV"
}
```

#### Reject Correction
```http
POST /api/attendance/correction/reject/
{
  "correctionId": 1,
  "reviewerNote": "No supporting evidence"
}
```

---

### 7. Work-From-Home (WFH) Management

#### Submit WFH Request
```http
POST /api/attendance/wfh/submit/
{
  "email": "employee@company.com",
  "fromDate": "2024-07-15",
  "toDate": "2024-07-16",
  "reason": "Doctor appointment + deep work"
}
```

**Response:**
```json
{
  "success": true,
  "wfhRequestId": 1,
  "message": "WFH request submitted"
}
```

#### Approve WFH Request
```http
POST /api/attendance/wfh/approve/
{
  "requestId": 1
}
```

#### Reject WFH Request
```http
POST /api/attendance/wfh/reject/
{
  "requestId": 1
}
```

---

## Geofence Configuration

### Add Office Location
```http
POST /attendance/geofences/
{
  "name": "HQ Office",
  "latitude": 28.5355,
  "longitude": 77.3910,
  "radiusMeters": 200,
  "isActive": true,
  "createdBy": "admin@company.com"
}
```

The system uses the Haversine formula to validate GPS coordinates against geofence boundaries. Employees checking in outside the geofence will have `geoVerified: false`.

---

## Service Layer Usage

### AttendanceService
Core business logic for attendance operations:

```python
from api.services.attendance_service import AttendanceService

# Record check-in
result = AttendanceService.record_check_in(
    email='emp@company.com',
    employee_name='John Doe',
    latitude=28.5355,
    longitude=77.3910
)

# Get attendance summary
summary = AttendanceService.get_attendance_summary(
    email='emp@company.com',
    from_date=date(2024, 7, 1),
    to_date=date(2024, 7, 31)
)
```

### OvertimeService
Overtime calculations and approval:

```python
from api.services.overtime_service import OvertimeService

# Calculate daily overtime
result = OvertimeService.calculate_daily_overtime(
    email='emp@company.com',
    employee_name='John Doe',
    today=date.today()
)

# Calculate monthly overtime
summary = OvertimeService.calculate_monthly_overtime(
    email='emp@company.com',
    year=2024,
    month=7
)

# Approve overtime
OvertimeService.approve_overtime(
    email='emp@company.com',
    date_obj=date.today(),
    approver_email='manager@company.com'
)
```

### NotificationService
Send notifications via email and in-app:

```python
from api.services.notification_service import NotificationService

# Send late check-in alert
NotificationService.send_late_checkin_alert(
    employee_email='emp@company.com',
    employee_name='John Doe',
    late_minutes=5,
    shift_start_time='09:00 AM'
)

# Send WFH approval
NotificationService.send_wfh_approval_notification(
    employee_email='emp@company.com',
    employee_name='John Doe',
    from_date='2024-07-15',
    to_date='2024-07-16',
    approved=True,
    approver='manager@company.com'
)
```

### GeofenceService
GPS validation:

```python
from api.services.geofence_service import GeofenceService
from api.models import GeoFence

geofence = GeoFence.objects.first()
is_valid = GeofenceService.is_within_geofence(
    latitude=28.5355,
    longitude=77.3910,
    geofence=geofence
)
```

---

## Database Schema

### Key Tables

**employee_attendance**
- `email` - Employee identifier
- `date` - Attendance date
- `check_in` - Check-in timestamp
- `check_out` - Check-out timestamp
- `status` - present/late/absent/half-day
- `worked_minutes` - Net work time
- `break_minutes` - Total break time
- `overtime_minutes` - Overtime duration
- `late_minutes` - Minutes late
- `is_wfh` - Work-from-home flag
- `geo_verified` - Location verified
- `shift_id` - Assigned shift

**employee_breaks**
- `email` - Employee identifier
- `date` - Break date
- `break_start` - Break start time
- `break_end` - Break end time
- `break_type` - meal/rest/personal/medical
- `break_minutes` - Duration
- `is_paid` - Paid break flag
- `status` - active/completed/cancelled

**overtimes**
- `email` - Employee identifier
- `date` - Work date
- `worked_hours` - Hours worked
- `overtime_hours` - OT hours
- `overtime_type` - regular/weekend/holiday
- `status` - calculated/pending_approval/approved/rejected

**late_checkin_alerts**
- `email` - Employee identifier
- `date` - Alert date
- `late_minutes` - Late duration
- `check_in_time` - Actual check-in
- `shift_start_time` - Expected start
- `is_excused` - Excused flag

---

## Workflow Examples

### Complete Check-In/Out Workflow
```python
from api.services.attendance_service import AttendanceService
from api.services.notification_service import NotificationService
from datetime import datetime, date

# 1. Employee checks in
check_in = AttendanceService.record_check_in(
    email='emp@company.com',
    employee_name='John Doe',
    latitude=28.5355,
    longitude=77.3910,
    device='mobile'
)

# 2. If late, send notification
if check_in['late_minutes'] > 0:
    NotificationService.send_late_checkin_alert(
        check_in.get('email'),
        'John Doe',
        check_in['late_minutes'],
        '09:00 AM'
    )

# 3. Employee starts break
break_start = AttendanceService.start_break(
    email='emp@company.com',
    employee_name='John Doe',
    break_type='meal',
    reason='Lunch'
)

# 4. Employee ends break
break_end = AttendanceService.end_break(
    email='emp@company.com',
    break_id=break_start['break_id']
)

# 5. Employee checks out
check_out = AttendanceService.record_check_out(
    email='emp@company.com',
    employee_name='John Doe'
)

# 6. Overtime calculated automatically
# System checks against OvertimePolicy and creates Overtime record
```

### WFH Request Workflow
```python
from api.models import WfhRequest
from api.services.notification_service import NotificationService
from datetime import date

# 1. Employee submits request
wfh = WfhRequest.objects.create(
    email='emp@company.com',
    employee_name='John Doe',
    from_date=date(2024, 7, 15),
    to_date=date(2024, 7, 16),
    reason='Doctor appointment',
    status='Pending'
)

# 2. Manager receives notification
NotificationService.send_notification(
    'manager@company.com',
    'WFH Request',
    'John Doe requested WFH for 2 days'
)

# 3. Manager approves (or rejects)
wfh.status = 'Approved'
wfh.approver = 'manager@company.com'
wfh.save()

# 4. Employee receives approval notification
NotificationService.send_wfh_approval_notification(
    'emp@company.com',
    'John Doe',
    '2024-07-15',
    '2024-07-16',
    approved=True,
    approver='manager@company.com'
)

# 5. Attendance automatically marked as WFH
```

---

## Admin Dashboard Features (TODO - Frontend Implementation)

1. **Attendance Dashboard**
   - Real-time employee status
   - Today's check-ins/check-outs
   - Late arrivals
   - WFH status

2. **Overtime Management**
   - Monthly overtime summary
   - Approval requests
   - Comp-off vs cash payout balance

3. **Corrections Queue**
   - Pending correction requests
   - Quick approve/reject
   - Audit trail

4. **Policies Management**
   - Edit break policies
   - Late thresholds
   - Overtime limits
   - WFH max days

5. **Reports**
   - Attendance trends
   - Late arrival patterns
   - Overtime analytics
   - Geofence violations

---

## Testing

### Unit Tests
```bash
python manage.py test api.tests.test_attendance_service
python manage.py test api.tests.test_overtime_service
python manage.py test api.tests.test_geofence_service
```

### API Integration Tests
```bash
python manage.py test api.tests.test_attendance_views
python manage.py test api.tests.test_wfh_views
```

### Load Testing
```bash
# Simulate 100 concurrent check-ins
locust -f locustfile.py --users=100 --spawn-rate=10
```

---

## Troubleshooting

### Issue: Overtime not calculated
- Check if Shift is assigned to employee
- Verify `shift_id` in EmployeeAttendance
- Ensure check-out is recorded
- Check OvertimePolicy is active

### Issue: Geofence verification failing
- Verify GPS coordinates are accurate
- Check geofence radius (default 200m)
- Ensure GeoFence is marked as active
- Test with Haversine calculator

### Issue: Notifications not sending
- Verify email configuration in settings.py
- Check SMTP credentials
- Ensure DEFAULT_FROM_EMAIL is set
- Check email logs for errors

### Issue: Late alerts not triggered
- Verify LateCheckInPolicy exists and is active
- Check `late_threshold_minutes` (default 5)
- Ensure shift start time is configured
- Review LateCheckInAlert records

---

## Performance Optimization

1. **Database Indexes**
   - Added on email, date fields for fast lookups
   - Period index on OvertimeBalance for monthly queries

2. **Caching**
   - Cache active policies (24-hour TTL)
   - Cache geofence lookups (1-hour TTL)

3. **Batch Processing**
   - Process overnight overtime calculations
   - Batch notification sending

4. **Query Optimization**
   - Use `select_related` for shift lookups
   - Use `prefetch_related` for policy queries
   - Aggregate break times in queries

---

## Security Considerations

1. **Access Control**
   - Employees can only view/modify own records
   - Managers can view team records
   - Admins have full access

2. **Data Encryption**
   - GPS coordinates encrypted in transit (HTTPS)
   - Email configuration encrypted at rest

3. **Audit Trail**
   - All corrections logged with reviewer info
   - Modification timestamps recorded
   - Change history preserved

4. **Rate Limiting**
   - Check-in API limited to 5/min per employee
   - Prevent spam notifications

---

## Future Enhancements

1. **Mobile App Integration**
   - Native iOS/Android apps
   - Offline check-in capability
   - Biometric authentication

2. **AI Features**
   - Predictive late arrival alerts
   - Anomaly detection in work patterns
   - Automated shift optimization

3. **Integration**
   - Payroll system sync
   - Calendar integration (shifts)
   - Slack/Teams notifications

4. **Analytics**
   - Advanced reporting dashboard
   - Predictive analytics
   - Team productivity insights

---

## Support & Documentation

- API Documentation: `/api/docs/`
- Swagger UI: `/api/swagger/`
- ReDoc: `/api/redoc/`
- Source: `api/services/` and `api/attendance_views.py`

---

**Last Updated:** 2024-07-08
**Version:** 1.0.0
**Status:** Production Ready
