# HRMS Attendance API Reference Card

**Base URL:** `http://api.hrms.com/api/`

---

## 🔐 Authentication
All endpoints require authentication token in headers:
```
Authorization: Token YOUR_AUTH_TOKEN
```

---

## ✅ Check-In / Check-Out

### Check-In
```
POST /attendance/check-in/
Body: {
  "email": "john@company.com",
  "employeeName": "John Doe",
  "latitude": 28.5355,
  "longitude": 77.3910,
  "device": "mobile",
  "geofenceId": 1
}
Response: {
  "success": true,
  "message": "Checked in on time",
  "status": "on_time|late|absent",
  "late_minutes": 0,
  "attendance_id": 123,
  "geo_verified": true
}
```

### Check-Out
```
POST /attendance/check-out/
Body: {
  "email": "john@company.com",
  "employeeName": "John Doe",
  "latitude": 28.5355,
  "longitude": 77.3910,
  "device": "mobile"
}
Response: {
  "success": true,
  "message": "Checked out successfully",
  "worked_minutes": 510,
  "break_minutes": 60,
  "overtime_minutes": 30
}
```

### Get Today's Status
```
GET /attendance/today/?email=john@company.com
Response: {
  "date": "2024-07-08",
  "email": "john@company.com",
  "employee": "John Doe",
  "status": "present",
  "checkInTime": "2024-07-08 09:05:00",
  "checkOutTime": "2024-07-08 18:00:00",
  "workedMinutes": 510,
  "breakMinutes": 60
}
```

### Get Summary (Date Range)
```
GET /attendance/summary/?email=john@company.com&fromDate=2024-07-01&toDate=2024-07-31
Response: {
  "totalDays": 31,
  "present": 22,
  "late": 2,
  "absent": 0,
  "halfDay": 0,
  "totalWorkedMinutes": 10560,
  "totalBreakMinutes": 660,
  "totalOvertimeMinutes": 120
}
```

---

## ☕ Break Management

### Start Break
```
POST /attendance/break/start/
Body: {
  "email": "john@company.com",
  "employeeName": "John Doe",
  "breakType": "meal|rest|personal|medical",
  "reason": "Lunch break"
}
Response: {
  "success": true,
  "breakId": 456,
  "message": "Break started (meal)"
}
```

### End Break
```
POST /attendance/break/end/
Body: {
  "email": "john@company.com",
  "breakId": 456
}
Response: {
  "success": true,
  "breakMinutes": 60,
  "breakType": "meal",
  "message": "Break ended. Duration: 60m"
}
```

### Get Today's Breaks
```
GET /attendance/breaks/today/?email=john@company.com
Response: [
  {
    "id": 456,
    "email": "john@company.com",
    "date": "2024-07-08",
    "breakStart": "2024-07-08 13:00:00",
    "breakEnd": "2024-07-08 14:00:00",
    "breakType": "meal",
    "breakMinutes": 60,
    "isPaid": false,
    "status": "completed"
  }
]
```

---

## ⏰ Overtime Management

### Get Daily Overtime
```
GET /attendance/overtime/daily/?email=john@company.com&date=2024-07-08
Response: {
  "id": 1,
  "email": "john@company.com",
  "employee": "John Doe",
  "date": "2024-07-08",
  "shiftHours": 8.0,
  "workedHours": 9.5,
  "overtimeHours": 1.5,
  "overtimeType": "regular|weekend|holiday",
  "status": "calculated|pending_approval|approved|rejected",
  "approver": "manager@company.com",
  "approvedAt": "2024-07-08 18:30:00"
}
```

### Get Monthly Overtime Summary
```
GET /attendance/overtime/monthly/?email=john@company.com&period=2024-07
Response: {
  "month": "2024-07",
  "totalOvertimeHours": 12.5,
  "totalWorkedHours": 162.5,
  "byType": {
    "regular": 8.5,
    "weekend": 4.0,
    "holiday": 0.0
  },
  "recordCount": 21
}
```

### Get Overtime Balance
```
GET /attendance/overtime/balance/?email=john@company.com&period=2024-07
Response: {
  "id": 1,
  "email": "john@company.com",
  "employee": "John Doe",
  "period": "2024-07",
  "totalOvertimeHours": 12.5,
  "compOffHours": 6.25,
  "cashPayoutHours": 6.25
}
```

### Approve Overtime
```
POST /attendance/overtime/approve/
Body: {
  "email": "john@company.com",
  "date": "2024-07-08"
}
Response: {
  "success": true,
  "message": "Overtime approved",
  "overtimeHours": 1.5,
  "approver": "manager@company.com"
}
```

---

## ⚠️ Late Check-In Alerts

### Get Late Alerts
```
GET /attendance/late-alerts/?email=john@company.com&date=2024-07-08
Response: [
  {
    "id": 1,
    "email": "john@company.com",
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

### Excuse Late Arrival
```
POST /attendance/late-alerts/excuse/
Body: {
  "alertId": 1,
  "excusedBy": "manager@company.com"
}
Response: {
  "success": true,
  "message": "Late arrival excused"
}
```

---

## 📝 Attendance Corrections

### Request Correction
```
POST /attendance/correction/
Body: {
  "email": "john@company.com",
  "attendanceDate": "2024-07-08",
  "requestedCheckIn": "2024-07-08 09:00:00",
  "requestedCheckOut": "2024-07-08 18:00:00",
  "reason": "System sync delay"
}
Response: {
  "success": true,
  "correctionId": 1,
  "message": "Correction request submitted"
}
```

### Get Pending Corrections (Manager)
```
GET /attendance/correction/pending/
Response: [
  {
    "id": 1,
    "email": "john@company.com",
    "employee": "John Doe",
    "attendanceDate": "2024-07-08",
    "requestedCheckIn": "2024-07-08 09:00:00",
    "requestedCheckOut": "2024-07-08 18:00:00",
    "reason": "System sync delay",
    "status": "pending",
    "submittedAt": "2024-07-08 18:30:00"
  }
]
```

### Approve Correction
```
POST /attendance/correction/approve/
Body: {
  "correctionId": 1,
  "reviewerNote": "Approved based on office CCTV"
}
Response: {
  "success": true,
  "message": "Correction approved",
  "updatedAttendance": {...}
}
```

### Reject Correction
```
POST /attendance/correction/reject/
Body: {
  "correctionId": 1,
  "reviewerNote": "No supporting evidence"
}
Response: {
  "success": true,
  "message": "Correction rejected"
}
```

---

## 🏠 Work-From-Home (WFH)

### Submit WFH Request
```
POST /attendance/wfh/submit/
Body: {
  "email": "john@company.com",
  "fromDate": "2024-07-15",
  "toDate": "2024-07-16",
  "reason": "Doctor appointment + deep work"
}
Response: {
  "success": true,
  "wfhRequestId": 1,
  "message": "WFH request submitted"
}
```

### Approve WFH Request
```
POST /attendance/wfh/approve/
Body: {
  "requestId": 1
}
Response: {
  "success": true,
  "message": "WFH request approved",
  "approver": "manager@company.com"
}
```

### Reject WFH Request
```
POST /attendance/wfh/reject/
Body: {
  "requestId": 1,
  "reason": "Busy period, need all hands on deck"
}
Response: {
  "success": true,
  "message": "WFH request rejected"
}
```

---

## 🗺️ Shift Management

### Create Shift
```
POST /shifts/
Body: {
  "name": "Morning Shift",
  "startTime": "09:00:00",
  "endTime": "18:00:00",
  "breakMinutes": 60,
  "graceMinutes": 15,
  "isFlexible": false,
  "flexHoursPerDay": 8.0,
  "overtimeAfterMinutes": 540,
  "isNightShift": false,
  "isActive": true
}
Response: {
  "id": 1,
  "name": "Morning Shift",
  "startTime": "09:00:00",
  ...
}
```

### Get Active Shifts
```
GET /shifts/active/
Response: [
  {
    "id": 1,
    "name": "Morning Shift",
    "startTime": "09:00:00",
    "endTime": "18:00:00",
    "breakMinutes": 60,
    "isActive": true
  }
]
```

### Get Shift Assignments
```
GET /shifts/1/assignments/
Response: [
  {
    "id": 1,
    "email": "john@company.com",
    "shift": 1,
    "effectiveFrom": "2024-07-01",
    "effectiveTo": null
  }
]
```

---

## 📍 Geofences

### Create Geofence
```
POST /geofences/
Body: {
  "name": "HQ Office",
  "latitude": 28.5355,
  "longitude": 77.3910,
  "radiusMeters": 200,
  "isActive": true
}
Response: {
  "id": 1,
  "name": "HQ Office",
  "latitude": 28.5355,
  "longitude": 77.3910,
  "radiusMeters": 200
}
```

### List Geofences
```
GET /geofences/
Response: [
  {
    "id": 1,
    "name": "HQ Office",
    "latitude": 28.5355,
    "longitude": 77.3910,
    "radiusMeters": 200,
    "isActive": true
  }
]
```

---

## ⚙️ Policies

### Get Break Policy
```
GET /policies/break/
Response: {
  "id": 1,
  "maxBreakMinutesPerDay": 60,
  "minBreakMinutes": 15,
  "maxBreakMinutes": 60,
  "isPaid": false
}
```

### Get Late Check-In Policy
```
GET /policies/late-checkin/
Response: {
  "id": 1,
  "lateThresholdMinutes": 5,
  "escalationCount": 3
}
```

### Get Overtime Policy
```
GET /policies/overtime/
Response: {
  "id": 1,
  "overTimeThresholdMinutes": 540,
  "dailyOTLimitMinutes": 180,
  "weeklyOTLimitMinutes": 600
}
```

### Get WFH Policy
```
GET /policies/wfh/
Response: {
  "id": 1,
  "maxWFHDaysPerWeek": 2,
  "maxWFHDaysPerMonth": 10,
  "requiresApproval": true,
  "advanceNoticeDays": 1
}
```

---

## 📊 Common Query Parameters

| Parameter | Format | Example |
|-----------|--------|---------|
| `email` | string | `john@company.com` |
| `date` | YYYY-MM-DD | `2024-07-08` |
| `fromDate` | YYYY-MM-DD | `2024-07-01` |
| `toDate` | YYYY-MM-DD | `2024-07-31` |
| `period` | YYYY-MM | `2024-07` |
| `status` | string | `on_time`, `late`, `absent` |
| `breakType` | string | `meal`, `rest`, `personal`, `medical` |

---

## ✅ Status Values

**Attendance Status:**
- `present` - Employee checked in and out on time
- `late` - Employee checked in late
- `absent` - No check-in recorded
- `half_day` - Partial day attendance
- `wfh` - Work from home approved

**Break Status:**
- `active` - Break in progress
- `completed` - Break ended normally
- `cancelled` - Break cancelled

**Overtime Status:**
- `calculated` - Overtime detected, pending review
- `pending_approval` - Waiting for manager approval
- `approved` - Manager approved
- `rejected` - Manager rejected

**Correction Status:**
- `pending` - Waiting for manager review
- `approved` - Correction accepted
- `rejected` - Correction denied

**WFH Status:**
- `Pending` - Awaiting manager decision
- `Approved` - Manager approved
- `Rejected` - Manager rejected

---

## 🚨 Error Responses

```json
{
  "error": "Employee not found",
  "code": "EMPLOYEE_NOT_FOUND",
  "status": 404
}
```

Common Error Codes:
- `EMPLOYEE_NOT_FOUND` (404)
- `SHIFT_NOT_ASSIGNED` (400)
- `GEOFENCE_VERIFICATION_FAILED` (400)
- `POLICY_VIOLATION` (400)
- `DUPLICATE_CHECK_IN` (400)
- `UNAUTHORIZED` (401)
- `RATE_LIMIT_EXCEEDED` (429)

---

## 💡 Tips

1. **Batch Operations:** Use `/summary/` endpoint for date ranges instead of calling daily endpoint
2. **Caching:** Results cached for 5 minutes, add `?cache=false` to bypass
3. **Rate Limiting:** Check-in limited to 5 per minute per employee
4. **Timezone:** All timestamps in server timezone (Asia/Kolkata)
5. **GPS Accuracy:** At least 50 meters for reliable geofence verification

---

**Last Updated:** July 8, 2024  
**API Version:** 1.0.0  
**Status:** Production Ready
