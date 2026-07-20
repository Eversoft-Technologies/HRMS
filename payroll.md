# Payroll Module — Development Plan

> A phased plan to build a Payroll module for the HRMS, grounded in the existing
> Django (`api` app) + prebuilt React SPA architecture. Employees are identified by
> **email** (there is no roster table); money is in USD (US tax context assumed).

---

## 1. Where we stand today

The current "payroll" is **onboarding bank-detail capture only** — there is no salary
amount, no pay run, and no payslip anywhere in the system.

**Already in our favor:**

1. **RBAC module is pre-wired.** `api/management/commands/seed_rbac.py` already seeds a
   `Payroll` module (order 6, `credit-card` icon), a `Payroll Group`, the permission
   codes `payroll.view` / `payroll.manage`, and a `Payroll Admin` role. The sidebar slot
   exists.
2. **Calculation inputs already exist and are clean:**
   - `EmployeeAttendance` — `worked_minutes`, `overtime_minutes`, `late_minutes`
   - `LeaveRequest` — approved leave days
   - `Overtime` / `OvertimeBalance` — `comp_off_hours` vs `cash_payout_hours`
3. **Clear templates to copy** for every layer:
   - View module → `api/onboarding_views.py`
   - Permission migration → `api/migrations/0027_onboarding_permissions.py`
   - Calc-service layer → `api/services/overtime_service.py`

**Genuinely missing (this is the module):** compensation records, a pay-run engine, and
payslips.

**Existing onboarding payroll artifacts** (reference only — they are *candidate*-scoped,
not *employee*-scoped):
- `PayrollInformation` — `bank_name`, `account_number`, `routing_number`, `tax_state`,
  `direct_deposit`
- `PayrollForm` / `CandidateFormSubmission` — admin PDF templates + signed submissions

---

## 2. Decisions to lock first

These are product decisions that change the build. Recommended default in **bold**.

| Decision | Options | Recommendation |
|---|---|---|
| **Pay basis** | Fixed salary vs. attendance-driven (LOP for unpaid days, hourly from `worked_minutes`) | **Fixed monthly salary with LOP deduction** for unapproved absence — uses attendance data without a full hourly engine. |
| **Pay frequency** | Monthly / semi-monthly / bi-weekly | **Monthly** for v1; keep it a field so other cadences come later. |
| **Tax model** | Full US withholding engine (federal tables + state + FICA/Medicare) vs. configurable percentage/flat deductions | **Configurable deduction components** in v1. A correct US tax engine is a separate multi-month effort — model deductions generically now, integrate real tax calc later. |
| **Payslip delivery** | Server-rendered PDF (base64-in-row, house style) vs. HTML-only view | **Server-rendered PDF stored base64**, matching `PayrollForm` / `CandidateFormSubmission`. |

> Market assumed to be **US** (`tax_state` / `routing_number` fields, not IFSC/PF/ESI).
> If any market is India/other, the deduction model changes materially.

---

## 3. New data models

All in `api/models.py`, matching house style: keyed on **`email`** (no roster table),
explicit `db_table` + `ordering`, INT PKs, `CharField` status with inline-comment enums,
`created_at`/`updated_at`, **`DecimalField` for money** (never float).

### `EmployeeCompensation`  (`employee_compensation`)
Effective-dated — a new row supersedes the old, so raises keep history.
- `email` (indexed)
- `pay_type` — `salaried | hourly`
- `pay_frequency` — `monthly | semimonthly | biweekly | weekly`
- `base_amount` / `annual_ctc` (Decimal)
- `currency` (default `USD`)
- `effective_from`, `effective_to` (null = open-ended)
- `status` — `active | inactive`
- `created_at`, `updated_at`

### `PayComponent`  (`pay_components`) — catalogue
- `code` (unique), `name`
- `type` — `earning | deduction`
- `calc_type` — `fixed | percent_of_base | formula`
- `rate` / `default_amount`
- `is_taxable`, `is_active`

### `EmployeePayComponent`  (`employee_pay_components`) — per-employee overrides
- `email`, `component` (FK), `amount`/`rate` override, `effective_from`/`effective_to`

### `PayrollRun`  (`payroll_runs`)
- `period_label` (e.g. `2026-07`), `period_start`, `period_end`, `pay_date`
- `status` — `draft | processing | pending_approval | approved | paid | cancelled`
- `frequency`
- `created_by`, `approved_by`, `approved_at`
- roll-up totals: `total_gross`, `total_deductions`, `total_net`, `employee_count`
- `notes`

### `Payslip`  (`payslips`)
- `run` (FK), `email`, `employee_name`
- snapshot: `worked_days`, `paid_days`, `lop_days`, `overtime_hours`
- `gross_earnings`, `total_deductions`, `net_pay` (Decimal)
- `earnings` (JSON `[{code,label,amount}]`), `deductions` (JSON)
- `status` — `draft | approved | paid`
- PDF: `file_name`, `file_mime`, `file_data` (base64), generated lazily
- `unique_together (run, email)`

### `PayrollSetting`  (`payroll_settings`) — key/value config
Mirrors `OnboardingSetting`. Holds tax rates, pay schedule, statutory config — so new
settings never need a migration.

> Bank details: v1 adds **employee-scoped** bank fields (on `EmployeeCompensation` or a
> small `EmployeeBankAccount`). The onboarding `PayrollInformation` is candidate-scoped
> and not reused directly.

---

## 4. Build phases

### Phase 1 — Compensation foundation
- New models above + migration.
- CRUD in a new `api/payroll_views.py` (function-based views, `path('payroll/...')`, **no
  trailing slash**): `payroll/compensation`, `payroll/compensation/<pk>`,
  `payroll/components`, `payroll/components/<pk>`.
- `ModelSerializer`s in `api/serializers.py` (camelCase wire format).
- **Deliverable:** admins can set salaries & pay components. No runs yet.

### Phase 2 — Pay-run engine (the core)
- `api/services/payroll_service.py` (mirrors `overtime_service.py`): for each active
  employee, snapshot attendance / approved-leave / OT for the period, apply compensation +
  components, compute **LOP → gross → deductions → net**, write draft `Payslip` rows.
- `POST payroll/runs` creates a draft run; `GET payroll/runs/<pk>` returns the run with its
  payslips.
- **Deliverable:** a draft run with inspectable per-employee payslips.
- **Highest-risk phase** — edge cases: mid-period joiners/leavers, unpaid leave, OT payout
  vs comp-off, proration.

### Phase 3 — Approval workflow + PDF
- Run status transitions: `payroll/runs/<pk>/process` → `/approve` → `/mark-paid`.
- Payslip PDF generation (base64, house style).
- Append-only audit log (copy the `OnboardingActivityLog` pattern).
- Notifications via the existing `notification_service`.
- **Deliverable:** an approvable, finalizable payroll cycle.

### Phase 4 — Permissions + self-service
- Extend the seeded Payroll module with granular codes: `payroll.run`, `payroll.approve`,
  `payroll.payslip.view_own`.
- Ship them via a **data migration** modeled on `0027_onboarding_permissions.py` **and**
  update `seed_rbac.py`.
- Employee "My Payslips" via `@require_perm(..., or_self=True)`.
- **Important:** `seed_rbac` is commented out in `deploy.yml`, so permissions **must** ship
  as a migration to reach production (migrations run automatically on deploy).

### Phase 5 — Frontend
- Add `dist/dist/assets/hrms-payroll.js` — the same `window.fetch`-patching helper pattern
  as `hrms-onboarding.js`. **There is no React source tree to rebuild.**
- Screens: Compensation setup, Run-payroll wizard, Payslip register, employee My-Payslips.
- Sidebar module is already seeded (order 6, `credit-card`).

### Phase 6 — Reports / exports
- Payroll register, bank-transfer file (CSV / ACH), period tax summary.

---

## 5. Watch-outs specific to this stack

- **`USE_TZ = False`** and naive datetimes — period-boundary math must stay naive to match
  attendance rows.
- **Passwords are plain-text** in `app_users` by design; keep payroll's sensitive fields
  (bank / SSN) out of any "SHOW"-style reveal and mask them in serializers.
- **`@require_perm` fails *open*** when no `X-User-Email` header is present. Payroll is
  money — consider requiring an identified actor on run/approve endpoints.
- **Money as `DecimalField`, never float** — the OT models use `FloatField` for *hours*
  (fine for hours, not for currency).

---

## 6. Convention cheat-sheet

| Layer | Pattern | Template file |
|---|---|---|
| Views | Function-based, `@api_view` + `@require_perm`, branch on `request.method` | `api/onboarding_views.py` |
| URLs | Explicit `path('payroll/...')`, **no trailing slash**, detail as `<int:pk>` | `api/urls.py` |
| Serializers | `ModelSerializer`, camelCase wire format | `api/serializers.py` |
| Permissions | Data migration (`get_or_create`, idempotent) + `seed_rbac.py` update | `api/migrations/0027_onboarding_permissions.py` |
| Services | Business logic in `api/services/` | `api/services/overtime_service.py` |
| Files | base64-in-row `TextField` (no storage backend configured) | `PayrollForm` / `CandidateFormSubmission` |

**Data inputs for calculation:** `EmployeeAttendance` (worked / OT / late minutes),
`LeaveRequest` (approved days), `Overtime` / `OvertimeBalance`.
