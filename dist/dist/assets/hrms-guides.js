/**
 * hrms-guides.js — "Help & Guides": step-by-step guides for Payroll,
 * Tax & Statutory and Attendance Policies.
 *
 *   /help/guides            all guides (left list, search, sections)
 *   /help/guides/<id>       one guide (deep link)
 *
 * Also a floating "📘 Guide" button on the related pages that opens the
 * matching guide in a side drawer. Static, hand-written content only (no
 * user data), rendered from the GUIDES table below. Uses HRMSSidecar; never
 * touches React-owned DOM.
 */
(function () {
  'use strict';
  if (window.__hrmsGuides) return;
  window.__hrmsGuides = true;

  /* ── content ──────────────────────────────────────────────────────────
     Each section: { h: heading, p: [paragraphs/HTML], steps: [..], tip, links: [[label, path]] } */
  var GUIDES = [
    {
      id: 'payroll', title: 'Payroll', icon: '💼', perms: ['payroll.view', 'payroll.manage'],
      summary: 'Set up salaries, run the monthly payroll, get it approved, pay employees and send payslips.',
      who: 'Payroll Admin, HR Manager, Finance Manager, Super Admin',
      sections: [
        { h: 'Where to find it',
          p: ['Sidebar → <b>Payroll Run</b>. One tab strip at the top switches between <b>Payroll Run</b>, <b>Tax &amp; Statutory</b>, <b>Payouts &amp; Banking</b>, <b>US Payroll</b> and <b>Separations &amp; F&amp;F</b>.'],
          links: [['Open Payroll Run', '/payroll/run']] },
        { h: '1. One-time setup',
          steps: [
            '<b>Employee Salaries</b> tab: check every employee\'s annual CTC, PAN, UAN, bank account and IFSC. A new employee gets a salary record automatically when they are created.',
            '<b>Salary Structures</b> tab: check how CTC splits into Basic, HRA and allowances (a default structure exists).',
            '<b>Tax &amp; Statutory → Tax tables</b>: confirm the income-tax slabs for the financial year (they are pre-filled and marked “verify”).',
            '<b>Payouts &amp; Banking → Integrations</b> (Super Admin): add the ICICI/HDFC bank keys, or leave the bank in <b>test mode</b> and pay with the bank CSV.'
          ],
          tip: 'PAN, UAN, PF and bank account numbers are stored encrypted and shown masked (AB•••••34F, ••••1234). Revealing a full number needs permission and a fresh sign-in, and is logged.' },
        { h: '2. Before running payroll each month',
          steps: [
            'Make sure attendance is complete: missed punches regularized, leave approved. Short days count as half-day / absent and become Loss of Pay (see the Attendance Policies guide).',
            'Approve pending <b>overtime</b> (Workspace → Overtime &amp; Comp-off) — only approved overtime is paid.',
            'Approve <b>expense claims</b> and <b>loans/advances</b> you want in this month (they are added automatically).'
          ] },
        { h: '3. Run the payroll',
          p: ['Payroll Run → <b>⚡ Process Payroll Wizard</b>:'],
          steps: [
            '<b>Select period</b> (e.g. 2026-11, start and end dates).',
            '<b>Attendance</b> is pulled in: paid days and Loss of Pay days per employee.',
            '<b>Calculate</b>: earnings, PF, ESI, PT, TDS (from each employee\'s tax regime and verified declarations), reimbursements, loan EMIs, leave encashment (January) and attendance penalties.',
            '<b>Validate</b>: fix warnings such as missing bank details or very high Loss of Pay.',
            '<b>Review</b> employee by employee; add bonuses or deductions as adjustments.',
            '<b>Submit for approval</b> with a note.'
          ] },
        { h: '4. Approve',
          steps: [
            'Approvers open <b>Approvals</b>. A Finance Manager or Super Admin approval (or three approvals) finalises the run. The approver and level always come from the signed-in user.',
            'Approvers can also <b>Request corrections</b> or <b>Reject</b> (a reason is required).',
            'Payslips are created when the run is approved.'
          ] },
        { h: '5. Pay the salaries',
          p: ['<b>Option A — bank file:</b> Payment Disbursal tab → download the NEFT/bank CSV (needs a fresh sign-in) → upload it in your bank portal → mark payments paid.',
              '<b>Option B — bank API</b> (Payouts &amp; Banking), maker-checker:'],
          steps: [
            '<b>Prepare</b> (Payroll Admin): choose the approved run → Prepare. Bad bank details are listed with “Fix bank details”.',
            '<b>Release</b> (a <i>different</i> person — HR Manager): Release → enter the emailed one-time code.',
            'The bank confirms each payment with a UTR; failures show the reason. <b>Re-queue</b> a failed payment with corrected bank details — no need to re-run payroll.'
          ],
          tip: 'The person who prepares a batch can never release it.' },
        { h: '6. Payslips and alerts',
          steps: [
            'Separations &amp; F&amp;F → <b>Email payslips for a pay run</b> sends password-protected PDF payslips (password: first 4 letters of the name in capitals + date of birth as DDMM, or PAN).',
            'Employees also download payslips from <b>Workspace → My Pay &amp; Loans</b>.',
            'With Twilio/Slack configured, employees get an SMS/WhatsApp when the salary is credited, and approvers get Slack approval cards.'
          ],
          links: [['Payouts & Banking', '/payroll/banking'], ['Separations & F&F', '/payroll/separations']] },
        { h: 'When someone leaves (Full & Final)',
          steps: [
            'Separations &amp; F&amp;F → <b>Initiate</b>: resignation date, last working day, notice served.',
            'Each department clears the checklist (IT assets are added automatically and recovered through IT Assets).',
            '<b>Compute</b>: salary for days worked + gratuity (after 5 years) + leave encashment − notice shortfall − loans − recoveries − TDS.',
            'A <i>different</i> HR person approves → F&amp;F statement and No-Dues certificate → mark paid.'
          ] },
        { h: 'Who does what',
          table: [['Role', 'Main jobs'],
                  ['Payroll Admin', 'Runs the wizard, prepares payouts, generates filings'],
                  ['HR Manager', 'Verifies tax proofs, releases payouts, approves F&amp;F'],
                  ['Finance Manager / Super Admin', 'Final pay-run approval; Super Admin sets up bank, Twilio and Slack'],
                  ['Employee', 'My Pay &amp; Loans (payslips, claims, loans), Tax Declaration']] }
      ]
    },
    {
      id: 'tax', title: 'Tax & Statutory', icon: '🧾', perms: ['payroll.view', 'payroll.tax.manage', 'payroll.tax.verify', 'payroll.statutory'],
      summary: 'Income-tax regimes and declarations, proof verification, monthly TDS, and the EPFO / ESIC / 24Q / Form 16 files.',
      who: 'Employees (declarations), HR / Payroll Admin (verification and filings)',
      sections: [
        { h: 'Where to find it',
          p: ['Employees: Workspace → <b>Tax Declaration</b>. HR: Payroll → <b>Tax &amp; Statutory</b> (tabs: Tax tables, Declarations, Statutory files, TDS preview).'],
          links: [['My Tax Declaration', '/my-pay/tax'], ['Tax & Statutory (HR)', '/payroll/compliance']] },
        { h: 'For employees: choose your regime and declare',
          steps: [
            'Pick the <b>financial year</b>. The page shows an <b>Old vs New regime</b> estimate for your own salary side by side.',
            'Choose your regime (the New regime is the default). Once HR locks it, or a payroll in that year has used it, only HR can change it.',
            'Declare investments: <b>80C</b> (PPF, ELSS, LIC, tuition, home-loan principal — up to ₹1.5 L), <b>80CCD(1B)</b> NPS (₹50k), <b>80D</b> health insurance, <b>24(b)</b> home-loan interest (₹2 L), and <b>HRA</b> (monthly rent, metro or not, landlord name; landlord PAN is required when rent is over ₹1 L a year).',
            'Submit. Upload proofs (PDF/PNG/JPEG, up to 5 MB) during the <b>proof window</b> (default 1 Jan – 28 Feb).'
          ],
          tip: 'Deductions only reduce tax under the Old regime. Until proofs are verified, TDS uses what you declared; after verification it uses the verified amounts.' },
        { h: 'For HR: verify and lock',
          steps: [
            '<b>Declarations</b> tab: open each submitted declaration, set the verified amount for each item (never more than declared), accept or reject proofs with a note.',
            '<b>Lock</b> verified declarations (or “Lock all verified”) before the year-end TDS.',
            'Change the proof window dates in the same tab if needed.'
          ] },
        { h: 'How monthly TDS is worked out',
          p: ['Every payroll run, for each Indian employee: projected yearly taxable income (this month × months left + what was already paid this year) − standard deduction − allowed deductions → tax by the chosen regime\'s slabs, 87A rebate (with marginal relief), surcharge and 4% cess → minus TDS already deducted → spread over the remaining months. <b>TDS preview</b> shows the full working for any employee.'],
          tip: 'Slab values are editable per financial year in Tax tables and must be checked against the current Finance Act.' },
        { h: 'Statutory files (HR, fresh sign-in needed)',
          table: [['File', 'When', 'What to do with it'],
                  ['EPFO ECR', 'Monthly', 'Upload the #~# text file on the EPFO portal. Invalid UANs are listed first.'],
                  ['ESIC', 'Monthly', 'Upload the CSV for employees earning ≤ ₹21,000. Add missing IP numbers first.'],
                  ['Form 24Q', 'Quarterly', 'Import into NSDL\'s Return Preparation Utility, add challan details, validate with the File Validation Utility.'],
                  ['Form 16', 'Yearly', 'Part B is generated here; upload Part A from TRACES and attach it.']],
          p: ['Every generated file is kept in the history list and can be downloaded again.'] },
        { h: 'US payroll (W-4, W-2, 1099)',
          p: ['Payroll → <b>US Payroll</b>: employees fill their W-4 at Workspace → W-4 (US); HR maintains federal/state tables, pay calendars (bi-weekly, semi-monthly), contractor payments, and generates W-2 / 1099-NEC at year end. The CFO dashboard shows all payroll costs in one currency.'],
          links: [['US Payroll', '/payroll/us'], ['My W-4', '/my-pay/w4']] }
      ]
    },
    {
      id: 'attendance', title: 'Attendance, WFH & Remote', icon: '📍',
      summary: 'Checking in and out at the office, from home or remote; locations and geo-fencing; shifts; automatic check-out when you leave the office; and what to do when you forget to check out.',
      who: 'Everyone (the last section is for HR / admins)',
      sections: [
        { h: 'Where to find it',
          p: ['Employees → <b>Check In / Out</b> is where you check in and out, ask for work from home, fix a missed punch and ask for short leave. Your <b>home location</b> is in your profile (HRIS → <b>Work Setup</b>).',
              'HR sets everything up from the <b>Attendance Settings</b> button on the Check In / Out page: Live Map, Office Locations, Auto Check-out &amp; Network, Shifts, Off-site Approvals, Work Arrangements and Recalculate Hours.'],
          links: [['Check In / Out', '/employees/checkin'], ['Attendance', '/employees/attendance']] },
        { h: 'Your work arrangement: office, hybrid or remote',
          table: [['Arrangement', 'What it means', 'Working from home on a day'],
                  ['<b>Onsite</b> (office)', 'You work from an office every day.', 'Only with an <b>approved WFH request</b> for that day.'],
                  ['<b>Hybrid</b>', 'Some days at home: either fixed weekdays (e.g. Mon &amp; Fri) or a number of days per week (counted Monday to Sunday).', 'On your home weekdays or within your weekly number; other days need a WFH request.'],
                  ['<b>Remote</b>', 'You work away from the office.', 'Every day.']],
          p: ['HR sets your arrangement (Attendance Settings → Work Arrangements) with a start date; you get a notification when it changes. A <b>rejected</b> WFH request always wins: you cannot work from home that day.'],
          tip: 'To ask for a day at home: Check In / Out → the WFH card → pick the dates and a reason. Your manager (or HR) approves it.' },
        { h: 'Register your home location (WFH / remote)',
          steps: ['Open your profile → <b>Work Setup</b> → set your home location while you are at home (“Use my location”). Your phone/browser must locate you to within 500 m.',
                  'No good GPS? Type the coordinates and add a note (at least 5 characters).',
                  'HR approves it. Until then it is <b>Pending</b> and is not used to verify you.',
                  'Moving house? Request a change with a reason. Your old home keeps working until HR approves the new one.'],
          tip: 'The home area is a circle of 200 m around the point by default (HR can set 50 – 1000 m). Moving between rooms or floors never counts as leaving.' },
        { h: 'Checking in',
          p: ['Every check-in needs your <b>location</b> (allow location access in the browser) unless you are on the <b>office Wi-Fi</b>. The browser looks for up to 15 seconds.'],
          table: [['Where you are', 'How it is checked'],
                  ['<b>At the office</b>', 'You must be inside an office location’s circle (HR sets the size, 200 m by default). A rough GPS reading gets extra allowance equal to its accuracy. On the office Wi-Fi you are verified even if GPS fails.'],
                  ['<b>Working from home</b> (approved WFH day)', 'Checked against your approved home location. Office Wi-Fi is never used for home.'],
                  ['<b>Remote employee</b>', 'Without an approved WFH request for the day, your check-in is checked against the office. Check in, then use <b>Switch to Remote</b> (it needs you inside your home area if you have one).'],
                  ['<b>Anywhere else</b> (client site, travelling)', 'You are asked for a <b>reason</b>. That sends an off-site request to HR; you are <b>not checked in yet</b>. Once HR approves, check in again.']],
          tip: 'Switch to Office / Switch to Remote during the day: Switch to Office needs you inside an office circle or on the office Wi-Fi.' },
        { h: 'What the check-in messages mean',
          table: [['You see', 'What to do'],
                  ['Location required / location blocked', 'Allow location for this site in the browser, or connect to the office Wi-Fi.'],
                  ['You are X m from the office — give a reason', 'You are outside the office circle. Move closer, or give a reason to ask HR for an off-site approval.'],
                  ['Off-site approval requested / pending', 'HR has your request. Check in again after it is approved.'],
                  ['Off-site request rejected', 'You cannot check in off-site today; checking in inside the office still works.'],
                  ['Work from home needs approval', 'Ask for WFH on the WFH card first.'],
                  ['Re-check-in needs approval', 'You were checked out automatically today. Give a reason; your manager approves the extra time (see below).'],
                  ['Already checked in', 'Last night’s night-shift session is still open. Check out first.']] },
        { h: 'Checking out',
          p: ['Press <b>Check out</b> on the Check In / Out page. No location is needed; if your location is available it only labels the timeline (Home, the office name, “Unverified Location”).',
              'Leaving early or working late is measured against your shift (night shifts end the next morning). Overtime starts after the shift’s overtime threshold (9 h by default).'] },
        { h: 'Automatic check-out when you leave the office',
          p: ['Only for sessions that <b>started at the office</b>. Never for WFH, remote, off-site or approval-only days, and never while you are on the office Wi-Fi.'],
          steps: ['While the Check In / Out page is open, your location is checked every 5 minutes (every minute once you seem to be outside).',
                  'If you stay outside the office for <b>10 minutes</b> (HR can change this), a full-screen <b>10-second warning with a beeping sound</b> appears. If sound is blocked the screen flashes and the phone vibrates.',
                  'Back inside? Press <b>“I’m back — re-check location”</b>.',
                  'Still outside after the countdown: you are checked out. Your hours end <b>when you left</b>, not when the warning ended. You and your manager get a notification.'],
          tip: 'The server double-checks: only clear GPS readings count, and a gap of more than 12 minutes between readings (laptop asleep, tab closed) restarts the clock. One vague reading never checks you out.' },
        { h: 'Checking in again after an automatic check-out',
          steps: ['Check in again with a short reason (at least 3 characters). You are checked in, but the new time is <b>held as pending</b>.',
                  'Your manager (or HR if you have no manager) approves it in My Team. Approved: the time is added. Rejected: the time is dropped and you cannot re-check-in again that day.'],
          tip: 'HR can switch the approval off in Attendance Settings → Auto Check-out &amp; Network.' },
        { h: 'Forgot to check out?',
          p: ['Nothing is closed for you automatically: a forgotten check-out is only a reminder.'],
          steps: ['At your shift end you get “<b>Shift ended</b>”, then “<b>Still checked in</b>” 30 minutes later and every 2 hours (at most 4 times).',
                  'If you try to check out the next day you see <b>Session expired</b>: use <b>Regularize</b> to enter the real check-out time.',
                  'The day is flagged as a <b>missed punch</b> and you get an e-mail. File the regularization within the deadline (3 days by default, set by your attendance policy); after it your manager is reminded.',
                  'Night shifts: the session stays open until 4 hours after the shift end (or until shortly before the next shift).'],
          tip: 'Regularize: Check In / Out → Missed punch / Regularize → pick the day, the times and a reason (client meeting, forgot badge, network issue, field work, system issue, other) and an optional photo. Up to 3 per month, for days up to 31 days back. Your manager approves it and the day’s hours are recalculated.' },
        { h: 'Hourly location check',
          p: ['While you are checked in and the page is open, your location is saved about once an hour (office, home or remote).',
              'You are only marked as <b>elsewhere</b> after <b>two clear readings</b> at least 4 minutes apart, both outside your area (office circle, home area, or 300 m from where you checked in when you have no home). Rough readings never count. Then you get a notification and a banner.'] },
        { h: 'Shifts, late marks and short leave',
          table: [['Setting', 'Default', 'Meaning'],
                  ['Shift', '09:00 – 18:00, 60 min break', 'Used when HR has not assigned you a shift (“General Shift”).'],
                  ['Grace', '15 min', 'Checking in after start + grace marks you <b>late</b> (late minutes count from the start). Flexible shifts are never late.'],
                  ['Night shift', 'End earlier than start', 'Checks in up to 4 h after the shift end still count for that night.'],
                  ['Half day / absent', 'Under 8 h / under 4 h 30 min', 'From your attendance policy; see the Attendance Policies guide.'],
                  ['Short leave', '2 per month, up to 120 min', 'Late in, early out or a break in the middle; approved minutes count as worked and remove the late / early mark.']] },
        { h: 'For HR: setting it up',
          steps: ['<b>Office Locations</b>: click the map or “Use my current position”, set the radius (200 m default). Geo-fencing starts once one active office exists. Needs <b>settings.manage</b>.',
                  '<b>Office networks (Wi-Fi / IP)</b> (Auto Check-out &amp; Network tab): “Add this network” while you are in the office. It matches the office’s <b>public</b> internet address, not 192.168.x.x. Up to 25 per office. Needs <b>attendance.network.manage</b>.',
                  '<b>Auto check-out</b> card: on/off, minutes outside (1 – 240), warning seconds (5 – 120), sound, and whether re-check-in needs approval. Needs <b>settings.manage</b>.',
                  '<b>Shifts</b>: create shifts (start, end, grace, overtime after, night shift) and assign them with a start date and time zone. Needs <b>settings.manage</b>.',
                  '<b>Work Arrangements</b>: onsite / hybrid / remote per employee with a start date. Needs <b>attendance.manage_arrangement</b>.',
                  '<b>Off-site Approvals</b> and <b>home locations</b>: approve off-site check-ins and home addresses. Needs <b>attendance.approve_offsite</b>. WFH requests: <b>attendance.approve_wfh</b> or the employee’s manager.',
                  '<b>Regularization &amp; short leave</b>: the employee’s manager, or <b>attendance.regularize.approve</b>.'],
          tip: 'Permissions are edited per role in Settings → Access Control. The Attendance Settings button itself shows for roles with attendance.edit.' }
      ]
    },
    {
      id: 'attendance-policy', title: 'Attendance Policies', icon: '🕘', perms: ['attendance.policy.view', 'attendance.policy.manage'],
      summary: 'How day status, late penalties, short leave, overtime, comp-off, auto check-out and office networks work — and how to set them up.',
      who: 'HR / Super Admin (settings), managers (approvals), employees',
      sections: [
        { h: 'Where to find it',
          p: ['Settings → <b>Attendance Policies</b> (profiles, who gets which profile, penalties). Employees → Check In / Out → <b>Attendance Settings</b> (office locations, shifts, <b>Auto Check-out &amp; Network</b>). Workspace → <b>Overtime &amp; Comp-off</b>. Settings → <b>Holiday Calendars</b>.'],
          links: [['Attendance Policies', '/settings/attendance-policies'], ['Overtime & Comp-off', '/attendance/overtime'], ['Holiday Calendars', '/settings/holidays']] },
        { h: 'Which policy applies to whom',
          p: ['Every employee follows exactly one policy profile, found in this order (first match wins):'],
          steps: ['An <b>individual assignment</b>', 'Their <b>department</b>', 'Their <b>location</b>', 'The <b>Default</b> profile', 'Built-in rules if no profile exists (8 h full day, 4 h 30 min half day, 3 free lates/month, then ½ day from Casual Leave)'],
          tip: 'Use “Preview who gets it” before saving, and the “Who gets which profile” tab to check anyone.' },
        { h: 'Create a policy',
          steps: [
            'Settings → Attendance Policies → <b>+ New profile</b>.',
            '<b>General &amp; hours</b>: name, full-day and half-day minutes (or “Use shift hours”). Tick <b>Default</b> for everyone not covered elsewhere.',
            '<b>Punctuality &amp; penalties</b>: check-in grace, early-out grace, “very late = half day after X min”, free lates per month, whether early outs count, the penalty action (deduct ½ day leave / ½ day Loss of Pay / warning only) and which leave types to deduct from.',
            '<b>Short leave &amp; regularization</b>: short leaves per month, max minutes each, days allowed to regularize.',
            '<b>Overtime &amp; comp-off</b>: threshold, daily/weekly caps, approval required, comp-off minutes and expiry.',
            '<b>Scope</b>: departments, locations, individual employees → <b>Preview</b> → <b>Save</b>.'
          ],
          tip: 'Changes apply to days closed after saving. To re-apply to past days the server admin runs: manage.py recalc_attendance --policy --from <date> (add --apply after checking the preview).' },
        { h: 'How a day is marked',
          table: [['Worked (breaks excluded)', 'Day becomes', 'Payroll'],
                  ['Full-day hours or more, on time', 'Present', 'Full day'],
                  ['Full-day hours, after the grace period', 'Late', 'Full day; counts toward penalties'],
                  ['Between half-day and full-day hours', 'Half-day', '½ day Loss of Pay'],
                  ['Below half-day hours', 'Absent', '1 day Loss of Pay'],
                  ['Approved short leave covers the gap', 'Present', 'Full day']] },
        { h: 'Late penalties',
          steps: ['The first N lates each month are free (default 3).', 'Each one after that deducts ½ day from the first leave type with balance, or becomes ½ day Loss of Pay when there is none.', 'The employee is notified each time. A manager or HR can <b>waive</b> a penalty with a note; an approved regularization or short leave removes it automatically.'] },
        { h: 'Missed check-out and regularization',
          steps: ['A day with no check-out is flagged after the shift ends; the employee gets an app notice and email to regularize (default 48 hours / the policy\'s days).', 'They use <b>Missed punch / Regularize</b> on Check In/Out or Leave: enter the real times and a reason.', 'The manager approves in <b>My Team</b>; hours, status and Loss of Pay are recalculated.'],
          tip: 'Forgetting to check out never checks anyone out automatically — only leaving the office area does (below).' },
        { h: 'Overtime and comp-off',
          steps: ['Overtime is counted after the threshold, capped per day and week.', 'It waits for manager approval (My Team or Overtime &amp; Comp-off → Approvals); only approved overtime is paid.', 'Approved weekend/holiday work earns <b>comp-off leave</b> (½ or 1 day) that expires (default 60 days); employees apply for it like any leave.'] },
        { h: 'Auto check-out on leaving the office',
          steps: ['Outside the office geofence for 10 minutes in a row → a 10-second warning with a sound and an “I\'m back” button.', 'Still outside when it ends → checked out automatically (the check-out time is when they left).', 'Checking in again that day needs the manager\'s approval in My Team.', 'Work-from-home and approved off-site days are never auto-checked-out; it only works while the HRMS page is open.'],
          p: ['Settings: Employees → Attendance → Attendance Settings → <b>Auto Check-out &amp; Network</b>.'] },
        { h: 'Office Wi-Fi / network',
          steps: ['From a PC in the office open <b>Auto Check-out &amp; Network</b>; it shows the office\'s public IP.', 'Click <b>“Add this network to &lt;office&gt;”</b>.', 'Check-ins from that network count as “at the office” even when indoor GPS drifts, and the auto check-out never starts while on it.'],
          tip: 'Ask your internet provider for a static IP; a changing IP has to be updated here. Keep “trust X-Forwarded-For” off on cPanel.' },
        { h: 'Holiday calendars',
          p: ['Settings → Holiday Calendars: create regional calendars (e.g. Hyderabad, California), add holidays or import a CSV, and assign employees or locations. An employee\'s own holidays never count as absent or Loss of Pay.'] }
      ]
    }
  ];

  /* page → guide for the floating button */
  var CONTEXT = [
    [/^\/payroll\/(compliance)/, 'tax'], [/^\/my-pay\/tax/, 'tax'], [/^\/payroll\/us/, 'tax'], [/^\/my-pay\/w4/, 'tax'],
    [/^\/payroll(\/|$)/, 'payroll'], [/^\/my-pay(\/|$)/, 'payroll'],
    [/^\/settings\/attendance-policies/, 'attendance-policy'], [/^\/attendance\/overtime/, 'attendance-policy'],
    [/^\/settings\/holidays/, 'attendance-policy'],
    [/^\/employees\/attendance/, 'attendance'], [/^\/employees\/checkin/, 'attendance']
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function can(code) { try { return !window.__hrmsCan || !!window.__hrmsCan(code); } catch (_) { return true; } }
  function allowed(g) { return !g.perms || g.perms.some(can); }
  function visible() { return GUIDES.filter(allowed); }
  function byId(id) { for (var i = 0; i < GUIDES.length; i++) if (GUIDES[i].id === id && allowed(GUIDES[i])) return GUIDES[i]; return null; }
  function strip(html) { return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' '); }

  /* ── styles ─────────────────────────────────────────────────────────── */
  function ensureStyle() {
    if (document.getElementById('hrms-guides-style')) return;
    var st = document.createElement('style');
    st.id = 'hrms-guides-style';
    st.textContent = [
      '.gd-page{display:grid;grid-template-columns:240px minmax(0,1fr);gap:22px;align-items:start;color:var(--text,#0f172a);}',
      '.gd-side{position:sticky;top:0;display:grid;gap:10px;}',
      '.gd-search{width:100%;box-sizing:border-box;padding:9px 12px;border-radius:10px;border:1px solid var(--border2,#d0d5dd);background:var(--bg2,#fff);color:var(--text,#0f172a);font:inherit;font-size:13.5px;}',
      '.gd-search:focus{outline:none;border-color:var(--accent,#4f8ef7);box-shadow:0 0 0 3px rgba(79,142,247,.2);}',
      '.gd-nav{display:grid;gap:4px;}',
      '.gd-nav a{display:flex;gap:10px;align-items:center;padding:10px 12px;border-radius:10px;text-decoration:none;color:var(--text2,#475569);font-weight:600;font-size:14px;border:1px solid transparent;}',
      '.gd-nav a:hover{background:var(--bg3,#f1f5f9);color:var(--text,#0f172a);}',
      '.gd-nav a.on{background:var(--bg2,#fff);border-color:var(--border2,#e5e7eb);color:var(--accent,#4f8ef7);}',
      '.gd-nav small{display:block;font-weight:500;font-size:11.5px;color:var(--text3,#64748b);}',
      '.gd-main{min-width:0;}',
      '.gd-hero{background:var(--bg2,#fff);border:1px solid var(--border2,#e5e7eb);border-radius:14px;padding:20px 22px;margin-bottom:14px;}',
      '.gd-hero h1{margin:0 0 6px;font-size:22px;display:flex;gap:10px;align-items:center;color:var(--text,#0f172a);}',
      '.gd-hero p{margin:0;color:var(--text2,#475569);font-size:14px;line-height:1.6;}',
      '.gd-who{display:inline-block;margin-top:10px;font-size:12px;color:var(--text3,#64748b);background:var(--bg3,#f1f5f9);border-radius:999px;padding:3px 10px;}',
      '.gd-toc{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px;}',
      '.gd-toc a{font-size:12.5px;padding:4px 10px;border-radius:999px;border:1px solid var(--border2,#e5e7eb);color:var(--text2,#475569);text-decoration:none;background:var(--bg2,#fff);}',
      '.gd-toc a:hover{border-color:var(--accent,#4f8ef7);color:var(--accent,#4f8ef7);}',
      '.gd-sec{background:var(--bg2,#fff);border:1px solid var(--border2,#e5e7eb);border-radius:14px;padding:18px 22px;margin-bottom:12px;}',
      '.gd-sec h2{margin:0 0 10px;font-size:16.5px;color:var(--text,#0f172a);}',
      '.gd-sec p{margin:0 0 10px;color:var(--text2,#334155);font-size:14px;line-height:1.65;}',
      '.gd-sec ol{margin:0 0 10px;padding-left:22px;color:var(--text2,#334155);font-size:14px;line-height:1.65;}',
      '.gd-sec li{margin-bottom:6px;}',
      '.gd-sec b{color:var(--text,#0f172a);}',
      '.gd-tip{display:flex;gap:10px;padding:10px 12px;border-radius:10px;background:rgba(79,142,247,.08);border:1px solid rgba(79,142,247,.25);color:var(--text2,#334155);font-size:13px;line-height:1.55;margin-top:6px;}',
      '.gd-table{width:100%;border-collapse:collapse;font-size:13px;margin:4px 0 10px;}',
      '.gd-table th{text-align:left;background:var(--bg3,#f1f5f9);color:var(--text3,#64748b);font-size:11px;text-transform:uppercase;letter-spacing:.4px;padding:8px 10px;border-bottom:1px solid var(--border2,#e5e7eb);}',
      '.gd-table td{padding:8px 10px;border-bottom:1px solid var(--border2,#e5e7eb);color:var(--text,#0f172a);vertical-align:top;}',
      '.gd-tablewrap{overflow-x:auto;}',
      '.gd-links{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;}',
      '.gd-links a{font-size:13px;font-weight:600;padding:6px 12px;border-radius:8px;background:var(--accent,#4f8ef7);color:#fff;text-decoration:none;}',
      '.gd-links a:hover{filter:brightness(1.08);}',
      '.gd-hit{background:rgba(250,204,21,.35);border-radius:3px;}',
      '.gd-empty{padding:30px;text-align:center;color:var(--text3,#64748b);}',
      '.gd-fab{position:fixed;right:92px;bottom:28px;z-index:9000;display:inline-flex;align-items:center;gap:6px;padding:9px 14px;border-radius:999px;border:1px solid var(--border2,#d0d5dd);background:var(--bg2,#fff);color:var(--text,#0f172a);font:inherit;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 8px 24px rgba(15,23,42,.18);}',
      '.gd-fab:hover{border-color:var(--accent,#4f8ef7);color:var(--accent,#4f8ef7);}',
      '.gd-drawer-bg{position:fixed;inset:0;z-index:10040;background:rgba(15,23,42,.45);}',
      '.gd-drawer{position:fixed;top:0;right:0;bottom:0;z-index:10041;width:min(620px,100vw);background:var(--bg,#f8fafc);border-left:1px solid var(--border2,#e5e7eb);box-shadow:-20px 0 60px rgba(15,23,42,.25);display:flex;flex-direction:column;}',
      '.gd-drawer-h{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border2,#e5e7eb);background:var(--bg2,#fff);}',
      '.gd-drawer-h b{font-size:15px;color:var(--text,#0f172a);}',
      '.gd-drawer-h a,.gd-drawer-h button{font:inherit;font-size:13px;}',
      '.gd-drawer-h button{background:none;border:0;font-size:22px;line-height:1;color:var(--text3,#64748b);cursor:pointer;padding:2px 6px;border-radius:8px;}',
      '.gd-drawer-b{overflow-y:auto;padding:16px 18px;}',
      '@media (max-width:860px){.gd-page{grid-template-columns:1fr;}.gd-side{position:static;}.gd-nav{grid-auto-flow:column;grid-auto-columns:max-content;overflow-x:auto;}.gd-fab{right:16px;bottom:88px;}}'
    ].join('\n');
    document.head.appendChild(st);
  }

  /* ── rendering ──────────────────────────────────────────────────────── */
  function sectionHtml(sec, i, q) {
    var hl = function (html) {
      if (!q) return html;
      // highlight text outside tags only
      var rx = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
      return html.replace(/(^|>)([^<]+)(?=<|$)/g, function (m, a, txt) { return a + txt.replace(rx, '<mark class="gd-hit">$1</mark>'); });
    };
    var h = '<section class="gd-sec" id="gd-s' + i + '"><h2>' + hl(esc(sec.h)) + '</h2>';
    (sec.p || []).forEach(function (t) { h += '<p>' + hl(t) + '</p>'; });
    if (sec.steps) h += '<ol>' + sec.steps.map(function (t) { return '<li>' + hl(t) + '</li>'; }).join('') + '</ol>';
    if (sec.table) {
      h += '<div class="gd-tablewrap"><table class="gd-table"><thead><tr>' + sec.table[0].map(function (c) { return '<th>' + c + '</th>'; }).join('') +
        '</tr></thead><tbody>' + sec.table.slice(1).map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + hl(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
    }
    if (sec.tip) h += '<div class="gd-tip"><span aria-hidden="true">💡</span><span>' + hl(sec.tip) + '</span></div>';
    if (sec.links) h += '<div class="gd-links">' + sec.links.map(function (l) { return '<a href="' + esc(l[1]) + '" data-gd-go="' + esc(l[1]) + '">' + esc(l[0]) + ' →</a>'; }).join('') + '</div>';
    return h + '</section>';
  }
  function secText(sec) {
    return strip([sec.h].concat(sec.p || [], sec.steps || [], sec.tip ? [sec.tip] : [], (sec.table || []).map(function (r) { return r.join(' '); })).join(' ')).toLowerCase();
  }
  function guideHtml(g, q) {
    var secs = g.sections.map(function (s, i) { return { s: s, i: i }; });
    if (q) secs = secs.filter(function (x) { return secText(x.s).indexOf(q.toLowerCase()) >= 0; });
    var html = '<div class="gd-hero"><h1><span aria-hidden="true">' + g.icon + '</span>' + esc(g.title) + ' guide</h1><p>' + esc(g.summary) + '</p>' +
      '<span class="gd-who">For: ' + esc(g.who) + '</span></div>';
    if (!q) html += '<nav class="gd-toc" aria-label="Sections">' + g.sections.map(function (s, i) { return '<a href="#gd-s' + i + '" data-gd-jump="gd-s' + i + '">' + esc(s.h) + '</a>'; }).join('') + '</nav>';
    html += secs.length ? secs.map(function (x) { return sectionHtml(x.s, x.i, q); }).join('') : '<div class="gd-empty">No section of this guide mentions “' + esc(q) + '”.</div>';
    return html;
  }

  function wire(root) {
    root.addEventListener('click', function (e) {
      var go = e.target.closest ? e.target.closest('[data-gd-go]') : null;
      if (go) {
        e.preventDefault();
        closeDrawer();
        var path = go.getAttribute('data-gd-go');
        if (window.HRMSSidecar && window.HRMSSidecar.go) window.HRMSSidecar.go(path); else location.href = path;
        return;
      }
      var j = e.target.closest ? e.target.closest('[data-gd-jump]') : null;
      if (j) {
        e.preventDefault();
        var el = root.querySelector('#' + j.getAttribute('data-gd-jump'));
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }

  /* ── /help/guides page ──────────────────────────────────────────────── */
  var page = { root: null, id: 'payroll', q: '' };
  function renderPage() {
    var root = page.root;
    if (!root) return;
    var list = visible();
    if (!list.length) {
      root.innerHTML = '<div class="gd-empty" style="padding:48px 16px;text-align:center">There are no guides for your role yet. Ask HR if you need help with a page.</div>';
      return;
    }
    var g = byId(page.id) || list[0];
    var q = page.q.trim();
    var counts = {};
    list.forEach(function (x) { counts[x.id] = q ? x.sections.filter(function (s) { return secText(s).indexOf(q.toLowerCase()) >= 0; }).length : null; });
    root.innerHTML = '<div class="gd-page"><aside class="gd-side">' +
      '<input class="gd-search" type="search" placeholder="Search the guides…" aria-label="Search the guides" value="' + esc(page.q) + '">' +
      '<nav class="gd-nav" aria-label="Guides">' + list.map(function (x) {
        return '<a href="/help/guides/' + x.id + '" data-gd-id="' + x.id + '" class="' + (x.id === g.id ? 'on' : '') + '"' + (x.id === g.id ? ' aria-current="page"' : '') + '><span aria-hidden="true">' + x.icon + '</span><span>' + esc(x.title) +
          '<small>' + (counts[x.id] == null ? esc(x.sections.length + ' sections') : counts[x.id] + ' match' + (counts[x.id] === 1 ? '' : 'es')) + '</small></span></a>';
      }).join('') + '</nav></aside>' +
      '<main class="gd-main">' + guideHtml(g, q) + '</main></div>';
    var input = root.querySelector('.gd-search');
    input.addEventListener('input', function () {
      page.q = input.value;
      var pos = input.selectionStart;
      renderPage();
      var again = page.root && page.root.querySelector('.gd-search');
      if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (_) {} }
    });
    root.querySelectorAll('[data-gd-id]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        var id = a.getAttribute('data-gd-id');
        if (window.HRMSSidecar) window.HRMSSidecar.go('/help/guides/' + id);
      });
    });
  }
  function fromSub(sub) { var id = String(sub || '').replace(/^\//, '').split('/')[0]; return byId(id) ? id : ((visible()[0] || {}).id || ''); }

  /* ── drawer + floating button ───────────────────────────────────────── */
  var drawer = null;
  function closeDrawer() {
    if (!drawer) return;
    document.removeEventListener('keydown', drawer.onKey, true);
    [drawer.bg, drawer.el].forEach(function (n) { if (n && n.parentNode) n.parentNode.removeChild(n); });
    var back = drawer.opener;
    drawer = null;
    if (back && document.contains(back)) try { back.focus(); } catch (_) {}
  }
  function openDrawer(id) {
    ensureStyle();
    closeDrawer();
    var g = byId(id);
    if (!g) return;
    var bg = document.createElement('div'); bg.className = 'gd-drawer-bg';
    var el = document.createElement('div'); el.className = 'gd-drawer'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', g.title + ' guide');
    el.innerHTML = '<div class="gd-drawer-h"><b>' + g.icon + ' ' + esc(g.title) + ' guide</b><span><a href="/help/guides/' + g.id + '" data-gd-go="/help/guides/' + g.id + '">Open all guides</a> <button type="button" aria-label="Close guide" data-gd-close>×</button></span></div>' +
      '<div class="gd-drawer-b">' + guideHtml(g, '') + '</div>';
    document.body.appendChild(bg); document.body.appendChild(el);
    wire(el);
    var onKey = function (e) { if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); } };
    document.addEventListener('keydown', onKey, true);
    bg.addEventListener('click', closeDrawer);
    el.querySelector('[data-gd-close]').addEventListener('click', closeDrawer);
    drawer = { el: el, bg: bg, onKey: onKey, opener: document.activeElement };
    el.querySelector('[data-gd-close]').focus();
  }
  function contextGuide() {
    var p = location.pathname;
    if (/^\/help\/guides/.test(p)) return null;
    for (var i = 0; i < CONTEXT.length; i++) if (CONTEXT[i][0].test(p)) return byId(CONTEXT[i][1]) ? CONTEXT[i][1] : null;
    return null;
  }
  var fab = null;
  function syncFab() {
    var id = contextGuide();
    if (!id) { if (fab && fab.parentNode) fab.parentNode.removeChild(fab); fab = null; return; }
    ensureStyle();
    if (!fab) {
      fab = document.createElement('button');
      fab.type = 'button';
      fab.className = 'gd-fab';
      fab.addEventListener('click', function () { openDrawer(fab.getAttribute('data-gd')); });
      document.body.appendChild(fab);
    }
    if (fab.getAttribute('data-gd') !== id) {
      var g = byId(id);
      fab.setAttribute('data-gd', id);
      fab.innerHTML = '<span aria-hidden="true">📘</span>Guide';
      fab.title = 'How to use ' + g.title;
      fab.setAttribute('aria-label', 'Open the ' + g.title + ' guide');
    }
  }

  function boot() {
    ensureStyle();
    var tick = function () { requestAnimationFrame(syncFab); };
    new MutationObserver(tick).observe(document.body, { childList: true, subtree: false });
    window.addEventListener('popstate', function () { setTimeout(syncFab, 80); });
    ['pushState', 'replaceState'].forEach(function (m) {
      var orig = history[m];
      history[m] = function () { var r = orig.apply(this, arguments); setTimeout(syncFab, 60); return r; };
    });
    setInterval(syncFab, 1500);
    syncFab();
  }

  function register() {
    window.HRMSSidecar.register({
      base: '/help/guides', title: 'Help & Guides',
      mount: function (root, sub) { ensureStyle(); page.root = root; page.id = fromSub(sub); page.q = ''; wire(root); renderPage(); },
      update: function (root, sub) { page.root = root; page.id = fromSub(sub); renderPage(); root.scrollTop = 0; },
      unmount: function () { page.root = null; }
    });
  }
  if (window.HRMSSidecar) register();
  else {
    var tries = 0, iv = setInterval(function () {
      if (window.HRMSSidecar) { clearInterval(iv); register(); } else if (++tries > 100) clearInterval(iv);
    }, 50);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.HRMSGuides = { open: openDrawer, list: function () { return GUIDES.map(function (g) { return g.id; }); } };
})();
