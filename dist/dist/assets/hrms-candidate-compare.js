/*
 * hrms-candidate-compare.js
 * ---------------------------------------------------------------------------
 * Replaces the "Candidate Comparison" card on the Resume Scoring page
 * (/recruit/resume-scoring) with the SAME data grid as the Job Board
 * (hrms-jobs-table.js): toolbar, sticky uppercase headers, funnel filters,
 * Edit Column / Edit Filters drawers, pagination, CSV / Excel export —
 * WITHOUT a bundle rebuild.
 *
 *   • Own grid from /api/resume-scores (the React card is hidden while mounted).
 *   • Job Code column: the Job Board post each candidate was scored against;
 *     click it to load that post's description into the Job Description box.
 *   • Job picker on the Job Description card: choose a Job Code and the post's
 *     description (from /api/jobs) is dropped into the textarea. Its Quick
 *     Code strip lists the codes used most recently (picked here or scored
 *     against) plus the total number of job posts.
 *   • Edit Column drawer (show/hide + drag reorder), persisted to localStorage.
 *   • Per-column Excel-style filter popups (sort + value search + checklist).
 *   • Edit Filters drawer: job post checklist, predefined quick filters, custom
 *     "contains" rules.
 *   • Pagination (page size + first/prev/pages/next/last). Export CSV / Excel.
 *   • Row click → syncs the candidate into the scorer; ✦ AI / View / Delete.
 *
 * Only the Candidate Comparison card is taken over; the JD input, resume
 * upload, and "Match Score" detail card on the same page are left in place
 * (the JD card just gains the Job Code picker). Kept mounted by a
 * MutationObserver. Theme-aware.
 */
(function () {
  'use strict';

  var PATH = '/recruit/resume-scoring';
  var CARD_TITLE = 'Candidate Comparison';
  var ID = {
    root: 'hrms-cc-root', style: 'hrms-cc-style', pop: 'hrms-cc-colpop',
    drawer: 'hrms-cc-drawer', cdrawer: 'hrms-cc-cdrawer', modal: 'hrms-cc-modal', menu: 'hrms-cc-exportmenu',
  };
  var LS_COLS = 'hrms_cc_columns_v1';

  // Grid columns. num → sorts/filters numerically and renders a score bar.
  var COLS = [
    { key: 'name', label: 'Candidate' },
    { key: 'jobCode', label: 'Job Code' },
    { key: 'role', label: 'Role' },
    { key: 'score', label: 'Overall', num: true, score: true },
    { key: 'technical', label: 'Technical', num: true, bar: true },
    { key: 'experience', label: 'Experience', num: true, bar: true },
    { key: 'domain', label: 'Domain', num: true, bar: true },
    { key: 'source', label: 'Source' },
    { key: 'formatted', label: 'Format', fmt: function (v) { return v ? 'Done' : 'Pending'; } },
  ];
  var PAGE_SIZES = [10, 25, 50, 100];
  var PREDEF = [
    ['all', 'All Candidates'], ['s90', 'Score ≥ 90'], ['s80', 'Score ≥ 80'],
    ['s70', 'Score ≥ 70'], ['done', 'Format: Done'], ['pending', 'Format: Pending'],
    ['new', 'Newly Uploaded'],
  ];

  var DEFAULT_JOBS = [
    {
      code: 'JOB-101',
      title: 'Senior Frontend Engineer',
      department: 'Engineering — Platform Team',
      location: 'Remote / Hybrid (Bangalore)',
      experience: '5+ years',
      type: 'Full-Time',
      skills: ['React', 'TypeScript', 'Next.js', 'CSS/Tailwind', 'Redux', 'Web Vitals', 'REST/GraphQL'],
      description:
        'Position: Senior Frontend Engineer\n' +
        'Department: Engineering — Platform Team\n' +
        'Location: Remote / Hybrid (Bangalore)\n' +
        'Experience: 5+ years\n' +
        'Employment Type: Full-Time\n\n' +
        'Job Overview:\n' +
        'We are seeking an exceptional Senior Frontend Engineer to build robust, delightful, and high-performance user interfaces for our next-generation HRMS and Enterprise Intelligence suite.\n\n' +
        'Key Responsibilities:\n' +
        '• Architect and maintain clean, scalable component libraries and responsive web apps using React, TypeScript, and modern state management.\n' +
        '• Collaborate closely with backend architects and product designers to deliver polished features and high Core Web Vitals performance.\n' +
        '• Implement unit, integration, and visual regression tests to ensure flawless frontend reliability.\n' +
        '• Optimize web performance, bundle sizes, accessibility (WCAG), and cross-browser compatibility.\n\n' +
        'Required Qualifications:\n' +
        '• 5+ years of production experience with modern JavaScript / TypeScript and React ecosystem.\n' +
        '• Mastery of modern CSS, responsive layouts, flexbox, grid, and CSS-in-JS or modern design tokens.\n' +
        '• Strong grasp of RESTful APIs, WebSocket integrations, and client-side performance tuning.\n' +
        '• Experience with automated testing frameworks (Jest, Vitest, Cypress, Playwright).'
    },
    {
      code: 'JOB-102',
      title: 'Lead Data Scientist & AI Engineer',
      department: 'AI & Data Intelligence',
      location: 'Bangalore / Hybrid',
      experience: '6+ years',
      type: 'Full-Time',
      skills: ['Python', 'NLP', 'PyTorch / TensorFlow', 'LangChain', 'OpenAI / Gemini LLMs', 'Scikit-Learn', 'Vector DBs'],
      description:
        'Position: Lead Data Scientist & AI Engineer\n' +
        'Department: AI & Data Intelligence\n' +
        'Location: Bangalore / Hybrid\n' +
        'Experience: 6+ years\n' +
        'Employment Type: Full-Time\n\n' +
        'Job Overview:\n' +
        'Lead our AI initiatives in developing state-of-the-art NLP models, semantic resume parsers, and candidate scoring algorithms.\n\n' +
        'Key Responsibilities:\n' +
        '• Design, train, and deploy generative AI and machine learning pipelines for automated candidate scoring and skills extraction.\n' +
        '• Fine-tune transformer models, design RAG pipelines, and integrate high-throughput embedding search.\n' +
        '• Work with data engineering teams to clean and preprocess large unstructured datasets.\n' +
        '• Establish model evaluation metrics, fairness auditing, and drift monitoring.\n\n' +
        'Required Qualifications:\n' +
        '• MS or BS in Computer Science, Statistics, AI/ML, or equivalent experience.\n' +
        '• Deep proficiency in Python, PyTorch, HuggingFace transformers, LangChain/LlamaIndex, and Vector DBs.\n' +
        '• Proven track record of putting LLM / NLP models into production with measurable impact.'
    },
    {
      code: 'JOB-103',
      title: 'Senior DevOps & Cloud Architect',
      department: 'Infrastructure & Cloud Ops',
      location: 'Bangalore / Remote',
      experience: '5+ years',
      type: 'Full-Time',
      skills: ['Kubernetes', 'Docker', 'AWS / GCP', 'Terraform', 'CI/CD (GitHub Actions)', 'Prometheus / Grafana', 'Linux'],
      description:
        'Position: Senior DevOps & Cloud Architect\n' +
        'Department: Infrastructure & Cloud Ops\n' +
        'Location: Bangalore / Remote\n' +
        'Experience: 5+ years\n' +
        'Employment Type: Full-Time\n\n' +
        'Job Overview:\n' +
        'We need an experienced DevOps & Cloud Architect to lead infrastructure reliability, automated deployments, container orchestration, and cloud security.\n\n' +
        'Key Responsibilities:\n' +
        '• Manage and scale Kubernetes clusters, container deployments, and zero-downtime releases.\n' +
        '• Provision infrastructure as code (IaC) with Terraform, Ansible, and Helm.\n' +
        '• Build robust CI/CD pipelines with GitHub Actions / GitLab CI for automated testing and staging deployments.\n' +
        '• Maintain 99.95% system uptime, disaster recovery, and comprehensive monitoring with Prometheus, Grafana, and ELK.\n\n' +
        'Required Qualifications:\n' +
        '• 5+ years building and maintaining production cloud infrastructure on AWS or GCP.\n' +
        '• Strong expertise in Docker, Kubernetes, Linux system administration, and shell scripting.\n' +
        '• In-depth knowledge of network security, VPCs, IAM policies, and SSL/TLS management.'
    },
    {
      code: 'JOB-104',
      title: 'Full Stack React & Node Developer',
      department: 'Product Engineering',
      location: 'Hyderabad / Hybrid',
      experience: '4+ years',
      type: 'Full-Time',
      skills: ['React', 'Node.js', 'Express / NestJS', 'PostgreSQL', 'TypeScript', 'Redis', 'Docker'],
      description:
        'Position: Full Stack React & Node Developer\n' +
        'Department: Product Engineering\n' +
        'Location: Hyderabad / Hybrid\n' +
        'Experience: 4+ years\n' +
        'Employment Type: Full-Time\n\n' +
        'Job Overview:\n' +
        'Looking for a versatile Full Stack Developer who enjoys shipping end-to-end features, from intuitive UI components to performant microservices.\n\n' +
        'Key Responsibilities:\n' +
        '• Deliver full-stack features using React, Node.js, TypeScript, and relational databases.\n' +
        '• Write maintainable, testable, and documented RESTful APIs and background workers.\n' +
        '• Optimize PostgreSQL database queries, index strategies, and Redis caching layers.\n' +
        '• Actively participate in agile sprints, code reviews, and architectural discussions.\n\n' +
        'Required Qualifications:\n' +
        '• 4+ years experience with React, Node.js, and TypeScript in production environments.\n' +
        '• Strong SQL database modeling and query tuning experience (PostgreSQL, MySQL).\n' +
        '• Solid understanding of authentication (JWT, OAuth2), security best practices, and Docker.'
    },
    {
      code: 'JOB-105',
      title: 'Python / FastAPI Backend Engineer',
      department: 'Core Services',
      location: 'Bangalore / Hybrid',
      experience: '4+ years',
      type: 'Full-Time',
      skills: ['Python', 'FastAPI', 'SQLAlchemy / Alembic', 'PostgreSQL', 'Celery / Redis', 'PyTest', 'Docker'],
      description:
        'Position: Python / FastAPI Backend Engineer\n' +
        'Department: Core Services\n' +
        'Location: Bangalore / Hybrid\n' +
        'Experience: 4+ years\n' +
        'Employment Type: Full-Time\n\n' +
        'Job Overview:\n' +
        'Join the Core Services team to architect and scale fast, asynchronous Python microservices powering recruitment workflows, scoring, and analytics.\n\n' +
        'Key Responsibilities:\n' +
        '• Build high-throughput REST APIs and asynchronous task processing with FastAPI and Celery.\n' +
        '• Design scalable database schemas with SQLAlchemy and perform seamless migrations via Alembic.\n' +
        '• Integrate third-party ATS, job boards, and cloud storage providers with resilient error handling.\n' +
        '• Maintain high test coverage with PyTest and implement comprehensive logging and telemetry.\n\n' +
        'Required Qualifications:\n' +
        '• 4+ years Python backend engineering experience with FastAPI, Flask, or Django.\n' +
        '• Strong knowledge of async programming (asyncio), concurrency, and distributed task queues.\n' +
        '• Proficient in PostgreSQL, connection pooling, Redis caching, and Docker containerization.'
    },
    {
      code: 'JOB-106',
      title: 'Technical Support Engineer',
      department: 'Customer Success',
      location: 'Remote / Bangalore',
      experience: '2+ years',
      type: 'Full-Time',
      skills: ['Technical Troubleshooting', 'SQL Queries', 'API Debugging (Postman)', 'Customer Communication', 'SLA Management'],
      description:
        'Position: Technical Support Engineer\n' +
        'Department: Customer Success\n' +
        'Location: Remote / Bangalore\n' +
        'Experience: 2+ years\n' +
        'Employment Type: Full-Time\n\n' +
        'Job Overview:\n' +
        'Provide world-class Tier 2/3 technical assistance to enterprise clients using Eversoft HRMS and talent acquisition tools.\n\n' +
        'Key Responsibilities:\n' +
        '• Investigate and resolve complex client-reported technical issues, API failures, and sync errors.\n' +
        '• Write targeted SQL queries to audit database inconsistencies and diagnose root causes.\n' +
        '• Act as bridge between customer success managers and engineering teams with detailed bug reports.\n' +
        '• Author helpful knowledge base articles, onboarding troubleshooting guides, and FAQs.\n\n' +
        'Required Qualifications:\n' +
        '• 2+ years experience in technical application support or customer engineering.\n' +
        '• Basic proficiency in SQL, REST API testing (Postman / cURL), and browser developer tools.\n' +
        '• Outstanding verbal and written communication skills with strong customer empathy.'
    },
    {
      code: 'JOB-107',
      title: 'Senior QA Automation Engineer',
      department: 'Quality Assurance',
      location: 'Bangalore / Hybrid',
      experience: '4+ years',
      type: 'Full-Time',
      skills: ['Playwright / Cypress', 'Selenium', 'JavaScript / TypeScript', 'API Testing', 'CI/CD Pipelines', 'Performance Testing (k6)'],
      description:
        'Position: Senior QA Automation Engineer\n' +
        'Department: Quality Assurance\n' +
        'Location: Bangalore / Hybrid\n' +
        'Experience: 4+ years\n' +
        'Employment Type: Full-Time\n\n' +
        'Job Overview:\n' +
        'Drive quality and test automation across all web apps, microservices, and mobile viewports for the Eversoft platform.\n\n' +
        'Key Responsibilities:\n' +
        '• Build and maintain end-to-end automation test suites using Playwright, TypeScript, and GitHub Actions.\n' +
        '• Execute load, stress, and security testing using k6 and JMeter before major production releases.\n' +
        '• Collaborate closely with product managers and engineers to define acceptance criteria and test plans.\n' +
        '• Monitor regression test results and maintain flaky-test-free CI execution.\n\n' +
        'Required Qualifications:\n' +
        '• 4+ years in software quality assurance with at least 3 years focused on automated testing.\n' +
        '• Hands-on expertise with Playwright, Cypress, or Selenium with TypeScript / JavaScript.\n' +
        '• Experience testing REST APIs, database state validation, and CI/CD automated test reporting.'
    },
    {
      code: 'JOB-108',
      title: 'Technical Product Manager',
      department: 'Product Management',
      location: 'Bangalore / Hybrid',
      experience: '5+ years',
      type: 'Full-Time',
      skills: ['Product Strategy', 'Roadmapping', 'Agile / Scrum', 'User Research', 'Data Analytics', 'Wireframing'],
      description:
        'Position: Technical Product Manager\n' +
        'Department: Product Management\n' +
        'Location: Bangalore / Hybrid\n' +
        'Experience: 5+ years\n' +
        'Employment Type: Full-Time\n\n' +
        'Job Overview:\n' +
        'Lead product discovery, strategy, and execution for the Eversoft AI Recruitment and Resume Intelligence suite.\n\n' +
        'Key Responsibilities:\n' +
        '• Define product roadmap, feature requirements, user stories, and measurable success KPIs.\n' +
        '• Conduct interviews with recruiters, hiring managers, and candidates to uncover pain points.\n' +
        '• Collaborate with engineering and UX designers to ship iterative, high-impact product releases.\n' +
        '• Analyze feature adoption metrics, funnel drop-offs, and customer feedback to guide decisions.\n\n' +
        'Required Qualifications:\n' +
        '• 5+ years product management experience in SaaS, enterprise software, or HR tech.\n' +
        '• Technical background or strong ability to communicate effectively with engineering teams.\n' +
        '• Data-driven mindset with experience using Mixpanel, Google Analytics, or SQL.'
    }
  ];

  // Job posts by code, straight from the Job Board (/api/jobs). The demo set
  // above is used only when the API yields no coded posts (e.g. the backend
  // has not been migrated yet), so the picker always has something to offer.
  var jobsRegistry = [];
  var registryLoaded = false;
  function jobFromPost(j) {
    var cf = (j && j.customFields && typeof j.customFields === 'object') ? j.customFields : {};
    var skills = cf.skills;
    if (typeof skills === 'string') skills = skills.split(/,\s*/);
    if (!Array.isArray(skills)) skills = [];
    var exp = cf.experience == null ? '' : String(cf.experience).trim();
    if (/^\d+(\.\d+)?$/.test(exp)) exp += '+ years';
    return {
      id: j.id, code: String(j.code || '').trim().toUpperCase(), title: j.title || '',
      department: j.dept || j.department || '', location: j.location || '', experience: exp,
      type: j.type || '', status: j.status || 'Active',
      skills: skills.map(function (s) { return String(s).trim(); }).filter(Boolean),
      description: j.description || ''
    };
  }
  function loadJobsRegistry() {
    return api('/api/jobs').then(function (res) {
      var list = Array.isArray(res) ? res : (res && res.jobs) || [];
      var posts = list.map(jobFromPost).filter(function (j) { return j.code; });
      jobsRegistry = posts.length ? posts : DEFAULT_JOBS.slice();
    }).catch(function () {
      if (!jobsRegistry.length) jobsRegistry = DEFAULT_JOBS.slice();
    }).then(function () {
      registryLoaded = true;
      renderTable();            // Job Code tooltips / title lookups
      enhanceJobPostCard();     // picker, quick codes, active post details
    });
  }
  // Job Board status -> pill colour: closed / cancelled / filled read as red,
  // on-hold as amber, anything else as an open post.
  function jobStatusKind(job) {
    if (!job) return '';
    var s = String(job.status || 'Active').toLowerCase();
    if (/closed|cancel|filled/.test(s)) return 'closed';
    if (/hold/.test(s)) return 'hold';
    return 'active';
  }
  function kindClass(job) { var k = jobStatusKind(job); return (k && k !== 'active') ? ' ' + k : ''; }
  function statusBadge(job) {
    var kind = jobStatusKind(job), label = (job && job.status) || 'Active';
    var col = kind === 'closed' ? 'var(--danger,#ef4444)' : kind === 'hold' ? 'var(--warn,#f59e0b)' : 'var(--success,#22c55e)';
    var bg = kind === 'closed' ? 'rgba(239,68,68,0.12)' : kind === 'hold' ? 'rgba(245,158,11,0.12)' : 'rgba(34,197,94,0.12)';
    return '<span class="cc-badge" style="background:' + bg + ';color:' + col + ';border-color:' + col + ';font-size:9.5px;font-weight:700;white-space:nowrap">● ' + esc(label) + '</span>';
  }
  function jobByCode(code) {
    var c = String(code || '').trim().toUpperCase(); if (!c) return null;
    for (var i = 0; i < jobsRegistry.length; i++) if (jobsRegistry[i].code === c) return jobsRegistry[i];
    return null;
  }
  // Quick Code strip: the Job Codes used most recently, newest first. A code
  // counts as used when it is picked in this picker (remembered per browser)
  // or when a resume was scored against it (any browser — the rows carry
  // updatedAt). Until anything has been used, the newest posts stand in so
  // the strip is never empty.
  var QUICK_CODE_LIMIT = 10;
  var RECENT_CODES_KEY = 'hrms_recent_job_codes';
  function recentCodePicks() {
    try { var v = JSON.parse(localStorage.getItem(RECENT_CODES_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; }
  }
  function rememberRecentCode(code) {
    var c = String(code || '').trim().toUpperCase(); if (!c) return;
    var list = recentCodePicks().filter(function (e) { return e && e.code !== c; });
    list.unshift({ code: c, at: Date.now() });
    try { localStorage.setItem(RECENT_CODES_KEY, JSON.stringify(list.slice(0, 25))); } catch (_) {}
  }
  function recentJobs(limit) {
    var uses = [];
    recentCodePicks().forEach(function (e) { if (e && e.code) uses.push({ code: String(e.code).toUpperCase(), at: num(e.at), id: 0 }); });
    (state.rows || []).forEach(function (r) {
      var code = candidateCode(r); if (!code) return;
      uses.push({ code: code, at: Date.parse(r.updatedAt || r.createdAt || '') || 0, id: num(r.id) });
    });
    uses.sort(function (a, b) { return (b.at - a.at) || (b.id - a.id); });
    var seen = {}, out = [];
    for (var i = 0; i < uses.length && out.length < limit; i++) {
      var c = uses[i].code; if (seen[c]) continue; seen[c] = 1;
      var j = jobByCode(c); if (j) out.push(j);
    }
    return out;
  }
  // The job post a scored candidate belongs to: by the code stamped on the row
  // when it was scored, else by matching its role text to a post title. No
  // guessing beyond that — an unmatched row simply shows no code.
  function getCandidateJob(r) {
    if (!r) return null;
    var byCode = jobByCode(r.jobCode); if (byCode) return byCode;
    var role = String(r.role || '').trim().toLowerCase();
    if (role) {
      for (var i = 0; i < jobsRegistry.length; i++) {
        var t = jobsRegistry[i].title.toLowerCase();
        if (t && (t === role || role.indexOf(t) !== -1 || t.indexOf(role) !== -1)) return jobsRegistry[i];
      }
    }
    return null;
  }
  function candidateCode(r) {
    if (r && r.jobCode) return String(r.jobCode).trim().toUpperCase();
    var j = getCandidateJob(r); return j ? j.code : '';
  }

  function setJdInput(text) {
    var tas = document.querySelectorAll('textarea');
    var jdTa = null;
    for (var i = 0; i < tas.length; i++) {
      var ph = (tas[i].getAttribute('placeholder') || '').toLowerCase();
      if (ph.indexOf('job description') !== -1) {
        jdTa = tas[i];
        break;
      }
    }
    if (!jdTa && tas.length > 0) jdTa = tas[0];
    if (!jdTa) return;

    var proto = window.HTMLTextAreaElement.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(jdTa, text);
    } else {
      jdTa.value = text;
    }
    jdTa.dispatchEvent(new Event('input', { bubbles: true }));
    jdTa.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function selectJobByCode(code) {
    if (!code) return;
    var clean = String(code).trim().toUpperCase();
    var job = jobByCode(clean);
    if (!job) job = jobsRegistry.filter(function (j) { return j.code.indexOf(clean) !== -1 || clean.indexOf(j.code) !== -1; })[0] || null;
    if (!job) { toast('Job Code ' + code + ' is not on the Job Board', 'error'); return; }

    try { localStorage.setItem('hrms_active_job_code', job.code); } catch (_) {}
    rememberRecentCode(job.code);
    if (!String(job.description || '').trim()) {
      // Never wipe whatever the recruiter already typed with an empty post.
      toast('[' + job.code + '] ' + job.title + ' has no description yet — add one on the Job Board.', 'error');
      enhanceJobPostCard();
      return;
    }
    setJdInput(job.description);
    toast('Loaded [' + job.code + '] ' + job.title + ' into Job Description');

    enhanceJobPostCard();

    var jdTa = findJdTextarea();
    if (jdTa) {
      var c = jdTa.closest('.card') || jdTa;
      try { c.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_) {}
    }
  }

  var state = {
    rows: [], loaded: false, cols: null,
    search: '', colFilters: {},         // key -> array of allowed display values
    jobFilter: null,                    // array of allowed Job Codes (null = all)
    predef: 'all', customFilters: [],   // [{key, val}] "contains"
    sortKey: null, sortDir: 1,
    page: 1, pageSize: 25,
    reactCount: -1,                     // last seen row count in the hidden React table
  };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function onPage() {
    var p = (location.pathname || '').replace(/\/+$/, '');
    var h = (location.hash || '').replace(/^#\/?/, '/').replace(/\/+$/, '');
    return p === PATH || p.indexOf(PATH) !== -1 || h === PATH || h.indexOf(PATH) !== -1;
  }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function col(key) { for (var i = 0; i < COLS.length; i++) if (COLS[i].key === key) return COLS[i]; return { key: key, label: key }; }
  function cellVal(row, key) {
    var c = col(key);
    if (key === 'jobCode') return candidateCode(row);
    var v = row[key];
    return c.fmt ? c.fmt(v, row) : (v == null ? '' : v);
  }

  // Column visibility + order, persisted exactly like the Job Board's grid.
  function loadColPrefs() {
    var saved = null; try { saved = JSON.parse(localStorage.getItem(LS_COLS) || 'null'); } catch (_) {}
    var byKey = {}; if (Array.isArray(saved)) saved.forEach(function (c, i) { if (c && c.key) byKey[c.key] = { on: c.on !== false, ord: i }; });
    var cols = COLS.map(function (c) { return { key: c.key, on: byKey[c.key] ? byKey[c.key].on : true }; });
    if (Array.isArray(saved) && saved.length) {
      cols.sort(function (a, b) { return (byKey[a.key] ? byKey[a.key].ord : 999) - (byKey[b.key] ? byKey[b.key].ord : 999); });
      // Prefs saved before Job Code existed would park it last; keep it beside the candidate.
      if (!byKey.jobCode) { for (var i = 0; i < cols.length; i++) if (cols[i].key === 'jobCode') { var jc = cols.splice(i, 1)[0]; cols.splice(cols[0] && cols[0].key === 'name' ? 1 : 0, 0, jc); break; } }
    }
    state.cols = cols;
  }
  function saveColPrefs() { try { localStorage.setItem(LS_COLS, JSON.stringify(state.cols)); } catch (_) {} }
  function shownCols() { if (!state.cols) loadColPrefs(); return state.cols.filter(function (c) { return c.on; }).map(function (c) { return col(c.key); }); }

  function api(path, opts) {
    return fetch(path, opts).then(function (r) {
      return r.text().then(function (t) {
        var d = null; if (t) { try { d = JSON.parse(t); } catch (_) { d = t; } }
        if (!r.ok) {
          var errStr = '';
          if (d) {
            if (typeof d === 'string') errStr = d;
            else if (typeof d.error === 'string') errStr = d.error;
            else if (d.error && typeof d.error.message === 'string') errStr = d.error.message;
            else if (typeof d.message === 'string') errStr = d.message;
            else if (typeof d.detail === 'string') errStr = d.detail;
            else if (d.error) errStr = typeof d.error === 'object' ? (d.error.message || JSON.stringify(d.error)) : String(d.error);
          }
          if (!errStr) errStr = 'HTTP ' + r.status;
          throw new Error(errStr);
        }
        return d;
      });
    });
  }
  function loadData() {
    api('/api/resume-scores').then(function (rows) {
      state.rows = Array.isArray(rows) ? rows : [];
      state.loaded = true; renderTable();
    }).catch(function () { state.loaded = true; renderTable(); });
  }
  function initials(row) {
    if (row.initials) return String(row.initials).slice(0, 2).toUpperCase();
    var p = String(row.name || '').trim().split(/\s+/);
    var s = ((p[0] || '')[0] || '') + ((p[1] || '')[0] || '');
    return (s || '?').toUpperCase();
  }
  function scoreColor(n) { n = num(n); return n >= 85 ? 'var(--success,#22c55e)' : n >= 70 ? 'var(--warn,#f59e0b)' : n >= 50 ? 'var(--accent4,#f7954f)' : 'var(--danger,#ef4444)'; }

  function distinct(key) {
    var seen = {}, out = [];
    state.rows.forEach(function (r) { var v = String(cellVal(r, key)); if (!(v in seen)) { seen[v] = 1; out.push(v); } });
    out.sort(function (a, b) { return col(key).num ? num(a) - num(b) : a.localeCompare(b); });
    return out;
  }

  function toast(msg, type) {
    var el = document.createElement('div');
    el.style.position = 'fixed';
    el.style.bottom = '20px';
    el.style.right = '20px';
    el.style.zIndex = '99999';
    el.style.padding = '10px 16px';
    el.style.borderRadius = '8px';
    el.style.fontSize = '12px';
    el.style.fontWeight = '600';
    el.style.boxShadow = '0 6px 20px rgba(0,0,0,0.3)';
    el.style.background = type === 'error' ? '#ef4444' : '#22c55e';
    el.style.color = '#fff';
    el.style.transition = 'opacity 0.3s ease';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 300);
    }, 3000);
  }

  function matchPredef(r) {
    switch (state.predef) {
      case 's90': return num(r.score) >= 90;
      case 's80': return num(r.score) >= 80;
      case 's70': return num(r.score) >= 70;
      case 'done': return !!r.formatted;
      case 'pending': return !r.formatted;
      case 'new': return !!r.uploaded;
      default: return true;
    }
  }

  // Single choke point: search + job post + column checklists + predefined + custom, then sort.
  function filtered() {
    var q = state.search.trim().toLowerCase();
    var rows = state.rows.filter(function (r) {
      if (q) {
        var job = getCandidateJob(r);
        var hay = [r.name, r.role, candidateCode(r), job && job.title, job && job.department, r.fileName, r.source]
          .map(function (x) { return String(x == null ? '' : x).toLowerCase(); }).join('\u0001');
        if (hay.indexOf(q) === -1) return false;
      }
      if (state.jobFilter && state.jobFilter.indexOf(candidateCode(r)) === -1) return false;
      for (var k in state.colFilters) { if (state.colFilters[k] && state.colFilters[k].indexOf(String(cellVal(r, k))) === -1) return false; }
      if (state.predef !== 'all' && !matchPredef(r)) return false;
      for (var i = 0; i < state.customFilters.length; i++) {
        var cf = state.customFilters[i];
        if (cf.val && String(cellVal(r, cf.key)).toLowerCase().indexOf(cf.val.toLowerCase()) === -1) return false;
      }
      return true;
    });
    if (state.sortKey) {
      var k = state.sortKey, dir = state.sortDir, numeric = col(k).num;
      rows = rows.slice().sort(function (a, b) {
        var va = cellVal(a, k), vb = cellVal(b, k);
        if (numeric) return (num(va) - num(vb)) * dir;
        return String(va).localeCompare(String(vb), undefined, { numeric: true }) * dir;
      });
    }
    return rows;
  }

  function activeFilterCount() {
    var n = 0;
    for (var k in state.colFilters) if (state.colFilters[k]) n++;
    if (state.jobFilter) n++;
    if (state.predef !== 'all') n++;
    n += state.customFilters.filter(function (c) { return c.val; }).length;
    return n;
  }

  /* ── styles ───────────────────────────────────────────────────────────── */
  // Grid chrome is a 1:1 port of hrms-jobs-table.js (jt-* → cc-*) so both
  // recruiting grids look and behave the same. Everything after the grid block
  // styles the Resume Scoring page extras (AI overlay, job picker, modals).
  function ensureStyle() {
    if (document.getElementById(ID.style)) return;
    var R = '#' + ID.root, D = '.cc-dr', M = '#' + ID.menu, P = '#' + ID.pop;
    var css = [
      R + '{margin-top:4px;}',
      R + ' .cc-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;}',
      R + ' .cc-ttl{font-size:15px;font-weight:700;color:var(--text,#f8fafc);}',
      R + ' .cc-count{font-size:12px;color:var(--text2,#94a3b8);font-weight:600;}',
      R + ' .cc-bar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:12px;}',
      R + ' .cc-search{flex:1;min-width:200px;background:var(--bg3,#1e293b);border:1px solid var(--border2,#334155);border-radius:9px;padding:9px 12px;color:var(--text,#f8fafc);font:inherit;font-size:13px;}',
      R + ' .cc-search:focus{border-color:var(--accent,#38bdf8);outline:none;}',
      /* Controls are GLOBAL (not root-scoped) so drawers/modals mounted on <body> get them too. */
      '.cc-btn{display:inline-flex;align-items:center;gap:6px;background:var(--bg3,#1e293b);border:1px solid var(--border2,#334155);border-radius:9px;padding:8px 14px;color:var(--text,#f8fafc);font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;transition:all .15s;}',
      '.cc-btn:hover{border-color:var(--accent,#38bdf8);color:var(--accent,#38bdf8);}',
      '.cc-btn.primary{background:var(--accent,#38bdf8);color:#fff;border-color:var(--accent,#38bdf8);}',
      '.cc-btn.primary:hover{filter:brightness(1.1);border-color:var(--accent,#38bdf8);color:#fff;}',
      '.cc-btn.ghost{background:transparent;color:var(--text2,#cbd5e1);}',
      '.cc-btn.ghost:hover{border-color:var(--accent,#38bdf8);color:var(--text,#f8fafc);}',
      '.cc-btn.danger{border-color:rgba(239,68,68,.55);background:rgba(239,68,68,.16);color:#ef4444;}',
      '.cc-btn.danger:hover{background:rgba(239,68,68,.32);border-color:#ef4444;color:#fff;}',
      '.cc-btn.cc-sm{padding:4px 10px;font-size:11px;border-radius:7px;}',
      '.cc-btn:disabled{opacity:.6;cursor:not-allowed;}',
      '.cc-icon{display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;background:var(--bg3,#1e293b);border:1px solid var(--border2,#334155);border-radius:9px;color:var(--text2,#cbd5e1);cursor:pointer;transition:all .15s;}',
      '.cc-icon:hover{border-color:var(--accent,#38bdf8);color:var(--accent,#38bdf8);}',
      '.cc-x{width:30px;height:30px;border:none;border-radius:50%;background:var(--bg3,#1e293b);color:var(--text2,#cbd5e1);font-size:17px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;line-height:1;}',
      '.cc-x:hover{background:var(--border2,#334155);color:var(--text,#f8fafc);}',
      R + ' .cc-wrap{overflow:auto;border:1px solid var(--border2,#334155);border-radius:12px;background:var(--bg2,#0f172a);margin-bottom:0;}',
      R + ' table.cc-table{width:100%;border-collapse:collapse;font-size:12.5px;}',
      R + ' .cc-table th{position:sticky;top:0;background:var(--bg2,#1e293b);color:var(--text2,#cbd5e1);text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;padding:12px 14px;border-bottom:1px solid var(--border2,#334155);white-space:nowrap;z-index:1;}',
      R + ' .cc-table th.cc-th-center{text-align:center;}',
      R + ' .cc-table th.cc-th-actions{text-align:right;}',
      R + ' .cc-th{display:flex;align-items:center;gap:6px;}',
      R + ' .cc-th.cc-th-center{justify-content:center;}',
      R + ' .cc-th .cc-lbl{cursor:pointer;user-select:none;color:var(--text,#f8fafc);font-weight:700;}',
      R + ' .cc-th .cc-lbl:hover{color:var(--accent,#38bdf8);}',
      R + ' .cc-th .cc-arrow{font-size:10px;color:var(--accent,#38bdf8);font-weight:bold;margin-left:4px;}',
      R + ' .cc-funnel{cursor:pointer;font-size:11px;color:var(--text2,#94a3b8);padding:3px 5px;border-radius:4px;line-height:1;display:inline-flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.04);border:1px solid transparent;transition:all .15s;}',
      R + ' .cc-funnel:hover{background:var(--bg3,#334155);border-color:var(--border2,#475569);color:var(--text,#ffffff);}',
      R + ' .cc-funnel.on{color:var(--accent,#38bdf8);background:rgba(56,189,248,0.12);border-color:rgba(56,189,248,0.3);}',
      R + ' .cc-table td{padding:11px 14px;border-bottom:1px solid var(--border2,#334155);color:var(--text,#f1f5f9);white-space:nowrap;vertical-align:middle;}',
      R + ' .cc-table td.cc-name{color:var(--text,#ffffff);font-weight:600;}',
      R + ' .cc-table td.cc-center{text-align:center;}',
      R + ' .cc-table td.cc-actions{text-align:right;}',
      R + ' .cc-table td.cc-actions .cc-btn{margin-left:6px;}',
      R + ' .cc-table tbody tr{cursor:pointer;}',
      R + ' .cc-table tr:hover td{background:rgba(255,255,255,.05);}',
      R + ' .cc-table tbody tr.cc-row-active td{background:rgba(56,189,248,.12);}',
      R + ' .cc-table tbody tr.cc-row-active td:first-child{box-shadow:inset 3px 0 0 var(--accent,#38bdf8);}',
      /* candidate cell */
      R + ' .cc-table td.cc-name{min-width:300px;}',
      R + ' .cc-cand{display:flex;align-items:center;gap:8px;width:100%;min-width:0;}',
      R + ' .cc-cand-names{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;}',
      R + ' .cc-nm{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;}',
      R + ' .cc-fn{font-size:10px;font-weight:400;color:var(--text2,#94a3b8);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      R + ' .cc-cand-actions{display:inline-flex;align-items:center;gap:5px;margin-left:auto;padding-left:10px;flex:0 0 auto;}',
      R + ' .cc-ic-btn{width:26px;height:26px;padding:0;background:var(--bg3,#1e293b);border:1px solid var(--border2,#334155);border-radius:6px;cursor:pointer;font-size:12px;line-height:1;color:var(--text2,#cbd5e1);display:inline-flex;align-items:center;justify-content:center;transition:all .15s ease;flex:0 0 26px;box-sizing:border-box;}',
      R + ' .cc-ic-btn:hover{color:var(--accent,#38bdf8);border-color:var(--accent,#38bdf8);background:rgba(56,189,248,0.15);transform:translateY(-1px);}',
      /* Global (not root-scoped) so the detail/resume modal avatar styles too. */
      '.cc-avc{width:28px;height:28px;border-radius:50%;background:var(--accent,#38bdf8);color:#fff;font-size:11px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;}',
      /* job code (same badge as the Job Board's Job Code column; clickable here) */
      '.cc-code{display:inline-block;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;font-weight:700;letter-spacing:.3px;color:var(--accent,#38bdf8);background:rgba(56,189,248,.12);border:1px solid rgba(56,189,248,.3);border-radius:6px;padding:2px 8px;white-space:nowrap;transition:all .15s;}',
      '.cc-code.hold{color:var(--warn,#f59e0b);background:rgba(245,158,11,.12);border-color:rgba(245,158,11,.4);}',
      '.cc-code.closed{color:var(--danger,#ef4444);background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.4);}',
      R + ' .cc-code{cursor:pointer;}',
      R + ' .cc-code:hover{filter:brightness(1.15);box-shadow:0 2px 6px rgba(0,0,0,.25);}',
      R + ' .cc-muted{color:var(--text2,#94a3b8);}',
      '.cc-badge{display:inline-block;cursor:default;font-size:10.5px;font-weight:700;padding:2px 9px;border-radius:999px;background:var(--bg3,#1e293b);border:1px solid var(--border2,#334155);color:var(--text2,#cbd5e1);}',
      R + ' .cc-pill{font-size:10.5px;font-weight:700;padding:2px 9px;border-radius:999px;}',
      R + ' .cc-pill.done{background:rgba(34,211,165,.18);color:var(--success,#22d3a5);}',
      R + ' .cc-bar-t{height:7px;border-radius:99px;background:var(--border2,#334155);overflow:hidden;min-width:52px;display:inline-block;width:70px;vertical-align:middle;}',
      R + ' .cc-bar-f{display:block;height:100%;border-radius:99px;}',
      R + ' .cc-barn{font-size:11px;color:var(--text2,#cbd5e1);margin-left:6px;}',
      R + ' .cc-empty{padding:40px;text-align:center;color:var(--text2,#cbd5e1);font-size:13px;}',
      /* pagination */
      R + ' .cc-pg{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:12px;margin-bottom:8px;font-size:12.5px;color:var(--text2,#cbd5e1);}',
      R + ' .cc-pg .cc-pgspacer{flex:1;}',
      R + ' .cc-pg button{min-width:30px;height:30px;padding:0 8px;background:var(--bg3,#1e293b);border:1px solid var(--border2,#334155);border-radius:8px;color:var(--text,#f8fafc);font:inherit;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s;}',
      R + ' .cc-pg button:hover:not(:disabled){border-color:var(--accent,#38bdf8);color:var(--accent,#38bdf8);}',
      R + ' .cc-pg button:disabled{opacity:.4;cursor:not-allowed;}',
      R + ' .cc-pg button.cur{background:var(--accent,#38bdf8);color:#fff;border-color:var(--accent,#38bdf8);}',
      R + ' .cc-psizes{display:none;gap:4px;}',   // phones only (see @media below)
      R + ' .cc-pg select{background:var(--bg3,#1e293b);border:1px solid var(--border2,#334155);border-radius:8px;color:var(--text,#f8fafc);font:inherit;font-size:12px;padding:5px 6px;}',
      /* export menu */
      M + '{position:absolute;z-index:400;background:var(--bg2,#1e293b);border:1px solid var(--border2,#334155);border-radius:10px;box-shadow:0 12px 34px rgba(0,0,0,.5);padding:6px;min-width:180px;}',
      M + ' button{display:block;width:100%;text-align:left;background:none;border:none;color:var(--text,#f8fafc);font:inherit;font-size:12.5px;padding:9px 12px;border-radius:7px;cursor:pointer;}',
      M + ' button:hover{background:var(--bg3,#334155);}',
      /* per-column filter popup */
      P + '{position:fixed;z-index:600;width:240px;background:var(--bg2,#1e293b);border:1px solid var(--border2,#334155);border-radius:10px;box-shadow:0 16px 40px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden;}',
      P + ' .cc-psort{display:flex;border-bottom:1px solid var(--border2,#334155);}',
      P + ' .cc-psort button{flex:1;background:none;border:none;color:var(--text2,#cbd5e1);font:inherit;font-size:11.5px;font-weight:600;padding:9px;cursor:pointer;}',
      P + ' .cc-psort button:hover{background:var(--bg3,#334155);color:var(--text,#f8fafc);}',
      P + ' .cc-psearch{margin:8px;padding:7px 9px;background:var(--bg3,#1e293b);border:1px solid var(--border2,#334155);border-radius:7px;color:var(--text,#f8fafc);font:inherit;font-size:12px;}',
      P + ' .cc-pvals{max-height:200px;overflow-y:auto;padding:0 8px;}',
      P + ' .cc-pv{display:flex;align-items:center;gap:8px;padding:5px 4px;font-size:12px;color:var(--text,#f8fafc);cursor:pointer;}',
      P + ' .cc-pv input{accent-color:var(--accent,#38bdf8);}',
      P + ' .cc-pf{display:flex;gap:8px;padding:8px;border-top:1px solid var(--border2,#334155);}',
      P + ' .cc-pf button{flex:1;border-radius:7px;padding:7px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;border:1px solid var(--border2,#334155);background:var(--bg3,#1e293b);color:var(--text,#f8fafc);}',
      P + ' .cc-pf button.primary{background:var(--accent,#38bdf8);color:#fff;border-color:var(--accent,#38bdf8);}',
      /* Edit Column / Edit Filters drawers */
      D + '-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:500;display:flex;justify-content:flex-end;animation:cc-fade .15s ease;}',
      D + '{width:380px;max-width:94vw;height:100vh;background:var(--bg2,#1e293b);border-left:1px solid var(--border2,#334155);box-shadow:-24px 0 70px rgba(0,0,0,.5);display:flex;flex-direction:column;animation:cc-slide .28s cubic-bezier(.2,.9,.3,1);}',
      D + ' .cc-dh{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid var(--border2,#334155);}',
      D + ' .cc-dh h3{margin:0;font-family:var(--font-d,inherit);font-size:17px;font-weight:700;color:var(--text,#f8fafc);}',
      D + ' .cc-dsub{padding:14px 22px 6px;font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--text2,#cbd5e1);}',
      D + ' .cc-dlist{flex:1;overflow-y:auto;padding:4px 16px 16px;}',
      D + ' .cc-ci{display:flex;align-items:center;gap:10px;background:var(--bg3,#1e293b);border:1px solid var(--border2,#334155);border-radius:9px;padding:10px 12px;margin-bottom:7px;cursor:grab;}',
      D + ' .cc-ci.drag{opacity:.4;}', D + ' .cc-ci.over{border-color:var(--accent,#38bdf8);}',
      D + ' .cc-grip{color:var(--text2,#94a3b8);font-size:14px;letter-spacing:-2px;}',
      D + ' .cc-ci label{flex:1;display:flex;align-items:center;gap:9px;font-size:13px;color:var(--text,#f8fafc);cursor:pointer;}',
      D + ' .cc-ci input{accent-color:var(--accent,#38bdf8);width:16px;height:16px;}',
      D + ' .cc-df{display:flex;gap:10px;padding:16px 22px;border-top:1px solid var(--border2,#334155);}',
      D + ' .cc-df .cc-btn{flex:1;justify-content:center;padding:11px;font-size:13px;font-weight:700;}',
      D + ' .cc-fsec{font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--text2,#cbd5e1);margin:14px 0 8px;}',
      D + ' .cc-fbody{flex:1;overflow-y:auto;padding:14px 22px 16px;}',
      D + ' .cc-bu{background:var(--bg3,#1e293b);border:1px solid var(--border2,#334155);border-radius:9px;padding:6px 10px;max-height:170px;overflow-y:auto;}',
      D + ' .cc-bu label{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text,#f8fafc);padding:5px 2px;cursor:pointer;}',
      D + ' .cc-bu input,' + D + ' .cc-pd input{accent-color:var(--accent,#38bdf8);width:15px;height:15px;}',
      D + ' .cc-pd{display:grid;gap:8px;}',
      D + ' .cc-pd label{display:flex;align-items:center;gap:10px;background:var(--bg3,#1e293b);border:1px solid var(--border2,#334155);border-radius:8px;padding:9px 12px;font-size:13px;color:var(--text,#f8fafc);cursor:pointer;}',
      D + ' .cc-pd label:hover{border-color:var(--accent,#38bdf8);}',
      D + ' #cc-cflist{margin-top:10px;display:flex;flex-direction:column;gap:4px;}',
      D + ' .cc-filter-row{display:flex;align-items:center;gap:8px;margin-bottom:10px;width:100%;box-sizing:border-box;}',
      D + ' .cc-filter-row select,' + D + ' .cc-filter-row input{flex:1 1 45%;min-width:0;background:var(--bg3,#1e293b);border:1px solid var(--border2,#334155);border-radius:8px;color:var(--text,#f8fafc);font:inherit;font-size:12.5px;padding:8px 10px;height:38px;box-sizing:border-box;}',
      D + ' .cc-filter-row select:focus,' + D + ' .cc-filter-row input:focus{border-color:var(--accent,#38bdf8);outline:none;}',
      D + ' .cc-filter-row .cc-cfx{flex:0 0 34px;width:34px;height:38px;background:var(--bg3,#1e293b);border:1px solid var(--border2,#334155);border-radius:8px;color:var(--danger,#f75f4f);font-size:18px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;line-height:1;box-sizing:border-box;}',
      D + ' .cc-filter-row .cc-cfx:hover{background:rgba(247,95,79,.15);border-color:var(--danger,#f75f4f);}',
      D + ' .cc-addf{color:var(--accent,#38bdf8);font-size:13px;font-weight:700;cursor:pointer;background:none;border:none;padding:10px 0 4px;display:inline-flex;align-items:center;gap:4px;margin-right:14px;}',
      D + ' .cc-addf:hover{text-decoration:underline;}',
      /* resume text modal */
      '.cc-ov{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:700;display:flex;align-items:center;justify-content:center;animation:cc-fade .15s ease;padding:20px;}',
      '.cc-modal{width:560px;max-width:96vw;max-height:90vh;overflow:auto;background:var(--bg2,#1e293b);border:1px solid var(--border2,#334155);border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.5);}',
      '.cc-modal-h{display:flex;align-items:center;gap:12px;padding:16px 22px;border-bottom:1px solid var(--border2,#334155);}',
      '.cc-modal-b{padding:20px 22px;}',
      '.cc-modal.cc-modal-wide{width:960px;}',
      '.cc-modal-b.cc-modal-b-flush{padding:0;}',
      '.cc-vframe{display:block;width:100%;height:72vh;border:0;background:#fff;}',
      '.cc-vimg{padding:12px;text-align:center;}',
      '.cc-vimg img{max-width:100%;max-height:72vh;border-radius:8px;}',
      '.cc-vtext{white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.55;color:var(--text);margin:0;font-family:var(--font);}',
      '.cc-vmsg{padding:26px;text-align:center;color:var(--text2);}',
      'html[data-theme="light"] ' + R + ' .cc-table tr:hover td{background:rgba(0,0,0,.04);}',
      'html[data-theme="light"] ' + R + ' .cc-funnel{background:rgba(0,0,0,.04);}',
      'html[data-theme="light"] .cc-job-item{border-bottom-color:rgba(0,0,0,.06);}',
      '@keyframes cc-fade{from{opacity:0}to{opacity:1}}',
      '@keyframes cc-slide{from{transform:translateX(100%)}to{transform:translateX(0)}}',
      '@keyframes cc-up{from{transform:translateY(100%)}to{transform:translateY(0)}}',
      /* ── Resume Scoring page extras (AI overlay, job picker, modals) ── */
      '.cc-pill-active{background:var(--accent,#4f8ef7) !important;color:#ffffff !important;border-color:var(--accent,#4f8ef7) !important;font-weight:700 !important;box-shadow:0 0 8px rgba(79,142,247,0.4) !important;}',
      '.cc-ring{display:flex;gap:16px;flex-wrap:wrap;margin:8px 0 16px;}',
      '.cc-ring .cc-rc{flex:1;min-width:130px;background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:12px;text-align:center;}',
      '.cc-rc .cc-rv{font-size:26px;font-weight:800;}',
      '.cc-rc .cc-rl{font-size:11px;color:var(--text2);margin-top:2px;}',
      '.cc-chips{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 14px;}',
      '.cc-chip{font-size:11.5px;padding:4px 11px;border-radius:99px;font-weight:500;display:inline-flex;align-items:center;gap:4px;line-height:1.45;}',
      '.cc-chip b{font-weight:700;}',
      '.cc-chip.miss{background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.38);color:#b91c1c;}',
      '[data-theme="dark"] .cc-chip.miss, .dark .cc-chip.miss{background:rgba(239,68,68,0.18);border-color:rgba(239,68,68,0.45);color:#fca5a5;}',
      '.cc-chip.str{background:rgba(34,197,94,0.12);border:1px solid rgba(34,197,94,0.38);color:#15803d;}',
      '[data-theme="dark"] .cc-chip.str, .dark .cc-chip.str{background:rgba(34,197,94,0.18);border-color:rgba(34,197,94,0.45);color:#86efac;}',
      '.cc-brief-card{background:var(--bg3);border:1px solid var(--border2);border-left:4px solid #6366f1;border-radius:10px;padding:12px 14px;margin-bottom:14px;font-size:12px;line-height:1.65;color:var(--text);}',
      '.cc-brief-card b{font-weight:700;color:var(--text);}',
      '.cc-ai-pulse{display:inline-block;animation:ccPulse 1.4s infinite ease-in-out;color:var(--accent,#4f8ef7);}',
      '@keyframes ccPulse{0%,100%{opacity:.4;transform:scale(.98)}50%{opacity:1;transform:scale(1.02)}}',
      '.cc-toggle-wrap{display:inline-flex;align-items:center;background:var(--bg3);border:1px solid var(--border2);border-radius:9px;padding:3px;gap:3px;vertical-align:middle;}',
      '.cc-toggle-tab{border:none;background:transparent;color:var(--text2);font-size:12px;font-weight:600;padding:7px 15px;border-radius:7px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;transition:all .15s ease;font-family:inherit;}',
      '.cc-toggle-tab:hover{color:var(--text);}',
      '.cc-toggle-tab.active.std{background:var(--accent,#4f8ef7);color:#fff;box-shadow:0 2px 8px rgba(79,142,247,0.35);}',
      '.cc-toggle-tab.active.ai{background:linear-gradient(135deg,var(--accent2,#7c5cfc),var(--accent,#4f8ef7));color:#fff;box-shadow:0 2px 8px rgba(124,92,252,0.35);}',
      '#hrms-ai-card-overlay{animation:cc-fade .25s ease;}',
      '.grid-2 > :nth-child(2) > *:not(#hrms-ai-card-overlay){animation:cc-fade .3s ease;}',
      '.grid-2 > div:last-child, .grid-2 > .card:last-child, .grid-2 > .card{position:relative !important;}',
      '#hrms-ai-card-overlay{position:absolute !important;top:0 !important;left:0 !important;right:0 !important;bottom:0 !important;width:100% !important;height:100% !important;max-width:100% !important;background:var(--bg2,#111827) !important;border-radius:inherit;z-index:40;padding:18px 20px;overflow-y:auto;overflow-x:hidden;box-sizing:border-box;display:flex;flex-direction:column;}',
      '#hrms-ai-card-overlay::-webkit-scrollbar{width:5px;}',
      '#hrms-ai-card-overlay::-webkit-scrollbar-track{background:transparent;}',
      '#hrms-ai-card-overlay::-webkit-scrollbar-thumb{background:var(--border2);border-radius:99px;}',
      '#hrms-ai-card-overlay::-webkit-scrollbar-thumb:hover{background:var(--accent,#4f8ef7);}',
      /* Match Score rings MUST always be in a horizontal row side-by-side */
      '.card div[style*="justify-content: space-around"],' +
      '.card div[style*="justify-content:space-around"],' +
      'div[style*="justify-content: space-around"],' +
      'div[style*="justify-content:space-around"]{display:flex !important;flex-direction:row !important;flex-wrap:nowrap !important;justify-content:space-around !important;align-items:center !important;width:100% !important;box-sizing:border-box !important;margin-top:4px !important;margin-bottom:16px !important;}',
      '.card div[style*="justify-content: space-around"] > div,' +
      '.card div[style*="justify-content:space-around"] > div,' +
      'div[style*="justify-content: space-around"] > div,' +
      'div[style*="justify-content:space-around"] > div{display:flex !important;flex-direction:column !important;align-items:center !important;flex:1 1 0 !important;min-width:0 !important;text-align:center !important;}',
      /* Flexible expandable inputs & job post styling */
      '.card textarea{box-sizing:border-box !important;resize:vertical !important;}',
      /* One brightness for both textareas: the app palette instead of browser
         defaults for value and placeholder, and an opaque background on the
         resume box so Chrome keeps subpixel anti-aliasing (it looked thinner). */
      '.card textarea[placeholder*="job description" i],.card textarea[placeholder*="resume" i]{color:var(--text) !important;-webkit-text-fill-color:var(--text);opacity:1 !important;font-weight:400 !important;}',
      '.card textarea[placeholder*="job description" i]::placeholder,.card textarea[placeholder*="resume" i]::placeholder{color:var(--text3,#5a6a85) !important;-webkit-text-fill-color:var(--text3,#5a6a85);opacity:1 !important;}',
      '.card textarea[placeholder*="resume" i]{background:var(--bg3) !important;}',
      /* The two-column grid stretches the left column to the Match Score card's
         height; let the Resume Input card (and its drop zone) absorb that instead
         of leaving a blank band under the buttons. */
      '.cc-g2 > div:first-child > .card:last-child{flex:1 1 auto;display:flex;flex-direction:column;}',
      '.cc-g2 > div:first-child > .card:last-child > div[style*="dashed"]{flex:1 1 auto;display:flex;flex-direction:column;}',
      '.cc-g2 > div:first-child > .card:last-child > div[style*="dashed"] > textarea{flex:1 1 auto;min-height:140px;}',
      '.cc-expand-btn{background:var(--bg3);border:1px solid var(--border2);border-radius:6px;color:var(--text2);font-size:11px;padding:3px 8px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;transition:all .15s ease;font-family:inherit;font-weight:600;}',
      '.cc-expand-btn:hover{color:var(--text);border-color:var(--accent,#4f8ef7);background:rgba(79,142,247,0.15);}',
      '.cc-job-post-card{background:linear-gradient(180deg,rgba(79,142,247,0.06) 0%,rgba(79,142,247,0.01) 100%);border:1px solid rgba(79,142,247,0.2);border-radius:10px;padding:12px 14px;margin-bottom:10px;}',
      '.cc-job-code-pill{display:inline-flex;align-items:center;font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:6px;background:linear-gradient(135deg,rgba(79,142,247,0.18),rgba(124,92,252,0.18));border:1px solid rgba(79,142,247,0.35);color:var(--accent,#4f8ef7);letter-spacing:0.3px;flex-shrink:0;font-family:monospace,sans-serif;}',
      /* Job Picker Bar & Scrollable Search Dropdown in JD Card */
      '.cc-job-picker-bar{position:relative;display:flex;align-items:center;gap:8px;margin-bottom:10px;width:100%;box-sizing:border-box;}',
      '.cc-job-search-box{position:relative;flex:1;min-width:200px;display:flex;align-items:center;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:2px 8px;gap:6px;box-sizing:border-box;}',
      '.cc-job-search-box:focus-within{border-color:var(--accent,#4f8ef7);box-shadow:0 0 0 2px rgba(79,142,247,0.25);}',
      '.cc-job-search-ico{font-size:13px;color:var(--text2);opacity:0.7;}',
      '.cc-job-code-input{flex:1;min-width:0;background:transparent;border:none;color:var(--text);font-family:inherit;font-size:12px;font-weight:600;padding:6px 0;outline:none;}',
      '.cc-job-drop-btn{background:transparent;border:none;color:var(--text2);font-size:11px;cursor:pointer;padding:4px 6px;border-radius:4px;}',
      '.cc-job-drop-btn:hover{color:var(--accent,#4f8ef7);background:rgba(79,142,247,0.12);}',
      '.cc-job-dropdown-list{position:absolute;top:calc(100% + 4px);left:0;right:0;max-height:280px;overflow-y:auto;-webkit-overflow-scrolling:touch;background:var(--bg2,#161b26);border:1px solid var(--border2);border-radius:10px;box-shadow:0 14px 34px rgba(0,0,0,0.5);z-index:9000;padding:6px;box-sizing:border-box;}',
      '.cc-job-item{padding:9px 11px;border-radius:7px;cursor:pointer;transition:all .12s ease;border-bottom:1px solid rgba(255,255,255,0.04);}',
      '.cc-job-item:last-child{border-bottom:none;}',
      '.cc-job-item:hover, .cc-job-item.selected{background:rgba(79,142,247,0.14);}',
      '.cc-job-item-top{display:flex;align-items:center;justify-content:space-between;gap:8px;}',
      '.cc-job-item-title{font-size:12.5px;font-weight:700;color:var(--text);margin-top:3px;}',
      '.cc-job-item-sub{font-size:11px;color:var(--text2);margin-top:2px;display:flex;gap:6px;flex-wrap:wrap;}',
      '.cc-quick-jobs-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:10px;}',
      '.cc-quick-jobs-lbl{font-size:10.5px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:0.4px;}',
      '.cc-quick-job-pill{font-size:10.5px;font-weight:600;padding:3px 8px;border-radius:6px;border:1px solid var(--border2);background:var(--bg3);color:var(--text2);cursor:pointer;transition:all .14s ease;display:inline-flex;align-items:center;gap:4px;}',
      '.cc-quick-job-pill:hover{color:var(--text);border-color:var(--accent,#4f8ef7);background:rgba(79,142,247,0.15);}',
      '.cc-quick-job-pill.active{background:var(--accent,#4f8ef7);border-color:var(--accent,#4f8ef7);color:#fff;font-weight:700;}',
      '.cc-quick-job-pill.closed:not(.active){color:var(--danger,#ef4444);border-color:rgba(239,68,68,.4);}',
      '.cc-quick-job-pill.hold:not(.active){color:var(--warn,#f59e0b);border-color:rgba(245,158,11,.4);}',
      '.cc-quick-jobs-total{font-size:10.5px;font-weight:700;padding:3px 8px;border-radius:6px;border:1px dashed var(--border2);background:transparent;color:var(--text2);cursor:pointer;text-transform:uppercase;letter-spacing:0.4px;white-space:nowrap;margin-left:auto;transition:all .14s ease;}',
      '.cc-quick-jobs-total:hover{color:var(--text);border-color:var(--accent,#4f8ef7);background:rgba(79,142,247,0.1);}',
      '.cc-job-skills-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px;padding-top:8px;border-top:1px dashed var(--border2);}',
      '.cc-job-skill-chip{font-size:10px;font-weight:600;padding:2px 7px;border-radius:5px;background:rgba(79,142,247,0.1);color:var(--accent,#4f8ef7);border:1px solid rgba(79,142,247,0.25);}',
      /* Mobile */
      '.cc-mobile-hint{display:none;}',
      '@media (max-width: 768px){' +
        R + ' .cc-bar{gap:8px;}' +
        R + ' .cc-search{flex-basis:100%;min-width:0;box-sizing:border-box;}' +
        '.cc-mobile-hint{display:flex;align-items:center;justify-content:center;padding:6px 12px;margin-bottom:8px;border-radius:6px;background:rgba(79,142,247,0.08);border:1px dashed rgba(79,142,247,0.3);color:var(--accent,#4f8ef7);font-size:11px;font-weight:600;text-align:center;}' +
        /* The Candidate column scrolls with the rest of the table (pinned at
           300px it left no room for any other column on a phone) and is
           narrower; the swipe hint above the table still points the way. */
        R + ' .cc-table td.cc-name{min-width:0;}' +
        /* A table cell sizes to its content, so both text lines must be capped. */
        R + ' .cc-nm,' + R + ' .cc-fn{max-width:140px;}' +
        R + ' .cc-cand-actions{padding-left:6px;gap:4px;}' +
        R + ' .cc-table td{padding:8px 8px;font-size:12px;}' +
        R + ' .cc-table th{padding:8px 8px;}' +
        '.cc-quick-jobs-bar{overflow-x:auto;white-space:nowrap;-webkit-overflow-scrolling:touch;padding-bottom:4px;}' +
        /* KPI cards: two per row, compact */
        '.content .stat-grid.cc-stats{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-bottom:14px;}' +
        '.cc-stats .stat-card{padding:10px 12px;min-width:0;}' +
        '.cc-stats .stat-label{font-size:9.5px;margin-bottom:4px;white-space:normal;}' +
        '.cc-stats .stat-value{font-size:22px;}' +
        '.cc-stats .stat-sub,.cc-stats .stat-trend{font-size:10px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
        /* Edit Filters / Edit Columns: a bottom sheet sized to its content */
        D + '-overlay{align-items:flex-end;justify-content:center;}' +
        D + '{width:100%;max-width:100%;height:auto;max-height:85vh;max-height:85dvh;border-left:0;border-top:1px solid var(--border2,#334155);border-radius:16px 16px 0 0;animation:cc-up .28s cubic-bezier(.2,.9,.3,1);}' +
        D + ' .cc-fbody,' + D + ' .cc-dlist{flex:0 1 auto;}' +
        D + ' .cc-dh{padding:14px 18px;}' +
        D + ' .cc-df{padding:12px 18px;}' +
        /* Page size: buttons instead of the native select, whose popup opened off-screen */
        R + ' .cc-psizes{display:inline-flex;}' +
        R + ' #cc-psize{display:none;}' +
        R + ' .cc-pg{row-gap:8px;padding-bottom:8px;}' +
        /* Scoring-mode toggle on its own row, Upload File + Bulk Upload side by side */
        '.cc-btn-row{flex-wrap:wrap !important;gap:6px !important;}' +
        '.cc-btn-row > #hrms-scoring-options{flex:1 1 100%;display:flex;}' +
        '.cc-btn-row .cc-toggle-tab{flex:1 1 0;justify-content:center;padding:7px 8px;font-size:11.5px;white-space:nowrap;}' +
        '.cc-btn-row > button{flex:1 1 calc(50% - 3px);min-width:0;padding:7px 8px !important;font-size:11.5px !important;white-space:nowrap;}' +
      '}'
    ].join('');
    var st = document.createElement('style'); st.id = ID.style; st.textContent = css;
    document.head.appendChild(st);
  }

  /* ── render ───────────────────────────────────────────────────────────── */
  var ICON_SLIDERS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><circle cx="9" cy="7" r="2.4" fill="var(--bg3)"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="15" cy="17" r="2.4" fill="var(--bg3)"/></svg>';
  var ICON_COLUMNS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="5.5" height="16" rx="1"/><rect x="9.5" y="4" width="5.5" height="16" rx="1"/><rect x="16" y="4" width="5" height="16" rx="1"/></svg>';
  function buildRoot() {
    var root = document.createElement('div'); root.id = ID.root;
    root.innerHTML =
      '<div class="cc-head"><span class="cc-ttl">' + CARD_TITLE + '</span><span class="cc-count" id="cc-count"></span></div>' +
      '<div class="cc-bar">' +
        '<input class="cc-search" id="cc-search" placeholder="Search candidates, job code, role…">' +
        '<div style="position:relative"><button class="cc-btn" id="cc-export">⭳ Export ▾</button></div>' +
        '<button class="cc-icon" id="cc-filters" title="Edit Filters">' + ICON_SLIDERS + '</button>' +
        '<button class="cc-icon" id="cc-columns" title="Edit Column">' + ICON_COLUMNS + '</button>' +
      '</div>' +
      '<div class="cc-mobile-hint"><span>⟵ Swipe table horizontally to view scores &amp; actions ⟶</span></div>' +
      '<div class="cc-wrap"><table class="cc-table"><thead id="cc-thead"></thead><tbody id="cc-tbody"></tbody></table></div>' +
      '<div class="cc-pg" id="cc-pg"></div>';
    root.querySelector('#cc-search').addEventListener('input', function (e) { state.search = e.target.value; state.page = 1; renderTable(); });
    root.querySelector('#cc-export').addEventListener('click', function (e) { e.stopPropagation(); toggleExportMenu(e.currentTarget); });
    root.querySelector('#cc-filters').addEventListener('click', openFiltersDrawer);
    root.querySelector('#cc-columns').addEventListener('click', openColsDrawer);
    return root;
  }

  function isCenter(c) { return !!(c.num || c.key === 'formatted'); }

  function renderTable() {
    var root = document.getElementById(ID.root); if (!root) return;
    var thead = root.querySelector('#cc-thead'), tbody = root.querySelector('#cc-tbody'); if (!thead || !tbody) return;
    var cols = shownCols(), span = cols.length + 1;
    thead.innerHTML = '<tr>' + cols.map(function (c) {
      var arrow = state.sortKey === c.key ? '<span class="cc-arrow">' + (state.sortDir > 0 ? '▲' : '▼') + '</span>' : '';
      var on = state.colFilters[c.key] ? ' on' : '';
      var center = isCenter(c) ? ' cc-th-center' : '';
      return '<th class="' + center.trim() + '"><div class="cc-th' + center + '">' +
        '<span class="cc-funnel' + on + '" data-flt="' + c.key + '" title="Filter">▼</span>' +
        '<span class="cc-lbl" data-sort="' + c.key + '">' + esc(c.label) + arrow + '</span></div></th>';
    }).join('') + '<th class="cc-th-actions">Actions</th></tr>';
    thead.querySelectorAll('[data-sort]').forEach(function (el) { el.addEventListener('click', function () { var k = el.getAttribute('data-sort'); if (state.sortKey === k) state.sortDir = -state.sortDir; else { state.sortKey = k; state.sortDir = 1; } renderTable(); }); });
    thead.querySelectorAll('[data-flt]').forEach(function (el) { el.addEventListener('click', function (e) { e.stopPropagation(); openColPopup(el.getAttribute('data-flt'), el); }); });

    if (!state.loaded) { tbody.innerHTML = '<tr><td class="cc-empty" colspan="' + span + '">Loading candidates…</td></tr>'; renderPg(0); setCount(); return; }
    var all = filtered(), total = all.length;
    if (!total) {
      tbody.innerHTML = '<tr><td class="cc-empty" colspan="' + span + '">' + (state.rows.length ? 'No candidates match your filters.' : 'No candidates scored yet.') + '</td></tr>';
      renderPg(0); setCount(0); return;
    }
    var pages = Math.max(1, Math.ceil(total / state.pageSize));
    if (state.page > pages) state.page = pages;
    var start = (state.page - 1) * state.pageSize, rows = all.slice(start, start + state.pageSize);

    tbody.innerHTML = rows.map(function (r) {
      return '<tr data-id="' + esc(r.id) + '">' + cols.map(function (c) { return cell(r, c); }).join('') +
        '<td class="cc-actions">' +
          '<button class="cc-btn primary cc-sm" data-ai="' + esc(r.id) + '" title="AI Deep Analysis">✦ AI</button>' +
          '<button class="cc-btn cc-sm" data-view="' + esc(r.id) + '" title="View uploaded resume">View</button>' +
          '<button class="cc-btn danger cc-sm" data-del="' + esc(r.id) + '" title="Delete candidate resume">🗑 Delete</button>' +
        '</td></tr>';
    }).join('');

    tbody.querySelectorAll('tr').forEach(function (tr) {
      tr.addEventListener('click', function () { syncToCandidate(byId(tr.getAttribute('data-id'))); });
    });
    tbody.querySelectorAll('[data-ai]').forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); showAIModal(byId(b.getAttribute('data-ai'))); });
    });
    tbody.querySelectorAll('[data-view]').forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); viewResume(byId(b.getAttribute('data-view'))); });
    });
    tbody.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var id = b.getAttribute('data-del');
        var cand = byId(id);
        var candName = (cand && cand.name) || 'this candidate';
        if (!confirm('Are you sure you want to delete ' + candName + '’s resume? This action cannot be undone.')) return;
        b.disabled = true;
        api('/api/resume-scores/' + id, { method: 'DELETE' }).then(function () {
          state.rows = state.rows.filter(function (row) { return String(row.id) !== String(id); });
          renderTable();
          toast('Resume deleted successfully.');
        }).catch(function (err) {
          b.disabled = false;
          toast('Failed to delete resume: ' + (err.message || 'Server error'), 'error');
        });
      });
    });
    tbody.querySelectorAll('[data-fmt]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var id = b.getAttribute('data-fmt');
        var cand = byId(id);
        b.disabled = true;
        b.textContent = 'Converting…';
        api('/api/resume-scores/' + id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ formatted: true })
        }).then(function () {
          if (cand) cand.formatted = true;
          renderTable();
          toast('Resume standardized to Eversoft template successfully.');
        }).catch(function (err) {
          b.disabled = false;
          b.textContent = 'Convert Failed (Retry)';
          toast('Format conversion failed: ' + (err.message || 'Server error'), 'error');
        });
      });
    });
    tbody.querySelectorAll('[data-eye]').forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); viewResume(byId(b.getAttribute('data-eye'))); });
    });
    tbody.querySelectorAll('[data-dl2]').forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); downloadResume(byId(b.getAttribute('data-dl2'))); });
    });
    tbody.querySelectorAll('[data-load-jd]').forEach(function (el) {
      el.addEventListener('click', function (e) { e.stopPropagation(); selectJobByCode(el.getAttribute('data-load-jd')); });
    });
    renderPg(total, start, rows.length, pages);
    setCount(total);
  }

  // One <td> per column (the cell decides its own classes, e.g. centred scores).
  function cell(r, c) {
    var v = cellVal(r, c.key);
    if (c.key === 'name') {
      var fn = r.fileName ? '<span class="cc-fn" title="' + esc(r.fileName) + '">📄 ' + esc(r.fileName) + '</span>' : '';
      return '<td class="cc-name"><div class="cc-cand">' +
        '<span class="cc-avc">' + esc(initials(r)) + '</span>' +
        '<div class="cc-cand-names"><span class="cc-nm" title="' + esc(r.name || '—') + '">' + esc(r.name || '—') + '</span>' + fn + '</div>' +
        '<span class="cc-cand-actions">' +
          '<button class="cc-ic-btn" data-eye="' + esc(r.id) + '" title="View resume">👁</button>' +
          '<button class="cc-ic-btn" data-dl2="' + esc(r.id) + '" title="Download resume">⤓</button>' +
        '</span></div></td>';
    }
    if (c.key === 'jobCode') {
      var code = candidateCode(r);
      if (!code) return '<td><span class="cc-muted">—</span></td>';
      var job = jobByCode(code), kind = jobStatusKind(job);
      var tip = job ? '[' + code + '] ' + job.title + ' · ' + (job.status || 'Active') + ' — click to load its description' : 'Job post ' + code + ' is not on the Job Board';
      var label = esc(code) + (job && kind !== 'active' ? ' · ' + esc(job.status) : '');
      return '<td><span class="cc-code' + kindClass(job) + '" data-load-jd="' + esc(code) + '" title="' + esc(tip) + '">' + label + '</span></td>';
    }
    if (c.score) return '<td class="cc-center"><b style="color:' + scoreColor(v) + '">' + num(v) + '</b></td>';
    if (c.bar) {
      var n = num(v);
      return '<td class="cc-center"><span class="cc-bar-t"><span class="cc-bar-f" style="width:' + Math.max(0, Math.min(100, n)) + '%;background:' + scoreColor(n) + '"></span></span><span class="cc-barn">' + n + '</span></td>';
    }
    // Source is where the resume came from; the default 'Upload' read as a
    // button, so it is shown as the past tense.
    if (c.key === 'source') { var src = v || 'Upload'; return '<td><span class="cc-badge">' + esc(src === 'Upload' ? 'Uploaded' : src) + '</span></td>'; }
    if (c.key === 'formatted') {
      return '<td class="cc-center">' + (r.formatted
        ? '<span class="cc-pill done">✓ Done</span>'
        : '<button class="cc-btn cc-sm" data-fmt="' + esc(r.id) + '" title="Convert resume to standardized format">Pending (Convert →)</button>') + '</td>';
    }
    return '<td>' + esc(v || '—') + '</td>';
  }

  function setCount(total) {
    var el = document.getElementById('cc-count'); if (!el) return;
    if (!state.loaded) { el.textContent = ''; return; }
    var t = total == null ? filtered().length : total;
    el.textContent = '· ' + t + ' / ' + state.rows.length + ' shown';
  }

  function renderPg(total, start, shown, pages) {
    var pg = document.getElementById('cc-pg'); if (!pg) return;
    if (!total) { pg.innerHTML = '<span>' + (state.loaded ? '0 candidates' : '') + '</span>'; return; }
    var from = start + 1, to = start + shown, p = state.page;
    var lo = Math.max(1, p - 2), hi = Math.min(pages, lo + 4); lo = Math.max(1, hi - 4);
    var nums = []; for (var i = lo; i <= hi; i++) nums.push(i);
    pg.innerHTML =
      '<span>' + from + '–' + to + ' of ' + total + '</span>' +
      '<span class="cc-pgspacer"></span>' +
      '<button data-pg="first"' + (p <= 1 ? ' disabled' : '') + '>«</button>' +
      '<button data-pg="prev"' + (p <= 1 ? ' disabled' : '') + '>‹</button>' +
      nums.map(function (n) { return '<button data-pg="' + n + '"' + (n === p ? ' class="cur"' : '') + '>' + n + '</button>'; }).join('') +
      '<button data-pg="next"' + (p >= pages ? ' disabled' : '') + '>›</button>' +
      '<button data-pg="last"' + (p >= pages ? ' disabled' : '') + '>»</button>' +
      '<span class="cc-psizes">' + PAGE_SIZES.map(function (s) { return '<button data-ps="' + s + '"' + (s === state.pageSize ? ' class="cur"' : '') + '>' + s + '</button>'; }).join('') + '</span>' +
      '<select id="cc-psize">' + PAGE_SIZES.map(function (s) { return '<option' + (s === state.pageSize ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select>' +
      '<span>per page</span>';
    pg.querySelectorAll('[data-pg]').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-pg');
        if (v === 'first') state.page = 1; else if (v === 'prev') state.page = Math.max(1, p - 1);
        else if (v === 'next') state.page = Math.min(pages, p + 1); else if (v === 'last') state.page = pages;
        else state.page = +v;
        renderTable();
      });
    });
    var sz = pg.querySelector('#cc-psize'); if (sz) sz.addEventListener('change', function (e) { state.pageSize = +e.target.value; state.page = 1; renderTable(); });
    pg.querySelectorAll('[data-ps]').forEach(function (b) {
      b.addEventListener('click', function () { state.pageSize = +b.getAttribute('data-ps'); state.page = 1; renderTable(); });
    });
  }

  function byId(id) { for (var i = 0; i < state.rows.length; i++) if (String(state.rows[i].id) === String(id)) return state.rows[i]; return null; }

  /* ── per-column filter popup ──────────────────────────────────────────── */
  function closePopups() { var p = document.getElementById(ID.pop); if (p) p.remove(); }
  function openColPopup(key, anchor) {
    if (document.getElementById(ID.pop)) { closePopups(); return; }
    var vals = distinct(key);
    var sel = state.colFilters[key] ? state.colFilters[key].slice() : vals.slice(); // default: all checked
    var pop = document.createElement('div'); pop.id = ID.pop;
    pop.innerHTML =
      '<div class="cc-psort"><button data-s="1">↑ Sort A→Z</button><button data-s="-1">↓ Sort Z→A</button></div>' +
      '<input class="cc-psearch" placeholder="Search values…">' +
      '<div class="cc-pvals"><label class="cc-pv"><input type="checkbox" id="cc-pall"> <b>(Select all)</b></label><div id="cc-pvlist"></div></div>' +
      '<div class="cc-pf"><button class="primary" data-a="apply">Apply</button><button data-a="clear">Clear</button></div>';
    document.body.appendChild(pop);
    var r = anchor.getBoundingClientRect();
    pop.style.top = Math.min(r.bottom + 4, window.innerHeight - 340) + 'px';
    pop.style.left = Math.min(r.left, window.innerWidth - 250) + 'px';
    function drawVals(filter) {
      var list = pop.querySelector('#cc-pvlist');
      var shown = vals.filter(function (v) { return !filter || v.toLowerCase().indexOf(filter) !== -1; });
      list.innerHTML = shown.map(function (v) { return '<label class="cc-pv"><input type="checkbox" value="' + esc(v) + '"' + (sel.indexOf(v) !== -1 ? ' checked' : '') + '> ' + (v === '' ? '(blank)' : esc(v)) + '</label>'; }).join('');
      list.querySelectorAll('input').forEach(function (cb) { cb.addEventListener('change', function () { var val = cb.value; if (cb.checked) { if (sel.indexOf(val) === -1) sel.push(val); } else { var i = sel.indexOf(val); if (i !== -1) sel.splice(i, 1); } syncAll(); }); });
      syncAll();
    }
    function syncAll() { var all = pop.querySelector('#cc-pall'); if (all) all.checked = vals.length && sel.length === vals.length; }
    drawVals('');
    pop.querySelector('.cc-psearch').addEventListener('input', function (e) { drawVals(e.target.value.toLowerCase()); });
    pop.querySelector('#cc-pall').addEventListener('change', function (e) { sel = e.target.checked ? vals.slice() : []; drawVals(pop.querySelector('.cc-psearch').value.toLowerCase()); });
    pop.querySelectorAll('[data-s]').forEach(function (b) { b.addEventListener('click', function () { state.sortKey = key; state.sortDir = +b.getAttribute('data-s'); closePopups(); renderTable(); }); });
    pop.querySelector('[data-a="apply"]').addEventListener('click', function () {
      if (sel.length === vals.length) delete state.colFilters[key]; else state.colFilters[key] = sel;
      state.page = 1; closePopups(); renderTable();
    });
    pop.querySelector('[data-a="clear"]').addEventListener('click', function () { delete state.colFilters[key]; state.page = 1; closePopups(); renderTable(); });
    setTimeout(function () { document.addEventListener('mousedown', function h(e) { var p = document.getElementById(ID.pop); if (p && !p.contains(e.target)) { p.remove(); document.removeEventListener('mousedown', h); } }); }, 0);
  }

  /* ── Edit Column drawer ───────────────────────────────────────────────── */
  function openColsDrawer() {
    closeColsDrawer(); closeDrawer();
    if (!state.cols) loadColPrefs();
    var ov = document.createElement('div'); ov.id = ID.cdrawer; ov.className = 'cc-dr-overlay';
    var dr = document.createElement('div'); dr.className = 'cc-dr';
    var onCount = state.cols.filter(function (c) { return c.on; }).length;
    dr.innerHTML =
      '<div class="cc-dh"><h3>Edit Column</h3><button class="cc-x" id="cc-dx">×</button></div>' +
      '<div class="cc-dsub"><span id="cc-dcount">' + onCount + '</span> of ' + state.cols.length + ' selected</div>' +
      '<div class="cc-dlist" id="cc-dlist"></div>' +
      '<div class="cc-df"><button class="cc-btn primary" id="cc-dapply">Apply</button><button class="cc-btn ghost" id="cc-dcancel">Cancel</button></div>';
    ov.appendChild(dr); document.body.appendChild(ov);
    var working = state.cols.map(function (c) { return { key: c.key, on: c.on }; });
    renderColsList(working);
    ov.addEventListener('click', function (e) { if (e.target === ov) closeColsDrawer(); });
    dr.querySelector('#cc-dx').addEventListener('click', closeColsDrawer);
    dr.querySelector('#cc-dcancel').addEventListener('click', closeColsDrawer);
    dr.querySelector('#cc-dapply').addEventListener('click', function () { state.cols = working; saveColPrefs(); renderTable(); closeColsDrawer(); });
  }
  function renderColsList(working) {
    var list = document.getElementById('cc-dlist'); if (!list) return;
    list.innerHTML = working.map(function (c, i) {
      return '<div class="cc-ci" draggable="true" data-i="' + i + '"><span class="cc-grip">⋮⋮</span><label><input type="checkbox"' + (c.on ? ' checked' : '') + '>' + esc(col(c.key).label) + '</label></div>';
    }).join('');
    list.querySelectorAll('.cc-ci').forEach(function (el) {
      var i = +el.getAttribute('data-i');
      el.querySelector('input').addEventListener('change', function (e) { working[i].on = e.target.checked; var dc = document.getElementById('cc-dcount'); if (dc) dc.textContent = working.filter(function (c) { return c.on; }).length; });
      el.addEventListener('dragstart', function (e) { el.classList.add('drag'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', i); });
      el.addEventListener('dragend', function () { el.classList.remove('drag'); });
      el.addEventListener('dragover', function (e) { e.preventDefault(); el.classList.add('over'); });
      el.addEventListener('dragleave', function () { el.classList.remove('over'); });
      el.addEventListener('drop', function (e) { e.preventDefault(); el.classList.remove('over'); var from = +e.dataTransfer.getData('text/plain'), to = i; if (from === to || isNaN(from)) return; var m = working.splice(from, 1)[0]; working.splice(to, 0, m); renderColsList(working); });
    });
  }
  function closeColsDrawer() { var ov = document.getElementById(ID.cdrawer); if (ov) ov.remove(); }

  /* ── Edit Filters drawer (Job Post + pre-defined + custom) ─────────────── */
  function openFiltersDrawer() {
    closeColsDrawer(); closeDrawer();
    var codes = distinct('jobCode');
    var sel = state.jobFilter ? state.jobFilter.slice() : codes.slice();
    var predef = state.predef;
    var customs = state.customFilters.map(function (c) { return { key: c.key, val: c.val }; });
    var ov = document.createElement('div'); ov.id = ID.drawer; ov.className = 'cc-dr-overlay';
    var dr = document.createElement('div'); dr.className = 'cc-dr';
    dr.innerHTML =
      '<div class="cc-dh"><h3>Edit Filters</h3><button class="cc-x" id="cc-fx">×</button></div>' +
      '<div class="cc-fbody">' +
        '<div class="cc-fsec" style="margin-top:0">Job Post</div>' +
        '<div class="cc-bu" id="cc-bu"></div>' +
        '<div class="cc-fsec">Pre-Defined Filters</div>' +
        '<div class="cc-pd">' + PREDEF.map(function (p) { return '<label><input type="radio" name="cc-predef" value="' + p[0] + '"' + (p[0] === predef ? ' checked' : '') + '>' + esc(p[1]) + '</label>'; }).join('') + '</div>' +
        '<div class="cc-fsec">Custom Filters</div>' +
        '<div id="cc-cflist"></div>' +
        '<button class="cc-addf" id="cc-addf">+ Add Filter</button>' +
        '<button class="cc-addf" id="cc-freset" style="color:var(--danger,#f75f4f)">Reset all filters</button>' +
      '</div>' +
      '<div class="cc-df"><button class="cc-btn primary" id="cc-fapply">Apply</button><button class="cc-btn ghost" id="cc-fcancel">Cancel</button></div>';
    ov.appendChild(dr); document.body.appendChild(ov); ensureStyle();
    var buBox = dr.querySelector('#cc-bu');
    function codeLabel(c) {
      if (c === '') return '<span class="cc-muted">(no job code)</span>';
      var j = jobByCode(c);
      return '<span class="cc-code' + kindClass(j) + '">' + esc(c) + '</span>' + (j ? ' <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(j.title) + '</span>' : '');
    }
    function drawBu() {
      if (!codes.length) { buBox.innerHTML = '<span class="cc-muted" style="font-size:12px">No candidates scored yet.</span>'; return; }
      buBox.innerHTML = '<label><input type="checkbox" id="cc-buall"' + (sel.length === codes.length ? ' checked' : '') + '> <b>(All selected)</b></label>' +
        codes.map(function (c) { return '<label><input type="checkbox" value="' + esc(c) + '"' + (sel.indexOf(c) !== -1 ? ' checked' : '') + '> ' + codeLabel(c) + '</label>'; }).join('');
      buBox.querySelector('#cc-buall').addEventListener('change', function (e) { sel = e.target.checked ? codes.slice() : []; drawBu(); });
      buBox.querySelectorAll('input[value]').forEach(function (cb) { cb.addEventListener('change', function () { var v = cb.value; if (cb.checked) { if (sel.indexOf(v) === -1) sel.push(v); } else { var i = sel.indexOf(v); if (i !== -1) sel.splice(i, 1); } var a = buBox.querySelector('#cc-buall'); if (a) a.checked = sel.length === codes.length; }); });
    }
    drawBu();
    dr.querySelectorAll('input[name="cc-predef"]').forEach(function (r) { r.addEventListener('change', function () { predef = r.value; }); });
    var cfList = dr.querySelector('#cc-cflist');
    function drawCf() {
      cfList.innerHTML = customs.map(function (c, i) {
        return '<div class="cc-filter-row"><select data-cfk="' + i + '">' + COLS.map(function (cc) { return '<option value="' + cc.key + '"' + (cc.key === c.key ? ' selected' : '') + '>' + esc(cc.label) + '</option>'; }).join('') + '</select>' +
          '<input data-cfv="' + i + '" placeholder="contains…" value="' + esc(c.val) + '"><button class="cc-cfx" data-cfd="' + i + '" title="Remove filter">×</button></div>';
      }).join('');
      cfList.querySelectorAll('[data-cfk]').forEach(function (s) { s.addEventListener('change', function () { customs[+s.getAttribute('data-cfk')].key = s.value; }); });
      cfList.querySelectorAll('[data-cfv]').forEach(function (inp) { inp.addEventListener('input', function () { customs[+inp.getAttribute('data-cfv')].val = inp.value; }); });
      cfList.querySelectorAll('[data-cfd]').forEach(function (b) { b.addEventListener('click', function () { customs.splice(+b.getAttribute('data-cfd'), 1); drawCf(); }); });
    }
    drawCf();
    dr.querySelector('#cc-addf').addEventListener('click', function () { customs.push({ key: COLS[0].key, val: '' }); drawCf(); });
    ov.addEventListener('click', function (e) { if (e.target === ov) closeDrawer(); });
    dr.querySelector('#cc-fx').addEventListener('click', closeDrawer);
    dr.querySelector('#cc-fcancel').addEventListener('click', closeDrawer);
    dr.querySelector('#cc-fapply').addEventListener('click', function () {
      state.jobFilter = (sel.length === codes.length) ? null : sel;
      state.predef = predef;
      state.customFilters = customs.filter(function (c) { return c.val; });
      state.page = 1; closeDrawer(); renderTable();
    });
    dr.querySelector('#cc-freset').addEventListener('click', function () {
      state.jobFilter = null; state.predef = 'all'; state.customFilters = []; state.colFilters = {}; state.sortKey = null; state.search = '';
      var si = document.getElementById('cc-search'); if (si) si.value = '';
      state.page = 1; closeDrawer(); renderTable();
    });
  }
  function closeDrawer() { var d = document.getElementById(ID.drawer); if (d) d.remove(); }

  /* ── view / download the stored resume text ───────────────────────────── */
  // Only the extracted resume TEXT is stored server-side (the original PDF is
  // parsed client-side and never uploaded), so "view/download resume" operates
  // on resumeText, which the list endpoint already returns.
  var detailCache = {};
  function fetchDetail(id) {
    if (detailCache[id]) return Promise.resolve(detailCache[id]);
    return api('/api/resume-scores/' + id).then(function (d) { detailCache[id] = d || {}; return detailCache[id]; });
  }
  function b64ToBlob(b64, mime) {
    try {
      var bin = atob(b64 || ''), n = bin.length, a = new Uint8Array(n);
      for (var i = 0; i < n; i++) a[i] = bin.charCodeAt(i);
      return new Blob([a], { type: mime || 'application/octet-stream' });
    } catch (_) { return null; }
  }
  function previewable(mime) { return /pdf|image\//i.test(mime || ''); }
  function triggerDownload(blob, name) {
    var u = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = u; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(u); }, 100);
  }

  // View the stored resume IN PAGE. The old path opened a new tab after the
  // async fetch (which popup blockers kill) and fell back to a text modal whose
  // closeModal() no longer existed, so "View" looked dead on many rows. Now: the
  // real PDF/image in a frame, else the extracted text, else a plain note.
  var viewerUrl = null, viewerSeq = 0;
  function closeModal() {
    var m = document.getElementById(ID.modal); if (m) m.remove();
    if (viewerUrl) { try { URL.revokeObjectURL(viewerUrl); } catch (_) {} viewerUrl = null; }
  }
  function inferMime(mime, name) {
    mime = String(mime || '').toLowerCase(); name = String(name || '').toLowerCase();
    if (mime && mime !== 'application/octet-stream') return mime;
    if (/\.pdf$/.test(name)) return 'application/pdf';
    var im = name.match(/\.(png|jpe?g|gif|webp)$/);
    if (im) return 'image/' + (im[1] === 'jpg' ? 'jpeg' : im[1]);
    return mime;
  }
  function viewResume(r) {
    if (!r) return;
    var seq = ++viewerSeq;
    renderViewer(r, null);                        // opens at once, inside the click
    fetchDetail(r.id).then(function (d) {
      if (seq === viewerSeq && document.getElementById(ID.modal)) renderViewer(r, d || {});
    }).catch(function (err) {
      if (seq === viewerSeq && document.getElementById(ID.modal)) renderViewer(r, { resumeText: r.resumeText || '' }, (err && err.message) || 'Request failed');
    });
  }
  function renderViewer(r, d, errMsg) {
    closeModal();
    var txt = d ? String(d.resumeText || r.resumeText || '').trim() : '';
    var fileName = (d && d.fileName) || r.fileName || '';
    var mime = d ? inferMime(d.fileMime, fileName) : '';
    var blob = (d && d.fileData) ? b64ToBlob(d.fileData, mime || 'application/octet-stream') : null;
    var url = null;
    if (blob && previewable(mime)) { url = URL.createObjectURL(blob); viewerUrl = url; }
    var body;
    if (!d) body = '<div class="cc-vmsg">Loading resume…</div>';
    else if (url && /pdf/i.test(mime)) body = '<iframe class="cc-vframe" src="' + url + '" title="Resume"></iframe>';
    else if (url) body = '<div class="cc-vimg"><img src="' + url + '" alt="Resume"></div>';
    else if (txt) body = '<pre class="cc-vtext">' + esc(txt) + '</pre>';
    else body = '<div class="cc-vmsg">' + (errMsg ? 'Could not load this resume: ' + esc(errMsg)
      : (blob ? 'This file type can’t be previewed in the browser. Use Download to open it.' : 'No resume file or text is stored for this candidate.')) + '</div>';
    var ov = document.createElement('div'); ov.className = 'cc-ov'; ov.id = ID.modal;
    ov.innerHTML =
      '<div class="cc-modal' + (url ? ' cc-modal-wide' : '') + '">' +
        '<div class="cc-modal-h">' +
          '<span class="cc-avc" style="width:34px;height:34px;font-size:13px">' + esc(initials(r)) + '</span>' +
          '<div style="flex:1;min-width:0"><div style="font-weight:700;color:var(--text)">' + esc(r.name || '—') + '</div>' +
            '<div style="font-size:11px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(fileName || 'Resume text') + '</div></div>' +
          (url ? '<button class="cc-btn" id="cc-m-tab" title="Open in a new tab">⧉ New tab</button>' : '') +
          ((blob || txt) ? '<button class="cc-btn" id="cc-m-dl">⭳ Download</button>' : '') +
          '<button class="cc-x" id="cc-m-x">×</button>' +
        '</div>' +
        '<div class="cc-modal-b' + (url ? ' cc-modal-b-flush' : '') + '">' + body + '</div>' +
      '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) closeModal(); });
    ov.querySelector('#cc-m-x').addEventListener('click', closeModal);
    var dl = ov.querySelector('#cc-m-dl'); if (dl) dl.addEventListener('click', function () { downloadResume(r); });
    var tab = ov.querySelector('#cc-m-tab'); if (tab) tab.addEventListener('click', function () { window.open(url, '_blank'); });
  }

  function downloadResume(r) {
    if (!r) return;
    fetchDetail(r.id).then(function (d) {
      d = d || {};
      var name = (d.fileName || r.fileName || (r.name ? r.name.replace(/\s+/g, '_') + '_Resume.txt' : 'resume.txt'));
      if (d.fileData) {
        var blob = b64ToBlob(d.fileData, d.fileMime || 'application/octet-stream');
        if (blob) { triggerDownload(blob, name); return; }
      }
      var txt = (d.resumeText || r.resumeText || '').trim();
      if (txt) {
        var blobTxt = new Blob([txt], { type: 'text/plain;charset=utf-8' });
        if (!/\.[a-zA-Z0-9]+$/.test(name)) name += '.txt';
        triggerDownload(blobTxt, name);
        return;
      }
      toast('No download file or text stored for this candidate.', 'error');
    }).catch(function (err) {
      toast('Failed to download resume: ' + (err.message || 'Error'), 'error');
    });
  }

  function setResumeInput(text) {
    var tas = document.querySelectorAll('textarea');
    var ta = null;
    for (var i = 0; i < tas.length; i++) {
      var ph = (tas[i].getAttribute('placeholder') || '').toLowerCase();
      if (ph.indexOf('resume') !== -1) {
        ta = tas[i];
        break;
      }
    }
    if (!ta && tas.length >= 2) ta = tas[1];
    if (!ta && tas.length === 1) ta = tas[0];
    if (!ta) return;

    var proto = window.HTMLTextAreaElement.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(ta, text);
    } else {
      ta.value = text;
    }
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function updateFileBadge(cand) {
    var ta = document.querySelector('textarea[placeholder*="resume"], textarea[placeholder*="Resume"]') || document.querySelectorAll('textarea')[1];
    if (!ta) return;
    var container = ta.closest('.card') || ta.parentElement;
    if (!container) return;

    var fileName = cand && (cand.fileName || (cand.name ? cand.name.replace(/\s+/g, '_') + '_Resume.pdf' : 'Resume.pdf'));
    if (!fileName) return;

    var badges = container.querySelectorAll('div');
    var reactBadge = null;
    for (var i = 0; i < badges.length; i++) {
      var txt = badges[i].textContent || '';
      if (txt.indexOf('📄') !== -1 && txt.indexOf('✕') !== -1) {
        reactBadge = badges[i];
        break;
      }
    }
    if (reactBadge) {
      var spans = reactBadge.querySelectorAll('span');
      if (spans.length >= 2) {
        spans[1].textContent = fileName;
        return;
      }
    }

    var ourBadge = container.querySelector('#cc-injected-file-badge');
    if (!ourBadge) {
      ourBadge = document.createElement('div');
      ourBadge.id = 'cc-injected-file-badge';
      ourBadge.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:6px 10px;background:rgba(34,211,165,0.08);border:1px solid rgba(34,211,165,0.25);border-radius:7px;font-family:var(--font);font-size:11px;';
      var btnRow = container.querySelector('.btn-primary') ? container.querySelector('.btn-primary').parentElement : null;
      if (btnRow && btnRow.parentNode === container) {
        container.insertBefore(ourBadge, btnRow);
      } else {
        var taWrap = ta.parentElement;
        if (taWrap && taWrap.parentNode === container) {
          container.insertBefore(ourBadge, taWrap.nextSibling);
        } else {
          container.appendChild(ourBadge);
        }
      }
    }
    ourBadge.innerHTML =
      '<span style="font-size:14px">📄</span>' +
      '<span style="color:var(--success,#22c55e);font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(fileName) + '</span>' +
      '<button id="cc-del-file-badge" style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:14px" title="Clear resume">✕</button>';
    var xBtn = ourBadge.querySelector('#cc-del-file-badge');
    if (xBtn) {
      xBtn.addEventListener('click', function () {
        ourBadge.remove();
        setResumeInput('');
      });
    }
  }

  function scrollToAnalysis() {
    var target = findMatchScoreCard();
    if (!target) {
      var cards = document.querySelectorAll('.card');
      for (var i = 0; i < cards.length; i++) {
        var t = cards[i].textContent || '';
        if (t.indexOf('Match Score') !== -1 || t.indexOf('MATCH SCORE') !== -1) {
          target = cards[i];
          break;
        }
      }
    }
    if (!target) return;

    try {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (_) {
      target.scrollIntoView();
    }

    var scrollContainers = document.querySelectorAll('.main, .content, main, #root, body, html');
    for (var c = 0; c < scrollContainers.length; c++) {
      var sc = scrollContainers[c];
      if (sc && sc.scrollHeight > sc.clientHeight) {
        var r = target.getBoundingClientRect();
        var scr = sc.getBoundingClientRect();
        if (r.top < scr.top || r.bottom > scr.bottom) {
          try {
            sc.scrollTo({ top: sc.scrollTop + (r.top - scr.top) - 20, behavior: 'smooth' });
          } catch (_) {}
        }
      }
    }
  }

  function proxyClickReact(cand) {
    if (!cand) return false;
    var rc = reactCard();
    if (!rc) return false;
    var trs = rc.querySelectorAll('tbody tr');
    for (var i = 0; i < trs.length; i++) {
      var tr = trs[i];
      var match = false;
      for (var k in tr) {
        if (k.startsWith('__reactFiber$')) {
          var fib = tr[k];
          if (fib && fib.key != null && String(fib.key) === String(cand.id)) {
            match = true;
            break;
          }
        }
      }
      if (!match) {
        var txt = (tr.textContent || '').trim();
        if (cand.name && cand.name !== 'Candidate' && txt.indexOf(cand.name) !== -1) {
          match = true;
        } else if (cand.fileName && txt.indexOf(cand.fileName) !== -1) {
          match = true;
        }
      }
      if (match) {
        tr.click();
        for (var prop in tr) {
          if (prop.startsWith('__reactProps$')) {
            if (tr[prop] && typeof tr[prop].onClick === 'function') {
              try { tr[prop].onClick({ stopPropagation: function () {} }); } catch (_) {}
            }
          }
        }
        return true;
      }
    }
    return false;
  }

  function syncToCandidate(cand) {
    if (!cand) return;

    var root = document.getElementById(ID.root);
    if (root) {
      var allTrs = root.querySelectorAll('tbody tr');
      for (var i = 0; i < allTrs.length; i++) {
        if (allTrs[i].getAttribute('data-id') === String(cand.id)) {
          allTrs[i].classList.add('cc-row-active');
        } else {
          allTrs[i].classList.remove('cc-row-active');
        }
      }
    }

    var aiOverlay = document.getElementById('hrms-ai-card-overlay');
    if (aiOverlay) aiOverlay.style.display = 'none';
    var tc = findMatchScoreCard();
    if (tc) {
      var ch = tc.children;
      for (var k = 0; k < ch.length; k++) {
        if (ch[k] !== aiOverlay) ch[k].style.display = '';
      }
    }

    proxyClickReact(cand);
    updateFileBadge(cand);

    if (cand.resumeText && cand.resumeText.trim().length >= 10) {
      setResumeInput(cand.resumeText);
      scrollToAnalysis();
    } else if (cand.id) {
      fetchDetail(cand.id).then(function (detail) {
        var rt = (detail && detail.resumeText) || (cand && cand.resumeText) || '';
        if (rt) {
          cand.resumeText = rt;
          setResumeInput(rt);
        }
        scrollToAnalysis();
      }).catch(function () {
        scrollToAnalysis();
      });
    } else {
      scrollToAnalysis();
    }
  }

  function hookBulkProcessedPills() {
    var cards = document.querySelectorAll('.card');
    var resumeCard = null;
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].querySelector('textarea[placeholder*="resume"], textarea[placeholder*="Resume"]') || (cards[i].textContent || '').indexOf('Resume Input') !== -1) {
        resumeCard = cards[i];
        break;
      }
    }
    if (!resumeCard) return;

    var containers = resumeCard.querySelectorAll('div');
    for (var c = 0; c < containers.length; c++) {
      var headerText = (containers[c].textContent || '');
      if (headerText.indexOf('resume(s)') !== -1 || headerText.indexOf('Processed') !== -1) {
        var pills = containers[c].querySelectorAll('span');
        for (var p = 0; p < pills.length; p++) {
          var pill = pills[p];
          var pillName = (pill.textContent || '').trim();
          if (!pillName || pillName.indexOf('·') !== -1 || pillName.indexOf('Processed') !== -1) continue;

          pill.style.cursor = 'pointer';
          pill.style.userSelect = 'none';
          pill.title = 'Click to view & score ' + pillName;

          if (!pill.__bulkHookBound) {
            pill.__bulkHookBound = true;
            (function (spanEl, fn) {
              spanEl.addEventListener('mouseenter', function () {
                if (!spanEl.classList.contains('cc-pill-active')) {
                  spanEl.style.background = 'rgba(79,142,247,0.25)';
                  spanEl.style.borderColor = 'var(--accent,#4f8ef7)';
                }
              });
              spanEl.addEventListener('mouseleave', function () {
                if (!spanEl.classList.contains('cc-pill-active')) {
                  spanEl.style.background = 'rgba(79,142,247,0.1)';
                  spanEl.style.borderColor = 'rgba(79,142,247,0.2)';
                }
              });
              spanEl.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();

                var allSiblingSpans = spanEl.parentElement ? spanEl.parentElement.querySelectorAll('span') : [];
                for (var s = 0; s < allSiblingSpans.length; s++) {
                  allSiblingSpans[s].classList.remove('cc-pill-active');
                  allSiblingSpans[s].style.background = 'rgba(79,142,247,0.1)';
                  allSiblingSpans[s].style.borderColor = 'rgba(79,142,247,0.2)';
                  allSiblingSpans[s].style.color = 'var(--accent,#4f8ef7)';
                }
                spanEl.classList.add('cc-pill-active');
                spanEl.style.background = 'var(--accent,#4f8ef7)';
                spanEl.style.borderColor = 'var(--accent,#4f8ef7)';
                spanEl.style.color = '#ffffff';

                var cleanFn = fn.toLowerCase().replace(/[-_]/g, ' ').replace(/\.[a-z0-9]+$/i, '').trim();
                var matched = null;
                for (var r = 0; r < state.rows.length; r++) {
                  var row = state.rows[r];
                  var rowFn = (row.fileName || '').toLowerCase();
                  var rowNm = (row.name || '').toLowerCase();
                  if (rowFn && (rowFn === fn.toLowerCase() || rowFn.indexOf(fn.toLowerCase()) !== -1 || fn.toLowerCase().indexOf(rowFn) !== -1)) {
                    matched = row; break;
                  }
                  if (rowNm && rowNm !== 'candidate' && (cleanFn.indexOf(rowNm) !== -1 || rowNm.indexOf(cleanFn) !== -1)) {
                    matched = row; break;
                  }
                }

                if (matched) {
                  syncToCandidate(matched);
                } else {
                  api('/api/resume-scores').then(function (rows) {
                    if (Array.isArray(rows)) {
                      state.rows = rows;
                      for (var j = 0; j < rows.length; j++) {
                        var rw = rows[j];
                        var rfn = (rw.fileName || '').toLowerCase();
                        if (rfn === fn.toLowerCase() || rfn.indexOf(fn.toLowerCase()) !== -1) {
                          syncToCandidate(rw); return;
                        }
                      }
                      if (rows.length > 0) syncToCandidate(rows[0]);
                    }
                  });
                }
              });
            })(pill, pillName);
          }
        }
      }
    }
  }

  function findMatchScoreCard() {
    var g2 = document.querySelector('.grid-2');
    if (g2 && g2.children.length >= 2) {
      var rightChild = g2.children[1];
      if (rightChild.classList.contains('card')) return rightChild;
      var innerCard = rightChild.querySelector('.card');
      if (innerCard) return innerCard;
      return rightChild;
    }
    if (g2) {
      var cards = g2.querySelectorAll('.card');
      for (var i = cards.length - 1; i >= 0; i--) {
        if (!cards[i].querySelector('textarea')) return cards[i];
      }
    }
    return null;
  }

  function resolveCandidateAndResume(r, targetCard) {
    var textareas = document.querySelectorAll('textarea');
    var jdText = textareas.length >= 2 ? (textareas[0].value || '').trim() : '';
    var taResume = textareas.length >= 2 ? (textareas[1].value || '').trim() : (textareas.length === 1 ? (textareas[0].value || '').trim() : '');

    if (r && r.resumeText && r.resumeText.trim().length >= 20) {
      return Promise.resolve({
        resumeText: r.resumeText,
        name: r.name || 'Candidate',
        role: r.role || 'Senior Frontend Engineer',
        jdText: r.jdText || jdText,
        id: r.id
      });
    }

    if (r && r.id) {
      return fetchDetail(r.id).then(function (detail) {
        var rt = (detail && detail.resumeText) || (r && r.resumeText) || '';
        if (rt && rt.trim().length >= 20) {
          return {
            resumeText: rt,
            name: r.name || (detail && detail.name) || 'Candidate',
            role: r.role || (detail && detail.role) || 'Senior Frontend Engineer',
            jdText: r.jdText || jdText,
            id: r.id
          };
        }
        throw new Error('The resume for candidate "' + (r.name || 'selected') + '" contains no readable content. Please upload a valid resume with content.');
      });
    }

    if (taResume && taResume.length >= 20) {
      var extractedName = (r && r.name) || '';
      if (!extractedName) {
        var firstLine = (taResume.split('\n')[0] || '').trim();
        extractedName = firstLine.split(/[-–—|,]/)[0].trim();
      }
      return Promise.resolve({
        resumeText: taResume,
        name: extractedName || 'Candidate',
        role: (r && r.role) || 'Senior Frontend Engineer',
        jdText: (r && r.jdText) || jdText,
        id: r && r.id
      });
    }

    var targetText = targetCard ? (targetCard.textContent || '') : '';
    var fetchRows = (state.rows && state.rows.length) ? Promise.resolve(state.rows) : api('/api/resume-scores').then(function (d) {
      state.rows = Array.isArray(d) ? d : [];
      return state.rows;
    }).catch(function () { return []; });

    return fetchRows.then(function (rows) {
      var matched = null;
      if (rows && rows.length && targetText) {
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].name && rows[i].name.trim().length >= 2 && targetText.indexOf(rows[i].name) !== -1) {
            matched = rows[i];
            break;
          }
        }
      }

      if (matched) {
        if (matched.resumeText && matched.resumeText.trim().length >= 20) {
          return {
            resumeText: matched.resumeText,
            name: matched.name,
            role: matched.role || 'Senior Frontend Engineer',
            jdText: (r && r.jdText) || jdText,
            id: matched.id
          };
        }
        return fetchDetail(matched.id).then(function (detail) {
          var rt = (detail && detail.resumeText) || '';
          if (rt && rt.trim().length >= 20) {
            return {
              resumeText: rt,
              name: matched.name,
              role: matched.role || 'Senior Frontend Engineer',
              jdText: (r && r.jdText) || jdText,
              id: matched.id
            };
          }
          throw new Error('The uploaded resume contains no readable text or content. Please upload a valid resume with content.');
        });
      }

      throw new Error('The uploaded resume contains no readable text or content. Please upload a valid resume with content.');
    });
  }

  var activeAIAbortController = null;
  function showAIModal(r) {
    var targetCard = findMatchScoreCard();
    if (!targetCard) return;

    var overlay = document.getElementById('hrms-ai-card-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'hrms-ai-card-overlay';
      targetCard.appendChild(overlay);
    }
    targetCard.style.position = 'relative';
    overlay.style.cssText = 'position:absolute;inset:0;background:var(--bg2,#ffffff);border-radius:inherit;z-index:40;padding:20px;overflow-y:auto;overflow-x:hidden;box-sizing:border-box;display:flex;flex-direction:column;';
    overlay.innerHTML =
      '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:360px;width:100%;text-align:center;margin:auto" class="cc-ai-pulse">' +
        '<div style="font-size:42px;margin-bottom:14px;color:#8b5cf6">✦</div>' +
        '<div style="font-weight:700;font-size:16px;color:var(--text)">Running Rapid AI Semantic Analysis…</div>' +
        '<div style="font-size:12px;color:var(--text2);margin-top:6px">Evaluating production depth &amp; domain fit via Claude</div>' +
        '<button class="cc-btn ghost" id="cc-cancel-ai" style="margin-top:16px;border:1px solid var(--border2);font-size:11.5px">✕ Cancel Analysis</button>' +
      '</div>';

    var children = targetCard.children;
    for (var k = 0; k < children.length; k++) {
      if (children[k] !== overlay) children[k].style.display = 'none';
    }

    var cancelBtn = overlay.querySelector('#cc-cancel-ai');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        if (activeAIAbortController) {
          activeAIAbortController.abort();
          activeAIAbortController = null;
        }
        overlay.style.display = 'none';
        for (var k = 0; k < children.length; k++) {
          if (children[k] !== overlay) children[k].style.display = '';
        }
      });
    }

    resolveCandidateAndResume(r, targetCard).then(function (cand) {
      var resumeText = cand.resumeText || '';
      var jdText = cand.jdText || '';
      var name = cand.name || 'Candidate';
      var role = cand.role || 'Senior Frontend Engineer';

      if (!resumeText || resumeText.trim().length < 20) {
        throw new Error('The uploaded resume contains no readable text or content. Please upload a valid resume with content.');
      }

      if (window.AbortController) {
        activeAIAbortController = new AbortController();
      }

      return api('/api/ai/score-resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: activeAIAbortController ? activeAIAbortController.signal : undefined,
        body: JSON.stringify({
          resumeText: resumeText,
          jdText: jdText || '',
          name: name,
          role: role,
          jobCode: cand.jobCode || activeJobCode(),
          saveToDb: true
        })
      }).then(function (res) {
        activeAIAbortController = null;
        renderAIResult(res, { name: name, role: role, id: cand.id }, targetCard);
        loadData();
      });
    }).catch(function (err) {
      activeAIAbortController = null;
      var msg = err.message || 'Could not connect to AI service.';
      if (typeof msg === 'object') {
        msg = (msg && (msg.message || msg.error)) || JSON.stringify(msg);
      }
      if (typeof msg !== 'string') msg = String(msg);
      var isEmptyErr = msg.indexOf('no readable text') !== -1 || msg.indexOf('Empty') !== -1 || msg.indexOf('no content') !== -1;
      if (msg.indexOf('404') !== -1) {
        msg = 'Endpoint <code>/api/ai/score-resume</code> returned 404.<br><br><b>Action required:</b> Please restart your running Django / Daphne development server so the new AI routes take effect.';
      }
      overlay.innerHTML =
        '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:360px;width:100%;text-align:center;padding:24px;box-sizing:border-box">' +
          '<div style="font-size:36px;margin-bottom:10px;color:' + (isEmptyErr ? 'var(--warn,#f59e0b)' : 'var(--danger,#ef4444)') + '">' + (isEmptyErr ? '⚠' : '✕') + '</div>' +
          '<div style="color:var(--danger,#ef4444);font-weight:700;font-size:15px;margin-bottom:8px">' + (isEmptyErr ? 'Empty Resume Rejected' : 'AI Analysis Unavailable') + '</div>' +
          '<div style="font-size:12px;color:var(--text2);line-height:1.6;max-width:400px;margin-bottom:16px">' + esc(msg) + '</div>' +
          '<div style="display:flex;gap:8px">' +
            (!isEmptyErr ? '<button class="cc-btn primary" id="cc-retry-ai">↺ Retry AI Analysis</button>' : '') +
            '<button class="cc-btn" id="cc-close-ai-err">Dismiss</button>' +
          '</div>' +
        '</div>';

      var retryBtn = overlay.querySelector('#cc-retry-ai');
      if (retryBtn) {
        retryBtn.addEventListener('click', function () { showAIModal(r); });
      }
      var closeBtn = overlay.querySelector('#cc-close-ai-err');
      if (closeBtn) {
        closeBtn.addEventListener('click', function () {
          overlay.style.display = 'none';
          for (var k = 0; k < children.length; k++) {
            if (children[k] !== overlay) children[k].style.display = '';
          }
        });
      }
    });
  }

  function drawRingSvg(percent, color) {
    var radius = 24;
    var circ = 2 * Math.PI * radius;
    var offset = circ - (Math.max(0, Math.min(100, percent)) / 100) * circ;
    return '<svg width="60" height="60" viewBox="0 0 60 60" style="display:block;margin:0 auto 4px">' +
      '<circle cx="30" cy="30" r="' + radius + '" stroke="var(--border2)" stroke-width="4.5" fill="none" />' +
      '<circle cx="30" cy="30" r="' + radius + '" stroke="' + color + '" stroke-width="4.5" fill="none" stroke-dasharray="' + circ + '" stroke-dashoffset="' + offset + '" stroke-linecap="round" transform="rotate(-90 30 30)" />' +
      '<text x="30" y="34.5" text-anchor="middle" dominant-baseline="middle" font-size="13" font-weight="800" fill="var(--text)" font-family="inherit">' + percent + '%</text>' +
    '</svg>';
  }

  function highlightBold(text) {
    if (!text) return '';
    var s = esc(text);
    // Bold numbers + years/experience: e.g. "6 years", "5+ years", "2024"
    s = s.replace(/(\b\d+\+?\s*(?:years?|yrs?|months?|internship|graduate|production)\b)/gi, '<b>$1</b>');
    // Bold critical lead keywords
    s = s.replace(/(\b(?:Zero|No|Lack of|Strong|Excellent|Tier-1|High-risk|Fast-track|Proven)\s+[A-Za-z0-9\+\#\-\/ ]{3,30}?\b)/gi, function (m) {
      if (m.indexOf('<b>') !== -1) return m;
      return '<b>' + m + '</b>';
    });
    return s;
  }

  function renderAIResult(res, r, targetCard) {
    if (!targetCard) targetCard = findMatchScoreCard();
    if (!targetCard) return;

    targetCard.style.position = 'relative';

    var overlay = document.getElementById('hrms-ai-card-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'hrms-ai-card-overlay';
      targetCard.appendChild(overlay);
    }
    overlay.style.cssText = 'position:absolute !important;top:0 !important;left:0 !important;right:0 !important;bottom:0 !important;width:100% !important;height:100% !important;max-width:100% !important;background:var(--bg2,#111827) !important;border-radius:inherit;z-index:40;padding:18px 20px;overflow-y:auto;overflow-x:hidden;box-sizing:border-box;display:flex;flex-direction:column;box-shadow:inset 0 1px 0 rgba(255,255,255,0.08);';

    var sc = num(res.score), tc = num(res.technical), exp = num(res.experience), dom = num(res.domain);
    var str = res.strengths || [], red = res.redFlags || [], skills = res.skills || [], missing = res.missing || [];
    var name = res.candidateName || r.name || 'Candidate';
    var role = res.role || r.role || 'Software Professional';

    overlay.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;border-bottom:1px solid var(--border2);padding-bottom:10px;width:100%;box-sizing:border-box">' +
        '<div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;overflow:hidden">' +
          '<span class="card-title" style="margin:0;white-space:nowrap">MATCH SCORE</span>' +
          '<span class="cc-badge" style="font-size:10.5px;color:#8b5cf6;border-color:rgba(139,92,246,0.3);background:rgba(139,92,246,0.08);font-weight:700;white-space:nowrap">✦ Claude AI Deep Analysis</span>' +
        '</div>' +
        '<button id="cc-close-ai-view" style="background:var(--bg3);border:1px solid var(--border2);border-radius:7px;padding:5px 12px;font-size:11.5px;font-weight:600;color:var(--text);cursor:pointer;display:inline-flex;align-items:center;gap:4px;flex-shrink:0;margin-left:8px">' +
          '← Standard Score' +
        '</button>' +
      '</div>' +

      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;width:100%;box-sizing:border-box">' +
        '<div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;overflow:hidden">' +
          '<span class="cc-avc" style="width:36px;height:36px;font-size:13px;background:linear-gradient(135deg,var(--accent2,#8b5cf6),var(--accent,#4f8ef7));flex-shrink:0">' + esc(initials({ name: name })) + '</span>' +
          '<div style="flex:1;min-width:0;overflow:hidden">' +
            '<div style="font-weight:700;font-size:14px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(name) + '">' + esc(name) + '</div>' +
            '<div style="font-size:11.5px;color:var(--text2);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(role) + '</div>' +
          '</div>' +
        '</div>' +
        '<div style="text-align:right;flex-shrink:0;margin-left:8px">' +
          '<div style="font-size:38px;font-weight:800;color:' + scoreColor(sc) + ';line-height:1">' + sc + '<span style="font-size:13px;color:var(--text2);font-weight:500"> / 100</span></div>' +
        '</div>' +
      '</div>' +

      (res.aiFallback ? '<div class="cc-score-explanation" style="background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.35);border-radius:8px;padding:8px 12px;margin:0 0 10px;font-size:11px;line-height:1.5;color:var(--text)"><b>\u26A0 AI service unavailable</b> \u2014 this is a keyword-based estimate, not an AI evaluation.' + (res.aiError ? ' <span style="color:var(--text2)">(' + esc(res.aiError) + ')</span>' : '') + '</div>' : '') +
      '<div class="cc-score-explanation" style="background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.22);border-radius:8px;padding:8px 12px;margin:0 0 14px;font-size:11px;line-height:1.5;color:var(--text2)">' +
        '<b>ℹ Scoring Methodology:</b> AI Deep Score evaluates engineering depth, project architecture, and contextual problem-solving via Claude AI. This intentionally complements keyword-based heuristic scoring.' +
      '</div>' +

      '<div style="display:flex;gap:10px;margin-bottom:16px;justify-content:space-between">' +
        '<div style="flex:1;background:var(--bg3);border:1px solid var(--border2);border-radius:12px;padding:12px 6px;text-align:center">' +
          drawRingSvg(tc, scoreColor(tc)) +
          '<div style="font-size:9.5px;font-weight:700;color:var(--text2);letter-spacing:0.5px">TECHNICAL</div>' +
        '</div>' +
        '<div style="flex:1;background:var(--bg3);border:1px solid var(--border2);border-radius:12px;padding:12px 6px;text-align:center">' +
          drawRingSvg(exp, scoreColor(exp)) +
          '<div style="font-size:9.5px;font-weight:700;color:var(--text2);letter-spacing:0.5px">EXPERIENCE</div>' +
        '</div>' +
        '<div style="flex:1;background:var(--bg3);border:1px solid var(--border2);border-radius:12px;padding:12px 6px;text-align:center">' +
          drawRingSvg(dom, scoreColor(dom)) +
          '<div style="font-size:9.5px;font-weight:700;color:var(--text2);letter-spacing:0.5px">DOMAIN</div>' +
        '</div>' +
      '</div>' +

      (skills.length ? '<div style="font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">MATCHED SKILLS (' + skills.length + ')</div><div class="cc-chips" style="margin-bottom:12px">' + skills.map(function (s) { return '<span class="cc-chip str">✓ ' + esc(s) + '</span>'; }).join('') + '</div>' : '') +

      (missing.length ? '<div style="font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">MISSING SKILLS (' + missing.length + ')</div><div class="cc-chips" style="margin-bottom:12px">' + missing.map(function (s) { return '<span class="cc-chip miss">✕ ' + esc(s) + '</span>'; }).join('') + '</div>' : '') +

      (res.executiveSummary ? '<div class="cc-brief-card"><b style="color:var(--accent,#4f8ef7)">✦ Hiring Brief:</b> ' + highlightBold(res.executiveSummary) + '</div>' : '') +

      (str.length ? '<div style="font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">KEY STRENGTHS</div><div class="cc-chips" style="margin-bottom:12px">' + str.map(function (s) { return '<span class="cc-chip str">✓ ' + highlightBold(s) + '</span>'; }).join('') + '</div>' : '') +

      (red.length ? '<div style="font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">GAPS &amp; RISKS</div><div class="cc-chips" style="margin-bottom:12px">' + red.map(function (s) { return '<span class="cc-chip miss">⚠ ' + highlightBold(s) + '</span>'; }).join('') + '</div>' : '');

    var closeBtn = overlay.querySelector('#cc-close-ai-view');
    if (closeBtn) {
      closeBtn.addEventListener('click', function() {
        overlay.style.display = 'none';
        var tc = findMatchScoreCard();
        if (tc) {
          for (var k = 0; k < tc.children.length; k++) {
            if (tc.children[k] !== overlay) tc.children[k].style.display = '';
          }
        }
        localStorage.setItem('hrms_scoring_mode', 'std');
        var stdBtn = document.getElementById('hrms-toggle-std');
        var aiBtn = document.getElementById('hrms-toggle-ai');
        if (stdBtn) stdBtn.classList.add('active');
        if (aiBtn) aiBtn.classList.remove('active');
      });
    }
  }

  /* ── export ───────────────────────────────────────────────────────────── */
  function toggleExportMenu(btn) {
    var ex = document.getElementById(ID.menu); if (ex) { ex.remove(); return; }
    var menu = document.createElement('div'); menu.id = ID.menu;
    menu.innerHTML = '<button data-x="csv">⭳ Download CSV (.csv)</button><button data-x="xlsx">⭳ Download Excel (.xlsx)</button>';
    btn.parentNode.appendChild(menu); menu.style.top = (btn.offsetTop + btn.offsetHeight + 6) + 'px'; menu.style.left = btn.offsetLeft + 'px';
    menu.querySelector('[data-x="csv"]').addEventListener('click', function () { exportCsv(); menu.remove(); });
    menu.querySelector('[data-x="xlsx"]').addEventListener('click', function () { exportXlsx(); menu.remove(); });
    setTimeout(function () { document.addEventListener('click', function h() { var m = document.getElementById(ID.menu); if (m) m.remove(); document.removeEventListener('click', h); }); }, 0);
  }
  function exportRows() {
    var cols = shownCols();
    return {
      head: cols.map(function (c) { return c.label; }).concat(['Skills', 'Missing']),
      body: filtered().map(function (r) {
        return cols.map(function (c) { var v = cellVal(r, c.key); return c.num ? num(v) : String(v); })
          .concat([(r.skills || []).join('; '), (r.missing || []).join('; ')]);
      })
    };
  }
  function download(bytes, name, type) { var b = new Blob([bytes], { type: type }), u = URL.createObjectURL(b), a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); setTimeout(function () { a.remove(); URL.revokeObjectURL(u); }, 100); }
  function exportCsv() { var d = exportRows(); var q = function (v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }; download('\ufeff' + [d.head].concat(d.body).map(function (r) { return r.map(q).join(','); }).join('\r\n'), 'candidate-comparison.csv', 'text/csv;charset=utf-8;'); }
  function exportXlsx() { var d = exportRows(); download(buildXlsx([d.head].concat(d.body)), 'candidate-comparison.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); }
  // Minimal single-sheet .xlsx (stored zip, inline strings) — no library needed.
  function buildXlsx(rows) {
    function cl(n) { var s = ''; n++; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26 | 0; } return s; }
    function xe(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
    var sr = rows.map(function (row, ri) { return '<row r="' + (ri + 1) + '">' + row.map(function (val, ci) { var ref = cl(ci) + (ri + 1); return (typeof val === 'number' && isFinite(val)) ? '<c r="' + ref + '"><v>' + val + '</v></c>' : '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xe(val) + '</t></is></c>'; }).join('') + '</row>'; }).join('');
    var files = [
      { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>' },
      { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Candidates" sheetId="1" r:id="rId1"/></sheets></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
      { name: 'xl/worksheets/sheet1.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + sr + '</sheetData></worksheet>' }
    ];
    return zipStore(files);
  }
  var CRCT = (function () { var t = []; for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b) { var crc = -1; for (var i = 0; i < b.length; i++) crc = (crc >>> 8) ^ CRCT[(crc ^ b[i]) & 0xff]; return (crc ^ -1) >>> 0; }
  function u16(n) { return [n & 0xff, (n >>> 8) & 0xff]; }
  function u32(n) { return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]; }
  function zipStore(files) {
    var enc = new TextEncoder(), parts = [], central = [], offset = 0;
    files.forEach(function (f) {
      var name = enc.encode(f.name), data = enc.encode(f.data), crc = crc32(data), sz = data.length;
      var local = [].concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(sz), u32(sz), u16(name.length), u16(0));
      parts.push(new Uint8Array(local), name, data);
      central.push(new Uint8Array([].concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(sz), u32(sz), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset))), name);
      offset += local.length + name.length + data.length;
    });
    var cd = central.reduce(function (a, b) { return a + b.length; }, 0);
    var end = new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cd), u32(offset), u16(0)));
    var all = parts.concat(central, [end]), total = all.reduce(function (a, b) { return a + b.length; }, 0), out = new Uint8Array(total), p = 0;
    all.forEach(function (a) { out.set(a, p); p += a.length; }); return out;
  }

  function reactCard() {
    var titles = document.querySelectorAll('.card-title');
    for (var i = 0; i < titles.length; i++) {
      var t = (titles[i].textContent || '').trim().toLowerCase();
      if (t === CARD_TITLE.toLowerCase() || t.indexOf('candidate comparison') !== -1) {
        return titles[i].closest('.card');
      }
    }
    var cards = document.querySelectorAll('.card');
    for (var j = 0; j < cards.length; j++) {
      if ((cards[j].textContent || '').toLowerCase().indexOf('candidate comparison') !== -1 && cards[j].querySelector('table')) {
        return cards[j];
      }
    }
    return null;
  }

  function unmount() {
    var root = document.getElementById(ID.root); if (root) root.remove();
    closePopups(); closeDrawer(); closeColsDrawer(); closeModal();
    var optWrap = document.getElementById('hrms-scoring-options'); if (optWrap) optWrap.remove();
    var aiBtn = document.getElementById('hrms-ai-deep-btn'); if (aiBtn) aiBtn.remove();
    // Restore any hidden buttons or cards
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      if ((buttons[i].textContent || '').indexOf('Score Resume') !== -1) buttons[i].style.display = '';
    }
    var targetCard = findMatchScoreCard();
    if (targetCard) {
      var overlay = document.getElementById('hrms-ai-card-overlay');
      if (overlay) overlay.remove();
      var children = targetCard.children;
      for (var k = 0; k < children.length; k++) children[k].style.display = '';
    }
    document.querySelectorAll('[data-cc-hidden]').forEach(function (c) { c.style.display = ''; c.removeAttribute('data-cc-hidden'); });
  }

  function cleanupScoreEmptyWrap() {
    var emptyWrap = document.getElementById('hrms-score-empty-wrap');
    if (emptyWrap) emptyWrap.remove();
    var targetCard = findMatchScoreCard();
    if (targetCard) {
      var overlay = document.getElementById('hrms-ai-card-overlay');
      var children = targetCard.children;
      for (var k = 0; k < children.length; k++) {
        if (children[k] !== overlay && children[k].style.display === 'none') {
          children[k].style.display = '';
        }
      }
    }
  }

  function showScoreEmptyState() {
    cleanupScoreEmptyWrap();
  }

  function hideScoreEmptyState() {
    cleanupScoreEmptyWrap();
  }

  function showScoreErrorBanner(msg) {
    var optWrap = document.getElementById('hrms-scoring-options');
    var btnRow = optWrap ? optWrap.parentNode : null;
    if (!btnRow) {
      var buttons = document.querySelectorAll('button');
      for (var i = 0; i < buttons.length; i++) {
        var t = (buttons[i].textContent || '').trim();
        if (t.indexOf('Score Resume') !== -1 || t.indexOf('Scoring…') !== -1) {
          btnRow = buttons[i].parentNode;
          break;
        }
      }
    }
    if (!btnRow || !btnRow.parentNode) return;
    var card = btnRow.parentNode;

    var errEl = document.getElementById('hrms-score-custom-err');
    if (!errEl) {
      errEl = document.createElement('div');
      errEl.id = 'hrms-score-custom-err';
    }

    // CRITICAL: Ensure errEl is NEVER inside btnRow (which is display:flex and would shift buttons horizontally)
    if (errEl.parentNode !== card || errEl.nextSibling !== btnRow) {
      card.insertBefore(errEl, btnRow);
    }

    if (msg) {
      errEl.style.cssText = 'font-size:11.5px;color:var(--danger,#ef4444);margin-bottom:10px;font-weight:600;display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.22);padding:7px 12px;border-radius:8px;';
      errEl.textContent = '⚠ ' + msg;
    } else {
      errEl.style.display = 'none';
      errEl.textContent = '';
    }
  }

  function ensureAIButtons() {
    if (!onPage()) return;

    // Clean up any standalone aiBtn if it exists
    var standaloneAiBtn = document.getElementById('hrms-ai-deep-btn');
    if (standaloneAiBtn) standaloneAiBtn.remove();

    var buttons = document.querySelectorAll('button');
    var scoreBtn = null;
    for (var i = 0; i < buttons.length; i++) {
      var t = (buttons[i].textContent || '').trim();
      if (t.indexOf('Score Resume') !== -1 || t.indexOf('Scoring…') !== -1) {
        if (!buttons[i].closest('#hrms-scoring-options')) {
          scoreBtn = buttons[i];
          break;
        }
      }
    }
    if (!scoreBtn || !scoreBtn.parentNode) return;

    var btnRow = scoreBtn.parentNode;
    btnRow.classList.add('cc-btn-row');   // phone layout hook (see @media)
    var orphanErr = btnRow.querySelector('#hrms-score-custom-err');
    if (orphanErr && btnRow.parentNode) {
      btnRow.parentNode.insertBefore(orphanErr, btnRow);
    }

    // Hide original scoreBtn so our unified toggle button takes its place cleanly
    scoreBtn.style.display = 'none';

    var curMode = localStorage.getItem('hrms_scoring_mode') || 'ai';

    var optWrap = document.getElementById('hrms-scoring-options');
    if (!optWrap) {
      optWrap = document.createElement('div');
      optWrap.id = 'hrms-scoring-options';
      optWrap.className = 'cc-toggle-wrap';
      optWrap.innerHTML =
        '<button id="hrms-toggle-std" type="button" class="cc-toggle-tab std ' + (curMode === 'std' ? 'active' : '') + '" title="Standard keyword and rule-based matching">' +
          '✦ Score Resume' +
        '</button>' +
        '<button id="hrms-toggle-ai" type="button" class="cc-toggle-tab ai ' + (curMode === 'ai' ? 'active' : '') + '" title="Deep semantic evaluation with Claude AI">' +
          '✦ AI Deep Score' +
        '</button>';

      var stdBtn = optWrap.querySelector('#hrms-toggle-std');
      var aiBtn = optWrap.querySelector('#hrms-toggle-ai');

      function validateInputs() {
        var textareas = document.querySelectorAll('textarea');
        var jdText = textareas.length >= 2 ? (textareas[0].value || '').trim() : '';
        var taResume = textareas.length >= 2 ? (textareas[1].value || '').trim() : (textareas.length === 1 ? (textareas[0].value || '').trim() : '');

        if (!jdText && !taResume) {
          showScoreErrorBanner("Please provide both a job description and a resume before scoring.");
          return false;
        }
        if (!jdText) {
          showScoreErrorBanner("Please enter or paste a job description before scoring.");
          return false;
        }
        if (!taResume) {
          showScoreErrorBanner("Please upload or paste a valid resume before scoring.");
          return false;
        }
        showScoreErrorBanner("");
        return true;
      }

      function setMode(mode) {
        curMode = mode;
        localStorage.setItem('hrms_scoring_mode', mode);
        if (mode === 'std') {
          stdBtn.classList.add('active');
          aiBtn.classList.remove('active');
        } else {
          aiBtn.classList.add('active');
          stdBtn.classList.remove('active');
        }
      }

      stdBtn.addEventListener('click', function (e) {
        e.preventDefault();
        setMode('std');
        if (!validateInputs()) return;
        var targetCard = findMatchScoreCard();
        if (targetCard) {
          var overlay = document.getElementById('hrms-ai-card-overlay');
          if (overlay) overlay.style.display = 'none';
          var children = targetCard.children;
          for (var k = 0; k < children.length; k++) {
            if (children[k] !== overlay) children[k].style.display = '';
          }
        }
        scoreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      });

      aiBtn.addEventListener('click', function (e) {
        e.preventDefault();
        setMode('ai');
        if (!validateInputs()) return;
        showAIModal();
      });
    }

    if (optWrap.parentNode !== btnRow || optWrap.previousSibling !== scoreBtn) {
      if (scoreBtn.nextSibling) {
        btnRow.insertBefore(optWrap, scoreBtn.nextSibling);
      } else {
        btnRow.appendChild(optWrap);
      }
    }

    // Handle file upload and textarea changes while preserving user's chosen mode
    function extractAndScoreFile(file) {
      if (!file) return;
      var fileName = file.name || 'resume.pdf';

      // Handle Bulk ZIP archives
      if (/\.zip$/i.test(fileName) || (file.type && file.type.indexOf('zip') !== -1)) {
        var mode = localStorage.getItem('hrms_scoring_mode') || 'ai';
        if (mode === 'ai') {
          var zipAttempts = 0;
          var zipInterval = setInterval(function () {
            zipAttempts++;
            var tc = findMatchScoreCard();
            var targetText = tc ? (tc.textContent || '') : '';
            if (targetText && (targetText.indexOf('Uploaded') !== -1 || targetText.indexOf('/ 100') !== -1 || targetText.indexOf('/100') !== -1 || zipAttempts >= 20)) {
              clearInterval(zipInterval);
              showAIModal();
            }
          }, 350);
        } else {
          var ov = document.getElementById('hrms-ai-card-overlay');
          if (ov) ov.style.display = 'none';
          var tc = findMatchScoreCard();
          if (tc) {
            var ch = tc.children;
            for (var k = 0; k < ch.length; k++) {
              if (ch[k] !== ov) ch[k].style.display = '';
            }
          }
        }
        return;
      }

      var jdEl = document.querySelector('textarea[placeholder*="Job Description"], textarea[placeholder*="job description"]') || document.querySelectorAll('textarea')[0];
      var jdText = jdEl ? jdEl.value : '';

      // Show loading pulse on right card and hide all other elements
      var targetCard = findMatchScoreCard();
      var overlay = null;
      if (targetCard) {
        overlay = document.getElementById('hrms-ai-card-overlay');
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.id = 'hrms-ai-card-overlay';
          targetCard.appendChild(overlay);
        }
        overlay.style.display = 'flex';
        overlay.style.width = '100%';
        overlay.innerHTML =
          '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;min-height:360px;width:100%;text-align:center;margin:auto" class="cc-ai-pulse">' +
            '<div style="font-size:42px;margin-bottom:14px;color:#8b5cf6">✦</div>' +
            '<div style="font-weight:700;font-size:16px;color:var(--text)">Analyzing Uploaded Resume…</div>' +
            '<div style="font-size:12px;color:var(--text2);margin-top:6px">Evaluating candidate profile with Claude AI</div>' +
            '<button class="cc-btn ghost" id="cc-cancel-upload-ai" style="margin-top:16px;border:1px solid var(--border2);font-size:11.5px">✕ Cancel</button>' +
          '</div>';

        var children = targetCard.children;
        for (var k = 0; k < children.length; k++) {
          if (children[k] !== overlay) children[k].style.display = 'none';
        }

        var canUp = overlay.querySelector('#cc-cancel-upload-ai');
        if (canUp) canUp.addEventListener('click', function() {
          overlay.style.display = 'none';
          for (var k = 0; k < children.length; k++) {
            if (children[k] !== overlay) children[k].style.display = '';
          }
        });
      }

      function showEmptyReject(fName) {
        if (targetCard && overlay) {
          overlay.innerHTML =
            '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:360px;width:100%;text-align:center;padding:24px;box-sizing:border-box">' +
              '<div style="font-size:36px;margin-bottom:10px;color:var(--warn,#f59e0b)">⚠</div>' +
              '<div style="color:var(--danger,#ef4444);font-weight:700;font-size:15px;margin-bottom:8px">Empty Resume Rejected</div>' +
              '<div style="font-size:12px;color:var(--text2);line-height:1.6;max-width:380px">The uploaded file <b>' + esc(fName) + '</b> contains no readable text or content.<br>Candidate analysis and scores cannot be generated without valid resume content.</div>' +
              '<button class="cc-btn" id="cc-dismiss-empty" style="margin-top:16px">Dismiss</button>' +
            '</div>';
          var dis = overlay.querySelector('#cc-dismiss-empty');
          if (dis) dis.addEventListener('click', function() {
            overlay.style.display = 'none';
            var children = targetCard.children;
            for (var k = 0; k < children.length; k++) {
              if (children[k] !== overlay) children[k].style.display = '';
            }
          });
        }
      }

      // If text file
      if (/\.(txt|md|json|csv|rtf)$/i.test(fileName)) {
        var reader = new FileReader();
        reader.onload = function (e) {
          var txt = (e.target.result || '').trim();
          if (txt && txt.length >= 20) {
            setResumeInput(txt);
            showAIModal({ resumeText: txt, jdText: jdText, name: fileName.replace(/\.[^/.]+$/, ''), fileName: fileName });
          } else {
            showEmptyReject(fileName);
          }
        };
        reader.readAsText(file);
        return;
      }

      // If PDF and pdfjs is on page
      if (/\.pdf$/i.test(fileName) && window.pdfjsLib) {
        var pdfReader = new FileReader();
        pdfReader.onload = function (e) {
          var typedarray = new Uint8Array(e.target.result);
          window.pdfjsLib.getDocument(typedarray).promise.then(function (pdf) {
            var maxPages = Math.min(pdf.numPages, 10);
            var pages = [];
            var done = 0;
            for (var p = 1; p <= maxPages; p++) {
              (function (pageNo) {
                pdf.getPage(pageNo).then(function (page) {
                  page.getTextContent().then(function (tc) {
                    pages[pageNo - 1] = tc.items.map(function (item) { return item.str; }).join(' ');
                    done++;
                    if (done === maxPages) {
                      var fullText = pages.join('\n\n').trim();
                      if (fullText && fullText.length >= 20) {
                        setResumeInput(fullText);
                        showAIModal({ resumeText: fullText, jdText: jdText, name: fileName.replace(/\.[^/.]+$/, ''), fileName: fileName });
                      } else {
                        showEmptyReject(fileName);
                      }
                    }
                  });
                });
              })(p);
            }
          }).catch(function () { /* fallback to polling */ });
        };
        pdfReader.readAsArrayBuffer(file);
      }

      // Poll textarea for React's own parser output
      var attempts = 0;
      var checkInterval = setInterval(function () {
        attempts++;
        var textareas = document.querySelectorAll('textarea');
        var resumeText = textareas.length >= 2 ? (textareas[1].value || '').trim() : (textareas.length === 1 ? (textareas[0].value || '').trim() : '');
        if (resumeText && resumeText.length >= 20) {
          clearInterval(checkInterval);
          showAIModal({ resumeText: resumeText, jdText: jdText, name: fileName.replace(/\.[^/.]+$/, ''), fileName: fileName });
        } else if (attempts >= 20) {
          clearInterval(checkInterval);
          if (!resumeText || resumeText.length < 20) {
            showEmptyReject(fileName);
          }
        }
      }, 250);
    }

    var allFileInputs = document.querySelectorAll('input[type="file"]');
    for (var f = 0; f < allFileInputs.length; f++) {
      if (!allFileInputs[f].__aiResetBound) {
        allFileInputs[f].__aiResetBound = true;
        (function (inp) {
          inp.addEventListener('change', function () {
            var mode = localStorage.getItem('hrms_scoring_mode') || 'ai';
            if (inp.files && inp.files[0]) {
              var isZip = /\.zip$/i.test(inp.files[0].name || '') || (inp.files[0].type && inp.files[0].type.indexOf('zip') !== -1);
              if (isZip) {
                var ov = document.getElementById('hrms-ai-card-overlay');
                if (ov) ov.style.display = 'none';
                var tc = findMatchScoreCard();
                if (tc) {
                  var ch = tc.children;
                  for (var k = 0; k < ch.length; k++) {
                    if (ch[k] !== ov) ch[k].style.display = '';
                  }
                }
                return;
              }
              if (mode === 'ai') {
                extractAndScoreFile(inp.files[0]);
              }
            } else if (mode === 'std') {
              var ov = document.getElementById('hrms-ai-card-overlay');
              if (ov) ov.style.display = 'none';
              var tc = findMatchScoreCard();
              if (tc) {
                var ch = tc.children;
                for (var k = 0; k < ch.length; k++) {
                  if (ch[k] !== ov) ch[k].style.display = '';
                }
              }
            }
          });
        })(allFileInputs[f]);
      }
    }
  }

  function syncJDsParsedCount() {
    var statCards = document.querySelectorAll('.stat-grid .card, .stat-grid > div');
    for (var i = 0; i < statCards.length; i++) {
      var txt = statCards[i].textContent || '';
      if (txt.indexOf('JDs Parsed') !== -1) {
        var textareas = document.querySelectorAll('textarea');
        var jdVal = textareas.length > 0 ? (textareas[0].value || '').trim() : '';
        var numEl = statCards[i].querySelector('.stat-value') || statCards[i].querySelector('div[style*="font-size"]') || statCards[i].querySelectorAll('div')[1];
        if (numEl) {
          numEl.textContent = jdVal ? '1' : '0';
        }
        break;
      }
    }
  }

  function fixMatchScoreRings() {
    var cards = document.querySelectorAll('.card');
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      var rc = c.querySelector('div[style*="space-around"]');
      if (!rc) {
        var svgs = c.querySelectorAll('svg circle');
        if (svgs.length >= 6) {
          var s = svgs[0].closest('svg');
          if (s && s.parentElement && s.parentElement.parentElement) {
            var cp = s.parentElement.parentElement.parentElement;
            if (cp && cp.children.length === 3) rc = cp;
          }
        }
      }
      if (rc) {
        rc.style.setProperty('display', 'flex', 'important');
        rc.style.setProperty('flex-direction', 'row', 'important');
        rc.style.setProperty('flex-wrap', 'nowrap', 'important');
        rc.style.setProperty('justify-content', 'space-around', 'important');
        rc.style.setProperty('align-items', 'center', 'important');
        rc.style.setProperty('width', '100%', 'important');
        for (var j = 0; j < rc.children.length; j++) {
          var ch = rc.children[j];
          ch.style.setProperty('display', 'flex', 'important');
          ch.style.setProperty('flex-direction', 'column', 'important');
          ch.style.setProperty('align-items', 'center', 'important');
          ch.style.setProperty('flex', '1 1 0', 'important');
          ch.style.setProperty('min-width', '0', 'important');
          ch.style.setProperty('text-align', 'center', 'important');
        }
      }
    }
  }

  function activeJobCode() { try { return String(localStorage.getItem('hrms_active_job_code') || '').trim().toUpperCase(); } catch (_) { return ''; } }
  function findJdTextarea() {
    var tas = document.querySelectorAll('textarea');
    for (var i = 0; i < tas.length; i++) {
      var ph = (tas[i].getAttribute('placeholder') || '').toLowerCase();
      if (ph.indexOf('job description') !== -1) return tas[i];
    }
    return tas.length ? tas[0] : null;
  }
  function jobMetaHtml(j) {
    var parts = [];
    if (j.department) parts.push('<span>🏢 ' + esc(j.department) + '</span>');
    if (j.location) parts.push('<span>📍 ' + esc(j.location) + '</span>');
    if (j.experience) parts.push('<span>⏳ ' + esc(j.experience) + '</span>');
    if (j.type) parts.push('<span class="cc-badge" style="padding:1px 6px;font-size:9.5px">' + esc(j.type) + '</span>');
    return parts.join('<span>·</span>');
  }

  // Job Code picker at the top of the Job Description card: choose a post and
  // its description (from the Job Board) is dropped into the textarea.
  function enhanceJobPostCard() {
    if (!onPage()) return;
    var jdTa = findJdTextarea(); if (!jdTa) return;
    var jdCard = jdTa.closest('.card') || jdTa.parentElement; if (!jdCard) return;
    jdTa.style.setProperty('resize', 'vertical', 'important');

    var activeJob = jobByCode(activeJobCode());
    if (!activeJob) {
      // Nothing picked yet: recognise a description pasted from a known post.
      var text = jdTa.value || '';
      if (text) for (var k = 0; k < jobsRegistry.length; k++) {
        var jr = jobsRegistry[k];
        if ((jr.code && text.indexOf(jr.code) !== -1) || (jr.title && text.indexOf(jr.title) !== -1)) { activeJob = jr; break; }
      }
    }

    var header = jdCard.querySelector('#cc-job-post-header');
    if (!header) {
      header = document.createElement('div');
      header.id = 'cc-job-post-header';
      header.className = 'cc-job-post-card';
      var cardTitle = jdCard.querySelector('.card-title');
      if (cardTitle && cardTitle.parentNode === jdCard) jdCard.insertBefore(header, cardTitle.nextSibling);
      else jdCard.insertBefore(header, jdTa);
    }
    // Never rebuild under a typing user, and skip the rebuild entirely when
    // nothing shown has changed (this runs on every DOM mutation).
    var searchInput = header.querySelector('#cc-job-code-search');
    if (searchInput && document.activeElement === searchInput) return;
    var isExpanded = jdTa.getAttribute('data-expanded') === '1';
    var quick = recentJobs(QUICK_CODE_LIMIT);
    if (!quick.length) quick = jobsRegistry.slice().reverse().slice(0, QUICK_CODE_LIMIT);   // nothing used yet: newest posts
    if (activeJob && !quick.some(function (j) { return j.code === activeJob.code; })) quick = [activeJob].concat(quick).slice(0, QUICK_CODE_LIMIT);
    var sig = [activeJob ? activeJob.code : '', jobsRegistry.map(function (j) { return j.code; }).join(','), quick.map(function (j) { return j.code; }).join(','), registryLoaded ? 1 : 0, isExpanded ? 1 : 0].join('|');
    if (header.getAttribute('data-sig') === sig) return;
    header.setAttribute('data-sig', sig);

    var placeholder = jobsRegistry.length ? 'Search Job Code or title (e.g. JOB-101)…' : (registryLoaded ? 'No job posts on the Job Board yet' : 'Loading job posts…');
    header.innerHTML =
      '<div class="cc-job-picker-bar">' +
        '<div class="cc-job-search-box">' +
          '<span class="cc-job-search-ico">🔍</span>' +
          '<input id="cc-job-code-search" class="cc-job-code-input" placeholder="' + esc(placeholder) + '" value="' + (activeJob ? '[' + esc(activeJob.code) + '] ' + esc(activeJob.title) : '') + '" autocomplete="off">' +
          '<button id="cc-job-dropdown-toggle" class="cc-job-drop-btn" title="View all Job Posts by Code">▾</button>' +
        '</div>' +
        '<div id="cc-job-code-dropdown" class="cc-job-dropdown-list" style="display:none"></div>' +
      '</div>' +
      (quick.length ? '<div class="cc-quick-jobs-bar"><span class="cc-quick-jobs-lbl" title="The ' + QUICK_CODE_LIMIT + ' Job Codes used most recently, newest first">Quick Code:</span>' +
        quick.map(function (j) {
          return '<button class="cc-quick-job-pill' + (activeJob && j.code === activeJob.code ? ' active' : '') + kindClass(j) + '" data-qcode="' + esc(j.code) + '" title="' + esc(j.title) + ' · ' + esc(j.status || 'Active') + '">[' + esc(j.code) + '] ' + esc(j.title.split(' ')[0]) + '</button>';
        }).join('') +
        '<button id="cc-quick-jobs-total" class="cc-quick-jobs-total" title="View all job posts by code">Total: ' + jobsRegistry.length + ' job post' + (jobsRegistry.length === 1 ? '' : 's') + ' ▾</button>' +
      '</div>' : '') +
      '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">' +
        (activeJob
          ? '<div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">' +
              '<div style="width:36px;height:36px;border-radius:9px;background:linear-gradient(135deg,rgba(79,142,247,0.2),rgba(124,92,252,0.2));border:1px solid rgba(79,142,247,0.3);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">💼</div>' +
              '<div style="flex:1;min-width:0;overflow:hidden">' +
                '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
                  '<span class="cc-job-code-pill" style="font-size:11px;padding:3px 8px">' + esc(activeJob.code) + '</span>' +
                  '<span style="font-size:13.5px;font-weight:700;color:var(--text);letter-spacing:-0.2px">' + esc(activeJob.title) + '</span>' +
                  statusBadge(activeJob) +
                '</div>' +
                '<div style="font-size:11px;color:var(--text2);margin-top:2px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">' + jobMetaHtml(activeJob) + '</div>' +
              '</div>' +
            '</div>'
          : '<div style="flex:1;min-width:0;font-size:12px;color:var(--text2);line-height:1.5">' +
              (jobsRegistry.length
                ? 'Select a <b>Job Code</b> to load that post’s description into the Job Description box below.'
                : (registryLoaded ? 'No job posts found. Post one on the <b>Job Board</b> and it will appear here by its Job Code.' : 'Loading job posts…')) +
            '</div>') +
        '<div style="display:flex;align-items:center;gap:6px;flex-shrink:0">' +
          '<button id="cc-jd-expand-toggle" class="cc-expand-btn" title="Expand or collapse Job Description">' + (isExpanded ? '⤡ Collapse' : '⤢ Expand') + '</button>' +
        '</div>' +
      '</div>' +
      (activeJob && activeJob.skills && activeJob.skills.length
        ? '<div class="cc-job-skills-bar"><span style="font-size:10.5px;font-weight:700;color:var(--text2);margin-right:2px">Key Skills:</span>' +
          activeJob.skills.map(function (s) { return '<span class="cc-job-skill-chip">' + esc(s) + '</span>'; }).join('') + '</div>'
        : '');

    // Hook expand button
    var expBtn = header.querySelector('#cc-jd-expand-toggle');
    if (expBtn) {
      expBtn.addEventListener('click', function (e) {
        e.preventDefault();
        var exp = jdTa.getAttribute('data-expanded') === '1';
        if (exp) {
          jdTa.style.height = '180px';
          jdTa.setAttribute('data-expanded', '0');
          expBtn.textContent = '⤢ Expand';
        } else {
          jdTa.style.height = '380px';
          jdTa.setAttribute('data-expanded', '1');
          expBtn.textContent = '⤡ Collapse';
        }
      });
    }

    // Hook quick code pills
    header.querySelectorAll('[data-qcode]').forEach(function (btn) {
      btn.addEventListener('click', function (e) { e.preventDefault(); selectJobByCode(btn.getAttribute('data-qcode')); });
    });

    // Hook dropdown and search input
    var searchInp = header.querySelector('#cc-job-code-search');
    var dropBtn = header.querySelector('#cc-job-dropdown-toggle');
    var dropMenu = header.querySelector('#cc-job-code-dropdown');

    function renderDropdownItems(filterText) {
      if (!dropMenu) return;
      var q = (filterText || '').trim().toLowerCase();
      var matches = jobsRegistry.filter(function (j) {
        if (!q) return true;
        return j.code.toLowerCase().indexOf(q) !== -1 ||
               j.title.toLowerCase().indexOf(q) !== -1 ||
               (j.department || '').toLowerCase().indexOf(q) !== -1 ||
               (j.skills || []).some(function (sk) { return sk.toLowerCase().indexOf(q) !== -1; });
      });

      if (!matches.length) {
        dropMenu.innerHTML = '<div style="padding:12px;text-align:center;color:var(--text2);font-size:11.5px">' + (jobsRegistry.length ? 'No matching Job Codes found' : 'No job posts on the Job Board yet') + '</div>';
      } else {
        dropMenu.innerHTML = matches.map(function (j) {
          var isSel = !!(activeJob && j.code === activeJob.code);
          return '<div class="cc-job-item' + (isSel ? ' selected' : '') + '" data-code="' + esc(j.code) + '">' +
            '<div class="cc-job-item-top">' +
              '<span class="cc-job-code-pill">' + esc(j.code) + '</span>' +
              '<span style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--text2);font-weight:600">' + esc(j.department || '') + statusBadge(j) + '</span>' +
            '</div>' +
            '<div class="cc-job-item-title">' + esc(j.title) + '</div>' +
            '<div class="cc-job-item-sub">' + jobMetaHtml({ location: j.location, experience: j.experience, type: j.type }) + '</div>' +
            ((j.skills || []).length ? '<div style="margin-top:5px;display:flex;gap:4px;flex-wrap:wrap">' +
              (j.skills || []).slice(0, 4).map(function (sk) { return '<span class="cc-job-skill-chip">' + esc(sk) + '</span>'; }).join('') + '</div>' : '') +
          '</div>';
        }).join('');

        dropMenu.querySelectorAll('.cc-job-item').forEach(function (item) {
          item.addEventListener('click', function () {
            var code = item.getAttribute('data-code');
            dropMenu.style.display = 'none';
            selectJobByCode(code);
          });
        });
      }
      dropMenu.style.display = 'block';
    }

    if (dropBtn && dropMenu) {
      dropBtn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (dropMenu.style.display === 'block') dropMenu.style.display = 'none';
        else renderDropdownItems('');
      });
    }
    var totalBtn = header.querySelector('#cc-quick-jobs-total');
    if (totalBtn && dropMenu) {
      totalBtn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (dropMenu.style.display === 'block') dropMenu.style.display = 'none';
        else renderDropdownItems('');
      });
    }

    if (searchInp && dropMenu) {
      searchInp.addEventListener('focus', function () {
        renderDropdownItems(searchInp.value.indexOf('[') !== -1 ? '' : searchInp.value);
      });
      searchInp.addEventListener('input', function () {
        renderDropdownItems(searchInp.value.replace(/^\[[^\]]+\]\s*/, ''));
      });
      searchInp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          var firstItem = dropMenu.querySelector('.cc-job-item');
          if (firstItem) { dropMenu.style.display = 'none'; searchInp.blur(); selectJobByCode(firstItem.getAttribute('data-code')); }
        } else if (e.key === 'Escape') {
          dropMenu.style.display = 'none';
        }
      });
      // Leaving the box without picking: put the current selection back.
      searchInp.addEventListener('blur', function () {
        setTimeout(function () { var cur = jobByCode(activeJobCode()); if (document.activeElement !== searchInp) searchInp.value = cur ? '[' + cur.code + '] ' + cur.title : ''; }, 150);
      });
    }

    // Close dropdown on outside click
    if (!window.__ccJobDropdownBound) {
      window.__ccJobDropdownBound = true;
      document.addEventListener('click', function (e) {
        var menu = document.getElementById('cc-job-code-dropdown');
        if (menu && menu.style.display === 'block' && !e.target.closest('#cc-job-post-header')) menu.style.display = 'none';
      });
    }

    if (!jdTa.__jdInputBound) {
      jdTa.__jdInputBound = true;
      jdTa.addEventListener('input', function () {
        if (document.activeElement !== searchInp) enhanceJobPostCard();
      });
    }
  }

  function enhanceResumeExpandable() {
    var tas = document.querySelectorAll('textarea');
    var resumeTa = null;
    for (var i = 0; i < tas.length; i++) {
      var ph = (tas[i].getAttribute('placeholder') || '').toLowerCase();
      if (ph.indexOf('resume') !== -1) {
        resumeTa = tas[i];
        break;
      }
    }
    if (!resumeTa && tas.length >= 2) resumeTa = tas[1];
    if (!resumeTa) return;

    // Enforce vertical resize
    resumeTa.style.setProperty('resize', 'vertical', 'important');

    var rCard = resumeTa.closest('.card');
    if (!rCard) return;

    var title = rCard.querySelector('.card-title');
    if (title && !title.querySelector('#cc-resume-expand-btn')) {
      title.style.display = 'flex';
      title.style.alignItems = 'center';
      title.style.justifyContent = 'space-between';
      var btn = document.createElement('button');
      btn.id = 'cc-resume-expand-btn';
      btn.className = 'cc-expand-btn';
      btn.textContent = resumeTa.getAttribute('data-expanded') === '1' ? '⤡ Collapse' : '⤢ Expand';
      btn.title = 'Expand or collapse Resume Input';
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        var exp = resumeTa.getAttribute('data-expanded') === '1';
        if (exp) {
          resumeTa.style.height = '140px';
          resumeTa.setAttribute('data-expanded', '0');
          btn.textContent = '⤢ Expand';
        } else {
          resumeTa.style.height = '340px';
          resumeTa.setAttribute('data-expanded', '1');
          btn.textContent = '⤡ Collapse';
        }
      });
      title.appendChild(btn);
    }
  }

  // Class hooks on React-owned containers (they carry only generic grid
  // classes) so the page-scoped CSS in ensureStyle() can reach them.
  function tagPageLayout() {
    var sg = document.querySelector('.content .stat-grid'); if (sg) sg.classList.add('cc-stats');
    var jd = findJdTextarea(); var g2 = jd && jd.closest('.grid-2'); if (g2) g2.classList.add('cc-g2');
  }

  var wasOnPage = false;
  function ensureLayout() {
    var on = onPage();
    if (!on) { wasOnPage = false; if (document.getElementById(ID.root)) unmount(); return; }
    // (Re)fetch job posts each time the page is entered: the Job Code picker
    // must exist before any candidate is scored, and new posts may have been
    // added on the Job Board since the last visit.
    // The overlay CSS used to be injected only once a scored candidate existed,
    // so none of the layout rules applied on an empty page.
    ensureStyle();
    tagPageLayout();
    if (!wasOnPage) { wasOnPage = true; loadJobsRegistry(); }
    ensureAIButtons();
    syncJDsParsedCount();
    hookBulkProcessedPills();
    fixMatchScoreRings();
    enhanceJobPostCard();
    enhanceResumeExpandable();

    cleanupScoreEmptyWrap();

    var textareas = document.querySelectorAll('textarea');
    for (var i = 0; i < textareas.length; i++) {
      var ta = textareas[i];
      if (!ta.__emptyGuardBound) {
        ta.__emptyGuardBound = true;
        ta.addEventListener('input', function () {
          showScoreErrorBanner("");
          cleanupScoreEmptyWrap();
        });
      }
    }

    var card = reactCard(); if (!card) return;             // no candidates yet → leave page as-is
    ensureStyle();

    // Hide the React card and, if the candidate set changed, refresh our data.
    var count = card.querySelectorAll('tbody tr').length;
    card.style.display = 'none'; card.setAttribute('data-cc-hidden', '1');

    var root = document.getElementById(ID.root), fresh = false;
    if (!root) { root = buildRoot(); fresh = true; }
    if (root.previousElementSibling !== card && card.parentNode) card.parentNode.insertBefore(root, card.nextSibling);

    if (fresh) { loadColPrefs(); renderTable(); loadData(); state.reactCount = count; }
    else if (count !== state.reactCount) { state.reactCount = count; loadData(); }
  }

  /* ── capture the uploaded file & attach it to the save request ────────────
     The React scorer extracts text and never keeps the file bytes, so the
     save request carries only fileName. We read the file the moment it is
     selected, keep it keyed by name, and splice its base64 into the matching
     POST /api/resume-scores body — so the real PDF/DOCX reaches the server. */
  // name -> Promise<{data, mime}|null>. Storing the PROMISE (not the resolved
  // value) lets the POST interceptor AWAIT an in-flight read, so a fast upload
  // that fires the save before the file finishes reading still gets its bytes —
  // the earlier version stored only the resolved value and lost that race.
  var fileStash = {};
  function readFileB64(file) {
    return new Promise(function (res) {
      var rd = new FileReader();
      rd.onload = function () { var s = String(rd.result || ''); var i = s.indexOf(','); res(i >= 0 ? s.slice(i + 1) : s); };
      rd.onerror = function () { res(''); };
      rd.readAsDataURL(file);
    });
  }
  function onFileChange(e) {
    if (!onPage()) return;                       // only the resume-scoring page uploads here
    var inp = e.target;
    if (!inp || inp.type !== 'file' || !inp.files || !inp.files.length) return;
    Array.prototype.forEach.call(inp.files, function (file) {
      var mime = file.type || 'application/octet-stream';
      fileStash[file.name] = readFileB64(file).then(function (b64) { return b64 ? { data: b64, mime: mime } : null; });
    });
  }
  // Inject fileData/fileMime for any item whose fileName matches a captured
  // file, AWAITING the read if it is still in flight. Matching strictly by name
  // means a pasted resume (no fileName) is never given a stale file. Handles
  // both single and bulk (array) payloads. Returns a Promise<bodyString>.
  function injectFileData(bodyStr) {
    var data; try { data = JSON.parse(bodyStr); } catch (_) { return Promise.resolve(bodyStr); }
    var items = Array.isArray(data) ? data : [data], touched = false;
    // Stamp the Job Code picked on the JD card on every new score, so the
    // comparison grid can show which post each candidate was scored against.
    var code = activeJobCode();
    if (code) items.forEach(function (o) { if (o && typeof o === 'object' && !o.jobCode) { o.jobCode = code; touched = true; } });
    var waits = items.map(function (o) {
      if (!o || typeof o !== 'object' || o.fileData || !o.fileName) return null;
      var p = fileStash[o.fileName];
      if (!p) return null;
      return p.then(function (f) { if (f) { o.fileData = f.data; o.fileMime = f.mime; touched = true; } });
    }).filter(Boolean);
    return Promise.all(waits).then(function () { return touched ? JSON.stringify(data) : bodyStr; });
  }
  function initInterceptors() {
    document.addEventListener('change', onFileChange, true);   // capture phase, before React's handler
    if (window.__ccFetchPatched || !window.fetch) return;
    window.__ccFetchPatched = true;
    var orig = window.fetch;                                    // already auth-patched by hrms-actor.js
    window.fetch = function (input, init) {
      var url = '', method = 'GET';
      try {
        url = (typeof input === 'string') ? input : (input && input.url) || '';
        method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      } catch (_) {}
      if (method === 'POST' && /\/api\/resume-scores(?:\?|$)/.test(url.split('#')[0]) && init && typeof init.body === 'string') {
        return injectFileData(init.body).then(function (nb) {
          var ni = init;
          if (nb !== init.body) { ni = {}; for (var k in init) ni[k] = init[k]; ni.body = nb; }
          return orig.call(window, input, ni);
        });
      }
      return orig.call(this, input, init);
    };
  }

  function start() {
    initInterceptors();
    var scheduled = false;
    new MutationObserver(function () {
      if (scheduled) return; scheduled = true;
      requestAnimationFrame(function () { scheduled = false; ensureLayout(); });
    }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('popstate', function () { setTimeout(ensureLayout, 60); });
    ensureLayout();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
