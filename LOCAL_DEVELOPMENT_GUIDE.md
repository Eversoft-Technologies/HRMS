# Eversoft HRMS - Local Development Guide

Complete guide for setting up, running, testing, and troubleshooting the **Eversoft HRMS** application in a local development environment.

---

## 1. System Overview & Architecture

- **Backend**: Python (3.10 – 3.12), Django 5.x, Django REST Framework (DRF), Django Channels & Daphne (ASGI for WebSockets).
- **Database**: MySQL 5.7+ / 8.x via `PyMySQL` connector (or local MySQL instance on port 3306).
- **Frontend**: Single Page Application (React / Vite) pre-compiled and served directly from `dist/dist/` via WhiteNoise / Django SPA router.
- **Authentication**: Custom `AppUser` model with JWT + 2-step OTP verification, Google OAuth, and granular RBAC permissions.
- **AI Integrations**: Anthropic Claude API for dynamic interview question generation and HR assistant (with graceful offline fallbacks).

---

## 2. Prerequisites

Ensure you have the following installed on your system:

| Tool | Recommended Version | Notes |
| :--- | :--- | :--- |
| **Git** | 2.x+ | Command line or GitHub Desktop |
| **Python** | 3.10, 3.11, or 3.12 | Ensure `python` and `pip` are added to system `PATH` |
| **MySQL Server** | 5.7+ or 8.x | Running locally on `localhost:3306` (or via Docker / XAMPP) |
| **Terminal** | PowerShell / Bash / Zsh | Standard command line environment |

---

## 3. Step-by-Step Setup Guide

### Step 1: Clone the Repository & Navigate

```bash
git clone <repository-url>
cd HRMS
```

---

### Step 2: Create and Activate Python Virtual Environment

#### Windows (PowerShell):
```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```
*(If PowerShell restricts script execution, run: `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`)*

#### macOS / Linux:
```bash
python3 -m venv .venv
source .venv/bin/activate
```

---

### Step 3: Install Dependencies

```bash
python -m pip install --upgrade pip
pip install -r requirements.txt
```

---

### Step 4: Configure Environment Variables

1. Copy the example configuration file:
   ```bash
   # Windows PowerShell
   Copy-Item .env.example .env

   # Linux / macOS
   cp .env.example .env
   ```

2. Open `.env` in your editor and configure your database and development flags:
   ```ini
   # --- Core ---
   APP_ENV=development
   DJANGO_DEBUG=true
   DJANGO_SECRET_KEY=dev-secret-key-for-local-testing
   DJANGO_ALLOWED_HOSTS=localhost,127.0.0.1
   HRMS_TIME_ZONE=Asia/Kolkata

   # --- Database (MySQL) ---
   DB_NAME=hrms_system
   DB_USER=root
   DB_PASSWORD=your_mysql_password
   DB_HOST=localhost
   DB_PORT=3306

   # --- Local Development OTP Echo ---
   DEV_OTP_ECHO=true
   ```

---

### Step 5: Database Creation & Migrations

1. Ensure MySQL server is running and create the database:
   ```sql
   CREATE DATABASE IF NOT EXISTS hrms_system CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   ```

2. Run Django database migrations:
   ```bash
   python manage.py migrate
   ```

3. Seed RBAC roles and permissions (Required):
   ```bash
   python manage.py seed_rbac
   ```

4. *(Optional)* Seed initial admin or demo data:
   ```bash
   python manage.py seed_demo_data
   ```

---

### Step 6: Start the Development Server

#### Option A: ASGI Server via Daphne (Recommended — supports WebSockets & live features):
```bash
daphne -b 127.0.0.1 -p 8000 hrms_project.asgi:application
```

#### Option B: Standard Django runserver:
```bash
python manage.py runserver 127.0.0.1:8000
```

Open your browser and visit: **`http://localhost:8000`**

---

## 4. Authentication, Signup & Login Flow

### 1. Default Super Admin Login
If seeded with `seed_rbac` / `seed_demo_data`:
- **Email**: `admin@eversoftit.com`
- **Password**: `admin123`
- **Role**: `Super Admin`

### 2. Signing Up a New User
1. Navigate to `http://localhost:8000/login` and select the **Create Account / Sign Up** tab.
2. Fill in **Full Name**, **Email Address**, and **Password** (minimum 6 characters).
3. Click **Create Account**.
4. The user is persisted to MySQL in the `app_users` table and synced to `user_profiles` with an auto-generated Employee ID.

### 3. Signing In & Two-Step Verification (OTP)
1. On the login screen, enter your registered **Email**, **Password**, and select your assigned **Role** (e.g., `Super Admin`, `HR Manager`, `HR Executive`, `Employee`).
2. Click **Sign In**.
3. **Local OTP Verification**:
   - Because `DEV_OTP_ECHO=true` (or `DEBUG=True`), when local email sending is not configured, the backend automatically prints the 6-digit verification code directly to the **terminal / console output**:
     ```text
     [HRMS DEV OTP] Verification code for user@example.com (User Name): 123456
     ```
   - Enter the 6-digit code on the verification screen to complete sign-in.

---

## 5. Managing Secrets & API Keys

All sensitive keys, database credentials, and external API tokens are managed via the `.env` file in the project root. Below is how to generate and configure each secret.

### 1. Generating `DJANGO_SECRET_KEY`
The Django secret key is used for cryptographic signing, session integrity, and CSRF protection.

Run any of the following commands in your terminal to generate a secure 50-character random key:

#### Option A: Using Python `secrets` module (Recommended)
```bash
python -c "import secrets; print(secrets.token_urlsafe(50))"
```

#### Option B: Using Django's built-in key generator
```bash
python -c "from django.core.management.utils import get_random_secret_key; print(get_random_secret_key())"
```

#### Option C: Using PowerShell
```powershell
powershell -Command "[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Minimum 0 -Maximum 256 }))"
```

Paste the generated key into your `.env` file:
```ini
DJANGO_SECRET_KEY=your_generated_random_secret_key_here
```

---

### 2. Outbound Email & OTP Secrets

The application sends 2-step login verification codes, password reset links, and candidate interview emails. The mailer automatically prefers **Resend** when configured, and falls back to **SMTP** (e.g. Gmail).

#### Option A: Resend API (Recommended for Cloud / Staging)
1. Sign up at [resend.com](https://resend.com).
2. Go to **API Keys** -> Create a new API Key with "Sending access".
3. Verify your sending domain (or use `onboarding@resend.dev` for sandbox testing).
4. Add to `.env`:
   ```ini
   RESEND_API_KEY=re_123456789abcdef
   RESEND_FROM_EMAIL=hr@yourdomain.com
   RESEND_FROM_NAME=Eversoft HRMS
   ```

#### Option B: Gmail / SMTP (Recommended for Local Testing with Real Email)
1. Enable **2-Step Verification** on your Google Account: [myaccount.google.com/security](https://myaccount.google.com/security).
2. Go to **App Passwords**: [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
3. Create an app password named `Eversoft HRMS` and copy the generated 16-character password.
4. Add to `.env`:
   ```ini
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=your-email@gmail.com
   SMTP_PASSWORD=your16charapppass
   SMTP_FROM_EMAIL=your-email@gmail.com
   SMTP_FROM_NAME=Eversoft HRMS
   ```

#### Option C: Offline Console Echo (Zero Setup for Local Development)
If you don't want to configure email credentials locally, keep `DEV_OTP_ECHO=true` in `.env`. When email sending is skipped or fails, the 6-digit OTP code is automatically printed directly to your running terminal.
```ini
DEV_OTP_ECHO=true
```

---

### 3. AI Assistant & Resume Scoring (`ANTHROPIC_API_KEY`)

Used for Claude-powered resume scoring, dynamic interview question generation, and the HR AI chat assistant.

1. Create an account at [Anthropic Console](https://console.anthropic.com/).
2. Navigate to **API Keys** -> **Create Key**.
3. Add your key and desired models to `.env`:
   ```ini
   ANTHROPIC_API_KEY=sk-ant-api03-...
   ANTHROPIC_MODEL=claude-sonnet-4-5
   ANTHROPIC_VALIDATION_MODEL=claude-haiku-4-5
   ```
*(Note: If left blank, the app gracefully falls back to built-in rule-based scoring and offline template questions).*

---

### 4. Google OAuth 2.0 Sign-In (`GOOGLE_CLIENT_ID`)

Enables "Continue with Google" one-click sign-in for employees and administrators.

1. Open [Google Cloud Console](https://console.cloud.google.com/apis/credentials).
2. Create a new project (e.g. `Eversoft HRMS Local`).
3. Configure the **OAuth Consent Screen** (User Type: External / Internal).
4. Go to **Credentials** -> **Create Credentials** -> **OAuth client ID**:
   - Application Type: `Web application`
   - Authorized JavaScript origins: `http://localhost:8000` and `http://127.0.0.1:8000`
5. Copy the **Client ID** and add it to `.env`:
   ```ini
   GOOGLE_CLIENT_ID=1234567890-abcdef.apps.googleusercontent.com
   ```

---

### 5. LinkedIn Recruiter Integration (`LINKEDIN_CLIENT_ID` & `SECRET`)

Allows recruiters to connect their personal LinkedIn profiles to automatically cross-post newly created job listings.

1. Create an app at [LinkedIn Developer Portal](https://www.linkedin.com/developers/apps) (associated with a Company Page).
2. Under the **Products** tab, request access to:
   - `Sign In with LinkedIn using OpenID Connect`
   - `Share on LinkedIn`
3. Under the **Auth** tab, add your Authorized Redirect URL:
   - For public domain: `https://your-domain.com/api/auth/linkedin/callback`
   - For local development: Run a tunnel (`ngrok http 8000`), set `HRMS_PUBLIC_URL=https://your-ngrok-subdomain.ngrok-free.app`, and register `https://your-ngrok-subdomain.ngrok-free.app/api/auth/linkedin/callback` on LinkedIn.
4. Copy the credentials into `.env`:
   ```ini
   LINKEDIN_CLIENT_ID=your_linkedin_client_id
   LINKEDIN_CLIENT_SECRET=your_linkedin_client_secret
   ```
*(Note: If left blank, LinkedIn cross-posting stays dormant and job posting works normally without LinkedIn).*

---

### 6. JWT Token Lifetime & Auth Configuration

```ini
JWT_ACCESS_MINUTES=60   # Access token expiration (default: 60 minutes)
JWT_REFRESH_DAYS=7      # Refresh token lifetime (default: 7 days)
```

---

## 6. Helpful Commands & Development Reference

| Action | Command |
| :--- | :--- |
| **Check System Health** | `python manage.py check` |
| **Create New Migration** | `python manage.py makemigrations` |
| **Apply Migrations** | `python manage.py migrate` |
| **Seed Roles & Permissions** | `python manage.py seed_rbac` |
| **Create Superuser (Django Admin)** | `python manage.py createsuperuser` |
| **Run Django Tests** | `python manage.py test` |
| **Inspect DB via Django Shell** | `python manage.py shell` |

---

## 7. Troubleshooting & FAQs

### Q1: Login fails with `"Invalid email or password"` immediately after signup.
- **Cause**: The user was not persisted in the database. Ensure migrations are up to date (`python manage.py migrate`).
- **Fix**: Verify MySQL connection in `.env`. Unauthenticated signup is allowed and automatically synchronizes `AppUser` and `UserProfile`.

### Q2: Sign-in says `"The selected role does not match this account"`.
- **Cause**: The role selected in the login dropdown does not match the role saved on the user's account in `AppUser` / `roles`.
- **Fix**: Choose the corresponding role matching your account:
  - `admin` accounts -> Select **Super Admin**
  - `hr` accounts -> Select **HR Manager**
  - `recruitment` accounts -> Select **HR Executive**
  - `employee` accounts -> Select **Employee**

### Q3: Didn't receive an OTP email in local development.
- **Fix**: Check your running Django / Daphne terminal window. The 6-digit OTP is printed directly in the terminal log when `DEV_OTP_ECHO=true` or `DEBUG=True`.

### Q4: Database connection error `(2003, "Can't connect to MySQL server")`.
- **Fix**: Ensure your MySQL server service is started (e.g. via Windows Services, XAMPP, or `net start mysql`) and that `DB_HOST`, `DB_PORT`, `DB_USER`, and `DB_PASSWORD` in `.env` match your local MySQL installation.

### Q5: Static files or UI updates not reflecting.
- **Fix**: The frontend is pre-built in `dist/dist/`. Hard refresh your browser (`Ctrl + F5` or `Cmd + Shift + R`) to clear cached assets.

### Q6: Changes to `.env` are not taking effect.
- **Fix**: Django reads `.env` once at startup. Always **stop and restart** your development server (`daphne` or `python manage.py runserver`) whenever you modify `.env`.
