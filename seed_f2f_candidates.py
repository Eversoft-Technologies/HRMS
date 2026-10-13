"""Seed the F2F Interview demo candidates as real interview records.

The Schedule & Links tab pads its candidate list with five sample people
(Ravi Kumar, Ananya Singh, Vikram Nair, Priya Mehta, Arjun Das) that live only
inside the compiled React bundle. Because they never reach /api/interviews,
nothing in the database knows their resume, JD, platform or Eva's questions —
so the Candidate Details panel had nothing to show for them.

This upserts one InterviewLink per demo email with a resume, a JD and a set of
AI (Eva) questions. The app dedupes its list by email, so the DB record wins
over the built-in sample from then on.

    python seed_f2f_candidates.py            # upsert the five demo candidates
    python seed_f2f_candidates.py --remove   # delete them again

Idempotent: re-running updates the same rows.
"""
import json
import os
import sys
from datetime import date, timedelta

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "hrms_project.settings")
django.setup()

from api.models import InterviewLink  # noqa: E402

today = date.today()


def d(days):
    return (today + timedelta(days=days)).isoformat()


JD_FRONTEND = """Position: Senior Frontend Engineer
Department: Engineering — Platform Team
Location: Remote / Hybrid (Bangalore)

Required Skills:
• React 18+ with hooks & context patterns
• Redux Toolkit / Zustand for state management
• TypeScript (strict mode preferred)
• REST APIs & GraphQL integration
• Node.js (BFF layer)
• AWS Amplify or similar cloud frontend services

Experience: 5+ years in product-focused frontend roles
Domain: B2B SaaS or fintech preferred
Nice to have: Micro-frontends, Web Performance optimization"""

JD_DATA = """Position: Data Scientist
Department: Analytics & ML
Location: Hyderabad (Hybrid)

Required Skills:
• Python (pandas, scikit-learn, PyTorch or TensorFlow)
• SQL and data modelling on a warehouse (BigQuery / Snowflake)
• Experiment design, A/B testing, causal inference basics
• Feature engineering and model monitoring in production

Experience: 3+ years shipping models that drive product decisions
Nice to have: LLM fine-tuning, MLOps (MLflow, Airflow)"""

JD_DEVOPS = """Position: DevOps Engineer
Department: Platform Infrastructure
Location: Remote (India)

Required Skills:
• Kubernetes (EKS/GKE), Helm, Docker
• Terraform / IaC, GitHub Actions or GitLab CI
• Observability: Prometheus, Grafana, OpenTelemetry
• Linux, networking, cost optimisation on AWS

Experience: 4+ years running production workloads
Nice to have: Security hardening, SRE on-call experience"""

JD_PM = """Position: Product Manager
Department: Product — HR Platform
Location: Bangalore

Responsibilities:
• Own the roadmap for onboarding and attendance modules
• Write PRDs, run discovery with HR admins, prioritise with engineering
• Define success metrics and run experiments

Experience: 4+ years in B2B SaaS product management
Nice to have: HR-tech or payroll domain knowledge"""

JD_BACKEND = """Position: Backend Engineer
Department: Engineering — Core Services
Location: Hybrid (Chennai)

Required Skills:
• Python (Django / FastAPI) or Go
• PostgreSQL / MySQL schema design, query tuning
• REST & async messaging (Kafka / SQS)
• Testing, CI/CD, containerised deployments

Experience: 3+ years building production APIs
Nice to have: Multi-tenant SaaS, RBAC and audit logging"""

CANDIDATES = [
    dict(
        name="Ravi Kumar", initials="RK", role="Sr. Frontend Engineer",
        email="ravi.kumar@email.com", phone="+91 98765 43210", score=94,
        status="Scheduled", interview_date=d(2), interview_time="10:00",
        platform="Microsoft Teams",
        link="https://teams.microsoft.com/l/meetup-join/eversoft-rk",
        jd_text=JD_FRONTEND,
        resume_text="""Ravi Kumar — ravi.kumar@email.com | LinkedIn
6 years of experience building scalable frontend applications.

Skills: React, Redux Toolkit, TypeScript, Node.js, REST APIs, Webpack, Jest, Git
Experience:
• Flipkart (2021–present): Led frontend for payments dashboard, React + Redux
• Razorpay (2019–2021): Built merchant onboarding flow, TypeScript + React hooks
• Startup (2018–2019): Full-stack, Node.js + React

Education: B.Tech Computer Science, IIT Bombay 2018""",
        questions=[
            "Walk me through the payments dashboard you led at Flipkart — what was the measurable business impact?",
            "Why choose Redux Toolkit over Zustand or React context for production state? What trade-offs did you accept?",
            "It's 2 AM and the dashboard's p95 latency has tripled. How do you diagnose it, mitigate it, and keep stakeholders informed?",
            "Describe a time you disagreed with a technical architect. Use the STAR format.",
            "Coding challenge: implement a rate limiter that queues excess async calls (N calls per window).",
            "What is your current shift availability for US-timezone overlap, and your work authorisation status?",
        ],
    ),
    dict(
        name="Ananya Singh", initials="AS", role="Data Scientist",
        email="ananya.singh@email.com", phone="+91 87654 32109", score=88,
        status="Pending", interview_date=d(4), interview_time="11:30",
        platform="Zoom", link=None,
        jd_text=JD_DATA,
        resume_text="""Ananya Singh — ananya.singh@email.com
4 years turning product data into shipped models.

Skills: Python, pandas, scikit-learn, PyTorch, SQL (BigQuery), Airflow, MLflow
Experience:
• Swiggy (2022–present): Built delivery-time prediction model (MAE down 18%)
• Zomato (2020–2022): Ran restaurant-ranking A/B tests, causal uplift analysis

Education: M.Sc. Statistics, ISI Kolkata 2020""",
        questions=[
            "Tell me about the delivery-time model at Swiggy — how did you validate an 18% MAE improvement wasn't leakage?",
            "How do you decide between an A/B test and a quasi-experimental method for a ranking change?",
            "A model's live accuracy drops sharply on Monday morning. What do you check first?",
            "Describe a time your analysis was challenged by a stakeholder. How did you respond?",
            "Which feature-engineering step are you proudest of, and why did it matter?",
        ],
    ),
    dict(
        name="Vikram Nair", initials="VN", role="DevOps Engineer",
        email="vikram.nair@email.com", phone="+91 76543 21098", score=82,
        status="Pending", interview_date=None, interview_time=None,
        platform=None, link=None,
        jd_text=JD_DEVOPS,
        resume_text="""Vikram Nair — vikram.nair@email.com
5 years keeping production platforms boring.

Skills: Kubernetes (EKS), Terraform, Helm, GitHub Actions, Prometheus, Grafana, AWS
Experience:
• Freshworks (2021–present): Migrated 40+ services to EKS, cut infra cost 27%
• Chargebee (2019–2021): Built CI/CD pipelines, on-call SRE rotation

Education: B.E. Computer Science, Anna University 2019""",
        questions=[
            "Walk me through the EKS migration at Freshworks — how did you sequence 40 services without downtime?",
            "Where did the 27% cost saving actually come from? What would you do differently?",
            "A deploy goes out and pods start CrashLooping in one region only. What's your runbook?",
            "How do you decide what deserves an alert versus a dashboard panel?",
            "Describe a security hardening change you drove and how you got engineering buy-in.",
        ],
    ),
    dict(
        name="Priya Mehta", initials="PM", role="Product Manager",
        email="priya.mehta@email.com", phone="+91 65432 10987", score=71,
        status="Completed", interview_date=d(-3), interview_time="14:00",
        platform="Microsoft Teams",
        link="https://teams.microsoft.com/l/meetup-join/eversoft-pm",
        outcome="Selected",
        jd_text=JD_PM,
        resume_text="""Priya Mehta — priya.mehta@email.com
6 years of B2B SaaS product management.

Experience:
• Darwinbox (2021–present): PM for onboarding & attendance; activation up 22%
• Keka (2018–2021): Owned payroll compliance features across 3 countries

Education: MBA, IIM Indore 2018; B.Tech, NIT Trichy 2015""",
        questions=[
            "Tell me about the onboarding activation lift at Darwinbox — what did you change and how did you measure it?",
            "How do you prioritise a compliance request from one large customer against roadmap features?",
            "Describe a launch that missed its target. What did you learn?",
            "How do you work with engineering when an estimate doubles mid-sprint?",
            "What metric would you put on the wall for an attendance module, and why?",
        ],
    ),
    dict(
        name="Arjun Das", initials="AD", role="Backend Engineer",
        email="arjun.das@email.com", phone="+91 54321 09876", score=79,
        status="Completed", interview_date=d(-2), interview_time="15:30",
        platform="Zoom",
        link="https://teams.microsoft.com/l/meetup-join/eversoft-ad",
        outcome="Waitlisted",
        jd_text=JD_BACKEND,
        resume_text="""Arjun Das — arjun.das@email.com
4 years building production APIs.

Skills: Python, Django, FastAPI, PostgreSQL, Redis, Kafka, Docker, pytest
Experience:
• PhonePe (2022–present): Multi-tenant ledger service, 30k rps, RBAC + audit log
• Juspay (2020–2022): Payment webhooks pipeline on Kafka

Education: B.Tech IT, VIT Vellore 2020""",
        questions=[
            "Describe the multi-tenant ledger at PhonePe — how do you isolate tenants at the data layer?",
            "Django ORM vs raw SQL for a hot path at 30k rps: how do you decide?",
            "A webhook consumer starts double-processing events. How do you make it idempotent?",
            "Tell me about a schema migration that went wrong and how you recovered.",
            "Coding challenge: design an audit-log table and the query for 'who changed this record last'.",
        ],
    ),
]


def upsert():
    for c in CANDIDATES:
        questions = c.pop("questions")
        obj, created = InterviewLink.objects.update_or_create(
            email=c["email"],
            defaults=dict(
                c,
                interview_questions=json.dumps(questions),
                interview_type="Technical",
                interviewer="Eva AI",
                duration="45 min",
                email_sent=bool(c.get("link")),
                tech_question_count=3, hr_question_count=3, final_question_count=3,
                coding_difficulty=["Medium"],
            ),
        )
        print(("created" if created else "updated"), obj.id, obj.name, obj.email)


def remove():
    emails = [c["email"] for c in CANDIDATES]
    n, _ = InterviewLink.objects.filter(email__in=emails).delete()
    print("deleted", n, "rows")


if __name__ == "__main__":
    if "--remove" in sys.argv:
        remove()
    else:
        upsert()
