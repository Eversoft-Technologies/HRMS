# Generate Eversoft HRMS Local Development Setup Guide PDF
$outputPath = "c:\Users\SRIKANTH ADIPIREDDY\Desktop\Eversoft_hrms\HRMS\LOCAL_DEVELOPMENT_SETUP_GUIDE.pdf"

$pages = @()

# Page 1: Overview, Architecture & Prerequisites
$p1 = @"
BT
/F1 18 Tf
0.08 0.18 0.45 rg
40 785 Td
(Eversoft HRMS - Local Development Setup Guide) Tj
ET

BT
/F2 9.5 Tf
0.4 0.4 0.4 rg
40 768 Td
(Complete onboarding handbook for developers setting up the local environment) Tj
ET

% Blue accent line
0.15 0.45 0.85 RG
2 w
40 758 m 555 758 l S

% Section 1: Overview Box
0.96 0.98 1.0 rg
0.8 0.88 0.96 RG
1 w
40 645 515 98 re B

BT
/F1 11 Tf
0.08 0.25 0.6 rg
52 725 Td
(1. SYSTEM OVERVIEW & ARCHITECTURE) Tj
ET

BT
/F2 9 Tf
0.15 0.15 0.15 rg
52 708 Td
(  Backend: Django 5.x + Django REST Framework with Channels & Daphne for WebSockets.) Tj
0 -14 Td
(  Database: MySQL 5.7+ / 8.x via PyMySQL connector with naive wall-clock timestamps.) Tj
0 -14 Td
(  Frontend: Pre-built React / Vite SPA served directly from dist/dist/ via WhiteNoise.) Tj
0 -14 Td
(  Auth & RBAC: Custom AppUser model with JWT + OTP + Google OAuth and granular RBAC.) Tj
0 -14 Td
(  AI Integration: Anthropic Claude API for interview question generation (with offline fallback).) Tj
ET

% Section 2: Prerequisites Box
0.98 0.98 0.98 rg
0.85 0.85 0.85 RG
1 w
40 540 515 90 re B

BT
/F1 11 Tf
0.15 0.2 0.35 rg
52 612 Td
(2. SYSTEM PREREQUISITES) Tj
ET

BT
/F2 9 Tf
0.15 0.15 0.15 rg
52 595 Td
(  1. Git: Command-line git or GitHub Desktop installed.) Tj
0 -14 Td
(  2. Python: Python 3.10 to 3.12 (with pip and venv modules enabled).) Tj
0 -14 Td
(  3. MySQL Server: Version 5.7+ or 8.x running locally on port 3306 or via Docker.) Tj
0 -14 Td
(  4. Terminal: PowerShell / Command Prompt on Windows, or Bash / Zsh on macOS/Linux.) Tj
ET

% Section 3 Heading
BT
/F1 13 Tf
0.08 0.18 0.45 rg
40 510 Td
(3. STEP-BY-STEP SETUP GUIDE) Tj
ET

% Step 1 & 2
0.95 0.95 0.95 rg
0.85 0.85 0.85 RG
1 w
40 375 515 120 re B

BT
/F1 10 Tf
0.1 0.3 0.65 rg
52 480 Td
(Step 1: Clone Repository & Step 2: Virtual Environment Setup) Tj
ET

BT
/F3 8.5 Tf
0.1 0.1 0.1 rg
52 462 Td
(# 1. Clone the project repo) Tj
0 -12 Td
(git clone <repository-url> HRMS) Tj
0 -12 Td
(cd HRMS) Tj
0 -14 Td
(# 2. Create and activate virtual environment) Tj
0 -12 Td
(python -m venv .venv) Tj
0 -12 Td
(.venv\Scripts\activate              # Windows (PowerShell / Command Prompt)) Tj
0 -12 Td
(source .venv/bin/activate          # macOS / Linux) Tj
ET

% Step 3 & 4
0.95 0.95 0.95 rg
0.85 0.85 0.85 RG
1 w
40 215 515 145 re B

BT
/F1 10 Tf
0.1 0.3 0.65 rg
52 344 Td
(Step 3: Dependencies & Step 4: Database Preparation) Tj
ET

BT
/F3 8.5 Tf
0.1 0.1 0.1 rg
52 326 Td
(# 3. Install required Python packages) Tj
0 -12 Td
(pip install -r requirements.txt) Tj
0 -14 Td
(# 4. Create MySQL database and grant privileges in MySQL CLI / Workbench:) Tj
0 -12 Td
(CREATE DATABASE hrms_system CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;) Tj
0 -12 Td
(GRANT ALL PRIVILEGES ON hrms_system.* TO 'root'@'localhost';) Tj
0 -12 Td
(FLUSH PRIVILEGES;) Tj
0 -14 Td
(# Or start quick MySQL via Docker:) Tj
0 -12 Td
(docker run --name hrms-mysql -e MYSQL_ROOT_PASSWORD=1234 -e MYSQL_DATABASE=hrms_system -p 3306:3306 -d mysql:8.0) Tj
ET

% Footer Page 1
0.8 0.8 0.8 RG
0.5 w
40 50 m 555 50 l S

BT
/F2 8 Tf
0.5 0.5 0.5 rg
40 38 Td
(Eversoft HRMS Local Development Setup Guide) Tj
440 0 Td
(Page 1 of 3) Tj
ET
"@

# Page 2: Environment Configuration, Migrations & Seeding
$p2 = @"
BT
/F1 14 Tf
0.08 0.18 0.45 rg
40 785 Td
(Step 5: Environment Variables Configuration (.env)) Tj
ET

% Environment box
0.96 0.98 1.0 rg
0.8 0.88 0.96 RG
1 w
40 580 515 190 re B

BT
/F2 9 Tf
0.15 0.15 0.15 rg
52 752 Td
(Copy the example environment file and configure your local settings:) Tj
ET

BT
/F3 8 Tf
0.1 0.1 0.1 rg
52 735 Td
(copy .env.example .env    # Windows) Tj
0 -11 Td
(cp .env.example .env      # macOS / Linux) Tj
0 -14 Td
(# Recommended local development values inside .env:) Tj
0 -11 Td
(APP_ENV=development) Tj
0 -11 Td
(DJANGO_SECRET_KEY=dev-insecure-secret-key-change-me) Tj
0 -11 Td
(DJANGO_DEBUG=true) Tj
0 -11 Td
(DJANGO_ALLOWED_HOSTS=localhost,127.0.0.1) Tj
0 -11 Td
(HRMS_TIME_ZONE=Asia/Kolkata) Tj
0 -11 Td
(DB_NAME=hrms_system) Tj
0 -11 Td
(DB_USER=root) Tj
0 -11 Td
(DB_PASSWORD=1234) Tj
0 -11 Td
(DB_HOST=localhost) Tj
0 -11 Td
(DB_PORT=3306) Tj
0 -11 Td
(DEV_OTP_ECHO=true        # Prints login OTP in console if email service is down) Tj
ET

% Step 6 & 7 Migrations & Seeding
0.98 0.98 0.98 rg
0.85 0.85 0.85 RG
1 w
40 375 515 190 re B

BT
/F1 10.5 Tf
0.1 0.3 0.65 rg
52 548 Td
(Step 6: Migrations & Step 7: Seeding Base Roles and Data) Tj
ET

BT
/F3 8.5 Tf
0.1 0.1 0.1 rg
52 530 Td
(# 1. Run database schema migrations) Tj
0 -12 Td
(python manage.py migrate) Tj
0 -12 Td
(# Note: If connecting to existing tables with data, run:) Tj
0 -12 Td
(# python manage.py migrate --fake-initial) Tj
0 -14 Td
(# 2. Seed RBAC modules, permission groups, and roles (MANDATORY)) Tj
0 -12 Td
(python manage.py seed_rbac) Tj
0 -14 Td
(# 3. Seed default attendance policies) Tj
0 -12 Td
(python manage.py seed_attendance_policies) Tj
0 -14 Td
(# 4. (Optional) Seed base job posts & interviews) Tj
0 -12 Td
(python manage.py seed_data) Tj
0 -14 Td
(# 5. (Optional) Seed employee chat channels & demo members) Tj
0 -12 Td
(python seed_chat_demo.py) Tj
ET

% Step 8: Admin account
0.95 0.98 0.95 rg
0.75 0.9 0.75 RG
1 w
40 180 515 180 re B

BT
/F1 10.5 Tf
0.1 0.45 0.2 rg
52 344 Td
(Step 8: Create Initial Super Admin User) Tj
ET

BT
/F2 8.5 Tf
0.2 0.2 0.2 rg
52 328 Td
(Run the Django shell to generate the initial admin account:) Tj
ET

BT
/F3 8 Tf
0.1 0.1 0.1 rg
52 312 Td
(python manage.py shell) Tj
0 -13 Td
(# Inside python interactive shell, paste:) Tj
0 -11 Td
(from api.models import AppUser, Role) Tj
0 -11 Td
(admin_role = Role.objects.filter(name='Super Admin').first()) Tj
0 -11 Td
(user, _ = AppUser.objects.get_or_create() Tj
0 -11 Td
(    email='admin@eversoftit.com',) Tj
0 -11 Td
(    defaults={'full_name': 'Super Admin', 'password': 'password123',) Tj
0 -11 Td
(              'role': 'admin', 'role_ref': admin_role, 'status': 'active', 'initials': 'SA'}) Tj
0 -11 Td
() Tj
0 -11 Td
(user.role_ref = admin_role; user.password = 'password123'; user.status = 'active'; user.save()) Tj
0 -11 Td
(print("Admin ready: admin@eversoftit.com / password123")) Tj
0 -11 Td
(exit()) Tj
ET

% Footer Page 2
0.8 0.8 0.8 RG
0.5 w
40 50 m 555 50 l S

BT
/F2 8 Tf
0.5 0.5 0.5 rg
40 38 Td
(Eversoft HRMS Local Development Setup Guide) Tj
440 0 Td
(Page 2 of 3) Tj
ET
"@

# Page 3: Running the App, Testing & Architecture Notes
$p3 = @"
BT
/F1 14 Tf
0.08 0.18 0.45 rg
40 785 Td
(Step 9: Start Dev Server & Step 10: Access Application) Tj
ET

% Dev server Box
0.96 0.98 1.0 rg
0.8 0.88 0.96 RG
1 w
40 655 515 115 re B

BT
/F3 8.5 Tf
0.1 0.1 0.1 rg
52 752 Td
(# Start the ASGI development server on port 8000) Tj
0 -13 Td
(python manage.py runserver 0.0.0.0:8000) Tj
0 -15 Td
(# Application URLs:) Tj
0 -13 Td
(Frontend UI:   http://localhost:8000) Tj
0 -13 Td
(API Health:    http://localhost:8000/api/health) Tj
0 -15 Td
(# Login Credentials:) Tj
0 -13 Td
(Email: admin@eversoftit.com  |  Password: password123  |  Role: Super Admin) Tj
0 -13 Td
((Check terminal output for 6-digit OTP code when prompted)) Tj
ET

% Section 4: Testing Commands
0.98 0.98 0.98 rg
0.85 0.85 0.85 RG
1 w
40 485 515 155 re B

BT
/F1 10.5 Tf
0.1 0.3 0.65 rg
52 622 Td
(4. TESTING & VERIFICATION COMMANDS) Tj
ET

BT
/F3 8.5 Tf
0.1 0.1 0.1 rg
52 602 Td
(# 1. Run full test suite) Tj
0 -13 Td
(python manage.py test tests/) Tj
0 -15 Td
(# 2. Run API and database smoke tests) Tj
0 -13 Td
(python smoke.py) Tj
0 -15 Td
(# 3. Run individual test module) Tj
0 -13 Td
(python manage.py test tests.test_attendance_geofence) Tj
0 -15 Td
(# 4. Re-sync RBAC roles and permissions after adding new models/codes) Tj
0 -13 Td
(python manage.py seed_rbac) Tj
0 -15 Td
(# 5. Inspect user notifications queue) Tj
0 -13 Td
(python manage.py list_notifications admin@eversoftit.com) Tj
ET

% Section 5: Architecture Gotchas
1.0 0.98 0.94 rg
0.95 0.65 0.3 RG
1 w
40 215 515 255 re B

BT
/F1 10.5 Tf
0.7 0.25 0.05 rg
52 452 Td
(5. IMPORTANT ARCHITECTURE RULES & GOTCHAS) Tj
ET

BT
/F2 8.5 Tf
0.15 0.15 0.15 rg
52 432 Td
(1. No Trailing Slashes (APPEND_SLASH = False):) Tj
0 -11 Td
(   All /api/* routes must NOT include trailing slashes (e.g. /api/jobs, /api/attendance/check-in).) Tj
0 -14 Td
(2. User & Caller Identity Headers:) Tj
0 -11 Td
(   Identity is passed via X-User-Email and X-Actor-Email headers or JWT Bearer authorization header.) Tj
0 -14 Td
(3. Pre-built Frontend Assets:) Tj
0 -11 Td
(   The React SPA is pre-built in dist/dist/ and served via WhiteNoise at site root. If editing JS) Tj
0 -11 Td
(   bundles, modify files in dist/ or re-build the frontend into dist/dist/.) Tj
0 -14 Td
(4. Database Wall-Clock Timezone:) Tj
0 -11 Td
(   USE_TZ is False and timeutil uses Asia/Kolkata timezone by default to store naive timestamps.) Tj
0 -14 Td
(5. Passwords & Auth Structure:) Tj
0 -11 Td
(   Custom AppUser model handles authentication. Do NOT import django.contrib.auth.) Tj
0 -14 Td
(6. Offline AI Fallback:) Tj
0 -11 Td
(   If ANTHROPIC_API_KEY is not supplied, built-in offline question generators are used seamlessly.) Tj
ET

% Page 3 Footer
0.8 0.8 0.8 RG
0.5 w
40 50 m 555 50 l S

BT
/F2 8 Tf
0.5 0.5 0.5 rg
40 38 Td
(Eversoft HRMS Local Development Setup Guide) Tj
440 0 Td
(Page 3 of 3) Tj
ET
"@

$rawPages = @($p1, $p2, $p3)

# Build valid PDF with dynamic xref calculation
$writer = [System.IO.MemoryStream]::new()
$sw = [System.IO.StreamWriter]::new($writer, [System.Text.Encoding]::ASCII)

$offsets = [System.Collections.Generic.List[long]]::new()
$offsets.Add(0) # 0-indexed dummy

function Write-Obj($str) {
    $sw.Flush()
    $offsets.Add($writer.Position)
    $sw.Write($str)
    $sw.Flush()
}

$sw.Write("%PDF-1.4`n")
$sw.Flush()

# Object 1: Catalog
Write-Obj "1 0 obj`n<< /Type /Catalog /Pages 2 0 R >>`nendobj`n"

# Object 2: Pages
$kids = ""
for ($i = 0; $i -lt $rawPages.Count; $i++) {
    $pageNum = 3 + $i
    $kids += "$pageNum 0 R "
}
Write-Obj "2 0 obj`n<< /Type /Pages /Kids [$kids] /Count $($rawPages.Count) >>`nendobj`n"

# Page objects (3, 4, 5)
$contentObjStart = 3 + $rawPages.Count
for ($i = 0; $i -lt $rawPages.Count; $i++) {
    $pageNum = 3 + $i
    $contentObjNum = $contentObjStart + $i
    Write-Obj "$pageNum 0 obj`n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents $contentObjNum 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >> /F2 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> /F3 << /Type /Font /Subtype /Type1 /BaseFont /Courier >> >> >> >>`nendobj`n"
}

# Content stream objects
for ($i = 0; $i -lt $rawPages.Count; $i++) {
    $contentObjNum = $contentObjStart + $i
    $streamContent = $rawPages[$i]
    $streamBytes = [System.Text.Encoding]::ASCII.GetBytes($streamContent)
    $streamLen = $streamBytes.Length
    Write-Obj "$contentObjNum 0 obj`n<< /Length $streamLen >>`nstream`n$streamContent`nendstream`nendobj`n"
}

# xref
$sw.Flush()
$xrefStart = $writer.Position
$totalObjs = $offsets.Count

$sw.Write("xref`n0 $totalObjs`n")
$sw.Write("0000000000 65535 f `n")
for ($i = 1; $i -lt $totalObjs; $i++) {
    $sw.Write(("{0:D10} 00000 n `n" -f $offsets[$i]))
}

$sw.Write("trailer`n<< /Size $totalObjs /Root 1 0 R >>`nstartxref`n$xrefStart`n%%EOF`n")
$sw.Flush()

[System.IO.File]::WriteAllBytes($outputPath, $writer.ToArray())
Write-Host "PDF generated successfully at $outputPath"
