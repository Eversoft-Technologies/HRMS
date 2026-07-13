# HRMS Attendance System Development Prompt

## Project Overview
Develop a comprehensive attendance management system for the HRMS platform that tracks employee check-ins, check-outs, breaks, work-from-home status, and overtime with intelligent alerts and location-based verification.

## Core Features

### 1. Shift-Based Check-In/Check-Out System
**Objective:** Enable employees to check in and out based on their assigned shifts with automatic validation.

**Requirements:**
- Define employee shift schedules with start and end times
- Validate check-ins against assigned shift times
- Record precise check-in and check-out timestamps
- Support multiple shifts per employee (rotating shifts)
- Automatic check-out trigger if employee forgets (with notification)
- Prevent duplicate check-ins within a grace period (e.g., 5 minutes)
- Manual check-in/out override for managers with audit trail

**Technical Implementation:**
- Models: `Shift`, `EmployeeShift`, `ShiftCheckInOut`
- API Endpoints:
  - `POST /api/attendance/check-in/` - Record check-in
  - `POST /api/attendance/check-out/` - Record check-out
  - `GET /api/attendance/current-shift/` - Get current shift details
  - `GET /api/attendance/history/` - Get check-in/out history

---

### 2. Break Tracking System
**Objective:** Monitor employee breaks during work hours and ensure compliance with company policy.

**Requirements:**
- Define break policies (break duration, break types, meal breaks, rest breaks)
- Track break start and end times
- Validate break duration against policy limits
- Allow multiple breaks per day
- Track break reason (meal, rest, personal, medical, etc.)
- Alert if employee exceeds maximum break time
- Distinguish between paid and unpaid breaks
- Prevent overlapping breaks

**Technical Implementation:**
- Models: `BreakPolicy`, `Break`, `BreakType`
- API Endpoints:
  - `POST /api/attendance/break/start/` - Start break
  - `POST /api/attendance/break/end/` - End break
  - `GET /api/attendance/breaks/` - Get break history
  - `GET /api/attendance/break-summary/` - Daily/weekly break summary

---

### 3. Location-Based Check-In/Check-Out
**Objective:** Verify employee presence at designated locations using GPS and geofencing.

**Requirements:**
- Define geofences for office locations with latitude, longitude, and radius
- Capture GPS coordinates during check-in/out
- Validate check-in location against geofence boundaries
- Allow remote office locations for work-from-home setups
- Generate alerts for check-ins outside approved locations
- Admin ability to override location restrictions
- Track location history for audit purposes
- Support multiple office locations

**Technical Implementation:**
- Models: `Geofence`, `Location`, `CheckInLocation`
- Services: Geofence validation utility
- API Endpoints:
  - `POST /api/attendance/check-in/location/` - Check-in with GPS coordinates
  - `GET /api/attendance/geofences/` - Get office geofences
  - `POST /api/attendance/location-override/` - Admin location override
  - `GET /api/attendance/location-violations/` - Report location violations

---

### 4. Work-From-Home (WFH) Management
**Objective:** Track and approve work-from-home arrangements while maintaining attendance records.

**Requirements:**
- WFH request/approval workflow
- Define WFH policies and allowed frequency
- Mark attendance as WFH with verification method
- Disable geofence requirements for approved WFH days
- Track WFH hours and balance
- Manager approval/rejection of WFH requests
- Generate WFH reports and trends
- Set max WFH days per week/month
- Email notifications for WFH status changes

**Technical Implementation:**
- Models: `WFHRequest`, `WFHPolicy`, `WFHApproval`
- Existing model: `WFHRequest` (possibly extend)
- API Endpoints:
  - `POST /api/attendance/wfh-request/` - Submit WFH request
  - `PUT /api/attendance/wfh-request/{id}/approve/` - Approve WFH
  - `PUT /api/attendance/wfh-request/{id}/reject/` - Reject WFH
  - `GET /api/attendance/wfh-balance/` - Get WFH balance
  - `GET /api/attendance/wfh-history/` - WFH history

---

### 5. Attendance Modification & Correction
**Objective:** Allow authorized personnel to modify attendance records with full audit trail.

**Requirements:**
- Correction request workflow (employee submits, manager approves)
- Support correction types: late check-in, early check-out, missing check-in/out, break adjustments
- Audit trail with who modified what and when
- Reason documentation for all modifications
- Manager dashboard for pending corrections
- Automatic approval for minor corrections (within threshold)
- Email notifications on modification status
- Historical backup of original records
- Corrections affect payroll and overtime calculations

**Technical Implementation:**
- Models: `AttendanceCorrection`, `CorrectionHistory`, `CorrectionApproval`
- Existing model: `AttendanceCorrection` (extend if needed)
- API Endpoints:
  - `POST /api/attendance/correction/` - Submit correction request
  - `PUT /api/attendance/correction/{id}/approve/` - Approve correction
  - `PUT /api/attendance/correction/{id}/reject/` - Reject correction
  - `GET /api/attendance/correction-history/` - Correction audit trail
  - `GET /api/attendance/pending-corrections/` - Manager dashboard

---

### 6. Late Check-In Alert System
**Objective:** Monitor and alert on late check-ins with escalation procedures.

**Requirements:**
- Configurable late threshold (e.g., 5, 10, 15 minutes)
- Real-time alert when check-in exceeds threshold
- Alert recipients: employee, manager, HR
- Track late check-in patterns and frequency
- Generate late check-in reports
- Apply late arrival policy automatically
- Escalation: notify senior manager if repeated
- Alert fatigue prevention (daily/weekly digest vs real-time)
- Manager can mark as approved/excused
- Impact on attendance score/KPI

**Technical Implementation:**
- Models: `LateCheckInAlert`, `LateCheckInPolicy`
- Services: Alert notification service
- API Endpoints:
  - `GET /api/attendance/late-alerts/` - Get late alerts
  - `PUT /api/attendance/late-alerts/{id}/mark-excused/` - Excuse late arrival
  - `GET /api/attendance/late-trends/` - Late check-in analytics
  - Notification: Email, SMS, In-app

---

### 7. Overtime Management
**Objective:** Track, record, and manage employee overtime hours.

**Requirements:**
- Automatic calculation of overtime when work exceeds shift hours
- Daily, weekly, and monthly overtime calculations
- Overtime type: regular overtime, weekend overtime, holiday overtime
- Configurable overtime thresholds and rates
- Overtime approval workflow
- Track overtime balance (comp-off, cash payout)
- Compliance with labor law limits
- Overtime request/approval system
- Calculate OT pay separately from base pay
- Generate overtime reports and analytics

**Technical Implementation:**
- Models: `Overtime`, `OvertimePolicy`, `OvertimeApproval`, `OvertimeBalance`
- Services: Overtime calculation engine
- API Endpoints:
  - `GET /api/attendance/overtime/` - Get overtime summary
  - `GET /api/attendance/overtime-balance/` - Current OT balance
  - `POST /api/attendance/overtime-request/` - Request overtime approval
  - `GET /api/attendance/overtime-analytics/` - OT reports and trends
  - `PUT /api/attendance/overtime-balance/adjust/` - Adjust OT balance

---

## Data Models Overview

```
Shift
├── name
├── start_time
├── end_time
├── company
└── status

EmployeeShift
├── employee
├── shift
├── start_date
├── end_date
└── status

CheckInOut
├── employee
├── check_in_time
├── check_out_time
├── shift
├── location_coordinates (GPS)
├── geofence_id
├── status (on_time, late, absent)
├── modified
├── modification_reason
└── modifier

Break
├── employee
├── break_start_time
├── break_end_time
├── break_type
├── reason
├── check_in_out_record
├── is_paid
└── status

WFHRequest
├── employee
├── request_date
├── start_date
├── end_date
├── reason
├── manager
├── status (pending, approved, rejected)
└── approval_date

AttendanceCorrection
├── employee
├── correction_date
├── correction_type
├── original_check_in
├── corrected_check_in
├── original_check_out
├── corrected_check_out
├── reason
├── requested_by
├── approved_by
├── status
└── audit_trail

Overtime
├── employee
├── date
├── shift_hours
├── worked_hours
├── overtime_hours
├── overtime_type
├── calculated_at
└── approved_by

Geofence
├── name
├── latitude
├── longitude
├── radius_meters
├── company
└── location_name
```

---

## API Response Examples

### Check-In Response
```json
{
  "id": "check_123",
  "employee": "emp_001",
  "check_in_time": "2024-07-08T09:05:00Z",
  "shift": "shift_morning",
  "location": {
    "latitude": 28.5355,
    "longitude": 77.3910,
    "geofence_verified": true
  },
  "status": "late",
  "late_minutes": 5,
  "message": "Check-in recorded. You are 5 minutes late."
}
```

### Overtime Summary Response
```json
{
  "employee": "emp_001",
  "period": "2024-07",
  "total_overtime_hours": 12.5,
  "overtime_breakdown": {
    "regular_overtime": 8.5,
    "weekend_overtime": 4.0
  },
  "overtime_balance": {
    "comp_off_hours": 5.0,
    "cash_payout_hours": 7.5
  }
}
```

---

## Key Considerations

### Security & Privacy
- Encrypt GPS coordinates in transit and at rest
- Access control: employees see own data, managers see team data
- Audit logging for all modifications
- GDPR compliance for location data

### Integration Points
- Payroll system: attendance affects pay calculations
- Leave management: WFH and leaves interact
- Email/SMS notification service
- Mobile app for on-the-go check-in
- Calendar integration for shift management

### Performance & Scalability
- Batch processing for overtime calculations
- Caching for geofence lookups
- Pagination for large attendance reports
- Real-time notifications using WebSocket/Celery

### User Experience
- Mobile-first check-in interface
- Offline check-in capability with sync
- Clear status indicators (on-time, late, etc.)
- Self-service correction requests
- Manager dashboard with actionable insights

---

## Development Roadmap

### Phase 1: Core Features
- Shift management and basic check-in/out
- Break tracking
- Geofence setup and location-based check-in

### Phase 2: Advanced Features
- WFH management
- Attendance corrections
- Late check-in alerts

### Phase 3: Intelligence & Reporting
- Overtime management
- Advanced analytics and reports
- Predictive alerts

### Phase 4: Optimization
- Mobile app enhancement
- Integration with external systems
- Performance optimization

---

## Testing Strategy
- Unit tests for overtime calculations
- Integration tests for notification system
- Location verification tests with mock GPS
- End-to-end tests for check-in/out workflows
- Load testing for high-volume scenarios

---

## Success Metrics
- 99% check-in success rate
- < 2 second check-in response time
- 95% accuracy in overtime calculations
- 100% audit trail completeness
- Employee satisfaction > 4/5
