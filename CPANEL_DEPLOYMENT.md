# 🚀 Deploying HRMS to GoDaddy cPanel with GitHub Actions (CI/CD)

This guide walks you through setting up a fully automated CI/CD pipeline to deploy your Django & React HRMS application to **GoDaddy Shared Hosting (cPanel)** using **GitHub Actions**.

cPanel does not support running persistent processes like `gunicorn` on shared hosting. Instead, it uses **Phusion Passenger** (under CloudLinux) to manage and run Python (WSGI) web applications. 

---

## 🛠️ Step 1: Create a MySQL Database on GoDaddy cPanel

1. Log in to your **GoDaddy cPanel**.
2. Under the **Databases** section, click **MySQL® Database Wizard**.
3. Create a database (e.g., `yourusername_hrms`).
4. Create a database user (e.g., `yourusername_hrms_user`) with a strong password. Note these down.
5. Grant **All Privileges** to the user for the created database.
6. Note the database host. On GoDaddy, this is usually `127.0.0.1` or `localhost`.

---

## 🐍 Step 2: Setup Python App in cPanel

cPanel uses Phusion Passenger to host Python apps.

1. In cPanel, go to the **Software** section and click **Setup Python App**.
2. Click **Create Application**.
3. Set the following options:
   * **Python Version**: Select **3.10.x** or **3.11.x** (Django 5.0+ requires Python 3.10+).
   * **Application root**: Enter the folder path where the code will live, relative to your home directory (e.g., `public_html/hrms`).
   * **Application URL**: Choose your domain or subdomain (e.g., `hrms.yourdomain.com` or `yourdomain.com/hrms`).
   * **Application startup file**: Enter `passenger_wsgi.py`.
   * **Application Entry point**: Enter `application`.
   * **Passenger Log File** (optional but highly recommended): Enter `logs/passenger.log`.
4. Click **Create**.
5. Once created, cPanel will display a command to enter the virtual environment at the top. It looks like:
   ```bash
   source /home/yourusername/virtualenv/public_html/hrms/3.10/bin/activate && cd /home/yourusername/public_html/hrms
   ```
   *Note the path to this virtualenv, as we will use it in our CI/CD pipeline.*

---

## 🔑 Step 3: Enable SSH Access and Generate Keys

To automate deployments, GitHub Actions needs SSH access to your cPanel hosting.

1. In cPanel, go to **Security** -> **SSH Access**.
2. Click **Manage SSH Keys**.
3. Click **Generate a New Key**:
   * Name: `id_github_actions` (or keep default `id_rsa`).
   * Enter a strong password (you will decrypt it when downloading).
   * Key type: `RSA`.
   * Key size: `2048` or `4096`.
4. Once generated, go back to the SSH keys list and click **Manage** next to the public key, then click **Authorize** (this adds it to `authorized_keys`).
5. Next, click **View/Download** next to the **Private Key**:
   * Enter the passphrase to convert it to PPK/OpenSSH format if prompted.
   * View and copy the entire private key text block (begins with `-----BEGIN OPENSSH PRIVATE KEY-----` or `-----BEGIN RSA PRIVATE KEY-----`). We will add this to GitHub secrets.

---

## 🔐 Step 4: Configure GitHub Secrets

In your GitHub repository (where your code is pushed), go to **Settings** -> **Secrets and variables** -> **Actions** and add the following **Repository Secrets**:

| Secret Name | Value | Description |
| :--- | :--- | :--- |
| `SSH_PRIVATE_KEY` | `-----BEGIN RSA PRIVATE KEY----- ... -----END RSA PRIVATE KEY-----` | The private SSH key copied from cPanel in Step 3. |
| `REMOTE_HOST` | `yourdomain.com` or server IP address | The hostname of your GoDaddy cPanel server. |
| `REMOTE_USER` | `your_cpanel_username` | Your cPanel login username (used for SSH connection). |
| `REMOTE_PORT` | `22` | The SSH port. GoDaddy usually defaults to `22`. |
| `REMOTE_TARGET_DIR` | `public_html/hrms` | The app folder name under `/home/username/` (e.g. `public_html/hrms`). |

---

## 📝 Step 5: Configure Production Variables on Server

Create a file named `.env.production` in your application root folder on the GoDaddy server (e.g. at `/home/yourusername/public_html/hrms/.env.production`) using the cPanel File Manager or SSH. 

Since `passenger_wsgi.py` sets `DJANGO_ENV=production` automatically, Django will read this file:

```env
DJANGO_DEBUG=False
DJANGO_SECRET_KEY=use-a-long-random-string-here
DJANGO_ALLOWED_HOSTS=yourdomain.com,hrms.yourdomain.com,127.0.0.1

DB_NAME=yourusername_hrms
DB_USER=yourusername_hrms_user
DB_PASSWORD=your_strong_db_password
DB_HOST=127.0.0.1
DB_PORT=3306

# Email / SMTP Configurations
EMAIL_BACKEND=django.core.mail.backends.smtp.EmailBackend
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USE_TLS=True
EMAIL_HOST_USER=your_email@gmail.com
EMAIL_HOST_PASSWORD=your_app_specific_password
DEFAULT_FROM_EMAIL=your_email@gmail.com

# AI Settings (if key is empty, the system uses the local offline fallback)
# ANTHROPIC_API_KEY=your-api-key
```

---

## 🚀 How the CI/CD Pipeline Works

We have created two main configuration files in your repository:
1. `passenger_wsgi.py`: The entrypoint file that maps Phusion Passenger requests to Django's WSGI application. It automatically sets `DJANGO_ENV=production`.
2. `.github/workflows/deploy.yml`: The GitHub Actions pipeline file.

Every time you push changes to your `main` branch:

1. **GitHub Runner starts**: A virtual Ubuntu runner checkouts your codebase.
2. **Deploys Files**: It uses `rsync` over SSH to copy all files to the remote GoDaddy folder (`REMOTE_TARGET_DIR`), excluding directories like `.venv`, `node_modules`, and local SQLite databases.
3. **Executes SSH Post-Deploy Script**:
   * Navigates to the app root.
   * Activates the virtualenv setup by cPanel.
   * Upgrades dependencies from `requirements.txt`.
   * Runs database migrations: `python manage.py migrate --noinput`
   * Collects static assets: `python manage.py collectstatic --noinput`
   * **Restarts Phusion Passenger**: It touches `tmp/restart.txt`. On next request, Passenger detects this and restarts the WSGI processes, hot-reloading your application.

---

## 🔍 Troubleshooting

### 1. Phusion Passenger Error on First Page Load
If you receive a Passenger error page:
- Check the log file specified in your Python App settings (e.g. `/home/username/public_html/hrms/logs/passenger.log` or `/home/username/logs/passenger.log`).
- Common cause: Python virtual environment packages not loaded. You can verify that all packages are installed correctly by entering SSH, activating the virtualenv, and running `pip list`.

### 2. PyMySQL Database Connection Error
If you get `ImportError: No module named 'MySQLdb'` or similar:
Ensure `PyMySQL` is installed. In `hrms_project/__init__.py`, you should add the following configuration to make Django use PyMySQL as a replacement for standard `mysqlclient` (which requires compilation tools that aren't available on shared hosting):

```python
import pymysql
pymysql.install_as_MySQLdb()
```

Let's check if this is already in the project. If not, you can add it to `hrms_project/__init__.py`.

### 3. Missing Static Files
If the UI displays text but no styles/images:
Ensure `whitenoise` is configured under `MIDDLEWARE` in `settings.py` (which it is, directly below `SecurityMiddleware`), and that the static files have been correctly generated in `staticfiles/` via the `collectstatic` command.
