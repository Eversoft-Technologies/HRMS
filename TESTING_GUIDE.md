# HRMS Attendance System - Testing Guide

**Purpose:** QA and testing procedures for the HRMS Attendance Management System  
**Version:** 1.0.0  
**Date:** July 8, 2024

---

## 🧪 Test Environment Setup

### Prerequisites
- Django development server running
- SQLite/MySQL database configured
- Sample employee data seeded
- Default policies initialized

### Setup Commands
```bash
# Apply migrations
python manage.py migrate

# Seed policies
python manage.py seed_attendance_policies

# Create test data
python manage.py shell < tests/seed_test_data.py

# Run development server
python manage.py runserver
```

---

## 📋 Test Cases

### 1. CHECK-IN/CHECK-OUT TESTS

#### TC-001: Normal On-Time Check-In
```
Setup:
  - Employee: john@company.com
  - Shift: 09:00-18:00
  - Grace: 15 minutes
  - Time: 09:05 AM
  
Steps:
  1. POST /api/attendance/check-in/
     {
       "email": "john@company.com",
       "employeeName": "John Doe",
       "latitude": 28.5355,
       "longitude": 77.3910
     }
  
Expected:
  - Status: 200 OK
  - Response status: "on_time"
  - Response late_minutes: 0
  - Database: EmployeeAttendance created with check_in timestamp
  
Validate:
  - SELECT * FROM employee_attendance WHERE email = 'john@company.com' AND date = TODAY()
```

#### TC-002: Late Check-In (5-15 minutes)
```
Setup:
  - Same as TC-001
  - Time: 09:20 AM (20 minutes late, 5 minutes past grace)
  
Steps:
  1. POST /api/attendance/check-in/ at 09:20
  
Expected:
  - Status: 200 OK
  - Response status: "late"
  - Response late_minutes: 5
  - LateCheckInAlert created
  - Notification sent to manager
  
Validate:
  - SELECT * FROM late_checkin_alerts WHERE email = 'john@company.com'
  - SELECT * FROM notifications WHERE recipient LIKE '%manager%'
```

#### TC-003: Very Late Check-In (>15 minutes)
```
Setup:
  - Time: 09:45 AM (45 minutes late, 30 minutes past grace)
  
Steps:
  1. POST /api/attendance/check-in/ at 09:45
  
Expected:
  - Status: "late"
  - late_minutes: 30
  - LateCheckInAlert.escalated: true
  - Email notification with escalation flag
  
Validate:
  - Check LateCheckInAlert.escalated = 1
```

#### TC-004: Duplicate Check-In Prevention
```
Setup:
  - Employee already checked in at 09:05
  
Steps:
  1. POST /api/attendance/check-in/ again at 09:10
  
Expected:
  - Status: 400 Bad Request
  - Error: "DUPLICATE_CHECK_IN"
  - Message: "Already checked in today"
  
Validate:
  - Only one EmployeeAttendance record for today
```

#### TC-005: Normal Check-Out
```
Setup:
  - Employee checked in at 09:00
  - Current time: 18:00
  - Worked 8 hours, 0 breaks
  
Steps:
  1. POST /api/attendance/check-out/
     {
       "email": "john@company.com",
       "employeeName": "John Doe",
       "latitude": 28.5355,
       "longitude": 77.3910
     }
  
Expected:
  - Status: 200 OK
  - Response worked_minutes: 480 (8 hours)
  - Response break_minutes: 0
  - Response overtime_minutes: 0
  - EmployeeAttendance.check_out updated
  
Validate:
  - SELECT check_out FROM employee_attendance WHERE email = 'john@company.com' AND date = TODAY()
```

#### TC-006: Check-Out with Overtime
```
Setup:
  - Employee worked 9.5 hours (90 minutes overtime)
  - Shift: 8 hours
  - OvertimePolicy threshold: 540 minutes (9 hours)
  
Steps:
  1. POST /api/attendance/check-out/ at 18:30
  
Expected:
  - Response overtime_minutes: 90
  - Overtime record created with status "calculated"
  - Response status: "present_with_ot"
  
Validate:
  - SELECT * FROM overtimes WHERE email = 'john@company.com' AND date = TODAY()
  - Overtime.status = 'calculated'
  - Overtime.overtime_hours = 1.5
```

#### TC-007: Missing Shift Assignment
```
Setup:
  - Employee: unassigned@company.com (no ShiftAssignment)
  
Steps:
  1. POST /api/attendance/check-in/
  
Expected:
  - Status: 400 Bad Request
  - Error: "SHIFT_NOT_ASSIGNED"
  - Message: "No shift assigned for this employee"
  
Validate:
  - Query ShiftAssignment returns empty
```

---

### 2. BREAK MANAGEMENT TESTS

#### TC-008: Start Break
```
Setup:
  - Employee checked in
  - BreakPolicy: max 60 min/day
  
Steps:
  1. POST /api/attendance/break/start/
     {
       "email": "john@company.com",
       "employeeName": "John Doe",
       "breakType": "meal"
     }
  
Expected:
  - Status: 200 OK
  - Response break_id: 1
  - Break record created with status "active"
  - break_start timestamp recorded
  
Validate:
  - SELECT * FROM employee_breaks WHERE id = 1 AND status = 'active'
```

#### TC-009: End Break
```
Setup:
  - Break started at 13:00
  - Current time: 14:00
  - Break duration: 60 minutes
  
Steps:
  1. POST /api/attendance/break/end/
     {
       "email": "john@company.com",
       "breakId": 1
     }
  
Expected:
  - Status: 200 OK
  - Response break_minutes: 60
  - Break record status changed to "completed"
  - break_end timestamp recorded
  
Validate:
  - SELECT break_minutes FROM employee_breaks WHERE id = 1
```

#### TC-010: Break Duration Validation
```
Setup:
  - BreakPolicy: max 60 minutes per break
  - Employee took 90-minute break
  
Steps:
  1. Start break at 13:00
  2. End break at 14:30 (90 minutes)
  
Expected:
  - Break still recorded
  - Policy violation warning in response
  - Notification sent about policy violation
  
Validate:
  - SELECT * FROM employee_breaks WHERE break_minutes > maxBreakMinutes
```

#### TC-011: Multiple Breaks in Day
```
Setup:
  - Break 1: 13:00-14:00 (60 min, meal)
  - Break 2: 16:00-16:15 (15 min, rest)
  - Total: 75 minutes
  - Policy max: 60 minutes/day
  
Steps:
  1. Start & end Break 1
  2. Start & end Break 2
  
Expected:
  - Second break allowed but flagged
  - Total break minutes: 75
  - Daily limit exceeded alert
  
Validate:
  - SELECT SUM(break_minutes) FROM employee_breaks WHERE email = 'john@company.com' AND date = TODAY()
```

#### TC-012: Personal Break Type
```
Steps:
  1. POST /api/attendance/break/start/
     {
       "breakType": "personal",
       "reason": "Bathroom"
     }
  
Expected:
  - Break recorded with is_paid = false
  - Break minutes still count toward worked time
  
Validate:
  - SELECT is_paid FROM employee_breaks WHERE break_type = 'personal'
```

---

### 3. OVERTIME TESTS

#### TC-013: Daily Overtime Calculation
```
Setup:
  - Shift: 8 hours (09:00-18:00, 1 hour lunch)
  - Employee worked: 09:00-19:30 (10.5 hours)
  - Overtime threshold: 9 hours
  - OvertimePolicy daily max: 3 hours
  
Steps:
  1. Employee checks out at 19:30
  2. GET /api/attendance/overtime/daily/?email=john@company.com&date=TODAY()
  
Expected:
  - Overtime record created
  - Status: "calculated"
  - worked_hours: 10.5
  - overtime_hours: 1.5
  - overtime_type: "regular"
  
Validate:
  - SELECT * FROM overtimes WHERE date = TODAY() AND email = 'john@company.com'
```

#### TC-014: Weekend Overtime Classification
```
Setup:
  - Date: Saturday
  - Employee worked 8 hours
  - Overtime threshold: 4 hours on weekends
  
Expected:
  - overtime_type: "weekend"
  - May have different rate (if implemented)
  
Validate:
  - SELECT overtime_type FROM overtimes WHERE date = 'Saturday'
```

#### TC-015: Monthly Overtime Summary
```
Setup:
  - 21 working days in July
  - Daily OT: varies from 0.5 to 2 hours
  - Total OT for month: 25 hours
  
Steps:
  1. GET /api/attendance/overtime/monthly/?email=john@company.com&period=2024-07
  
Expected:
  - Response totalOvertimeHours: 25.0
  - Response byType includes all classifications
  - recordCount: 21
  
Validate:
  - SELECT SUM(overtime_hours) FROM overtimes WHERE email = 'john@company.com' AND MONTH(date) = 7
```

#### TC-016: Overtime Balance Calculation
```
Setup:
  - Month: July
  - Total OT: 12 hours
  - Policy: 50% comp-off, 50% cash
  
Expected:
  - totalOvertimeHours: 12.0
  - compOffHours: 6.0
  - cashPayoutHours: 6.0
  
Validate:
  - SELECT * FROM overtime_balances WHERE period = '2024-07'
```

#### TC-017: Approve Overtime
```
Setup:
  - Overtime record status: "calculated"
  - Manager: manager@company.com
  
Steps:
  1. POST /api/attendance/overtime/approve/
     {
       "email": "john@company.com",
       "date": "2024-07-08"
     }
  
Expected:
  - Status: "approved"
  - approver: "manager@company.com"
  - approvedAt timestamp recorded
  
Validate:
  - SELECT status FROM overtimes WHERE date = '2024-07-08'
```

#### TC-018: Overtime Policy Violation
```
Setup:
  - Daily OT limit: 3 hours
  - Employee worked 5 hours overtime
  
Expected:
  - Overtime record created
  - Policy violation flag set
  - Alert notification sent
  
Validate:
  - Check response includes violation warning
```

---

### 4. LATE ALERT TESTS

#### TC-019: Late Alert Creation
```
Setup:
  - Employee late by 20 minutes
  
Expected:
  - LateCheckInAlert created
  - is_excused: false
  - date: TODAY()
  - late_minutes: 20
  
Validate:
  - SELECT * FROM late_checkin_alerts WHERE email = 'john@company.com' AND date = TODAY()
```

#### TC-020: Excuse Late Arrival
```
Setup:
  - LateCheckInAlert exists
  
Steps:
  1. POST /api/attendance/late-alerts/excuse/
     {
       "alertId": 1,
       "excusedBy": "manager@company.com"
     }
  
Expected:
  - is_excused: true
  - excusedBy: "manager@company.com"
  - Notification sent to employee
  
Validate:
  - SELECT is_excused FROM late_checkin_alerts WHERE id = 1
```

#### TC-021: Escalation on Repeated Lates
```
Setup:
  - Employee late 3 times in month (policy escalation count: 3)
  - Late alert #1: excused
  - Late alert #2: excused
  - Late alert #3: not excused
  
Expected:
  - escalated: true
  - Alert escalation workflow initiated
  - Manager notification with escalation flag
  
Validate:
  - SELECT escalated FROM late_checkin_alerts WHERE id = 3
```

---

### 5. WFH REQUEST TESTS

#### TC-022: Submit WFH Request
```
Steps:
  1. POST /api/attendance/wfh/submit/
     {
       "email": "john@company.com",
       "fromDate": "2024-07-15",
       "toDate": "2024-07-16",
       "reason": "Doctor appointment"
     }
  
Expected:
  - Status: 200 OK
  - WfhRequest created with status "Pending"
  - Notification sent to manager
  
Validate:
  - SELECT * FROM wfh_requests WHERE email = 'john@company.com' AND from_date = '2024-07-15'
```

#### TC-023: WFH Policy Validation
```
Setup:
  - WFHPolicy: max 2 days/week, 10 days/month
  - Employee already has 2 WFH days this week
  
Steps:
  1. Request 3rd WFH day in same week
  
Expected:
  - Status: 400 Bad Request
  - Error: "POLICY_VIOLATION"
  - Message: "Maximum WFH days per week exceeded"
  
Validate:
  - No WfhRequest created
```

#### TC-024: Approve WFH Request
```
Setup:
  - WFH request status: "Pending"
  
Steps:
  1. POST /api/attendance/wfh/approve/
     {
       "requestId": 1
     }
  
Expected:
  - Status: "Approved"
  - approver: "manager@company.com"
  - Employee notification sent
  - Attendance auto-marked as WFH
  
Validate:
  - SELECT status FROM wfh_requests WHERE id = 1
  - SELECT is_wfh FROM employee_attendance WHERE date IN ('2024-07-15', '2024-07-16')
```

#### TC-025: Reject WFH Request
```
Steps:
  1. POST /api/attendance/wfh/reject/
     {
       "requestId": 1,
       "reason": "Busy period"
     }
  
Expected:
  - Status: "Rejected"
  - rejection_reason recorded
  - Employee notification sent
  
Validate:
  - SELECT status FROM wfh_requests WHERE id = 1
```

---

### 6. GEOFENCE TESTS

#### TC-026: Within Geofence
```
Setup:
  - Geofence: HQ (28.5355, 77.3910, radius 200m)
  - Employee location: (28.5355, 77.3910) - exact
  
Steps:
  1. POST /api/attendance/check-in/ with coordinates
  
Expected:
  - geo_verified: true
  - Distance calculated: 0m
  
Validate:
  - haversine_distance(28.5355, 77.3910, 28.5355, 77.3910) = 0
```

#### TC-027: Just Outside Geofence
```
Setup:
  - Geofence radius: 200m
  - Employee: 210m away
  
Expected:
  - geo_verified: false
  - But check-in still allowed
  - Violation alert sent
  
Validate:
  - Check distance calculation
  - Verify alert notification
```

#### TC-028: Geofence Accuracy Test
```
Setup:
  - Known coordinates with calculated distance
  - Use online calculator to verify Haversine formula
  
Example:
  Coords 1: 28.5355, 77.3910 (HQ)
  Coords 2: 28.5356, 77.3912 (Employee)
  Expected distance: ~24 meters
  
Expected:
  - Calculated distance within 5m accuracy
```

#### TC-029: Multiple Geofences
```
Setup:
  - Geofence 1: HQ (28.5355, 77.3910)
  - Geofence 2: Branch (28.6000, 77.4000)
  
Steps:
  1. Employee at location 28.5355, 77.3910
  
Expected:
  - Within Geofence 1: true
  - Within Geofence 2: false
  
Validate:
  - Proper distance calculation for both
```

---

### 7. CORRECTION REQUEST TESTS

#### TC-030: Submit Correction
```
Steps:
  1. POST /api/attendance/correction/
     {
       "email": "john@company.com",
       "attendanceDate": "2024-07-08",
       "requestedCheckIn": "2024-07-08 09:00:00",
       "requestedCheckOut": "2024-07-08 18:00:00",
       "reason": "System sync issue"
     }
  
Expected:
  - Status: 200 OK
  - AttendanceCorrection created with status "Pending"
  - Manager notification sent
  
Validate:
  - SELECT * FROM attendance_corrections WHERE email = 'john@company.com'
```

#### TC-031: Get Pending Corrections
```
Setup:
  - 5 pending corrections in system
  
Steps:
  1. GET /api/attendance/correction/pending/
  
Expected:
  - Response includes all 5 pending corrections
  - Each with employee info and original attendance
  
Validate:
  - Count results = 5
```

#### TC-032: Approve Correction
```
Setup:
  - AttendanceCorrection status: "Pending"
  
Steps:
  1. POST /api/attendance/correction/approve/
     {
       "correctionId": 1,
       "reviewerNote": "Verified with CCTV"
     }
  
Expected:
  - Status: "Approved"
  - EmployeeAttendance updated with new times
  - Employee notification sent
  
Validate:
  - SELECT check_in, check_out FROM employee_attendance WHERE email = 'john@company.com'
```

#### TC-033: Reject Correction
```
Steps:
  1. POST /api/attendance/correction/reject/
     {
       "correctionId": 1,
       "reviewerNote": "No evidence provided"
     }
  
Expected:
  - Status: "Rejected"
  - Original attendance unchanged
  - Employee notification sent with reason
  
Validate:
  - Verify EmployeeAttendance unchanged
```

---

### 8. NOTIFICATION TESTS

#### TC-034: Late Checkin Notification
```
Setup:
  - Employee late by 10 minutes
  
Expected:
  - Email notification sent to manager
  - In-app notification created
  - Contains: employee name, date, time, late minutes
  
Validate:
  - SELECT * FROM notifications WHERE title LIKE '%Late%'
```

#### TC-035: Overtime Alert
```
Setup:
  - Employee overtime exceeds daily limit
  
Expected:
  - Alert notification sent
  - Contains: overtime hours, policy limit, percentage
  
Validate:
  - Check notification queue
```

#### TC-036: WFH Approval Notification
```
Expected:
  - Approval/rejection sent to employee
  - Contains: dates, approval status, approver name
  
Validate:
  - Email sent successfully
```

#### TC-037: Break Limit Alert
```
Setup:
  - Employee exceeded daily break limit
  
Expected:
  - Alert sent
  - Contains: total break time, policy limit
  
Validate:
  - SELECT * FROM notifications WHERE title LIKE '%Break%'
```

---

## 🧪 Performance Tests

### PT-001: Concurrent Check-Ins
```
Setup:
  - 100 employees
  - All checking in simultaneously
  
Test:
  - Send 100 concurrent check-in requests
  - Measure response time
  - Verify database consistency
  
Expected:
  - 95th percentile response time: <500ms
  - All 100 records created
  - No duplicates or errors
  
Command:
  locust -f locustfile.py --users=100 --spawn-rate=10
```

### PT-002: Overtime Calculation (1000 records)
```
Setup:
  - 1000 overtime records
  
Test:
  - Calculate monthly summary
  - Measure query time
  
Expected:
  - Response time: <1 second
  - Accurate aggregation
  
Command:
  python manage.py shell < tests/performance_test.py
```

### PT-003: Report Generation
```
Setup:
  - 10,000 attendance records
  
Test:
  - Generate monthly report for 100 employees
  - Measure performance
  
Expected:
  - Complete in <5 seconds
  - Accurate calculations
```

---

## 🔒 Security Tests

### SEC-001: SQL Injection
```
Attempt:
  - POST /api/attendance/check-in/
  - email: "' OR '1'='1"
  
Expected:
  - No injection possible
  - Proper error message
  - Query fails safely
```

### SEC-002: CSRF Protection
```
Attempt:
  - POST without CSRF token
  
Expected:
  - Status: 403 Forbidden
  - Error message about CSRF
```

### SEC-003: Authentication Required
```
Attempt:
  - GET /api/attendance/summary/
  - No authentication token
  
Expected:
  - Status: 401 Unauthorized
```

### SEC-004: Rate Limiting
```
Attempt:
  - 10 check-in requests in 1 minute from same employee
  
Expected:
  - First 5 succeed
  - 6th onwards: 429 Rate Limited
```

---

## 📊 Integration Tests

### INT-001: Complete Workflow
```
Day 1:
  1. Employee shift assigned
  2. Geofence created for office
  3. Employee checks in (on time)
  4. Employee starts break
  5. Employee ends break
  6. Employee checks out (with 1h OT)
  
Verify:
  - All records created correctly
  - Calculations accurate
  - Notifications sent
  - Database consistent
```

### INT-002: WFH Complete Flow
```
Steps:
  1. Employee submits WFH request
  2. Manager approves
  3. Employee checks in from home
  4. System bypasses geofence check
  5. Employee works normally
  6. Check out recorded as WFH
  7. Monthly report shows WFH day
  
Verify:
  - Attendance marked as WFH
  - Geofence validation skipped
  - Reports reflect WFH
```

### INT-003: Overtime to Payroll
```
Steps:
  1. Calculate monthly OT
  2. Create OvertimeBalance record
  3. Export to payroll system
  4. Verify 50/50 split
  
Verify:
  - Correct comp-off allocation
  - Correct cash payout allocation
  - Integration with payroll API
```

---

## 🐛 Bug Reproduction Tests

### BUG-001: Timezone Issues
```
Setup:
  - Server timezone: UTC+5:30 (IST)
  - Employee timezone: different
  
Steps:
  1. Employee in different timezone checks in
  2. Verify timestamp in correct timezone
  
Expected:
  - Check-in time matches employee's local time
```

### BUG-002: Daylight Saving Time
```
Setup:
  - During DST transition
  
Expected:
  - Overtime calculation handles DST properly
  - No double counting or missing hours
```

### BUG-003: Leap Year
```
Setup:
  - February 29 (leap year only)
  
Expected:
  - Date handling correct
  - OT calculations correct
```

---

## 📋 Test Execution Checklist

Before deployment:
- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] Performance tests within SLA
- [ ] Security tests pass
- [ ] Manual QA testing complete
- [ ] Database migration reversible
- [ ] Backup procedures tested
- [ ] Rollback procedures tested
- [ ] Documentation complete
- [ ] Production readiness checklist signed

---

## 📊 Test Report Template

```
Test Execution Report
=====================

Date: 2024-07-08
Tester: QA Team
Build Version: 1.0.0

Summary:
--------
Total Test Cases: 45
Passed: 44
Failed: 0
Blocked: 1
Coverage: 95%

Issues Found:
---------
(None in production release)

Recommendation:
-----------
✅ READY FOR PRODUCTION DEPLOYMENT

Sign-off:
--------
QA Lead: _______________
Date: _______________
```

---

**Test Guide Complete**
