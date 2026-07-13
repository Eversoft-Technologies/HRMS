# Attendance System - Testing & Deployment Guide

## ✅ Pre-Deployment Checklist

### Database Setup
- [ ] All migrations applied (`python manage.py migrate`)
- [ ] Default policies seeded (`python manage.py seed_attendance_policies`)
- [ ] Database indexes created
- [ ] Backup strategy in place

### Backend Configuration
- [ ] Django settings configured
- [ ] Email SMTP credentials set
- [ ] Timezone set correctly (Django USE_TZ = True)
- [ ] Logging configured
- [ ] CORS allowed for frontend domain

### Security
- [ ] HTTPS enabled in production
- [ ] API rate limiting configured
- [ ] CSRF tokens enabled
- [ ] SQL injection prevention verified
- [ ] GPS coordinates encryption enabled

### Testing
- [ ] Unit tests passing
- [ ] API integration tests passing
- [ ] Load tests passed (100+ concurrent users)
- [ ] Geofence calculations verified
- [ ] Overtime calculations verified

---

## 🧪 Testing Procedures

### Manual Testing Steps

#### 1. Check-In Test
```bash
# 1. Create a shift
python manage.py shell
>>> from api.models import Shift, ShiftAssignment
>>> from datetime import date
>>> shift = Shift.objects.create(
>>>     name='Test Shift',
>>>     start_time='09:00:00',
>>>     end_time='18:00:00'
>>> )
>>> ShiftAssignment.objects.create(
>>>     email='test@company.com',
>>>     shift=shift,
>>>     effective_from=date.today()
>>> )
>>> exit()

# 2. Test check-in API
curl -X POST http://localhost:8000/api/attendance/check-in/ \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@company.com",
    "employeeName": "Test User",
    "latitude": 28.5355,
    "longitude": 77.3910
  }'

# 3. Verify in database
python manage.py shell
>>> from api.models import EmployeeAttendance
>>> att = EmployeeAttendance.objects.latest('id')
>>> print(f"Status: {att.status}, Shift: {att.shift_id}")
```

#### 2. Break Test
```bash
# 1. Start break
curl -X POST http://localhost:8000/api/attendance/break/start/ \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@company.com",
    "employeeName": "Test User",
    "breakType": "meal"
  }'

# Response should include break_id: 1
# 2. End break (use break_id from response)
curl -X POST http://localhost:8000/api/attendance/break/end/ \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@company.com",
    "breakId": 1
  }'

# 3. Verify break created
python manage.py shell
>>> from api.models import Break
>>> b = Break.objects.latest('id')
>>> print(f"Break type: {b.break_type}, Duration: {b.break_minutes}m")
```

#### 3. Late Alert Test
```bash
# 1. Create shift starting at 09:00 with 15 min grace
python manage.py shell
>>> from api.models import Shift
>>> shift = Shift.objects.create(
>>>     name='Strict Shift',
>>>     start_time='09:00:00',
>>>     grace_minutes=15
>>> )

# 2. Check in at 09:30 (30 minutes late)
# System should create LateCheckInAlert
curl -X POST http://localhost:8000/api/attendance/check-in/ \
  -H "Content-Type: application/json" \
  -d '{
    "email": "late@company.com",
    "employeeName": "Late User",
    "latitude": 28.5355,
    "longitude": 77.3910
  }'

# 3. Response should show late_minutes: 15
# 4. Check alerts
curl http://localhost:8000/api/attendance/late-alerts/?email=late@company.com
```

#### 4. Overtime Test
```bash
# 1. Employee works 9 hours (1h overtime)
# Set check-in at 09:00
python manage.py shell
>>> from api.models import EmployeeAttendance
>>> from datetime import datetime
>>> att = EmployeeAttendance.objects.create(
>>>     email='overtime@company.com',
>>>     employee_name='OT User',
>>>     date='2024-07-08',
>>>     check_in=datetime(2024, 7, 8, 9, 0),
>>>     check_out=datetime(2024, 7, 8, 18, 0),
>>>     shift_id=1  # 8-hour shift
>>> )

# 2. Calculate overtime
curl http://localhost:8000/api/attendance/overtime/daily/?email=overtime@company.com&date=2024-07-08

# 3. Response should show:
# {
#   "workedHours": 9.0,
#   "shiftHours": 8.0,
#   "overtimeHours": 1.0
# }
```

---

## 🚀 Deployment Steps

### Production Deployment

#### 1. Environment Setup
```bash
# Create production environment file
cat > .env.production << EOF
DEBUG=False
SECRET_KEY=your-secret-key-here
ALLOWED_HOSTS=hrms.company.com,api.hrms.company.com
DATABASE_URL=mysql://user:pass@db.company.com:3306/hrms_prod
EMAIL_BACKEND=django.core.mail.backends.smtp.EmailBackend
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USE_TLS=True
EMAIL_HOST_USER=hrms@company.com
EMAIL_HOST_PASSWORD=app-password-here
DEFAULT_FROM_EMAIL=hrms@company.com
USE_TZ=True
TIME_ZONE=Asia/Kolkata
EOF
```

#### 2. Database Migration
```bash
# Backup existing database
mysqldump -u user -p hrms > hrms_backup_2024-07-08.sql

# Apply new migrations
python manage.py migrate --settings=hrms_project.settings_production

# Verify migrations
python manage.py showmigrations
```

#### 3. Load Initial Data
```bash
# Seed policies
python manage.py seed_attendance_policies --settings=hrms_project.settings_production

# Verify policies created
python manage.py shell --settings=hrms_project.settings_production
>>> from api.models import BreakPolicy, LateCheckInPolicy, OvertimePolicy, WFHPolicy
>>> print(f"Break Policies: {BreakPolicy.objects.count()}")
>>> print(f"Late Policies: {LateCheckInPolicy.objects.count()}")
>>> print(f"Overtime Policies: {OvertimePolicy.objects.count()}")
>>> print(f"WFH Policies: {WFHPolicy.objects.count()}")
```

#### 4. Collect Static Files
```bash
python manage.py collectstatic --noinput --clear
```

#### 5. Start Services
```bash
# Using Gunicorn + Nginx
gunicorn hrms_project.wsgi:application \
  --workers 4 \
  --bind 0.0.0.0:8000 \
  --timeout 120 \
  --access-logfile /var/log/hrms/access.log \
  --error-logfile /var/log/hrms/error.log
```

#### 6. Setup Cron Jobs
```bash
# Add to crontab for daily overtime balance calculation
0 0 * * * cd /path/to/HRMS && python manage.py calculate_overtime_balances

# Add to crontab for cleaning up old notifications
0 3 * * 0 cd /path/to/HRMS && python manage.py cleanup_old_notifications --days=90
```

#### 7. Configure Nginx
```nginx
upstream hrms_backend {
    server 127.0.0.1:8000;
}

server {
    listen 443 ssl http2;
    server_name api.hrms.company.com;
    
    ssl_certificate /etc/ssl/certs/hrms.crt;
    ssl_certificate_key /etc/ssl/private/hrms.key;
    
    client_max_body_size 100M;
    
    location / {
        proxy_pass http://hrms_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
```

---

## 🐛 Common Issues & Solutions

### Issue 1: Migration Fails
```
ERROR: Duplicate column name 'break_start'
```
**Solution:**
```bash
# Check if column already exists
python manage.py dbshell
mysql> DESCRIBE employee_breaks;

# If column exists, create new migration without it
python manage.py makemigrations
```

### Issue 2: Geofence Not Verifying
```
geo_verified: false even when inside zone
```
**Solution:**
```python
# Debug geofence distance
from api.services.geofence_service import GeofenceService
from api.models import GeoFence

geofence = GeoFence.objects.first()
distance = GeofenceService.haversine_distance(
    lat1=28.5355, lon1=77.3910,
    lat2=geofence.latitude, lon2=geofence.longitude
)
print(f"Distance: {distance}m, Radius: {geofence.radius_meters}m")

# Increase radius if needed
geofence.radius_meters = 300
geofence.save()
```

### Issue 3: Overtime Not Calculated
```
Overtime record not created after check-out
```
**Solution:**
```python
# Verify shift assignment exists
from api.models import ShiftAssignment
from datetime import date

assignment = ShiftAssignment.objects.filter(
    email='employee@company.com',
    effective_from__lte=date.today(),
).first()

if not assignment:
    # Create assignment
    from api.models import Shift
    shift = Shift.objects.first()
    ShiftAssignment.objects.create(
        email='employee@company.com',
        shift=shift,
        effective_from=date.today()
    )

# Manually trigger overtime calculation
from api.services.overtime_service import OvertimeService
result = OvertimeService.calculate_daily_overtime(
    email='employee@company.com',
    employee_name='Employee Name',
    today=date.today()
)
print(result)
```

### Issue 4: Notifications Not Sending
```
Notification created but email not sent
```
**Solution:**
```bash
# Test email configuration
python manage.py shell
>>> from django.core.mail import send_mail
>>> send_mail(
...     'Test Subject',
...     'Test Message',
...     'from@company.com',
...     ['to@company.com'],
...     fail_silently=False
... )

# If error, check SMTP settings
>>> from django.conf import settings
>>> print(settings.EMAIL_HOST)
>>> print(settings.EMAIL_PORT)
>>> print(settings.EMAIL_USE_TLS)
```

### Issue 5: High Memory Usage
```
Memory increases over time, causing OOM
```
**Solution:**
```python
# Optimize queries in settings.py
# Add database connection pooling
DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.mysql',
        'CONN_MAX_AGE': 600,  # Connection pooling
        'OPTIONS': {
            'init_command': "SET sql_mode='STRICT_TRANS_TABLES'",
        }
    }
}

# Increase Gunicorn workers memory limit
gunicorn --workers 2 --worker-class sync --max-requests 1000
```

---

## 📊 Monitoring & Logs

### Log File Locations
```
/var/log/hrms/access.log      # Nginx access logs
/var/log/hrms/error.log       # Nginx error logs
/var/log/hrms/django.log      # Django application logs
/var/log/hrms/attendance.log  # Attendance service logs
```

### Key Metrics to Monitor
```
1. Check-in API response time (target: <100ms)
2. Database query performance
3. Email delivery success rate
4. Overtime calculation accuracy
5. Geofence verification accuracy
6. Server uptime & availability
```

### Health Check Endpoint
```bash
curl http://localhost:8000/api/health/
# Response: {"status": "ok", "timestamp": "2024-07-08T10:30:00Z"}
```

---

## 📋 Rollback Plan

If issues occur in production:

### Step 1: Identify Issue
```bash
# Check recent error logs
tail -100 /var/log/hrms/error.log

# Check database integrity
python manage.py dbshell
mysql> SELECT COUNT(*) FROM employee_attendance;
```

### Step 2: Stop Services
```bash
sudo systemctl stop hrms
sudo systemctl stop nginx
```

### Step 3: Restore Database
```bash
# Restore from backup
mysql -u user -p hrms < hrms_backup_2024-07-08.sql

# Verify restore
python manage.py dbshell
mysql> SELECT COUNT(*) FROM employee_attendance;
```

### Step 4: Rollback Code
```bash
# Revert to previous version
git revert HEAD
git push origin main

# Redeploy
supervisorctl restart hrms
```

### Step 5: Verify
```bash
# Check services
sudo systemctl status hrms nginx

# Run tests
curl http://api.hrms.company.com/api/health/
```

---

## ✨ Post-Deployment Verification

```python
# Run this script to verify everything is working
python manage.py shell

from api.models import (
    BreakPolicy, LateCheckInPolicy, OvertimePolicy, WFHPolicy,
    Shift, ShiftAssignment, EmployeeAttendance
)

print("✓ Database connectivity OK")
print(f"✓ Break Policies: {BreakPolicy.objects.count()}")
print(f"✓ Late Policies: {LateCheckInPolicy.objects.count()}")
print(f"✓ Overtime Policies: {OvertimePolicy.objects.count()}")
print(f"✓ WFH Policies: {WFHPolicy.objects.count()}")
print(f"✓ Shifts configured: {Shift.objects.count()}")
print(f"✓ Attendance records: {EmployeeAttendance.objects.count()}")

print("\n✓ System Ready for Production!")
```

---

## 📞 Emergency Contacts

- **Tech Lead:** tech-lead@company.com
- **DevOps:** devops@company.com
- **Database Admin:** dba@company.com
- **On-Call:** +91-XXX-XXX-XXXX

---

**Deployment Completed!** 🎉
