/**
 * hrms-projects.js  v4
 * ---------------------------------------------------------------------------
 * v4: GitHub Projects (v2) views and fields. A project has saved, shared views
 *     (tabs: Table / Board / Roadmap / + New view; the active tab's menu has
 *     layout, save / discard (unsaved-changes dot), rename, duplicate, delete)
 *     stored at /api/projects/<id>/views. Table: row numbers, Title, the view's
 *     visible fields ("..." menu: sort, group by, hide, move; drag to resize),
 *     "+" Add field menu + "Add issue fields" dialog, project fields (text,
 *     number, date, single select, iteration: /api/projects/<id>/fields, values
 *     PUT /api/tasks/<id>/fields/<fid>), inline cell editors and an add row
 *     (Ctrl+Space). Board cards show the view's fields and group by any
 *     groupable field. Roadmap: start -> target bars (fallback created -> due),
 *     week / month / quarter zoom, drag to move or resize, "No dates" list.
 *     Projects can be archived / restored / deleted (type the name). Issue
 *     pane: start / target / effort / parent / reviewers / project fields and
 *     comment editing. "All projects" keeps a local view in localStorage.
 * v3: GitHub-style "Create new issue" dialog (title, markdown editor, field
 *     chips: Assignee / Label / Issue type / Priority / Project / Milestone /
 *     + Due date / Team / Status, "Create more", Ctrl+Enter) and one shared
 *     markdown editor (Write | Preview, toolbar, shortcuts, list continuation,
 *     @mention and #issue pickers, paste/drop/click files) used for the new
 *     issue, the issue description, comments, project README and status
 *     updates. Projects: picker with pins (localStorage, per user) and
 *     "+ New project", a project side panel (short description, README,
 *     status updates with On track / At risk / Off track / Complete /
 *     Inactive) and an issue type (task / bug / feature / improvement).
 *     Images are embedded in the markdown as data URLs (<= 1 MB each); any
 *     other file goes to the issue's single attachment slot.
 *     Endpoints: /api/projects/<id>/status-updates[/<uid>].
 * Task Tracker (/employees/tasks) as a GitHub Projects (v2)-style page.
 *
 *   Board   columns by status (To Do / In Progress / In Review / Done) or by
 *           assignee / priority; drag & drop between columns (keyboard: the
 *           card's "..." menu -> Move to), collapsible columns, "+ Add item".
 *   Table   sortable columns, inline edit (status, priority, assignee, due),
 *           row selection + bulk actions, sticky header, "Load more".
 *   Filter  Open / Closed / All, project + team pickers and a GitHub-style
 *           query box: is:open is:closed assignee:me|<email/name> no:assignee
 *           priority:high team:"Name" label:bug status:review project:CODE
 *           due:overdue, "-" negates, everything else is a keyword.
 *           View + filters live in the URL (?view=&state=&q=&project=&team=
 *           &group=&sort=&dir=) and in localStorage per user.
 *   Item    side pane at /employees/tasks/issue/<id> (deep-linkable): edit
 *           title / description / status / assignee / priority / labels /
 *           team / project / milestone / due / progress, timeline of comments
 *           and status events, reactions, close / reopen, delete.
 *   Keys    n or c = new issue, / = filter, Esc = close menu / dialog / pane.
 *
 * Mounted through HRMSSidecar (hrms-sidecar.js): the page renders into the
 * sidecar's own root; React-owned DOM is never touched. Dialogs, menus and
 * toasts are body-level layers removed on unmount.
 *
 * Backend: GET/POST /api/tasks, PUT/DELETE /api/tasks/<id> (task.edit /
 * task.delete; delete only while To Do), GET /api/tasks/assignees?q=&teamId=,
 * GET/POST /api/tasks/<id>/comments, DELETE /api/tasks/<id>/comments/<cid>,
 * POST /api/tasks/<id>/comments/<cid>/reactions, GET /api/projects,
 * GET /api/projects/<id>/burndown, GET /api/teams.
 * Status = EmployeeTask.stage: todo | inprogress | review | done.
 */
(function () {
  'use strict';
  if (window.__hrmsProjectsLoaded) return;
  window.__hrmsProjectsLoaded = true;

  var BASE = '/employees/tasks';
  var STYLE_ID = 'hrms-projects-style';
  var LS_PREFIX = 'hrms-tasks-view:';
  var PAGE = 100;
  var SC = null;

  var STATUSES = [
    { id: 'todo', label: 'To Do', tone: 'green', hint: "This item hasn't been started" },
    { id: 'inprogress', label: 'In Progress', tone: 'yellow', hint: 'This is actively being worked on' },
    { id: 'review', label: 'In Review', tone: 'blue', hint: 'Waiting for review' },
    { id: 'done', label: 'Done', tone: 'purple', hint: 'This has been completed' }
  ];
  var PRIORITIES = [
    { id: 'high', label: 'High', tone: 'red' },
    { id: 'medium', label: 'Medium', tone: 'yellow' },
    { id: 'low', label: 'Low', tone: 'gray' }
  ];
  var LABELS = [
    { name: 'bug', hue: 356, desc: "Something isn't working" },
    { name: 'enhancement', hue: 186, desc: 'New feature or request' },
    { name: 'frontend', hue: 212, desc: 'UI & components' },
    { name: 'backend', hue: 258, desc: 'API & database' },
    { name: 'documentation', hue: 160, desc: 'Improvements to docs' },
    { name: 'question', hue: 300, desc: 'Further information is requested' },
    { name: 'design', hue: 28, desc: 'Design work' },
    { name: 'high-priority', hue: 8, desc: 'Urgent attention required' }
  ];
  var REACTIONS = [['+1', '👍'], ['-1', '👎'], ['laugh', '😄'], ['hooray', '🎉'],
                   ['heart', '❤️'], ['rocket', '🚀'], ['eyes', '👀']];
  var TYPES = [
    { id: 'task', label: 'Task', tone: 'blue', desc: 'A specific piece of work' },
    { id: 'bug', label: 'Bug', tone: 'red', desc: 'An unexpected problem or behavior' },
    { id: 'feature', label: 'Feature', tone: 'purple', desc: 'A request, idea, or new functionality' },
    { id: 'improvement', label: 'Improvement', tone: 'green', desc: 'Make something that exists better' }
  ];
  var PSTATUS = [
    { id: 'on_track', label: 'On track', tone: 'green' },
    { id: 'at_risk', label: 'At risk', tone: 'yellow' },
    { id: 'off_track', label: 'Off track', tone: 'red' },
    { id: 'complete', label: 'Complete', tone: 'purple' },
    { id: 'inactive', label: 'Inactive', tone: 'gray' }
  ];
  var PROJ_STATES = [['planning', 'Planning'], ['active', 'Active'], ['on_hold', 'On hold'], ['completed', 'Completed']];
  var DEFAULTS = { view: 'board', state: 'all', q: '', project: '', team: '', group: 'status', sort: 'updated', dir: 'desc', tgroup: '', pv: '' };
  var KEYS = ['view', 'state', 'q', 'project', 'team', 'group', 'sort', 'dir', 'tgroup', 'pv'];
  var LAYOUTS = ['table', 'board', 'roadmap'];
  var SORTS = [['updated', 'Last updated'], ['created', 'Created'], ['title', 'Title'], ['priority', 'Priority'],
               ['due', 'Due date'], ['status', 'Status'], ['assignee', 'Assignee'], ['team', 'Team'],
               ['start', 'Start date'], ['target', 'Target date'], ['effort', 'Effort'], ['closed', 'Closed']];
  /* Fields a view can show (GitHub Projects "fields"). Title is always on.
     ro = read-only cell; group = can group the board / table by it;
     issue = an issue-level field offered by the "Add issue fields" dialog. */
  var FIELD_DEFS = [
    { id: 'assignees', name: 'Assignees', group: true, desc: 'People working on the issue' },
    { id: 'status', name: 'Status', group: true, desc: 'To Do, In Progress, In Review or Done' },
    { id: 'labels', name: 'Labels', desc: 'Labels applied to the issue' },
    { id: 'milestone', name: 'Milestone', group: true, desc: 'The project milestone' },
    { id: 'type', name: 'Type', group: true, issue: true, desc: 'Task, bug, feature or improvement' },
    { id: 'reviewers', name: 'Reviewers', desc: 'Who reviews the work' },
    { id: 'parent', name: 'Parent issue', issue: true, desc: 'The issue this one is a sub-issue of' },
    { id: 'subissues', name: 'Sub-issues progress', ro: true, desc: 'Closed sub-issues out of all sub-issues' },
    { id: 'created', name: 'Created', ro: true, desc: 'When the issue was opened' },
    { id: 'updated', name: 'Updated', ro: true, desc: 'When the issue last changed' },
    { id: 'closed', name: 'Closed', ro: true, desc: 'When the issue was closed' },
    { id: 'priority', name: 'Priority', group: true, issue: true, desc: 'How urgent the issue is' },
    { id: 'start', name: 'Start date', issue: true, desc: 'When work starts (used by the roadmap)' },
    { id: 'target', name: 'Target date', issue: true, desc: 'When work should be finished (used by the roadmap)' },
    { id: 'effort', name: 'Effort', issue: true, desc: 'Estimated size, e.g. story points' },
    { id: 'team', name: 'Team', group: true, issue: true, desc: 'The team that owns the issue' },
    { id: 'due', name: 'Due date', issue: true, desc: 'The issue deadline' }
  ];
  var DEFAULT_FIELDS = ['assignees', 'status', 'priority', 'labels', 'type', 'milestone', 'team', 'due', 'updated'];
  var COL_W = { num: 64, title: 340, assignees: 170, status: 130, labels: 200, milestone: 150, type: 120, reviewers: 170, parent: 210,
                subissues: 160, created: 110, updated: 110, closed: 110, priority: 110, start: 130, target: 130, effort: 90, team: 140, due: 140 };
  var FTYPES = [['text', 'Text'], ['number', 'Number'], ['date', 'Date'], ['single_select', 'Single select'], ['iteration', 'Iteration']];
  var FCOLORS = ['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'pink', 'purple'];
  var ZOOMS = [['week', 'Week', 32], ['month', 'Month', 12], ['quarter', 'Quarter', 4]];

  /* ── icons (GitHub Octicons) ─────────────────────────────────────────── */
  function svg(d, size) {
    size = size || 16;
    return '<svg class="gh-ic" viewBox="0 0 16 16" width="' + size + '" height="' + size + '" fill="currentColor" aria-hidden="true">' + d + '</svg>';
  }
  var P = {
    open: '<path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"></path><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"></path>',
    closed: '<path d="M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5Z"></path><path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z"></path>',
    comment: '<path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"></path>',
    board: '<path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25ZM1.5 5.5v8.75c0 .138.112.25.25.25h3.5v-9Zm5.25 9h2.5v-9h-2.5Zm4 0h3.5a.25.25 0 0 0 .25-.25v-8.75h-3.75ZM14.5 4V1.75a.25.25 0 0 0-.25-.25H1.75a.25.25 0 0 0-.25.25V4Z"></path>',
    table: '<path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25ZM1.5 6.5h13V1.75a.25.25 0 0 0-.25-.25H1.75a.25.25 0 0 0-.25.25ZM14.5 8H1.5v6.25c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25Z"></path>',
    plus: '<path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z"></path>',
    kebab: '<path d="M8 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM1.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm13 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"></path>',
    search: '<path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"></path>',
    x: '<path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"></path>',
    link: '<path d="m7.775 3.275 1.25-1.25a3.5 3.5 0 1 1 4.95 4.95l-2.5 2.5a3.5 3.5 0 0 1-4.95 0 .751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018 1.998 1.998 0 0 0 2.83 0l2.5-2.5a2.002 2.002 0 0 0-2.83-2.83l-1.25 1.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042Zm-4.69 9.64a1.998 1.998 0 0 0 2.83 0l1.25-1.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042l-1.25 1.25a3.5 3.5 0 1 1-4.95-4.95l2.5-2.5a3.5 3.5 0 0 1 4.95 0 .751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018 1.998 1.998 0 0 0-2.83 0l-2.5 2.5a1.998 1.998 0 0 0 0 2.83Z"></path>',
    calendar: '<path d="M4.75 0a.75.75 0 0 1 .75.75V2h5V.75a.75.75 0 0 1 1.5 0V2h1.25c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 13.25 16H2.75A1.75 1.75 0 0 1 1 14.25V3.75C1 2.784 1.784 2 2.75 2H4V.75A.75.75 0 0 1 4.75 0ZM2.5 7.5v6.75c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V7.5Zm10.75-4H2.75a.25.25 0 0 0-.25.25V6h11V3.75a.25.25 0 0 0-.25-.25Z"></path>',
    chevDown: '<path d="M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 8.94l3.72-3.72a.749.749 0 0 1 1.06 0Z"></path>',
    chevRight: '<path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"></path>',
    trash: '<path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z"></path>',
    pencil: '<path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z"></path>',
    milestone: '<path d="M7.75 0a.75.75 0 0 1 .75.75V3h3.634c.414 0 .814.147 1.13.414l2.07 1.75a1.75 1.75 0 0 1 0 2.672l-2.07 1.75a1.75 1.75 0 0 1-1.13.414H8.5v5.25a.75.75 0 0 1-1.5 0V10H2.75A1.75 1.75 0 0 1 1 8.25v-5.5C1 1.784 1.784 1 2.75 1H7V.75A.75.75 0 0 1 7.75 0Zm.75 8.5h3.634a.25.25 0 0 0 .162-.06l2.07-1.75a.25.25 0 0 0 0-.38l-2.07-1.75a.25.25 0 0 0-.162-.06H8.5Z"></path>',
    graph: '<path d="M1.5 1.75V13.5h13.75a.75.75 0 0 1 0 1.5H.75a.75.75 0 0 1-.75-.75V1.75a.75.75 0 0 1 1.5 0Zm14.28 2.53-5.25 5.25a.75.75 0 0 1-1.06 0L7 7.06 4.28 9.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.25-3.25a.75.75 0 0 1 1.06 0L10 7.94l4.72-4.72a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042Z"></path>',
    sliders: '<path d="M15 2.75a.75.75 0 0 1-.75.75h-4a.75.75 0 0 1 0-1.5h4a.75.75 0 0 1 .75.75Zm-8.5.75v1.25a.75.75 0 0 0 1.5 0v-4a.75.75 0 0 0-1.5 0V2H1.75a.75.75 0 0 0 0 1.5H6.5Zm1.25 5.25a.75.75 0 0 0 0-1.5h-6a.75.75 0 0 0 0 1.5h6ZM15 8a.75.75 0 0 1-.75.75H11.5V10a.75.75 0 1 1-1.5 0V6a.75.75 0 0 1 1.5 0v1.25h2.75A.75.75 0 0 1 15 8Zm-9 5.25v-2a.75.75 0 0 0-1.5 0v1.25H1.75a.75.75 0 0 0 0 1.5H4.5v1.25a.75.75 0 0 0 1.5 0v-2Zm9 0a.75.75 0 0 1-.75.75h-6a.75.75 0 0 1 0-1.5h6a.75.75 0 0 1 .75.75Z"></path>',
    smiley: '<path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm3.82 1.636a.75.75 0 0 1 1.038.175l.007.009c.103.118.22.222.35.31.264.178.683.37 1.285.37.602 0 1.02-.192 1.285-.371.13-.088.247-.192.35-.31l.007-.008a.75.75 0 0 1 1.222.87l-.614-.431c.614.43.614.431.613.431v.001l-.001.002-.002.003-.005.007-.014.019a2.066 2.066 0 0 1-.184.213c-.16.166-.338.316-.53.445-.63.418-1.37.638-2.127.629-.946 0-1.652-.308-2.126-.63a3.331 3.331 0 0 1-.715-.657l-.014-.02-.005-.006-.002-.003v-.002h-.001l.613-.432-.614.43a.75.75 0 0 1 .183-1.044ZM12 7a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM5 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"></path>'
  };
  P.bold = '<path d="M4 2h4.5a3.501 3.501 0 0 1 2.852 5.53A3.499 3.499 0 0 1 9.5 14H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Zm1 7v3h4.5a1.5 1.5 0 0 0 0-3Zm3.5-2a1.5 1.5 0 0 0 0-3H5v3Z"></path>';
  P.italic = '<path d="M6 2.75A.75.75 0 0 1 6.75 2h6.5a.75.75 0 0 1 0 1.5h-2.505l-3.858 9H9.25a.75.75 0 0 1 0 1.5h-6.5a.75.75 0 0 1 0-1.5h2.505l3.858-9H6.75A.75.75 0 0 1 6 2.75Z"></path>';
  P.heading = '<path d="M3.75 2a.75.75 0 0 1 .75.75V7h7V2.75a.75.75 0 0 1 1.5 0v10.5a.75.75 0 0 1-1.5 0V8.5h-7v4.75a.75.75 0 0 1-1.5 0V2.75A.75.75 0 0 1 3.75 2Z"></path>';
  P.quote = '<path d="M1.75 2.5h10.5a.75.75 0 0 1 0 1.5H1.75a.75.75 0 0 1 0-1.5Zm4 5h8.5a.75.75 0 0 1 0 1.5h-8.5a.75.75 0 0 1 0-1.5Zm0 5h8.5a.75.75 0 0 1 0 1.5h-8.5a.75.75 0 0 1 0-1.5ZM2.5 7.75v6a.75.75 0 0 1-1.5 0v-6a.75.75 0 0 1 1.5 0Z"></path>';
  P.code = '<path d="m11.28 3.22 4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734L13.94 8l-3.72-3.72a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215Zm-6.56 0a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L2.06 8l3.72 3.72a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L.47 8.53a.75.75 0 0 1 0-1.06Z"></path>';
  P.listUl = '<path d="M5.75 2.5h8.5a.75.75 0 0 1 0 1.5h-8.5a.75.75 0 0 1 0-1.5Zm0 5h8.5a.75.75 0 0 1 0 1.5h-8.5a.75.75 0 0 1 0-1.5Zm0 5h8.5a.75.75 0 0 1 0 1.5h-8.5a.75.75 0 0 1 0-1.5ZM2 14a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm1-6a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM2 4a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"></path>';
  P.listOl = '<path d="M5 3.25a.75.75 0 0 1 .75-.75h8.5a.75.75 0 0 1 0 1.5h-8.5A.75.75 0 0 1 5 3.25Zm0 5a.75.75 0 0 1 .75-.75h8.5a.75.75 0 0 1 0 1.5h-8.5A.75.75 0 0 1 5 8.25Zm0 5a.75.75 0 0 1 .75-.75h8.5a.75.75 0 0 1 0 1.5h-8.5a.75.75 0 0 1-.75-.75ZM2.003 2.5V6h.503a.5.5 0 0 1 0 1H.5a.5.5 0 0 1 0-1h.503V3.308l-.28.14a.5.5 0 0 1-.446-.895l1.003-.5a.5.5 0 0 1 .723.447ZM.5 10.5a.5.5 0 0 1 .5-.5h1.5a1 1 0 0 1 .6 1.8l-1.2.9h1.1a.5.5 0 0 1 0 1H1a.5.5 0 0 1-.3-.9l1.8-1.35V11H1a.5.5 0 0 1-.5-.5Z"></path>';
  P.tasklist = '<path d="M2 2h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Zm4.655 8.595a.75.75 0 0 1 0 1.06L4.03 14.28a.75.75 0 0 1-1.06 0l-1.5-1.5a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l.97.97 2.095-2.095a.75.75 0 0 1 1.06 0ZM9.75 2.5h5.5a.75.75 0 0 1 0 1.5h-5.5a.75.75 0 0 1 0-1.5Zm0 5h5.5a.75.75 0 0 1 0 1.5h-5.5a.75.75 0 0 1 0-1.5Zm0 5h5.5a.75.75 0 0 1 0 1.5h-5.5a.75.75 0 0 1 0-1.5Zm-7.25-9v3h3v-3Z"></path>';
  P.mention = '<path d="M4.75 2.37a6.501 6.501 0 0 0 6.5 11.26.75.75 0 0 1 .75 1.298A7.999 7.999 0 0 1 .989 4.148 8 8 0 0 1 16 7.75v1.5a2.75 2.75 0 0 1-5.072 1.475 3.999 3.999 0 1 1 .072-4.723V5.75a.75.75 0 0 1 1.5 0v3.5a1.25 1.25 0 0 0 2.5 0v-1.5a6.5 6.5 0 0 0-9.75-5.38ZM10.5 8a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"></path>';
  P.crossRef = '<path d="M2.75 3.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 13H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 14.543V13H2.75A1.75 1.75 0 0 1 1 11.25v-7.5C1 2.784 1.784 2 2.75 2h5.5a.75.75 0 0 1 0 1.5ZM16 1.25v4.146a.25.25 0 0 1-.427.177L14.03 4.03l-3.75 3.75a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l3.75-3.75-1.543-1.543A.25.25 0 0 1 11.604 1h4.146a.25.25 0 0 1 .25.25Z"></path>';
  P.reply = '<path d="M6.78 1.97a.75.75 0 0 1 0 1.06L3.81 6h6.44A4.75 4.75 0 0 1 15 10.75v2.5a.75.75 0 0 1-1.5 0v-2.5a3.25 3.25 0 0 0-3.25-3.25H3.81l2.97 2.97a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L1.47 7.28a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z"></path>';
  P.undo = '<path d="M1.22 6.28a.749.749 0 0 1 0-1.06l3.5-3.5a.749.749 0 1 1 1.06 1.06L3.561 5h7.188A4.501 4.501 0 0 1 10.5 14H8.796a.75.75 0 0 1 0-1.5H10.5a3 3 0 1 0 0-6H3.561L5.78 8.72a.749.749 0 1 1-1.06 1.06l-3.5-3.5Z"></path>';
  P.paperclip = '<path d="M12.212 3.02a1.753 1.753 0 0 0-2.478.003l-5.83 5.83a3.007 3.007 0 0 0-.88 2.127c0 .795.315 1.551.88 2.116.567.567 1.333.89 2.126.89.79 0 1.548-.321 2.116-.89l5.48-5.48a.75.75 0 0 1 1.061 1.06l-5.48 5.48a4.492 4.492 0 0 1-3.177 1.33c-1.2 0-2.345-.487-3.187-1.33a4.483 4.483 0 0 1-1.32-3.177c0-1.195.475-2.341 1.32-3.186l5.83-5.83a3.25 3.25 0 0 1 5.553 2.297c0 .863-.343 1.691-.953 2.301L7.439 12.39c-.375.377-.884.59-1.416.593a1.998 1.998 0 0 1-1.412-.586 1.992 1.992 0 0 1-.584-1.41c0-.528.21-1.033.584-1.406l5.83-5.83a.75.75 0 0 1 1.061 1.06l-5.83 5.83a.5.5 0 0 0 0 .708.5.5 0 0 0 .708 0l5.83-5.83a1.75 1.75 0 0 0 0-2.47Z"></path>';
  P.arrowLeft = '<path d="M7.78 12.53a.75.75 0 0 1-1.06 0L2.47 8.28a.75.75 0 0 1 0-1.06l4.25-4.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L4.81 7h7.44a.75.75 0 0 1 0 1.5H4.81l2.97 2.97a.75.75 0 0 1 0 1.06Z"></path>';
  P.pin = '<path d="m11.294.984 3.722 3.722a1.75 1.75 0 0 1-.504 2.826l-1.327.613a3.089 3.089 0 0 0-1.533 1.535l-.89 1.931a.75.75 0 0 1-1.213.218L7.5 9.81l-3.72 3.72a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734L6.44 8.75 4.399 6.709a.75.75 0 0 1 .218-1.213l1.931-.89a3.089 3.089 0 0 0 1.535-1.533l.613-1.327a1.75 1.75 0 0 1 2.598-.762Zm-1.06 1.06a.25.25 0 0 0-.398.07l-.613 1.327a4.588 4.588 0 0 1-2.28 2.28l-.97.448 4.01 4.01.448-.97a4.588 4.588 0 0 1 2.28-2.28l1.327-.613a.25.25 0 0 0 .07-.398Z"></path>';
  P.pulse = '<path d="M6 2c.306 0 .582.187.696.471L10 10.731l1.304-3.26A.751.751 0 0 1 12 7h3.25a.75.75 0 0 1 0 1.5h-2.742l-1.812 4.528a.751.751 0 0 1-1.392 0L6 4.77 4.696 8.03A.75.75 0 0 1 4 8.5H.75a.75.75 0 0 1 0-1.5h2.742l1.812-4.529A.751.751 0 0 1 6 2Z"></path>';
  P.info = '<path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"></path>';
  P.tag = '<path d="M1 7.775V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 0 1 0 2.474l-5.026 5.026a1.75 1.75 0 0 1-2.474 0l-6.25-6.25A1.752 1.752 0 0 1 1 7.775Zm1.5 0c0 .066.026.13.073.177l6.25 6.25a.25.25 0 0 0 .354 0l5.025-5.025a.25.25 0 0 0 0-.354l-6.25-6.25a.25.25 0 0 0-.177-.073H2.75a.25.25 0 0 0-.25.25ZM6 5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"></path>';
  P.person = '<path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"></path>';
  P.people = '<path d="M2 5.5a3.5 3.5 0 1 1 5.898 2.549 5.508 5.508 0 0 1 3.034 4.084.75.75 0 1 1-1.482.235 4 4 0 0 0-7.9 0 .75.75 0 0 1-1.482-.236A5.507 5.507 0 0 1 3.102 8.05 3.493 3.493 0 0 1 2 5.5ZM11 4a3.001 3.001 0 0 1 2.22 5.018 5.01 5.01 0 0 1 2.56 3.012.749.749 0 0 1-.885.954.752.752 0 0 1-.549-.514 3.507 3.507 0 0 0-2.522-2.372.75.75 0 0 1-.574-.73v-.352a.75.75 0 0 1 .416-.672A1.5 1.5 0 0 0 11 5.5.75.75 0 0 1 11 4Zm-5.5-.5a2 2 0 1 0-.001 3.999A2 2 0 0 0 5.5 3.5Z"></path>';
  P.bug = '<path d="M4.72.22a.75.75 0 0 1 1.06 0l1 .999a3.488 3.488 0 0 1 2.441 0l.999-1a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.775.776c.616.63.995 1.493.995 2.444v.327c0 .1-.009.197-.025.292.408.14.764.392 1.029.722l1.968-.787a.75.75 0 0 1 .556 1.392L13 7.258V9h2.25a.75.75 0 0 1 0 1.5H13v.5c0 .409-.049.806-.141 1.186l2.17.868a.75.75 0 0 1-.557 1.392l-2.184-.873A4.997 4.997 0 0 1 8 16a4.997 4.997 0 0 1-4.288-2.427l-2.183.873a.75.75 0 0 1-.558-1.392l2.17-.868A5.036 5.036 0 0 1 3 11v-.5H.75a.75.75 0 0 1 0-1.5H3V7.258L.971 6.446a.75.75 0 0 1 .558-1.392l1.967.787c.265-.33.62-.583 1.03-.722a1.677 1.677 0 0 1-.026-.292V4.5c0-.951.38-1.814.995-2.444L4.72 1.28a.75.75 0 0 1 0-1.06Zm.53 6.28a.75.75 0 0 0-.75.75V11a3.5 3.5 0 1 0 7 0V7.25a.75.75 0 0 0-.75-.75ZM6.173 5h3.654A.172.172 0 0 0 10 4.827V4.5a2 2 0 1 0-4 0v.327c0 .096.077.173.173.173Z"></path>';
  P.bulb = '<path d="M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.848.284.411.537.896.621 1.49a.75.75 0 0 1-1.484.211c-.04-.282-.163-.547-.37-.847a8.456 8.456 0 0 0-.542-.68c-.084-.1-.173-.205-.268-.32C3.201 7.75 2.5 6.766 2.5 5.25 2.5 2.31 4.863 0 8 0s5.5 2.31 5.5 5.25c0 1.516-.701 2.5-1.328 3.259-.095.115-.184.22-.268.319-.207.245-.383.453-.541.681-.208.3-.33.565-.37.847a.751.751 0 0 1-1.485-.212c.084-.593.337-1.078.621-1.489.203-.292.45-.584.673-.848.075-.088.147-.173.213-.253.561-.679.985-1.32.985-2.304 0-2.06-1.637-3.75-4-3.75ZM5.75 12h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5ZM6 15.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75Z"></path>';
  P.zap = '<path d="M9.504.43a1.516 1.516 0 0 1 2.437 1.713L10.415 5.5h2.123c1.57 0 2.346 1.909 1.22 3.004l-7.34 7.142a1.249 1.249 0 0 1-.871.354h-.302a1.25 1.25 0 0 1-1.157-1.723L5.633 10.5H3.462c-1.57 0-2.346-1.909-1.22-3.004L9.503.429Zm1.047 1.074L3.286 8.571A.25.25 0 0 0 3.462 9H6.75a.75.75 0 0 1 .694 1.034l-1.713 4.188 6.982-6.793A.25.25 0 0 0 12.538 7H9.25a.75.75 0 0 1-.683-1.06l2.008-4.418.003-.006-.004-.009-.006-.006-.008-.001-.009.004Z"></path>';
  P.arrowUp = '<path d="M3.47 7.78a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0l4.25 4.25a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018L9 4.81v7.44a.75.75 0 0 1-1.5 0V4.81L4.53 7.78a.75.75 0 0 1-1.06 0Z"></path>';
  P.file = '<path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"></path>';
  P.book = '<path d="M0 1.75A.75.75 0 0 1 .75 1h4.253c1.227 0 2.317.59 3 1.501A3.743 3.743 0 0 1 11.006 1h4.245a.75.75 0 0 1 .75.75v10.5a.75.75 0 0 1-.75.75h-4.507a2.25 2.25 0 0 0-1.591.659l-.622.621a.75.75 0 0 1-1.06 0l-.622-.621A2.25 2.25 0 0 0 5.258 13H.75a.75.75 0 0 1-.75-.75Zm7.251 10.324.004-5.073-.002-2.253A2.25 2.25 0 0 0 5.003 2.5H1.5v9h3.757a3.75 3.75 0 0 1 1.994.574ZM8.755 4.75l-.004 7.322a3.752 3.752 0 0 1 1.992-.572H14.5v-9h-3.495a2.25 2.25 0 0 0-2.25 2.25Z"></path>';
  var TICON = { task: P.tasklist, bug: P.bug, feature: P.bulb, improvement: P.zap };
  function typeOf(id) { var v = String(id || 'task').toLowerCase(); for (var i = 0; i < TYPES.length; i++) if (TYPES[i].id === v) return TYPES[i]; return TYPES[0]; }
  function pstatusOf(id) { for (var i = 0; i < PSTATUS.length; i++) if (PSTATUS[i].id === id) return PSTATUS[i]; return PSTATUS[0]; }
  /* Status shown for a project in every list: its latest status update
     (On track / At risk / ...) when it has one, else its own state
     (Planning / Active / On hold / Completed). */
  var PSTATE_TONE = { planning: 'blue', active: 'green', on_hold: 'yellow', completed: 'purple' };
  function projStateLabel(p) { var l = ''; PROJ_STATES.forEach(function (x) { if (x[0] === p.status) l = x[1]; }); return l || (p.status ? String(p.status).replace(/_/g, ' ') : ''); }
  function projStatusText(p) {
    if (!p) return '';
    if (p.latestStatus) return pstatusOf(p.latestStatus.status || p.latestStatus).label;
    return projStateLabel(p);
  }
  function projStatusPill(p) {
    if (!p) return '';
    if (p.latestStatus) return pstatusPill(p.latestStatus);
    var l = projStateLabel(p);
    return l ? '<span class="gh-pill gh-tone-' + (PSTATE_TONE[p.status] || 'gray') + '" title="Project state: ' + esc(l) + '">' + esc(l) + '</span>' : '';
  }
  function pstatusPill(s) {
    if (!s) return '';
    var x = pstatusOf(s.status || s);
    return '<span class="gh-pill gh-tone-' + x.tone + '" title="Project status: ' + esc(x.label) + '">' + esc(x.label) + '</span>';
  }

  /* ── state ───────────────────────────────────────────────────────────── */
  var S = null;
  function fresh() {
    return {
      root: null, refs: {}, tasks: [], extra: {}, projects: [], teams: [], loaded: false, loading: false,
      error: '', seq: 0, ctrl: null, f: copy(DEFAULTS), collapsed: {}, selected: {}, limit: PAGE,
      quickAdd: null, pane: null, modals: [], insight: !!insPrefs().open, insRange: insPrefs().range || 30, burndown: null, qTimer: null,
      cleanup: [], focusTitle: '', dragId: null,
      mde: {}, imgs: {}, imgSeq: 0, people: {}, pp: null, ac: null, metaLoaded: false,
      // views & fields (per project, server-side); vc = fields/widths/zoom of the current view
      views: null, fields: [], vc: { fields: DEFAULT_FIELDS.slice(), widths: {}, zoom: 'month' }, vdraft: {},
      pendingUrl: null, showArchived: false, pmeta: '', rmDrag: null
    };
  }
  function copy(o) { var r = {}; for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k]; return r; }

  /* ── small helpers ───────────────────────────────────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function me() { try { return SC.me(); } catch (_) { return { email: '', name: '' }; } }
  function can(code) { try { return window.__hrmsCan ? !!window.__hrmsCan(code) : true; } catch (_) { return true; } }
  function canEdit() { return can('task.edit'); }
  function canDelete() { return can('task.delete'); }
  function canCreate() { return can('task.create'); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function todayISO() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function stageOf(t) {
    var s = String((t && t.stage) || '').toLowerCase().replace(/[\s_-]/g, '');
    if (s === 'done' || s === 'complete' || s === 'completed' || s === 'closed') return 'done';
    if (s === 'review' || s === 'inreview') return 'review';
    if (s === 'inprogress' || s === 'progress' || s === 'doing') return 'inprogress';
    return 'todo';
  }
  function statusOf(id) { for (var i = 0; i < STATUSES.length; i++) if (STATUSES[i].id === id) return STATUSES[i]; return STATUSES[0]; }
  function prioOf(id) {
    var p = String(id || 'medium').toLowerCase();
    for (var i = 0; i < PRIORITIES.length; i++) if (PRIORITIES[i].id === p) return PRIORITIES[i];
    return { id: p, label: p.charAt(0).toUpperCase() + p.slice(1), tone: 'gray' };
  }
  function isClosed(t) { return stageOf(t) === 'done'; }
  function hashHue(s) { var h = 0; s = String(s || ''); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }
  function labelHue(name) {
    var n = String(name || '').toLowerCase();
    for (var i = 0; i < LABELS.length; i++) if (LABELS[i].name === n) return LABELS[i].hue;
    return hashHue(n);
  }
  function parseLabels(raw) {
    var arr = raw;
    if (typeof raw === 'string') {
      try { arr = JSON.parse(raw || '[]'); } catch (_) { arr = raw.split(','); }
    }
    if (!Array.isArray(arr)) return [];
    var out = [];
    arr.forEach(function (l) {
      var n = String((typeof l === 'string' ? l : (l && l.name)) || '').trim();
      if (n && out.indexOf(n) === -1) out.push(n);
    });
    return out;
  }
  function initials(name) {
    var parts = String(name || '').replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
    if (!parts.length) return '?';
    return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : (parts[0][1] || ''))).toUpperCase();
  }
  function personName(t) { return t.assignee || t.assigneeEmail || ''; }
  function avatar(name, key, size) {
    if (!name) return '<span class="gh-av gh-av--none" aria-hidden="true" style="--sz:' + (size || 20) + 'px"></span>';
    return '<span class="gh-av" aria-hidden="true" style="--h:' + hashHue(key || name) + ';--sz:' + (size || 20) + 'px">' + esc(initials(name)) + '</span>';
  }
  function labelChip(name, extra) {
    return '<span class="gh-label" style="--h:' + labelHue(name) + '">' + esc(name) + (extra || '') + '</span>';
  }
  function dueISO(d) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '').trim()); return m ? m[0] : ''; }
  function isOverdue(t) { var iso = dueISO(t.due); return !!iso && !isClosed(t) && iso < todayISO(); }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDue(d) {
    var iso = dueISO(d);
    if (!iso) return String(d || '');
    var y = +iso.slice(0, 4), m = +iso.slice(5, 7), day = +iso.slice(8, 10);
    return MONTHS[m - 1] + ' ' + day + (y !== new Date().getFullYear() ? ', ' + y : '');
  }
  function parseTime(s) {
    if (!s) return null;
    var d = new Date(String(s).replace(' ', 'T'));
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtAbs(s) {
    var d = parseTime(s);
    if (!d) return '';
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function relTime(s) {
    var d = parseTime(s);
    if (!d) return '';
    var sec = Math.round((Date.now() - d.getTime()) / 1000);
    if (sec < 45) return 'just now';
    if (sec < 3600) return Math.max(1, Math.round(sec / 60)) + 'm ago';
    if (sec < 86400) return Math.round(sec / 3600) + 'h ago';
    if (sec < 86400 * 30) return Math.round(sec / 86400) + 'd ago';
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + (d.getFullYear() !== new Date().getFullYear() ? ', ' + d.getFullYear() : '');
  }
  function timeEl(s) { return s ? '<time title="' + esc(fmtAbs(s)) + '">' + esc(relTime(s)) + '</time>' : ''; }
  function stateIcon(t, size) {
    var st = stageOf(t);
    return '<span class="gh-tone-' + statusOf(st).tone + ' gh-stateic" title="' + esc(statusOf(st).label) + '">' + svg(st === 'done' ? P.closed : P.open, size || 16) + '</span>';
  }
  function ref(t) { return '#' + t.id; }
  function teamById(id) { for (var i = 0; i < S.teams.length; i++) if (String(S.teams[i].id) === String(id)) return S.teams[i]; return null; }
  function projectById(id) { for (var i = 0; i < S.projects.length; i++) if (String(S.projects[i].id) === String(id)) return S.projects[i]; return null; }
  function findTask(id) {
    for (var i = 0; i < S.tasks.length; i++) if (String(S.tasks[i].id) === String(id)) return S.tasks[i];
    return S.extra[String(id)] || null;
  }
  function replaceTask(row) {
    if (!row || row.id == null) return;
    for (var i = 0; i < S.tasks.length; i++) if (String(S.tasks[i].id) === String(row.id)) { S.tasks[i] = row; return; }
    if (S.extra[String(row.id)]) S.extra[String(row.id)] = row;
  }

  /* ── fields: definitions, values, cells ──────────────────────────────── */
  function customById(id) { for (var i = 0; i < S.fields.length; i++) if (String(S.fields[i].id) === String(id)) return S.fields[i]; return null; }
  function fdef(id) {
    if (id === 'title') return { id: 'title', name: 'Title' };
    var m = /^f:(\d+)$/.exec(id || '');
    if (m) {
      var cf = customById(m[1]);
      return cf ? { id: id, name: cf.name, custom: cf, group: cf.type === 'single_select' || cf.type === 'iteration' } : null;
    }
    for (var i = 0; i < FIELD_DEFS.length; i++) if (FIELD_DEFS[i].id === id) return FIELD_DEFS[i];
    return null;
  }
  function visibleFields() { return (S.vc.fields || []).filter(function (id) { return id !== 'title' && !!fdef(id); }); }
  function isVisible(id) { return visibleFields().indexOf(id) !== -1; }
  function colWidth(id) { var w = S.vc.widths && S.vc.widths[id]; return w ? Math.max(48, Math.min(900, w)) : (COL_W[id] || 160); }
  function fieldVal(t, fid) { var f = t && t.fields; return f && Object.prototype.hasOwnProperty.call(f, String(fid)) ? f[String(fid)] : null; }
  function choiceOf(cf, v) { var cs = (cf.options && cf.options.choices) || []; for (var i = 0; i < cs.length; i++) if (cs[i].id === v) return cs[i]; return null; }
  function iterOf(cf, v) { var its = cf.iterations || []; for (var i = 0; i < its.length; i++) if (its[i].id === v) return its[i]; return null; }
  function reviewerName(t) { var e = String(t.reviewerEmail || '').toLowerCase(); return e ? (S.people[e] || e) : ''; }
  function canConfigure() {
    var p = projectById(S.f.project);
    return canManageProject(p);
  }
  /* Comparable value for sorting (null = empty, sorts last). */
  function sortVal(t, id) {
    switch (id) {
      case 'title': return String(t.title || '').toLowerCase();
      case 'assignees': case 'assignee': return personName(t) ? personName(t).toLowerCase() : null;
      case 'status': return SRANK[stageOf(t)];
      case 'labels': var l = parseLabels(t.labels); return l.length ? l[0].toLowerCase() : null;
      case 'milestone': return t.milestoneTitle ? String(t.milestoneTitle).toLowerCase() : null;
      case 'type': return typeOf(t.issueType).label.toLowerCase();
      case 'reviewers': return reviewerName(t) ? reviewerName(t).toLowerCase() : null;
      case 'parent': return t.parentTitle ? String(t.parentTitle).toLowerCase() : null;
      case 'subissues': var s = t.subIssues || {}; return s.total ? s.done / s.total : null;
      case 'created': return Number(t.id) || 0;
      case 'updated': var d = parseTime(t.updatedAt || t.createdAt); return d ? d.getTime() : Number(t.id) || 0;
      case 'closed': var c = parseTime(t.closedAt); return c ? c.getTime() : null;
      case 'priority': var r = PRANK[String(t.priority || 'medium').toLowerCase()]; return r == null ? 9 : r;
      case 'start': return t.startDate || null;
      case 'target': return t.targetDate || null;
      case 'effort': return t.effort == null || t.effort === '' ? null : Number(t.effort);
      case 'team': return t.teamName ? String(t.teamName).toLowerCase() : null;
      case 'due': return dueISO(t.due) || null;
    }
    var fd = fdef(id);
    if (!fd || !fd.custom) return null;
    var v = fieldVal(t, fd.custom.id);
    if (v == null || v === '') return null;
    if (fd.custom.type === 'single_select') { var cs = (fd.custom.options && fd.custom.options.choices) || []; for (var i = 0; i < cs.length; i++) if (cs[i].id === v) return i; return null; }
    if (fd.custom.type === 'number') return Number(v);
    return typeof v === 'string' ? v.toLowerCase() : v;
  }
  function selPill(ch) { return ch ? '<span class="gh-opt gh-opt-' + esc(ch.color || 'gray') + '">' + esc(ch.name) + '</span>' : ''; }
  function emptyCell() { return '<span class="gh-muted">—</span>'; }
  /* Display HTML for one field of one issue (no editing chrome). */
  function cellInner(t, id) {
    var st, pr, ty, who, v;
    switch (id) {
      case 'assignees': who = personName(t); return who ? avatar(who, t.assigneeEmail || who, 20) + '<span class="gh-ellip">' + esc(who) + '</span>' : emptyCell();
      case 'status': st = statusOf(stageOf(t)); return '<span class="gh-pill gh-tone-' + st.tone + '"><span class="gh-dot gh-dot--sm" aria-hidden="true"></span>' + esc(st.label) + '</span>';
      case 'labels': var ls = parseLabels(t.labels); return ls.length ? '<span class="gh-cellchips">' + ls.map(function (l) { return labelChip(l); }).join('') + '</span>' : emptyCell();
      case 'milestone': return t.milestoneTitle ? svg(P.milestone, 14) + '<span class="gh-ellip">' + esc(t.milestoneTitle) + '</span>' : emptyCell();
      case 'type': ty = typeOf(t.issueType); return '<span class="gh-tone-' + ty.tone + '">' + svg(TICON[ty.id], 14) + '</span><span>' + esc(ty.label) + '</span>';
      case 'reviewers': who = reviewerName(t); return who ? avatar(who, t.reviewerEmail, 20) + '<span class="gh-ellip">' + esc(who) + '</span>' : emptyCell();
      case 'parent': return t.parentId ? '<span class="gh-tone-gray">' + svg(P.crossRef, 14) + '</span><span class="gh-ellip"><span class="gh-ref">#' + esc(t.parentId) + '</span> ' + esc(t.parentTitle || '') + '</span>' : emptyCell();
      case 'subissues':
        var si = t.subIssues || {};
        if (!si.total) return emptyCell();
        var pct = Math.round(si.done / si.total * 100);
        return '<span class="gh-subprog" title="' + si.done + ' of ' + si.total + ' sub-issues closed"><span class="gh-bar gh-bar--sm"><i style="width:' + pct + '%"></i></span><span>' + si.done + '/' + si.total + '</span></span>';
      case 'created': return timeEl(t.createdAt) || emptyCell();
      case 'updated': return timeEl(t.updatedAt || t.createdAt) || emptyCell();
      case 'closed': return t.closedAt ? timeEl(t.closedAt) : emptyCell();
      case 'priority': pr = prioOf(t.priority); return '<span class="gh-pill gh-tone-' + pr.tone + '">' + esc(pr.label) + '</span>';
      case 'start': return t.startDate ? esc(fmtDue(t.startDate)) : emptyCell();
      case 'target': return t.targetDate ? '<span' + (isPast(t.targetDate) && !isClosed(t) ? ' class="gh-overdue"' : '') + '>' + esc(fmtDue(t.targetDate)) + '</span>' : emptyCell();
      case 'effort': return t.effort == null || t.effort === '' ? emptyCell() : '<span class="gh-num">' + esc(t.effort) + '</span>';
      case 'team': return t.teamName ? '<span class="gh-ellip">' + esc(t.teamName) + '</span>' : emptyCell();
      case 'due': return t.due ? '<span' + (isOverdue(t) ? ' class="gh-overdue"' : '') + '>' + esc(dueISO(t.due) ? fmtDue(t.due) : t.due) + '</span>' : emptyCell();
    }
    var fd = fdef(id);
    if (!fd || !fd.custom) return '';
    v = fieldVal(t, fd.custom.id);
    if (v == null || v === '') return emptyCell();
    switch (fd.custom.type) {
      case 'single_select': return selPill(choiceOf(fd.custom, v)) || emptyCell();
      case 'iteration': var it = iterOf(fd.custom, v); return it ? svg(P.calendar, 14) + '<span class="gh-ellip">' + esc(it.title) + '</span>' : esc(v);
      case 'date': return esc(fmtDue(v));
      case 'number': return '<span class="gh-num">' + esc(v) + '</span>';
      default: return '<span class="gh-ellip" title="' + esc(v) + '">' + esc(v) + '</span>';
    }
  }
  function isPast(iso) { return !!iso && String(iso).slice(0, 10) < todayISO(); }
  function cellReadOnly(id) { var fd = fdef(id); return !fd || !!fd.ro; }
  /* Small "Name: value" chip for board cards. */
  function cardChip(t, id) {
    var fd = fdef(id);
    if (!fd) return '';
    if (fd.custom) {
      var v = fieldVal(t, fd.custom.id);
      if (v == null || v === '') return '';
      if (fd.custom.type === 'single_select') { var ch = choiceOf(fd.custom, v); return ch ? '<span class="gh-opt gh-opt-' + esc(ch.color) + '" title="' + esc(fd.name) + '">' + esc(ch.name) + '</span>' : ''; }
      var txt = fd.custom.type === 'iteration' ? ((iterOf(fd.custom, v) || {}).title || v) : (fd.custom.type === 'date' ? fmtDue(v) : v);
      return '<span class="gh-pill gh-tone-gray" title="' + esc(fd.name) + '">' + esc(fd.name) + ': ' + esc(txt) + '</span>';
    }
    if (id === 'start' && t.startDate) return '<span class="gh-pill gh-tone-gray">Start ' + esc(fmtDue(t.startDate)) + '</span>';
    if (id === 'target' && t.targetDate) return '<span class="gh-pill gh-tone-gray">Target ' + esc(fmtDue(t.targetDate)) + '</span>';
    if (id === 'effort' && t.effort != null && t.effort !== '') return '<span class="gh-pill gh-tone-gray">Effort ' + esc(t.effort) + '</span>';
    if (id === 'team' && t.teamName) return '<span class="gh-pill gh-tone-gray">' + svg(P.people, 12) + ' ' + esc(t.teamName) + '</span>';
    if (id === 'status' && S.f.group !== 'status') { var s = statusOf(stageOf(t)); return '<span class="gh-pill gh-tone-' + s.tone + '">' + esc(s.label) + '</span>'; }
    if (id === 'reviewers' && t.reviewerEmail) return '<span class="gh-pill gh-tone-gray">Reviewer: ' + esc(reviewerName(t)) + '</span>';
    if (id === 'closed' && t.closedAt) return '<span class="gh-pill gh-tone-purple">Closed ' + esc(relTime(t.closedAt)) + '</span>';
    if (id === 'created') return '<span class="gh-pill gh-tone-gray">Created ' + esc(relTime(t.createdAt)) + '</span>';
    return '';
  }

  /* ── dates for the roadmap ───────────────────────────────────────────── */
  function dayNum(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : null; }
  function isoOfDay(n) { var d = new Date(n * 86400000); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function localISO(s) { var d = parseTime(s); return d ? d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) : ''; }
  /* {s, e, fb} day numbers for a roadmap bar, or null when undated.
     Start date -> Target date; fallback: created -> due. */
  function spanOf(t) {
    var s = dayNum(t.startDate), e = dayNum(t.targetDate);
    if (s != null || e != null) return { s: s != null ? s : e, e: e != null ? Math.max(e, s != null ? s : e) : s, fb: false };
    var due = dayNum(dueISO(t.due));
    if (due == null) return null;
    var c = dayNum(localISO(t.createdAt));
    return { s: c != null && c <= due ? c : due, e: due, fb: true };
  }

  /* ── markdown (GitHub-flavoured subset) ─────────────────────────────────
     Safe by construction: every piece of user text is HTML-escaped, and only
     the constructs below emit markup. Links are http(s)/mailto only; images
     are http(s) or data:image/(png|jpeg|gif|webp);base64 only. The server
     stores markdown raw and never renders it. */
  var SAFE_IMG = /^(?:https?:\/\/[^\s"'<>()]+|data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+\/=]+)$/i;
  var SAFE_HREF = /^(?:https?:\/\/|mailto:)[^\s"'<>]+$/i;
  var FENCE_RE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
  var LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  var HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
  function emph(s) {
    return s.replace(/\*\*(?=\S)([^*]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w])__(?=\S)([^_]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
      .replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])?\*(?!\*)/g, function (all, pre, body) { return body === undefined ? all : pre + '<em>' + body + '</em>'; })
      .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~(?=\S)([^~]*?\S)~~/g, '<del>$1</del>');
  }
  function mentionHtml(who) {
    var name = S && S.people ? S.people[who.toLowerCase()] : '';
    return '<span class="gh-mention" title="' + esc(who) + '">@' + esc(name || who) + '</span>';
  }
  function mdInline(src) {
    var keep = [];
    function hold(html) { keep.push(html); return '\u0001' + (keep.length - 1) + '\u0001'; }
    var s = String(src || '').replace(/[\u0000\u0001]/g, '');
    s = s.replace(/`([^`\n]+)`/g, function (_, c) { return hold('<code>' + esc(c) + '</code>'); });
    s = s.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, function (all, alt, url) {
      return SAFE_IMG.test(url) ? hold('<img src="' + esc(url) + '" alt="' + esc(alt) + '" loading="lazy">') : all;
    });
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (all, label, url) {
      return SAFE_HREF.test(url) ? hold('<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + emph(esc(label)) + '</a>') : all;
    });
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>"'\u0001]*[^\s<>"'.,;:!?)\u0001])/g, function (_, pre, url) {
      return pre + hold('<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(url) + '</a>');
    });
    s = s.replace(/(^|[^\w@\/])@([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+|[A-Za-z0-9](?:[\w.-]*\w)?)/g, function (_, pre, who) {
      return pre + hold(mentionHtml(who));
    });
    s = s.replace(/(^|[\s(\[])#(\d+)\b/g, function (_, pre, n) {
      return pre + hold('<a href="' + BASE + '/issue/' + n + '" class="gh-xref">#' + n + '</a>');
    });
    return emph(esc(s)).replace(/\u0001(\d+)\u0001/g, function (_, i) { return keep[+i] || ''; });
  }
  function mdCells(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); });
  }
  /* o.interactive: task-list checkboxes are clickable and carry data-task=<n>
     (n counts task items in source order, outside code fences and quotes —
     the same order toggleTaskSrc() walks). */
  function md(src, o) { return mdRender(src, o || {}, { n: 0 }); }
  function mdRender(src, o, counter) {
    var lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    var out = [], para = [], stack = [], m;
    function flush() { if (para.length) { out.push('<p>' + para.map(mdInline).join('<br>') + '</p>'); para = []; } }
    function closeLists(indent) { while (stack.length && stack[stack.length - 1].indent > indent) out.push('</li></' + stack.pop().tag + '>'); }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if ((m = FENCE_RE.exec(line))) {
        flush(); closeLists(-1);
        var fence = m[1], code = [];
        for (i++; i < lines.length && lines[i].trim().indexOf(fence) !== 0; i++) code.push(lines[i]);
        out.push('<pre><code' + (m[2] ? ' data-lang="' + esc(m[2]) + '"' : '') + '>' + esc(code.join('\n')) + '</code></pre>');
        continue;
      }
      if (!line.trim()) {
        flush();
        var j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j >= lines.length || !(LIST_RE.test(lines[j]) || /^\s{2,}\S/.test(lines[j]))) closeLists(-1);
        continue;
      }
      if ((m = LIST_RE.exec(line)) && !HR_RE.test(line)) {
        flush();
        var indent = m[1].replace(/\t/g, '    ').length, ordered = /\d/.test(m[2]), tag = ordered ? 'ol' : 'ul';
        var tm = /^\[([ xX])\](?:\s+(.*))?$/.exec(m[3]);
        closeLists(indent);
        var top = stack[stack.length - 1];
        var open = '<' + tag + (ordered && parseInt(m[2], 10) !== 1 ? ' start="' + parseInt(m[2], 10) + '"' : '') + '>';
        if (!top || top.indent < indent) { out.push(open); stack.push({ tag: tag, indent: indent }); }
        else if (top.tag !== tag) { out.push('</li></' + stack.pop().tag + '>' + open); stack.push({ tag: tag, indent: indent }); }
        else out.push('</li>');
        if (tm) {
          var n = counter.n++, live = o.interactive && !o.nested;
          out.push('<li class="gh-md-task"><input type="checkbox" class="gh-md-cb"' + (live ? ' data-task="' + n + '"' : ' disabled') + (tm[1] !== ' ' ? ' checked' : '') +
            ' aria-label="' + esc((tm[1] !== ' ' ? 'Completed task: ' : 'Task: ') + (tm[2] || '')) + '"> ' + mdInline(tm[2] || ''));
        } else out.push('<li>' + mdInline(m[3]));
        continue;
      }
      if (stack.length && /^\s{2,}\S/.test(line)) { out.push('<br>' + mdInline(line.trim())); continue; }
      closeLists(-1);
      if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) { flush(); out.push('<h' + m[1].length + '>' + mdInline(m[2]) + '</h' + m[1].length + '>'); continue; }
      if (HR_RE.test(line)) { flush(); out.push('<hr>'); continue; }
      if (/^\s{0,3}>/.test(line)) {
        flush();
        var q = [];
        for (; i < lines.length && /^\s{0,3}>/.test(lines[i]); i++) q.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        i--;
        out.push('<blockquote>' + mdRender(q.join('\n'), { nested: true }, { n: 0 }) + '</blockquote>');
        continue;
      }
      if (line.indexOf('|') !== -1 && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        flush();
        var aligns = mdCells(lines[i + 1]).map(function (c) { return /^:-+:$/.test(c) ? 'center' : (/-:$/.test(c) ? 'right' : (/^:/.test(c) ? 'left' : '')); });
        var al = function (k) { return aligns[k] ? ' style="text-align:' + aligns[k] + '"' : ''; };
        var html = '<div class="gh-md-table"><table><thead><tr>' + mdCells(line).map(function (c, k) { return '<th' + al(k) + '>' + mdInline(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
        for (i += 2; i < lines.length && lines[i].indexOf('|') !== -1 && lines[i].trim(); i++) {
          html += '<tr>' + mdCells(lines[i]).map(function (c, k) { return '<td' + al(k) + '>' + mdInline(c) + '</td>'; }).join('') + '</tr>';
        }
        i--;
        out.push(html + '</tbody></table></div>');
        continue;
      }
      para.push(line);
    }
    flush(); closeLists(-1);
    return out.join('');
  }
  /* Flip the n-th task item ([ ] <-> [x]) in the markdown source; null if absent. */
  function toggleTaskSrc(src, n) {
    var lines = String(src || '').replace(/\r\n?/g, '\n').split('\n'), k = 0, fence = null, m;
    for (var i = 0; i < lines.length; i++) {
      if (fence) { if (lines[i].trim().indexOf(fence) === 0) fence = null; continue; }
      if ((m = FENCE_RE.exec(lines[i]))) { fence = m[1]; continue; }
      if (/^\s*([-*+]|\d{1,9}[.)])\s+\[[ xX]\](\s|$)/.test(lines[i])) {
        if (k++ === n) {
          lines[i] = lines[i].replace(/\[([ xX])\]/, function (_, c) { return c === ' ' ? '[x]' : '[ ]'; });
          return lines.join('\n');
        }
      }
    }
    return null;
  }

  /* ── network ─────────────────────────────────────────────────────────── */
  function errText(d, status) {
    var msg = '';
    if (d && typeof d === 'object') {
      msg = d.message || d.detail || d.error || '';
      if (!msg) {
        for (var k in d) {
          if (Object.prototype.hasOwnProperty.call(d, k)) {
            var v = d[k];
            msg = k + ': ' + (Array.isArray(v) ? v.join(' ') : String(v));
            break;
          }
        }
      }
    }
    if (status === 403) return "You don't have permission to do that" + (msg ? ' (' + msg.replace(/^Permission denied:?\s*/i, '') + ')' : '') + '.';
    if (status === 401) return 'Your session has expired. Please sign in again.';
    if (status >= 500) return 'The server had a problem (' + status + '). Please try again.';
    return msg || ('Request failed (' + status + ')');
  }
  function req(url, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    if (opts.signal) init.signal = opts.signal;
    return fetch(url, init).then(function (r) {
      return r.text().then(function (t) {
        var d = null;
        try { d = t ? JSON.parse(t) : null; } catch (_) {}
        if (!r.ok) { var e = new Error(errText(d, r.status)); e.status = r.status; e.data = d; throw e; }
        return d;
      });
    }, function (e) {
      if (e && e.name === 'AbortError') throw e;
      throw new Error('Network error. Check your connection and try again.');
    });
  }

  /* ── toasts ──────────────────────────────────────────────────────────── */
  function toast(msg, kind) {
    var box = document.getElementById('gh-toasts');
    if (!box) {
      box = document.createElement('div');
      box.id = 'gh-toasts';
      box.className = 'gh-layer gh-toasts';
      box.setAttribute('role', 'status');
      box.setAttribute('aria-live', 'polite');
      document.body.appendChild(box);
    }
    var el = document.createElement('div');
    el.className = 'gh-toast gh-toast--' + (kind || 'ok');
    el.innerHTML = '<span class="gh-toast-msg">' + esc(msg) + '</span><button type="button" class="gh-iconbtn" aria-label="Dismiss">' + svg(P.x, 14) + '</button>';
    el.querySelector('button').onclick = function () { if (el.parentNode) el.parentNode.removeChild(el); };
    box.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, kind === 'err' ? 7000 : 4000);
  }

  /* ── persistence: URL + localStorage ─────────────────────────────────── */
  function prefsKey() { return LS_PREFIX + (me().email || 'anon'); }
  function savePrefs() {
    try {
      // vc (visible fields / widths / zoom) is the local "All projects" view;
      // a project's views live on the server.
      var prev = loadPrefs() || {};
      localStorage.setItem(prefsKey(), JSON.stringify({ f: S.f, collapsed: S.collapsed, vc: S.f.project ? (prev.vc || null) : S.vc }));
    } catch (_) {}
  }
  function lastViewKey() { return 'hrms-tasks-lastview:' + (me().email || 'anon'); }
  function lastViewFor(pid) { try { return (JSON.parse(localStorage.getItem(lastViewKey()) || '{}') || {})[pid] || ''; } catch (_) { return ''; } }
  function rememberView(pid, vid) {
    try { var o = JSON.parse(localStorage.getItem(lastViewKey()) || '{}') || {}; o[pid] = String(vid); localStorage.setItem(lastViewKey(), JSON.stringify(o)); } catch (_) {}
  }
  function groupOk(g) { return ['status', 'assignee', 'priority', 'type', 'milestone', 'team'].indexOf(g) !== -1 || /^f:\d+$/.test(g); }
  function cleanVc(vc) {
    vc = vc && typeof vc === 'object' ? vc : {};
    var fields = Array.isArray(vc.fields) ? vc.fields.filter(function (x) { return typeof x === 'string' && x !== 'title' && /^(?:[a-z]{2,12}|f:\d+)$/.test(x); }) : DEFAULT_FIELDS.slice();
    var widths = {};
    if (vc.widths && typeof vc.widths === 'object') Object.keys(vc.widths).sort().forEach(function (k) { var n = Number(vc.widths[k]); if (n > 0) widths[k] = Math.round(Math.max(48, Math.min(900, n))); });
    return { fields: fields.filter(function (x, i) { return fields.indexOf(x) === i; }), widths: widths, zoom: ['week', 'month', 'quarter'].indexOf(vc.zoom) !== -1 ? vc.zoom : 'month' };
  }
  function loadPrefs() {
    try { var p = JSON.parse(localStorage.getItem(prefsKey()) || 'null'); return p && typeof p === 'object' ? p : null; } catch (_) { return null; }
  }
  function sanitize(f) {
    var o = copy(DEFAULTS);
    KEYS.forEach(function (k) { if (f && f[k] != null) o[k] = String(f[k]); });
    if (LAYOUTS.indexOf(o.view) === -1) o.view = 'board';
    if (['open', 'closed', 'all'].indexOf(o.state) === -1) o.state = DEFAULTS.state;
    if (o.group === 'assignees') o.group = 'assignee';
    if (!groupOk(o.group)) o.group = 'status';
    if (o.tgroup === 'assignees') o.tgroup = 'assignee';
    if (o.tgroup && !groupOk(o.tgroup)) o.tgroup = '';
    if (o.sort === 'assignees') o.sort = 'assignee';
    if (!SORTS.some(function (s) { return s[0] === o.sort; }) && !FIELD_DEFS.some(function (f) { return f.id === o.sort; }) && !/^f:\d+$/.test(o.sort)) o.sort = 'updated';
    if (o.dir !== 'asc') o.dir = 'desc';
    if (!/^\d*$/.test(o.project)) o.project = '';
    if (!/^\d*$/.test(o.team)) o.team = '';
    if (!/^\d*$/.test(o.pv) || !o.project) o.pv = '';
    return o;
  }
  function urlFilters() {
    var sp = new URLSearchParams(location.search), f = {}, any = false;
    KEYS.forEach(function (k) { if (sp.has(k)) { f[k] = sp.get(k); any = true; } });
    return { any: any, f: f, focus: sp.get('focus') || '' };
  }
  function qs() {
    var parts = [];
    KEYS.forEach(function (k) { if (S.f[k] !== DEFAULTS[k] && S.f[k] !== '') parts.push(k + '=' + encodeURIComponent(S.f[k])); });
    return parts.length ? '?' + parts.join('&') : '';
  }
  function issueFromPath() {
    var p = location.pathname.replace(/\/+$/, '');
    var m = /^\/employees\/tasks\/issue\/(\d+)$/.exec(p);
    return m ? m[1] : null;
  }
  function writeUrl(push) {
    if (!S || !S.root) return;
    var url = BASE + (S.pane ? '/issue/' + S.pane.id : '') + qs();
    if (url === location.pathname + location.search) return;
    try { history[push ? 'pushState' : 'replaceState']({}, '', url); } catch (_) {}
  }
  function setFilter(patch, opts) {
    opts = opts || {};
    var before = S.f.project;
    if (patch.project != null && String(patch.project) !== before) { stashDraft(); patch.pv = ''; }
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) S.f[k] = patch[k];
    S.f = sanitize(S.f);
    S.limit = PAGE;
    if (S.f.project !== before) {
      S.burndown = null;
      if (!S.f.project) { var pr = loadPrefs(); S.vc = cleanVc(pr && pr.vc); }
    }
    savePrefs();
    writeUrl(!!opts.push);
    if (S.f.project !== before) { loadTasks(); loadProjectMeta(); }
    renderChrome();
    renderBody();
  }
  /* The view's fields / widths / zoom changed (not part of S.f). */
  function vcChanged() {
    savePrefs();
    renderChrome();
    renderBody();
  }

  /* ── data ────────────────────────────────────────────────────────────── */
  function loadMeta() {
    var my = S;
    return Promise.all([
      req('/api/projects?archived=all').catch(function (e) { return { __err: e }; }),
      req('/api/teams').catch(function () { return []; })
    ]).then(function (res) {
      if (S !== my || !S.root) return;
      S.projects = Array.isArray(res[0]) ? res[0] : [];
      S.projErr = (res[0] && res[0].__err) ? (res[0].__err.status === 403
        ? "You don't have access to the project list (needs the project.view permission)."
        : 'Could not load projects' + (res[0].__err.status ? ' (error ' + res[0].__err.status + ')' : '') + ': ' + (res[0].__err.message || 'unknown error')) : '';
      S.teams = (Array.isArray(res[1]) ? res[1] : []).filter(function (t) { return (t.status || 'active') === 'active' || String(t.id) === S.f.team; });
      S.metaLoaded = true;
      knownPeople('');
      renderChrome();
      if (S.pp) renderPP();
      if (S.loaded) renderBody();
      if (S.pane) renderPane();
    });
  }
  function loadTasks() {
    if (S.ctrl) { try { S.ctrl.abort(); } catch (_) {} }
    var ctrl = window.AbortController ? new AbortController() : null;
    S.ctrl = ctrl;
    var my = ++S.seq, st = S;
    S.loading = true;
    if (!S.loaded) renderBody(); else markBusy(true);
    var url = '/api/tasks' + (S.f.project ? '?projectId=' + encodeURIComponent(S.f.project) : '');
    return req(url, { signal: ctrl && ctrl.signal }).then(function (rows) {
      if (st !== S || my !== S.seq || !S.root) return;
      S.tasks = Array.isArray(rows) ? rows : [];
      S.loaded = true; S.loading = false; S.error = '';
      knownPeople('');
      markBusy(false);
      renderChrome();
      renderBody();
      afterLoad();
    }, function (e) {
      if (st !== S || my !== S.seq || !S.root || (e && e.name === 'AbortError')) return;
      S.loading = false; S.error = e.message || 'Could not load issues.';
      markBusy(false);
      renderBody();
    });
  }
  function markBusy(on) { if (S.refs.body) S.refs.body.classList.toggle('gh-busy', !!on); }
  function afterLoad() {
    if (S.focusTitle) {
      var want = S.focusTitle.toLowerCase(), hit = null;
      S.tasks.forEach(function (t) { if (!hit && String(t.title || '').trim().toLowerCase() === want) hit = t; });
      S.focusTitle = '';
      if (hit) { openIssue(hit.id, { replace: true }); return; }
      writeUrl(false);
    }
    if (S.pane) {
      if (!findTask(S.pane.id)) fetchMissing(S.pane.id);
      else renderPane();
    }
  }
  function fetchMissing(id) {
    var st = S;
    // Deep link to an issue outside the current project filter: look it up in the full list.
    req('/api/tasks').then(function (rows) {
      if (st !== S || !S.root || !S.pane || String(S.pane.id) !== String(id)) return;
      var hit = null;
      (rows || []).forEach(function (t) { if (String(t.id) === String(id)) hit = t; });
      if (hit) { S.extra[String(id)] = hit; renderPane(); }
      else { toast('Issue #' + id + ' was not found. It may have been deleted.', 'err'); closePane(); }
    }, function (e) { if (st === S && S.root) toast(e.message, 'err'); });
  }

  /* Optimistic update: apply locally, PUT, replace with the server row or roll back. */
  function updateTask(t, patch, opts) {
    opts = opts || {};
    var before = copy(t);
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) t[k] = patch[k];
    t.updatedAt = new Date().toISOString();
    if (!opts.silent) { renderBody(); if (S.pane && String(S.pane.id) === String(t.id)) renderPane(); }
    var st = S;
    return req('/api/tasks/' + t.id, { method: 'PUT', body: patch }).then(function (row) {
      if (st !== S || !S.root) return row;
      if (row && row.id != null) {
        if (row.commentCount == null) row.commentCount = t.commentCount;
        replaceTask(row);
      }
      if (!opts.silent) { renderBody(); if (S.pane && String(S.pane.id) === String(t.id)) { renderPane(); refreshTimeline(); } }
      return row;
    }, function (e) {
      if (st !== S || !S.root) throw e;
      for (var k2 in before) if (Object.prototype.hasOwnProperty.call(before, k2)) t[k2] = before[k2];
      if (!opts.silent) { renderBody(); if (S.pane && String(S.pane.id) === String(t.id)) renderPane(); toast(e.message, 'err'); }
      throw e;
    });
  }
  function createTask(body) {
    var m = me();
    if (m.email && !body.createdBy) body.createdBy = m.email;
    return req('/api/tasks', { method: 'POST', body: body }).then(function (row) {
      if (S && S.root && row && row.id != null) { S.tasks.unshift(row); renderChrome(); renderBody(); }
      return row;
    });
  }
  /* Set a project field on an issue (optimistic). value null clears it. */
  function setFieldValue(t, cf, value) {
    var key = String(cf.id), before = t.fields ? copy(t.fields) : {};
    t.fields = copy(t.fields || {});
    if (value == null || value === '') delete t.fields[key]; else t.fields[key] = value;
    renderBody(); if (S.pane && String(S.pane.id) === String(t.id)) renderPane();
    var st = S;
    return req('/api/tasks/' + t.id + '/fields/' + cf.id, { method: 'PUT', body: { value: value == null || value === '' ? null : value } }).then(function (d) {
      if (st !== S || !S.root) return d;
      t.fields = (d && d.fields) || t.fields;
      t.updatedAt = new Date().toISOString();
      renderBody(); if (S.pane && String(S.pane.id) === String(t.id)) renderPane();
      return d;
    }, function (e) {
      if (st !== S || !S.root) throw e;
      t.fields = before;
      renderBody(); if (S.pane && String(S.pane.id) === String(t.id)) renderPane();
      toast(e.message, 'err');
      throw e;
    });
  }

  /* ── saved views (per project, shared) ───────────────────────────────── */
  function viewById(id) { var vs = S.views || []; for (var i = 0; i < vs.length; i++) if (String(vs[i].id) === String(id)) return vs[i]; return null; }
  function defaultCfg(layout) {
    return { layout: layout || 'table', fields: DEFAULT_FIELDS.slice(), widths: {}, sort: 'updated', dir: 'desc',
             group: 'status', tgroup: '', q: '', state: 'all', zoom: 'month' };
  }
  function normCfg(c) {
    var d = defaultCfg(c && c.layout), o = {};
    c = c || {};
    var vc = cleanVc({ fields: c.fields || d.fields, widths: c.widths, zoom: c.zoom });
    o.layout = LAYOUTS.indexOf(c.layout) !== -1 ? c.layout : d.layout;
    o.fields = vc.fields; o.widths = vc.widths; o.zoom = vc.zoom;
    o.sort = c.sort || d.sort; o.dir = c.dir === 'asc' ? 'asc' : 'desc';
    o.group = c.group && groupOk(c.group === 'assignees' ? 'assignee' : c.group) ? (c.group === 'assignees' ? 'assignee' : c.group) : d.group;
    o.tgroup = c.tgroup && c.tgroup !== 'none' && groupOk(c.tgroup === 'assignees' ? 'assignee' : c.tgroup) ? (c.tgroup === 'assignees' ? 'assignee' : c.tgroup) : '';
    o.q = String(c.q || ''); o.state = ['open', 'closed', 'all'].indexOf(c.state) !== -1 ? c.state : d.state;
    return o;
  }
  function viewCfg(v) { var c = copy((v && v.config) || {}); c.layout = v ? v.layout : 'table'; return normCfg(c); }
  function curCfg() {
    return normCfg({ layout: S.f.view, fields: S.vc.fields, widths: S.vc.widths, zoom: S.vc.zoom, sort: S.f.sort, dir: S.f.dir,
                     group: S.f.group, tgroup: S.f.tgroup, q: S.f.q, state: S.f.state });
  }
  function applyCfg(c) {
    c = normCfg(c);
    S.f.view = c.layout; S.f.sort = c.sort; S.f.dir = c.dir; S.f.group = c.group; S.f.tgroup = c.tgroup; S.f.q = c.q; S.f.state = c.state;
    S.f = sanitize(S.f);
    S.vc = { fields: c.fields, widths: c.widths, zoom: c.zoom };
    if (S.refs.q) S.refs.q.value = S.f.q;
  }
  function isDirty(v) {
    v = v || viewById(S.f.pv);
    if (!v) return false;
    if (String(v.id) !== String(S.f.pv)) return !!S.vdraft[v.id];
    return JSON.stringify(curCfg()) !== JSON.stringify(viewCfg(v));
  }
  function stashDraft() {
    if (!S.f.pv || !viewById(S.f.pv)) return;
    if (isDirty()) S.vdraft[S.f.pv] = curCfg(); else delete S.vdraft[S.f.pv];
  }
  function selectView(id, opts) {
    opts = opts || {};
    var v = viewById(id);
    if (!v) return;
    if (String(S.f.pv) !== String(id)) stashDraft();
    S.f.pv = String(v.id);
    applyCfg(S.vdraft[v.id] || viewCfg(v));
    if (S.pendingUrl) {
      // A deep link's own filters win over the saved view (shown as unsaved changes).
      var u = S.pendingUrl;
      S.pendingUrl = null;
      ['view', 'state', 'q', 'sort', 'dir', 'group', 'tgroup'].forEach(function (k) { if (u[k] != null) S.f[k] = u[k]; });
      S.f = sanitize(S.f);
      if (S.refs.q) S.refs.q.value = S.f.q;
    }
    S.limit = PAGE;
    rememberView(S.f.project, v.id);
    savePrefs();
    writeUrl(!!opts.push);
    renderChrome();
    renderBody();
  }
  function loadProjectMeta() {
    var pid = S.f.project, st = S;
    S.views = null; S.fields = []; S.pmeta = pid;
    if (!pid) { renderChrome(); return Promise.resolve(); }
    return Promise.all([req('/api/projects/' + pid + '/views'), req('/api/projects/' + pid + '/fields').catch(function () { return []; })]).then(function (res) {
      if (st !== S || !S.root || S.f.project !== pid) return;
      S.views = Array.isArray(res[0]) ? res[0] : [];
      S.fields = Array.isArray(res[1]) ? res[1] : [];
      var want = viewById(S.f.pv) ? S.f.pv : (viewById(lastViewFor(pid)) ? lastViewFor(pid) : (S.views[0] && S.views[0].id));
      if (want != null) selectView(want, {});
      else { renderChrome(); renderBody(); }
    }, function (e) {
      if (st !== S || !S.root || S.f.project !== pid) return;
      S.views = [];
      toast('Views could not be loaded: ' + e.message, 'err');
      renderChrome();
    });
  }
  function reloadFields() {
    var pid = S.f.project, st = S;
    if (!pid) return Promise.resolve();
    return req('/api/projects/' + pid + '/fields').then(function (rows) {
      if (st !== S || S.f.project !== pid) return;
      S.fields = Array.isArray(rows) ? rows : [];
      renderChrome(); renderBody(); if (S.pane) renderPane();
    });
  }
  function viewUrl(id) { return '/api/projects/' + S.f.project + '/views' + (id ? '/' + id : ''); }
  function toServer(c) {
    return { fields: c.fields, widths: c.widths, zoom: c.zoom, sort: c.sort, dir: c.dir, group: c.group, tgroup: c.tgroup || 'none', q: c.q, state: c.state };
  }
  function saveView() {
    var v = viewById(S.f.pv);
    if (!v) return;
    var c = curCfg(), st = S;
    req(viewUrl(v.id), { method: 'PATCH', body: { layout: c.layout, config: toServer(c) } }).then(function (row) {
      if (st !== S) return;
      replaceView(row);
      delete S.vdraft[row.id];
      renderChrome();
      toast('View “' + row.name + '” saved.');
    }, function (e) { toast(e.message, 'err'); });
  }
  function discardView() {
    var v = viewById(S.f.pv);
    if (!v) return;
    delete S.vdraft[v.id];
    applyCfg(viewCfg(v));
    savePrefs(); writeUrl(false); renderChrome(); renderBody();
    toast('Changes to “' + v.name + '” discarded.');
  }
  function replaceView(row) {
    for (var i = 0; i < S.views.length; i++) if (String(S.views[i].id) === String(row.id)) { S.views[i] = row; return; }
    S.views.push(row);
  }
  function createView(layout, name, cfg) {
    var st = S, c = cfg || defaultCfg(layout);
    c.layout = layout;
    return req(viewUrl(), { method: 'POST', body: { name: name || '', layout: layout, config: toServer(normCfg(c)) } }).then(function (row) {
      if (st !== S) return row;
      S.views.push(row);
      selectView(row.id, { push: true });
      toast('Created view “' + row.name + '”.');
      return row;
    }, function (e) { toast(e.message, 'err'); throw e; });
  }
  function promptText(o) {
    return new Promise(function (resolve) {
      var done = false;
      var m = openModal('<form class="gh-modal gh-modal--sm" role="dialog" aria-modal="true" aria-labelledby="gh-pt-t"><div class="gh-modal-h"><h3 id="gh-pt-t">' + esc(o.title) + '</h3></div>' +
        '<div class="gh-modal-b"><div class="gh-field"><label for="gh-pt-in">' + esc(o.label) + '</label><input id="gh-pt-in" class="gh-input" maxlength="' + (o.max || 100) + '" autocomplete="off" value="' + esc(o.value || '') + '"></div></div>' +
        '<div class="gh-modal-f"><button type="button" class="gh-btn" data-x="1">Cancel</button><button type="submit" class="gh-btn gh-btn-primary">' + esc(o.ok || 'Save') + '</button></div></form>',
        { onClose: function () { if (!done) { done = true; resolve(null); } } });
      var inp = m.el.querySelector('#gh-pt-in');
      inp.focus(); inp.select();
      m.el.querySelector('form').addEventListener('submit', function (e) {
        e.preventDefault();
        var v = inp.value.trim();
        if (!v) { inp.focus(); return; }
        done = true; m.close(); resolve(v);
      });
    });
  }
  function openViewTabMenu(anchor) {
    var v = viewById(S.f.pv);
    if (!v) return;
    var cfgOk = canConfigure(), dirty = isDirty();
    var items = [{ header: 'Layout' }].concat(LAYOUTS.map(function (l) {
      return { v: 'layout:' + l, label: l.charAt(0).toUpperCase() + l.slice(1), checked: S.f.view === l, icon: svg(l === 'board' ? P.board : (l === 'table' ? P.table : P.calendar), 14) };
    }));
    items.push({ sep: true },
      { v: 'save', label: 'Save changes', disabled: !dirty || !cfgOk, title: cfgOk ? '' : "You can't change this project's views" },
      { v: 'discard', label: 'Discard changes', disabled: !dirty },
      { sep: true },
      { v: 'rename', label: 'Rename view', disabled: !cfgOk },
      { v: 'dup', label: 'Duplicate view', disabled: !cfgOk },
      { v: 'delete', label: 'Delete view', danger: true, disabled: !cfgOk || (S.views || []).length <= 1, title: (S.views || []).length <= 1 ? 'A project needs at least one view' : '' });
    openMenu(anchor, items, function (val) {
      var st = S;
      if (val.indexOf('layout:') === 0) setFilter({ view: val.slice(7) }, { push: true });
      else if (val === 'save') saveView();
      else if (val === 'discard') discardView();
      else if (val === 'rename') {
        promptText({ title: 'Rename view', label: 'View name', value: v.name }).then(function (name) {
          if (!name || st !== S || name === v.name) return;
          req(viewUrl(v.id), { method: 'PATCH', body: { name: name } }).then(function (row) { replaceView(row); renderChrome(); toast('View renamed.'); }, function (e) { toast(e.message, 'err'); });
        });
      } else if (val === 'dup') createView(S.f.view, 'Copy of ' + v.name, curCfg()).then(null, function () {});
      else if (val === 'delete') {
        confirmBox({ title: 'Delete view “' + v.name + '”?', body: 'The view is removed for everyone. Issues and fields are not affected.', ok: 'Delete view', danger: true }).then(function (ok) {
          if (!ok || st !== S) return;
          req(viewUrl(v.id), { method: 'DELETE' }).then(function () {
            if (st !== S) return;
            var i = S.views.indexOf(v);
            S.views = S.views.filter(function (x) { return x !== v; });
            delete S.vdraft[v.id];
            S.f.pv = '';
            var next = S.views[Math.max(0, i - 1)];
            if (next) selectView(next.id, { push: true });
            toast('View deleted.');
          }, function (e) { toast(e.message, 'err'); });
        });
      }
    }, 'View options');
  }
  function openNewViewMenu(anchor) {
    if (!canConfigure()) { toast("You don't have permission to add views to this project.", 'err'); return; }
    openMenu(anchor, [{ header: 'New view' }].concat(LAYOUTS.map(function (l) {
      return { v: l, label: l.charAt(0).toUpperCase() + l.slice(1), icon: svg(l === 'board' ? P.board : (l === 'table' ? P.table : P.calendar), 14),
               hint: l === 'table' ? 'Spreadsheet of fields' : (l === 'board' ? 'Columns by a field' : 'Timeline by dates') };
    })), function (l) {
      var n = (S.views || []).length + 1;
      createView(l, 'View ' + n).then(null, function () {});
    }, 'New view');
  }

  /* ── filtering / sorting ─────────────────────────────────────────────── */
  function parseQuery(q) {
    var out = { terms: [], quals: [] }, m;
    var re = /(-?)([a-zA-Z]+):(?:"([^"]*)"|(\S+))|"([^"]*)"|(\S+)/g;
    while ((m = re.exec(String(q || '')))) {
      if (m[2]) out.quals.push({ neg: m[1] === '-', key: m[2].toLowerCase(), val: String(m[3] != null ? m[3] : m[4] || '').toLowerCase() });
      else out.terms.push(String(m[5] != null ? m[5] : m[6] || '').toLowerCase());
    }
    return out;
  }
  function has(hay, needle) { return String(hay || '').toLowerCase().indexOf(needle) !== -1; }
  var QUALS = {
    is: function (t, v) {
      if (v === 'open') return !isClosed(t);
      if (v === 'closed' || v === 'done') return isClosed(t);
      if (v === 'overdue') return isOverdue(t);
      return stageOf(t) === v.replace(/[\s_-]/g, '');
    },
    status: function (t, v) {
      v = v.replace(/[\s_-]/g, '');
      var s = statusOf(stageOf(t));
      return s.id === v || s.label.toLowerCase().replace(/\s/g, '') === v;
    },
    assignee: function (t, v) {
      if (v === 'me') return !!me().email && String(t.assigneeEmail || '').toLowerCase() === me().email;
      if (v === 'none' || v === '') return !personName(t);
      return has(t.assigneeEmail, v) || has(t.assignee, v);
    },
    no: function (t, v) {
      if (v === 'assignee') return !personName(t);
      if (v === 'label' || v === 'labels') return !parseLabels(t.labels).length;
      if (v === 'team') return !t.teamId;
      if (v === 'project') return !t.projectId;
      if (v === 'due') return !String(t.due || '').trim();
      if (v === 'milestone') return !t.milestoneId;
      return true;
    },
    priority: function (t, v) { return String(t.priority || 'medium').toLowerCase().indexOf(v) === 0; },
    team: function (t, v) { return has(t.teamName, v) || String(t.teamId) === v; },
    label: function (t, v) { return parseLabels(t.labels).some(function (l) { return l.toLowerCase() === v; }); },
    project: function (t, v) { return has(t.projectCode, v) || has(t.projectName, v) || String(t.projectId) === v; },
    milestone: function (t, v) { return has(t.milestoneTitle, v); },
    type: function (t, v) { return typeOf(t.issueType).id === v || typeOf(t.issueType).label.toLowerCase() === v; },
    author: function (t, v) { return has(t.createdBy, v); },
    due: function (t, v) {
      if (v === 'overdue') return isOverdue(t);
      if (v === 'none') return !String(t.due || '').trim();
      if (v === 'today') return dueISO(t.due) === todayISO();
      return has(t.due, v);
    }
  };
  QUALS.labels = QUALS.label;
  QUALS.state = QUALS.is;
  function matchQuery(t, pq) {
    for (var i = 0; i < pq.quals.length; i++) {
      var q = pq.quals[i], fn = QUALS[q.key];
      if (!fn) { if (!has(haystack(t), q.key + ':' + q.val) !== q.neg) return false; continue; }
      if (!!fn(t, q.val) === q.neg) return false;
    }
    if (pq.terms.length) {
      var hay = haystack(t);
      for (var j = 0; j < pq.terms.length; j++) {
        var term = pq.terms[j], neg = term.charAt(0) === '-' && term.length > 1;
        if (neg) term = term.slice(1);
        if (has(hay, term) === neg) return false;
      }
    }
    return true;
  }
  function haystack(t) {
    if (t.__hay && t.__hayAt === t.updatedAt + '|' + t.title) return t.__hay;
    var h = [t.title, t.taskCode, '#' + t.id, t.description, t.assignee, t.assigneeEmail, t.teamName,
             t.projectName, t.projectCode, t.milestoneTitle, parseLabels(t.labels).join(' '), t.issueType || ''].join(' ').toLowerCase();
    try { Object.defineProperty(t, '__hay', { value: h, writable: true, configurable: true, enumerable: false });
          Object.defineProperty(t, '__hayAt', { value: t.updatedAt + '|' + t.title, writable: true, configurable: true, enumerable: false }); } catch (_) {}
    return h;
  }
  function baseFiltered() {
    var pq = parseQuery(S.f.q);
    return S.tasks.filter(function (t) {
      if (S.f.team && String(t.teamId) !== S.f.team) return false;
      return matchQuery(t, pq);
    });
  }
  function applyState(list) {
    if (S.f.state === 'open') return list.filter(function (t) { return !isClosed(t); });
    if (S.f.state === 'closed') return list.filter(isClosed);
    return list;
  }
  var PRANK = { urgent: -1, high: 0, medium: 1, low: 2 };
  var SRANK = { todo: 0, inprogress: 1, review: 2, done: 3 };
  function sortList(list) {
    var key = S.f.sort, dir = S.f.dir === 'asc' ? 1 : -1;
    // Priority sorts High first when "descending" (rank is inverted).
    var inv = key === 'priority' ? -1 : 1;
    var vals = {};
    list.forEach(function (t) { vals[t.id] = sortVal(t, key); });
    return list.slice().sort(function (a, b) {
      var x = vals[a.id], y = vals[b.id];
      var ex = x == null || x === '', ey = y == null || y === '';
      if (ex !== ey) return ex ? 1 : -1;            // empty values last, either direction
      if (!ex) {
        if (x < y) return -1 * dir * inv;
        if (x > y) return 1 * dir * inv;
      }
      return (Number(b.id) || 0) - (Number(a.id) || 0);
    });
  }

  /* ── styles ──────────────────────────────────────────────────────────── */
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var old = document.getElementById('gh-projects-styles');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var css = [
      /* tokens — app variables first, explicit GitHub colours per theme */
      '.gh-app,.gh-layer{--gh-fg:var(--text,#e6edf3);--gh-muted:var(--text2,#9198a1);--gh-canvas:var(--bg2,#151b23);--gh-raised:var(--bg3,#212830);',
      '--gh-inset:var(--bg,#0d1117);--gh-overlay:var(--bg2,#151b23);--gh-line:rgba(255,255,255,.12);--gh-line-soft:rgba(255,255,255,.07);',
      '--gh-hover:rgba(255,255,255,.05);--gh-accent:var(--accent,#4f8ef7);--gh-green:#3fb950;--gh-yellow:#d29922;--gh-blue:#58a6ff;',
      '--gh-purple:#a371f7;--gh-red:#f85149;--gh-gray:#9198a1;--gh-orange:#db6d28;--gh-pink:#db61a2;--gh-primary:#238636;--gh-primary-hover:#2ea043;--gh-on-primary:#fff;',
      '--gh-shadow:0 8px 24px rgba(1,4,9,.55);--gh-lbl-bg:.22;--gh-lbl-l:74%;--gh-lbl-s:80%;--gh-av-l:36%;',
      'color:var(--gh-fg);font-family:inherit}',
      'html[data-theme="light"] .gh-app,html[data-theme="light"] .gh-layer{--gh-muted:#57606a;--gh-raised:#ffffff;--gh-inset:#ffffff;--gh-overlay:#ffffff;',
      '--gh-line:var(--border2,#c1c3c5);--gh-line-soft:#d9dbe0;--gh-hover:rgba(31,35,40,.05);--gh-green:#116329;--gh-yellow:#7d4e00;--gh-blue:#0550ae;',
      '--gh-purple:#6639ba;--gh-red:#b42318;--gh-gray:#57606a;--gh-orange:#bc4c00;--gh-pink:#bf3989;--gh-primary:#1a7f37;--gh-primary-hover:#116329;',
      '--gh-shadow:0 8px 24px rgba(66,74,83,.2);--gh-lbl-bg:.14;--gh-lbl-l:27%;--gh-lbl-s:75%}',
      '.gh-app *,.gh-layer *{box-sizing:border-box}',
      '.gh-app [hidden],.gh-layer [hidden]{display:none !important}',
      '.gh-app{max-width:100%;min-width:0;margin-bottom:24px}',
      '.hrms-sc-root[data-sc="/employees/tasks"]{overflow-x:hidden}',
      '@media(max-width:720px){.hrms-sc-root[data-sc="/employees/tasks"]{padding:14px 12px !important}}',
      '.gh-sr{position:absolute !important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
      '.gh-ic{display:inline-block;vertical-align:text-bottom;flex:none}',
      '.gh-tone-green{color:var(--gh-green)}.gh-tone-yellow{color:var(--gh-yellow)}.gh-tone-blue{color:var(--gh-blue)}.gh-tone-purple{color:var(--gh-purple)}.gh-tone-red{color:var(--gh-red)}.gh-tone-gray{color:var(--gh-gray)}',
      '.gh-app :focus-visible,.gh-layer :focus-visible{outline:2px solid var(--gh-accent);outline-offset:1px}',
      /* buttons + inputs */
      '.gh-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:5px 12px;font:inherit;font-size:13px;font-weight:600;line-height:20px;border-radius:6px;border:1px solid var(--gh-line);background:var(--gh-raised);color:var(--gh-fg);cursor:pointer;white-space:nowrap;transition:background .12s,border-color .12s}',
      '.gh-btn:hover:not(:disabled){background:var(--gh-hover);border-color:var(--gh-muted)}',
      '.gh-btn:disabled{opacity:.55;cursor:not-allowed}',
      '.gh-btn-primary{background:var(--gh-primary);border-color:transparent;color:var(--gh-on-primary)}',
      '.gh-btn-primary:hover:not(:disabled){background:var(--gh-primary-hover);border-color:transparent}',
      '.gh-btn-danger{color:var(--gh-red)}',
      '.gh-btn-danger:hover:not(:disabled){background:var(--gh-red);border-color:var(--gh-red);color:#fff}',
      '.gh-btn-sm{min-height:28px;padding:3px 10px;font-size:12px}',
      '.gh-btn-invisible{background:transparent;border-color:transparent;color:var(--gh-muted)}',
      '.gh-btn-invisible:hover:not(:disabled){background:var(--gh-hover);border-color:transparent;color:var(--gh-fg)}',
      '.gh-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--gh-muted);cursor:pointer;flex:none}',
      '.gh-iconbtn:hover{background:var(--gh-hover);color:var(--gh-fg)}',
      '.gh-input,.gh-select,.gh-textarea{font:inherit;font-size:13px;color:var(--gh-fg);background:var(--gh-inset);border:1px solid var(--gh-line);border-radius:6px;padding:5px 10px;min-height:32px;outline:none;max-width:100%}',
      '.gh-select{padding-right:28px;cursor:pointer}',
      '.gh-select option{background:var(--gh-overlay);color:var(--gh-fg)}',
      '.gh-textarea{width:100%;min-height:96px;resize:vertical;line-height:1.5;padding:8px 10px}',
      '.gh-input:focus,.gh-select:focus,.gh-textarea:focus{border-color:var(--gh-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--gh-accent) 25%,transparent)}',
      '.gh-input::placeholder,.gh-textarea::placeholder{color:var(--gh-muted);opacity:.85}',
      /* header card */
      '.gh-header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px 16px;padding:14px 18px;background:var(--gh-canvas);border:1px solid var(--gh-line);border-radius:12px;margin-bottom:14px}',
      '.gh-title-group{display:flex;align-items:center;gap:12px;min-width:0}',
      '.gh-proj-icon{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:8px;background:color-mix(in srgb,var(--gh-accent) 15%,transparent);color:var(--gh-accent);flex:none}',
      '.gh-proj-title{font-size:16px;font-weight:700;margin:0;line-height:1.3;color:var(--gh-fg);overflow-wrap:anywhere}',
      '.gh-proj-sub{font-size:12px;color:var(--gh-muted);margin-top:2px}',
      '.gh-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.gh-actions .gh-select{min-width:150px;max-width:240px}',
      /* insights */
      '.gh-insight{padding:14px 16px 16px;margin:-4px 0 14px;background:var(--gh-canvas);border:1px solid var(--gh-line);border-radius:10px}',
      '.gh-ins-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}',
      '.gh-ins-head h3{display:flex;align-items:center;gap:8px;margin:0;font-size:14px;font-weight:700;color:var(--gh-fg);flex:1;min-width:0}',
      '.gh-ins-head h3 .gh-muted{font-weight:500;font-size:12px}',
      '.gh-ins-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:14px}',
      '.gh-ins-tiles .gh-stat{background:var(--gh-raised,var(--gh-canvas));border:1px solid var(--gh-line-soft);border-radius:8px;padding:10px 12px;text-align:left;font-family:inherit}',
      '.gh-stat b small{font-size:12px;color:var(--gh-muted);font-weight:600}',
      '.gh-stat-btn{cursor:pointer;display:flex;flex-direction:column;justify-content:flex-start;align-items:stretch}.gh-stat-btn:hover{border-color:var(--gh-line)}',
      '.gh-ins-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}',
      '.gh-ch{border:1px solid var(--gh-line-soft);border-radius:8px;padding:12px 14px;min-width:0;background:var(--gh-raised,var(--gh-canvas))}',
      '.gh-ch-wide{grid-column:1/-1}',
      '.gh-ch-h{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px}',
      '.gh-ch-h h4{margin:0;font-size:13px;font-weight:600;color:var(--gh-fg)}',
      '.gh-ch-legend{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--gh-muted)}',
      '.gh-ch-legend span{display:inline-flex;align-items:center;gap:5px}.gh-ch-legend i{width:10px;height:10px;border-radius:3px;display:inline-block}',
      '.gh-ch-svg{width:100%;height:auto;display:block;max-height:240px}',
      '.gh-ch-grid{stroke:var(--gh-line-soft);stroke-width:1}',
      '.gh-ch-tick{fill:var(--gh-muted);font-size:11px;font-family:inherit}',
      '.gh-ch-big{fill:var(--gh-fg);font-size:22px;font-weight:700;font-family:inherit}',
      '.gh-ch-line{fill:none;stroke-width:2.25;stroke-linejoin:round;stroke-linecap:round}',
      '.gh-ch-area-open{fill:color-mix(in srgb,var(--gh-green) 16%,transparent)}',
      '.gh-ch-area-done{fill:color-mix(in srgb,var(--gh-purple) 14%,transparent)}',
      '.gh-ch-hit{fill:transparent}.gh-ch-hit:hover{fill:color-mix(in srgb,var(--gh-fg) 6%,transparent)}',
      '.gh-ch-note{margin:6px 0 0;font-size:11px;color:var(--gh-muted)}',
      '.gh-ch-donutwrap{display:flex;align-items:center;gap:16px;flex-wrap:wrap}',
      '.gh-ch-donut{width:140px;height:140px;flex:none}',
      '.gh-ch-track{fill:none;stroke:var(--gh-line-soft);stroke-width:16}',
      '.gh-ch-arc{fill:none;stroke-width:16}',
      '.gh-ch-keys{display:flex;flex-direction:column;gap:2px;flex:1;min-width:140px}',
      '.gh-ch-key{display:flex;align-items:center;gap:8px;padding:5px 8px;border:0;background:none;border-radius:6px;font:inherit;font-size:13px;color:var(--gh-fg);cursor:pointer;text-align:left}',
      '.gh-ch-key:hover,.gh-ch-row:hover{background:var(--gh-hover)}',
      '.gh-ch-key i,.gh-ch-dot{width:10px;height:10px;border-radius:50%;display:inline-block;flex:none}',
      '.gh-ch-key span{flex:1}.gh-ch-key b{font-variant-numeric:tabular-nums}',
      '.gh-ch-bars{display:flex;flex-direction:column;gap:2px}',
      '.gh-ch-row{display:grid;grid-template-columns:minmax(90px,38%) 1fr 34px;align-items:center;gap:10px;padding:5px 6px;border:0;background:none;border-radius:6px;font:inherit;font-size:12.5px;color:var(--gh-fg);text-align:left;width:100%}',
      'button.gh-ch-row{cursor:pointer}',
      '.gh-ch-lbl{display:flex;align-items:center;gap:6px;min-width:0}',
      '.gh-ch-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.gh-ch-track2{display:flex;height:10px;border-radius:99px;background:var(--gh-line-soft);overflow:hidden}',
      '.gh-ch-track2 i{display:block;height:100%}',
      '.gh-ch-n{text-align:right;font-variant-numeric:tabular-nums}',
      '.gh-ch-empty{padding:18px;text-align:center;color:var(--gh-muted);font-size:13px}',
      '.gh-ch-key:focus-visible,.gh-ch-row:focus-visible,.gh-stat-btn:focus-visible{outline:2px solid var(--gh-accent);outline-offset:1px}',
      '@media(max-width:720px){.gh-ins-grid{grid-template-columns:1fr}.gh-ch-row{grid-template-columns:minmax(80px,40%) 1fr 30px}}',
      '.gh-insight[hidden]{display:none}',
      '.gh-stat{font-size:11px;font-weight:600;color:var(--gh-muted);text-transform:uppercase;letter-spacing:.5px}',
      '.gh-stat b{display:block;font-size:18px;color:var(--gh-fg);text-transform:none;letter-spacing:0;margin-top:2px}',
      '.gh-bar{height:8px;border-radius:99px;background:var(--gh-line-soft);overflow:hidden;margin-top:8px}',
      '.gh-bar>i{display:block;height:100%;background:var(--gh-green);border-radius:inherit}',
      /* toolbar */
      '.gh-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;border-bottom:1px solid var(--gh-line);padding-bottom:10px;margin-bottom:14px}',
      '.gh-tabs{display:flex;gap:4px}',
      '.gh-tab{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;font:inherit;font-size:13px;font-weight:600;color:var(--gh-muted);background:none;border:1px solid transparent;border-radius:6px;cursor:pointer}',
      '.gh-tab:hover{color:var(--gh-fg);background:var(--gh-hover)}',
      '.gh-tab[aria-selected="true"]{color:var(--gh-fg);background:var(--gh-canvas);border-color:var(--gh-line)}',
      '.gh-filters{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:1;justify-content:flex-end;min-width:0}',
      '.gh-seg{display:inline-flex;border:1px solid var(--gh-line);border-radius:6px;overflow:hidden;flex:none}',
      '.gh-seg button{display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:12.5px;font-weight:600;padding:5px 10px;border:0;background:var(--gh-raised);color:var(--gh-muted);cursor:pointer;min-height:30px}',
      '.gh-seg button+button{border-left:1px solid var(--gh-line)}',
      '.gh-seg button:hover{color:var(--gh-fg)}',
      '.gh-seg button[aria-pressed="true"]{background:color-mix(in srgb,var(--gh-accent) 16%,var(--gh-raised));color:var(--gh-fg)}',
      '.gh-seg .gh-n{font-weight:500;color:var(--gh-muted)}',
      '.gh-search{position:relative;flex:1 1 260px;min-width:180px;max-width:520px}',
      '.gh-search>.gh-ic{position:absolute;left:9px;top:50%;transform:translateY(-50%);color:var(--gh-muted);pointer-events:none}',
      '.gh-search .gh-input{width:100%;padding-left:30px;padding-right:30px}',
      '.gh-search .gh-iconbtn{position:absolute;right:3px;top:50%;transform:translateY(-50%);width:24px;height:24px}',
      '.gh-search .gh-iconbtn[hidden]{display:none}',
      '.gh-count-line{font-size:12px;color:var(--gh-muted);white-space:nowrap}',
      /* body */
      '.gh-body{position:relative;min-height:200px}',
      '.gh-body.gh-busy::after{content:"";position:absolute;left:0;right:0;top:-12px;height:2px;background:linear-gradient(90deg,transparent,var(--gh-accent),transparent);background-size:50% 100%;background-repeat:no-repeat;animation:gh-slide 1s linear infinite}',
      '@keyframes gh-slide{from{background-position:-50% 0}to{background-position:150% 0}}',
      '.gh-empty{padding:48px 16px;text-align:center;color:var(--gh-muted);font-size:13px;border:1px dashed var(--gh-line);border-radius:10px;background:var(--gh-canvas)}',
      '.gh-empty h3{margin:8px 0 4px;font-size:16px;color:var(--gh-fg)}',
      '.gh-empty .gh-btn{margin-top:12px}',
      '.gh-error{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 14px;border-radius:8px;border:1px solid color-mix(in srgb,var(--gh-red) 45%,transparent);background:color-mix(in srgb,var(--gh-red) 10%,transparent);color:var(--gh-fg);font-size:13px}',
      '.gh-skel{border-radius:8px;background:linear-gradient(90deg,var(--gh-line-soft) 25%,var(--gh-hover) 50%,var(--gh-line-soft) 75%);background-size:200% 100%;animation:gh-shimmer 1.2s ease-in-out infinite}',
      '@keyframes gh-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}',
      /* board */
      '.gh-board{display:flex;gap:12px;align-items:flex-start;overflow-x:auto;padding-bottom:10px;overscroll-behavior-x:contain}',
      '.gh-col{flex:1 0 250px;max-width:420px;min-width:240px;display:flex;flex-direction:column;background:var(--gh-canvas);border:1px solid var(--gh-line);border-radius:10px;max-height:calc(100vh - 230px);min-height:220px}',
      '.gh-col.is-over{border-color:var(--gh-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--gh-accent) 35%,transparent)}',
      '.gh-col-h{display:flex;align-items:center;gap:8px;padding:10px 10px 8px 12px;flex:none}',
      '.gh-dot{width:12px;height:12px;border-radius:50%;border:2px solid currentColor;flex:none}',
      '.gh-col-title{font-size:13px;font-weight:700;margin:0;color:var(--gh-fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.gh-count{display:inline-block;min-width:20px;padding:0 6px;font-size:12px;font-weight:600;line-height:18px;text-align:center;border-radius:99px;background:var(--gh-line-soft);color:var(--gh-fg)}',
      '.gh-col-hint{font-size:12px;color:var(--gh-muted);padding:0 12px 8px;margin-top:-4px}',
      '.gh-col-h .gh-iconbtn{margin-left:auto}',
      '.gh-col-body{flex:1;min-height:60px;overflow-y:auto;padding:2px 8px 8px;display:flex;flex-direction:column;gap:8px}',
      '.gh-col-empty{padding:18px 8px;text-align:center;font-size:12px;color:var(--gh-muted);border:1px dashed var(--gh-line);border-radius:8px}',
      '.gh-col-empty button{font:inherit;color:var(--gh-accent);background:none;border:0;cursor:pointer;padding:0;text-decoration:underline}',
      '.gh-col-f{padding:4px 8px 8px;flex:none}',
      '.gh-add{width:100%;justify-content:flex-start}',
      '.gh-qa{display:flex;flex-direction:column;gap:6px}',
      '.gh-qa .gh-input{width:100%}',
      '.gh-qa-hint{font-size:11px;color:var(--gh-muted)}',
      '.gh-col--collapsed{flex:0 0 52px;min-width:52px;max-width:52px;align-items:center;padding:8px 0;cursor:pointer}',
      '.gh-col--collapsed .gh-col-vert{writing-mode:vertical-rl;transform:rotate(180deg);display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;margin-top:10px;color:var(--gh-fg)}',
      '.gh-card{position:relative;background:var(--gh-raised);border:1px solid var(--gh-line);border-radius:8px;padding:10px 10px 9px 12px;cursor:pointer;transition:border-color .12s,box-shadow .12s;color:var(--gh-fg)}',
      '.gh-card:hover{border-color:color-mix(in srgb,var(--gh-accent) 55%,var(--gh-line))}',
      '.gh-card.is-dragging{opacity:.45}',
      '.gh-card.is-active{border-color:var(--gh-accent);box-shadow:0 0 0 1px var(--gh-accent)}',
      '.gh-card-top{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--gh-muted);min-height:20px}',
      '.gh-card-top .gh-iconbtn{margin-left:auto;width:24px;height:24px;margin-right:-4px;opacity:.75}',
      '.gh-card:hover .gh-card-top .gh-iconbtn,.gh-card:focus-within .gh-card-top .gh-iconbtn{opacity:1}',
      '.gh-ref{font-variant-numeric:tabular-nums;color:var(--gh-muted)}',
      '.gh-card-proj{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px}',
      '.gh-card-title{font-size:13.5px;font-weight:600;line-height:1.4;margin:4px 0 0;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
      '.gh-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}',
      '.gh-label{display:inline-flex;align-items:center;gap:4px;padding:0 8px;font-size:12px;font-weight:600;line-height:20px;border-radius:99px;white-space:nowrap;',
      'background:hsla(var(--h),70%,48%,var(--gh-lbl-bg));color:hsl(var(--h),var(--gh-lbl-s),var(--gh-lbl-l));border:1px solid hsla(var(--h),65%,55%,.45)}',
      '.gh-label button{border:0;background:none;color:inherit;cursor:pointer;padding:0;margin-right:-3px;display:inline-flex}',
      '.gh-pill{display:inline-flex;align-items:center;gap:4px;padding:0 8px;font-size:12px;font-weight:600;line-height:20px;border-radius:99px;border:1px solid color-mix(in srgb,currentColor 40%,transparent);background:color-mix(in srgb,currentColor 10%,transparent);white-space:nowrap}',
      '.gh-card-foot{display:flex;align-items:center;gap:10px;margin-top:9px;font-size:12px;color:var(--gh-muted);flex-wrap:wrap}',
      '.gh-card-foot .gh-meta{display:inline-flex;align-items:center;gap:4px}',
      '.gh-card-foot .gh-who{display:inline-flex;align-items:center;gap:6px;min-width:0;margin-right:auto;max-width:60%}',
      '.gh-card-foot .gh-who span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.gh-overdue{color:var(--gh-red);font-weight:600}',
      '.gh-progress{height:4px;border-radius:99px;background:var(--gh-line-soft);overflow:hidden;margin-top:9px}',
      '.gh-progress>i{display:block;height:100%;background:var(--gh-green)}',
      '.gh-av{display:inline-flex;align-items:center;justify-content:center;width:var(--sz,20px);height:var(--sz,20px);border-radius:50%;flex:none;background:hsl(var(--h,210),45%,var(--gh-av-l,36%));color:#fff;font-size:calc(var(--sz,20px) * .42);font-weight:700;letter-spacing:.2px}',
      '.gh-av--none{background:transparent;border:1px dashed var(--gh-muted)}',
      /* table */
      '.gh-bulk{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;margin-bottom:10px;border:1px solid color-mix(in srgb,var(--gh-accent) 45%,var(--gh-line));background:color-mix(in srgb,var(--gh-accent) 9%,var(--gh-canvas));border-radius:8px;font-size:13px}',
      '.gh-bulk[hidden]{display:none}',
      '.gh-bulk strong{margin-right:4px}',
      '.gh-tablewrap{border:1px solid var(--gh-line);border-radius:10px;background:var(--gh-canvas);overflow:auto;max-height:calc(100vh - 240px);-webkit-overflow-scrolling:touch}',
      '.gh-table{width:100%;min-width:960px;border-collapse:separate;border-spacing:0;font-size:13px}',
      '.gh-table th{position:sticky;top:0;z-index:2;background:var(--gh-canvas);text-align:left;font-size:12px;font-weight:600;color:var(--gh-muted);padding:0;border-bottom:1px solid var(--gh-line);white-space:nowrap}',
      '.gh-th-btn{display:flex;align-items:center;gap:4px;width:100%;font:inherit;font-weight:600;color:inherit;background:none;border:0;padding:9px 10px;cursor:pointer;text-align:left}',
      '.gh-th-btn:hover{color:var(--gh-fg)}',
      '.gh-th-btn .gh-arrow{font-size:10px;opacity:.85}',
      '.gh-table td{padding:6px 10px;border-bottom:1px solid var(--gh-line-soft);vertical-align:middle;color:var(--gh-fg);white-space:nowrap}',
      '.gh-table tr:last-child td{border-bottom:0}',
      '.gh-table tbody tr:hover td{background:var(--gh-hover)}',
      '.gh-table tbody tr.is-selected td{background:color-mix(in srgb,var(--gh-accent) 9%,transparent)}',
      '.gh-table .gh-c-check{width:40px;text-align:center;padding-left:12px;padding-right:4px}',
      '.gh-table th.gh-c-check{padding:9px 4px 9px 12px}',
      '.gh-table input[type=checkbox]{width:15px;height:15px;accent-color:var(--gh-accent);cursor:pointer}',
      '.gh-t-title{display:flex;align-items:center;gap:8px;min-width:280px;max-width:520px}',
      '.gh-titlelink{font:inherit;font-weight:600;color:var(--gh-fg);background:none;border:0;padding:0;cursor:pointer;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.gh-titlelink:hover{color:var(--gh-accent);text-decoration:underline}',
      '.gh-t-title .gh-label{flex:none}',
      '.gh-cellsel{font:inherit;font-size:13px;color:var(--gh-fg);background:transparent;border:1px solid transparent;border-radius:6px;padding:3px 6px;cursor:pointer;max-width:160px}',
      '.gh-cellsel:hover,.gh-cellsel:focus{border-color:var(--gh-line);background:var(--gh-inset)}',
      '.gh-cellsel option{background:var(--gh-overlay);color:var(--gh-fg)}',
      '.gh-cellbtn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:13px;color:var(--gh-fg);background:transparent;border:1px solid transparent;border-radius:6px;padding:3px 6px;cursor:pointer;max-width:200px}',
      '.gh-cellbtn:hover{border-color:var(--gh-line);background:var(--gh-inset)}',
      '.gh-cellbtn span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.gh-muted{color:var(--gh-muted)}',
      '.gh-celldate{font:inherit;font-size:13px;color:var(--gh-fg);background:transparent;border:1px solid transparent;border-radius:6px;padding:2px 4px;color-scheme:inherit}',
      '.gh-celldate:hover,.gh-celldate:focus{border-color:var(--gh-line);background:var(--gh-inset)}',
      '.gh-celldate.gh-overdue{color:var(--gh-red)}',
      '.gh-more{display:flex;align-items:center;justify-content:center;gap:12px;padding:12px;font-size:12.5px;color:var(--gh-muted)}',
      /* layers: popovers, dialogs, pane, toasts */
      '.gh-pop{position:fixed;z-index:100030;min-width:200px;max-width:min(320px,calc(100vw - 16px));max-height:min(380px,calc(100vh - 16px));overflow:auto;background:var(--gh-overlay);border:1px solid var(--gh-line);border-radius:10px;box-shadow:var(--gh-shadow);padding:6px;font-size:13px}',
      '.gh-menu-h{padding:6px 8px 4px;font-size:11px;font-weight:700;color:var(--gh-muted);text-transform:uppercase;letter-spacing:.5px}',
      '.gh-menu-sep{height:1px;background:var(--gh-line-soft);margin:6px 0}',
      '.gh-menu-item{display:flex;align-items:center;gap:8px;width:100%;font:inherit;font-size:13px;color:var(--gh-fg);background:none;border:0;border-radius:6px;padding:6px 8px;cursor:pointer;text-align:left}',
      '.gh-menu-item:hover,.gh-menu-item:focus{background:var(--gh-hover);outline:none}',
      '.gh-menu-item:focus-visible{box-shadow:inset 0 0 0 2px var(--gh-accent)}',
      '.gh-menu-item:disabled{opacity:.5;cursor:not-allowed}',
      '.gh-menu-item .gh-check{width:16px;flex:none;color:var(--gh-accent);font-weight:700}',
      '.gh-menu-item small{color:var(--gh-muted);margin-left:auto;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:55%}',
      '.gh-menu-item.gh-danger{color:var(--gh-red)}',
      '.gh-picker .gh-input{width:100%;margin-bottom:6px}',
      '.gh-picker-list{display:flex;flex-direction:column}',
      '.gh-pop.gh-picker-wide{max-width:min(420px,calc(100vw - 16px));width:420px}',
      '.gh-picker-empty{padding:10px 8px;color:var(--gh-muted);font-size:12.5px}',
      '.gh-backdrop{position:fixed;inset:0;background:rgba(1,4,9,.55)}',
      'html[data-theme="light"] .gh-backdrop{background:rgba(31,35,40,.38)}',
      '.gh-modal-wrap{position:fixed;inset:0;z-index:100020;display:flex;align-items:flex-start;justify-content:center;padding:6vh 16px 16px;overflow-y:auto}',
      '.gh-modal{position:relative;width:min(680px,100%);background:var(--gh-overlay);color:var(--gh-fg);border:1px solid var(--gh-line);border-radius:12px;box-shadow:var(--gh-shadow)}',
      '.gh-modal--sm{width:min(440px,100%)}',
      '.gh-modal-h{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;border-bottom:1px solid var(--gh-line-soft)}',
      '.gh-modal-h h3{margin:0;font-size:16px;font-weight:700}',
      '.gh-modal-b{padding:16px 18px;display:flex;flex-direction:column;gap:14px}',
      '.gh-modal-b p{margin:0;font-size:13.5px;line-height:1.5;color:var(--gh-fg)}',
      '.gh-modal-f{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid var(--gh-line-soft);flex-wrap:wrap}',
      '.gh-field{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.gh-field>label,.gh-field>.gh-flabel{font-size:12.5px;font-weight:600;color:var(--gh-fg)}',
      '.gh-field .gh-input,.gh-field .gh-select{width:100%}',
      '.gh-grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
      '.gh-req{color:var(--gh-red)}',
      '.gh-ferr{font-size:12px;color:var(--gh-red);min-height:0}',
      '.gh-formerr{padding:8px 12px;border-radius:6px;font-size:13px;border:1px solid color-mix(in srgb,var(--gh-red) 45%,transparent);background:color-mix(in srgb,var(--gh-red) 10%,transparent)}',
      '.gh-formerr[hidden]{display:none}',
      '.gh-labelpick{display:flex;flex-wrap:wrap;gap:6px}',
      '.gh-labelpick button{font:inherit;cursor:pointer;opacity:.7}',
      '.gh-labelpick button[aria-pressed="true"]{opacity:1;box-shadow:0 0 0 1px currentColor}',
      '.gh-combo{display:flex;align-items:center;gap:8px;width:100%;justify-content:flex-start;font-weight:500}',
      '.gh-combo .gh-ic:last-child{margin-left:auto;color:var(--gh-muted)}',
      '.gh-pane-wrap{position:fixed;inset:0;z-index:100010}',
      '.gh-pane{position:absolute;top:0;right:0;bottom:0;width:min(940px,100vw);display:flex;flex-direction:column;background:var(--gh-overlay);color:var(--gh-fg);border-left:1px solid var(--gh-line);box-shadow:var(--gh-shadow);animation:gh-in .16s ease-out}',
      '@keyframes gh-in{from{transform:translateX(24px);opacity:.4}to{transform:none;opacity:1}}',
      '.gh-pane-h{display:flex;align-items:center;gap:8px;padding:10px 14px 10px 18px;border-bottom:1px solid var(--gh-line-soft);font-size:12.5px;color:var(--gh-muted);flex:none}',
      '.gh-pane-h .gh-crumb{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.gh-pane-h .gh-sp{margin-left:auto}',
      '.gh-pane-scroll{flex:1;overflow-y:auto;min-height:0}',
      '.gh-pane-top{padding:16px 20px 12px;border-bottom:1px solid var(--gh-line-soft)}',
      '.gh-pane-title{display:flex;align-items:flex-start;gap:10px}',
      '.gh-pane-title h2{flex:1;margin:0;font-size:22px;font-weight:600;line-height:1.3;overflow-wrap:anywhere}',
      '.gh-pane-title h2 .gh-ref{font-weight:400;margin-left:6px}',
      '.gh-pane-title .gh-input{flex:1;font-size:16px}',
      '.gh-statebar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;font-size:13px;color:var(--gh-muted)}',
      '.gh-statebadge{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:99px;font-size:13px;font-weight:600;color:#fff}',
      '.gh-statebadge.is-open{background:var(--gh-primary)}',
      '.gh-statebadge.is-closed{background:#8250df}',
      'html[data-theme="light"] .gh-statebadge.is-closed{background:#6639ba}',
      '.gh-pane-grid{display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:0}',
      '.gh-pane-main{padding:16px 20px 24px;display:flex;flex-direction:column;gap:14px;min-width:0}',
      '.gh-pane-side{padding:14px 18px 24px;border-left:1px solid var(--gh-line-soft);display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.gh-sf{padding:10px 0;border-bottom:1px solid var(--gh-line-soft);display:flex;flex-direction:column;gap:6px;font-size:13px}',
      '.gh-sf:last-child{border-bottom:0}',
      '.gh-sf-h{display:flex;align-items:center;justify-content:space-between;font-size:12px;font-weight:600;color:var(--gh-muted)}',
      '.gh-sf .gh-select,.gh-sf .gh-input{width:100%;min-height:30px;font-size:12.5px}',
      '.gh-sf .gh-cellbtn{max-width:100%;padding:3px 4px;margin-left:-4px}',
      '.gh-sf-val{color:var(--gh-fg);overflow-wrap:anywhere}',
      '.gh-range{display:flex;align-items:center;gap:8px}',
      '.gh-range input[type=range]{flex:1;accent-color:var(--gh-green)}',
      '.gh-box{border:1px solid var(--gh-line);border-radius:8px;background:var(--gh-canvas);min-width:0}',
      '.gh-box-h{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--gh-line-soft);font-size:12.5px;color:var(--gh-muted);background:color-mix(in srgb,var(--gh-accent) 5%,transparent);border-radius:8px 8px 0 0;flex-wrap:wrap}',
      '.gh-box-h strong{color:var(--gh-fg)}',
      '.gh-box-h .gh-sp{margin-left:auto;display:inline-flex;gap:4px;align-items:center}',
      '.gh-box-b{padding:12px 14px;font-size:13.5px;line-height:1.55;overflow-wrap:anywhere}',
      '.gh-box-b .gh-textarea{min-height:140px}',
      '.gh-box-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:8px;flex-wrap:wrap}',
      '.gh-badge{padding:0 7px;border-radius:99px;font-size:11.5px;line-height:18px;border:1px solid var(--gh-line);color:var(--gh-muted);font-weight:600}',
      '.gh-md p{margin:0 0 6px}.gh-md p:last-child{margin-bottom:0}',
      '.gh-md h4,.gh-md h5,.gh-md h6{margin:10px 0 6px;font-size:14px}',
      '.gh-md ul,.gh-md ol{margin:4px 0 8px;padding-left:22px}',
      '.gh-md ul.gh-md-tasks{list-style:none;padding-left:4px}',
      '.gh-md code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;padding:1px 5px;border-radius:5px;background:var(--gh-line-soft)}',
      '.gh-md pre{margin:6px 0;padding:10px 12px;border-radius:6px;background:var(--gh-inset);border:1px solid var(--gh-line-soft);overflow:auto}',
      '.gh-md pre code{padding:0;background:none}',
      '.gh-md blockquote{margin:4px 0;padding:0 10px;border-left:3px solid var(--gh-line);color:var(--gh-muted)}',
      '.gh-md a{color:var(--gh-accent)}',
      '.gh-md hr{border:0;border-top:1px solid var(--gh-line);margin:10px 0}',
      '.gh-md-gap{height:6px}',
      '.gh-mention{font-weight:600;color:var(--gh-fg)}',
      '.gh-placeholder{color:var(--gh-muted);font-style:italic}',
      '.gh-timeline{display:flex;flex-direction:column;gap:12px}',
      '.gh-cmt{display:flex;gap:10px;align-items:flex-start}',
      '.gh-cmt .gh-box{flex:1}',
      '.gh-event{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--gh-muted);padding:0 0 0 8px}',
      '.gh-event .gh-evdot{width:24px;height:24px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:var(--gh-line-soft);color:var(--gh-fg);flex:none}',
      '.gh-event b{color:var(--gh-fg)}',
      '.gh-reacts{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 12px}',
      '.gh-react{display:inline-flex;align-items:center;gap:4px;font:inherit;font-size:12px;padding:1px 8px;border-radius:99px;border:1px solid var(--gh-line);background:transparent;color:var(--gh-fg);cursor:pointer;line-height:20px}',
      '.gh-react:hover{border-color:var(--gh-accent)}',
      '.gh-react.is-mine{background:color-mix(in srgb,var(--gh-accent) 14%,transparent);border-color:var(--gh-accent)}',
      '.gh-attach{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start}',
      '.gh-attach img{max-width:100%;max-height:220px;border-radius:6px;border:1px solid var(--gh-line)}',
      '.gh-attach a{color:var(--gh-accent);font-size:13px}',
      '.gh-warnbox{padding:8px 12px;border-radius:6px;font-size:13px;border:1px solid color-mix(in srgb,var(--gh-yellow) 50%,transparent);background:color-mix(in srgb,var(--gh-yellow) 10%,transparent)}',
      '.gh-composer .gh-box-b{display:flex;flex-direction:column;gap:8px}',
      '.gh-pane-foot{display:flex;gap:8px;flex-wrap:wrap;padding-top:6px}',
      '.gh-toasts{position:fixed;left:16px;bottom:16px;z-index:100040;display:flex;flex-direction:column;gap:8px;max-width:min(420px,calc(100vw - 32px))}',
      '.gh-toast{display:flex;align-items:center;gap:8px;padding:10px 8px 10px 14px;border-radius:8px;background:var(--gh-overlay);color:var(--gh-fg);border:1px solid var(--gh-line);border-left:4px solid var(--gh-green);box-shadow:var(--gh-shadow);font-size:13px;animation:gh-in .16s ease-out}',
      '.gh-toast--err{border-left-color:var(--gh-red)}',
      '.gh-toast-msg{flex:1;line-height:1.4}',
      '.gh-kbd{font-family:ui-monospace,Consolas,monospace;font-size:11px;padding:0 5px;border:1px solid var(--gh-line);border-bottom-width:2px;border-radius:4px;color:var(--gh-muted)}',
      '.gh-hint{font-size:12px;color:var(--gh-muted);margin-top:10px;display:flex;gap:12px;flex-wrap:wrap}',
      /* markdown: richer blocks */
      '.gh-md h1,.gh-md h2{font-size:1.35em;font-weight:600;margin:14px 0 8px;padding-bottom:.25em;border-bottom:1px solid var(--gh-line-soft)}',
      '.gh-md h3{font-size:1.15em;font-weight:600;margin:12px 0 6px}',
      '.gh-md>:first-child{margin-top:0}',
      '.gh-md li.gh-md-task{list-style:none;margin-left:-18px}',
      '.gh-md li.gh-md-task>input{margin:0 6px 0 0;vertical-align:middle;width:14px;height:14px;accent-color:var(--gh-accent)}',
      '.gh-md .gh-md-cb[data-task]{cursor:pointer}',
      '.gh-md img{max-width:100%;height:auto;border-radius:6px;vertical-align:middle}',
      '.gh-md del{opacity:.8}',
      '.gh-md-table{overflow-x:auto;margin:8px 0}',
      '.gh-md table{border-collapse:collapse;font-size:13px}',
      '.gh-md th,.gh-md td{border:1px solid var(--gh-line);padding:5px 10px;text-align:left}',
      '.gh-md th{font-weight:600;background:var(--gh-canvas)}',
      '.gh-md .gh-mention{padding:0 3px;border-radius:5px;background:color-mix(in srgb,var(--gh-accent) 14%,transparent)}',
      /* markdown editor */
      '.gh-mde{border:1px solid var(--gh-line);border-radius:8px;background:var(--gh-inset);min-width:0;transition:border-color .12s,box-shadow .12s}',
      '.gh-mde:focus-within{border-color:var(--gh-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--gh-accent) 22%,transparent)}',
      '.gh-mde.is-drag{border-style:dashed;border-color:var(--gh-accent);background:color-mix(in srgb,var(--gh-accent) 6%,var(--gh-inset))}',
      '.gh-mde-head{display:flex;align-items:flex-end;justify-content:space-between;gap:4px 8px;flex-wrap:wrap;padding:6px 8px 0;border-bottom:1px solid var(--gh-line);background:var(--gh-canvas);border-radius:8px 8px 0 0}',
      '.gh-mde-tabs{display:flex;gap:2px;margin-bottom:-1px}',
      '.gh-mde-tab{font:inherit;font-size:13px;padding:6px 14px;border:1px solid transparent;border-bottom:0;border-radius:6px 6px 0 0;background:none;color:var(--gh-muted);cursor:pointer}',
      '.gh-mde-tab:hover{color:var(--gh-fg)}',
      '.gh-mde-tab[aria-selected="true"]{background:var(--gh-inset);border-color:var(--gh-line);color:var(--gh-fg);font-weight:600}',
      '.gh-mde-tools{display:flex;align-items:center;flex-wrap:wrap;padding-bottom:4px}',
      '.gh-mde-tool{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;background:none;color:var(--gh-muted);border-radius:6px;cursor:pointer}',
      '.gh-mde-tool:hover,.gh-mde-tool:focus-visible{background:var(--gh-hover);color:var(--gh-fg)}',
      '.gh-mde-sep{width:1px;height:16px;background:var(--gh-line);margin:0 4px}',
      '.gh-mde-ta.gh-textarea{display:block;border:0;border-radius:0;box-shadow:none;background:transparent;font-size:14px;padding:10px 12px}',
      '.gh-mde-ta.gh-textarea:focus{box-shadow:none;border:0}',
      '.gh-mde .gh-mde-ta:focus-visible{outline:none}',
      '.gh-mde-drop{display:flex;align-items:center;gap:6px;padding:7px 12px;font-size:12.5px;color:var(--gh-muted);border-top:1px dashed var(--gh-line);cursor:pointer;border-radius:0 0 8px 8px;position:relative}',
      '.gh-mde-drop:hover{color:var(--gh-fg);background:var(--gh-hover)}',
      '.gh-mde-drop:focus-within{outline:2px solid var(--gh-accent);outline-offset:-2px}',
      '.gh-mde-preview{padding:10px 12px;font-size:14px;line-height:1.55;overflow-wrap:anywhere;min-height:120px}',
      '.gh-ac{min-width:240px;max-width:min(380px,calc(100vw - 16px))}',
      '.gh-ac .gh-menu-item[aria-selected="true"]{background:color-mix(in srgb,var(--gh-accent) 18%,transparent)}',
      '.gh-ac .gh-ac-t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.gh-ac .gh-menu-item{cursor:pointer}',
      /* new issue dialog */
      '.gh-ni{width:min(880px,100%);display:flex;flex-direction:column}',
      '.gh-ni-h{display:flex;align-items:center;gap:6px;padding:10px 12px;border-bottom:1px solid var(--gh-line-soft)}',
      '.gh-ni-h h3{flex:1;margin:0;font-size:14px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.gh-ni-b{padding:16px;display:flex;flex-direction:column;gap:12px;flex:1}',
      '.gh-ni-title.gh-input{width:100%;font-size:16px;min-height:40px;padding:8px 12px}',
      '.gh-ni-chips{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.gh-chip{display:inline-flex;align-items:center;gap:6px;max-width:280px;min-height:28px;padding:2px 10px;font:inherit;font-size:12.5px;font-weight:500;color:var(--gh-muted);background:transparent;border:1px dashed var(--gh-line);border-radius:99px;cursor:pointer}',
      '.gh-chip:hover:not(:disabled){color:var(--gh-fg);border-color:var(--gh-muted);background:var(--gh-hover)}',
      '.gh-chip.is-set{border-style:solid;color:var(--gh-fg)}',
      '.gh-chip.is-solid{border-style:solid;background:var(--gh-raised);color:var(--gh-fg)}',
      '.gh-chip>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-flex;align-items:center;gap:4px;min-width:0}',
      '.gh-chip:disabled{opacity:.5;cursor:not-allowed}',
      '.gh-chip--icon{padding:2px 6px}',
      '.gh-ni-f{display:flex;align-items:center;gap:8px;padding:12px 16px;border-top:1px solid var(--gh-line-soft);flex-wrap:wrap}',
      '.gh-ni-f .gh-sp{flex:1}',
      '.gh-check-lbl{display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;color:var(--gh-fg)}',
      '.gh-check-lbl input{accent-color:var(--gh-accent);width:15px;height:15px;margin:0}',
      '.gh-kbd-inv{font-size:11px;opacity:.85;font-weight:500}',
      '.gh-ni-att{display:flex;flex-wrap:wrap;gap:6px}',
      '.gh-filechip{display:inline-flex;align-items:center;gap:6px;padding:2px 2px 2px 10px;border:1px solid var(--gh-line);border-radius:6px;font-size:12.5px;background:var(--gh-canvas);max-width:100%}',
      '.gh-filechip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.gh-lbl-dot{width:12px;height:12px;border-radius:50%;flex:none;background:hsl(var(--h),65%,52%)}',
      '.gh-datepop{padding:8px;min-width:220px}.gh-datepop .gh-input{width:100%}',
      /* header: project picker + info */
      '.gh-title-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
      '.gh-projbtn{min-width:170px;max-width:280px;justify-content:flex-start}',
      '.gh-projbtn>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.gh-projempty{display:flex;align-items:center;justify-content:space-between;gap:10px 16px;flex-wrap:wrap;padding:12px 16px;margin:-4px 0 14px;border:1px dashed var(--gh-line);border-radius:10px;background:var(--gh-canvas);font-size:13px;color:var(--gh-muted)}',
      '.gh-projempty b{color:var(--gh-fg)}',
      /* project panel */
      '.gh-pp{width:min(560px,100vw)}',
      '.gh-pp-h{display:flex;align-items:center;gap:8px;padding:12px 12px 12px 18px;border-bottom:1px solid var(--gh-line-soft);flex:none}',
      '.gh-pp-h h2{margin:0;font-size:18px;font-weight:600;flex:1;min-width:0;overflow-wrap:anywhere;line-height:1.3}',
      '.gh-pp-h .gh-proj-icon{width:28px;height:28px}',
      '.gh-iconbtn[aria-pressed="true"]{color:var(--gh-accent);background:color-mix(in srgb,var(--gh-accent) 12%,transparent)}',
      '.gh-pp-b{padding:16px 20px 28px;display:flex;flex-direction:column;gap:18px}',
      '.gh-pp-sh{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;min-height:28px}',
      '.gh-pp-sh h3{margin:0;font-size:14px;font-weight:600;display:inline-flex;align-items:center;gap:6px}',
      '.gh-pp-text{margin:0;font-size:14px;line-height:1.5;overflow-wrap:anywhere}',
      '.gh-pp-empty{margin:0;font-size:13.5px;color:var(--gh-muted);line-height:1.5}',
      '.gh-pp-row{display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap}.gh-pp-row .gh-sp{flex:1}',
      '.gh-w100{width:100%}',
      '.gh-counter{font-size:11.5px;color:var(--gh-muted)}',
      '.gh-counter.is-over{color:var(--gh-red);font-weight:600}',
      '.gh-pp-div{border:0;border-top:1px solid var(--gh-line);margin:0}',
      '.gh-pp-readme{font-size:14px;line-height:1.55;overflow-wrap:anywhere}',
      '.gh-su-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;padding:26px 18px;border:1px solid var(--gh-line);border-radius:10px;background:var(--gh-canvas)}',
      '.gh-su-ic{width:40px;height:40px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--gh-line);color:var(--gh-muted);background:var(--gh-inset)}',
      '.gh-su-empty h4{margin:4px 0 0;font-size:15px;font-weight:600}',
      '.gh-su-empty p{margin:0;font-size:13px;color:var(--gh-muted);max-width:400px;line-height:1.5}',
      '.gh-su-acts{display:flex;align-items:center;gap:14px;flex-wrap:wrap;justify-content:center;margin-top:6px}',
      '.gh-linkbtn{font:inherit;font-size:13px;color:var(--gh-accent);background:none;border:0;padding:0;cursor:pointer}',
      '.gh-linkbtn:hover{text-decoration:underline}',
      '.gh-su-list{display:flex;flex-direction:column;gap:12px}',
      '.gh-su-dates{display:flex;align-items:center;gap:6px;padding:8px 14px 0;font-size:12.5px;color:var(--gh-muted)}',
      '.gh-su-form{display:flex;flex-direction:column;gap:12px;padding:14px;border:1px solid var(--gh-line);border-radius:10px;background:var(--gh-canvas);margin-bottom:12px}',
      '.gh-su-fh{margin:0;font-size:14px;font-weight:600}',
      '.gh-su-st{display:flex;flex-wrap:wrap;gap:8px;border:0;margin:0;padding:0;min-width:0}',
      '.gh-su-st legend{font-size:12.5px;font-weight:600;margin-bottom:8px;padding:0}',
      '.gh-su-st label{position:relative;cursor:pointer;display:inline-flex}',
      '.gh-su-st input{position:absolute;opacity:0;width:1px;height:1px;margin:0}',
      '.gh-su-st .gh-pill{line-height:24px;padding:0 10px}',
      '.gh-su-st input:checked+.gh-pill{box-shadow:0 0 0 2px currentColor;background:color-mix(in srgb,currentColor 18%,transparent)}',
      '.gh-su-st input:focus-visible+.gh-pill{outline:2px solid var(--gh-accent);outline-offset:3px}',
      '.gh-pp-meta{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:13px;margin:0}',
      '.gh-pp-meta dt{color:var(--gh-muted)}.gh-pp-meta dd{margin:0;overflow-wrap:anywhere}',
      '.gh-help{max-width:340px;padding:12px 14px;font-size:13px;line-height:1.5}',
      '.gh-help-h{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}',
      '.gh-help p{margin:0 0 8px}.gh-help ul{margin:0;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:4px}',
      '.gh-teampick{display:flex;flex-wrap:wrap;gap:6px}',
      '.gh-teampick button{font:inherit;font-size:12.5px;padding:2px 10px;border-radius:99px;border:1px solid var(--gh-line);background:transparent;color:var(--gh-muted);cursor:pointer;min-height:26px}',
      '.gh-teampick button[aria-pressed="true"]{color:var(--gh-fg);border-color:var(--gh-accent);background:color-mix(in srgb,var(--gh-accent) 14%,transparent)}',
      /* view tabs */
      '.gh-vtabs{display:flex;align-items:flex-end;gap:2px;flex-wrap:wrap;min-width:0}',
      '.gh-vtab-w{display:inline-flex;align-items:center;border-radius:6px 6px 0 0;border:1px solid transparent;border-bottom:0}',
      '.gh-vtab-w.is-active{background:var(--gh-canvas);border-color:var(--gh-line)}',
      '.gh-vtab-w .gh-tab{border:0;background:none;border-radius:6px 0 0 6px}','.gh-vtabs .gh-tab{white-space:nowrap;flex:none}.gh-vtab-w{flex:none}',
      '.gh-vtab-w.is-active .gh-tab{color:var(--gh-fg)}',
      '.gh-vtab-w .gh-iconbtn{width:24px;height:24px;margin-right:4px}',
      '.gh-dirtydot{width:8px;height:8px;border-radius:50%;background:var(--gh-accent);display:inline-block;margin-left:2px}',
      '.gh-newview{color:var(--gh-muted)}',
      /* field table (GitHub Projects table layout) */
      '.gh-ftable{table-layout:fixed;border-collapse:separate;border-spacing:0;font-size:13px;min-width:0}',
      '.gh-ftable th{position:sticky;top:0;z-index:3;background:var(--gh-canvas);text-align:left;font-size:12px;font-weight:600;color:var(--gh-muted);padding:0;border-bottom:1px solid var(--gh-line);border-right:1px solid var(--gh-line-soft);white-space:nowrap;height:36px}',
      '.gh-ftable td{padding:0 8px;height:38px;border-bottom:1px solid var(--gh-line-soft);border-right:1px solid var(--gh-line-soft);vertical-align:middle;color:var(--gh-fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:var(--gh-canvas)}',
      '.gh-ftable tbody tr:hover td{background:linear-gradient(var(--gh-hover),var(--gh-hover)),var(--gh-canvas)}',
      '.gh-ftable tbody tr.is-selected td{background:linear-gradient(color-mix(in srgb,var(--gh-accent) 10%,transparent),color-mix(in srgb,var(--gh-accent) 10%,transparent)),var(--gh-canvas)}',
      '.gh-th{display:flex;align-items:center;min-width:0;height:36px;padding-right:8px}',
      '.gh-th .gh-th-btn{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;padding:9px 8px}',
      '.gh-th .gh-iconbtn{width:24px;height:24px;opacity:0;flex:none}',
      '.gh-ftable th:hover .gh-th .gh-iconbtn,.gh-th .gh-iconbtn:focus-visible,.gh-th .gh-iconbtn[aria-expanded="true"]{opacity:1}',
      '@media(hover:none){.gh-th .gh-iconbtn{opacity:1}}',
      '.gh-ftable th{position:sticky}',
      '.gh-resize{position:absolute;top:0;right:0;width:8px;height:100%;cursor:col-resize;z-index:4;touch-action:none}',
      '.gh-resize:hover,.gh-resize:focus-visible,.gh-resize.is-active{background:linear-gradient(90deg,transparent 5px,var(--gh-accent) 5px,var(--gh-accent) 7px,transparent 7px);outline:none}',
      '.gh-c-num{text-align:right;color:var(--gh-muted);font-variant-numeric:tabular-nums}',
      '.gh-ftable td.gh-c-num{padding:0 8px 0 6px}',
      '.gh-numcell{display:flex;align-items:center;justify-content:space-between;gap:4px}',
      '.gh-numcell input{opacity:0}',
      '.gh-ftable tr:hover .gh-numcell input,.gh-numcell input:checked,.gh-numcell input:focus-visible,.gh-ftable.has-sel .gh-numcell input{opacity:1}',
      '.gh-c-title .gh-t-title{min-width:0;max-width:none}',
      '.gh-c-plus{width:44px;text-align:center}',
      '.gh-c-plus .gh-iconbtn{margin:0 auto}',
      '.gh-cell{display:flex;align-items:center;gap:6px;width:100%;min-width:0;height:30px;font:inherit;font-size:13px;color:var(--gh-fg);background:transparent;border:1px solid transparent;border-radius:6px;padding:0 6px;margin:0 -6px;cursor:pointer;text-align:left;overflow:hidden}',
      '.gh-cell:hover{border-color:var(--gh-line)}',
      '.gh-cell.is-ro{cursor:default}.gh-cell.is-ro:hover{border-color:transparent}',
      '.gh-ellip{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.gh-cellchips{display:flex;gap:4px;overflow:hidden}',
      '.gh-num{font-variant-numeric:tabular-nums}',
      '.gh-dot--sm{width:8px;height:8px;border-width:2px;margin-right:2px}',
      '.gh-subprog{display:inline-flex;align-items:center;gap:8px;min-width:0;width:100%}',
      '.gh-subprog .gh-bar{flex:1;margin:0;min-width:40px}',
      '.gh-bar--sm{height:6px}',
      '.gh-grp td{background:var(--gh-raised) !important;font-weight:600;height:34px}',
      '.gh-grp-h{display:inline-flex;align-items:center;gap:8px;position:sticky;left:12px}',
      '.gh-addrow td{background:var(--gh-canvas)}',
      '.gh-addrow-in{display:flex;align-items:center;gap:8px;color:var(--gh-muted);position:sticky;left:12px;max-width:min(520px,80vw)}',
      '.gh-addrow-in input{flex:1;min-width:0;font:inherit;font-size:13px;color:var(--gh-fg);background:transparent;border:1px solid transparent;border-radius:6px;padding:5px 8px;outline:none}',
      '.gh-addrow-in input:focus{border-color:var(--gh-accent);background:var(--gh-inset)}',
      '.gh-addrow-in input::placeholder{color:var(--gh-muted)}',
      '@media(min-width:721px){',
      '.gh-ftable .gh-c-num{position:sticky;left:0;z-index:2}',
      '.gh-ftable .gh-c-title{position:sticky;left:var(--numw,64px);z-index:2;box-shadow:1px 0 0 var(--gh-line)}',
      '.gh-ftable th.gh-c-num,.gh-ftable th.gh-c-title{z-index:5}',
      '}',
      /* single-select option colours */
      '.gh-opt{display:inline-flex;align-items:center;padding:0 8px;font-size:12px;font-weight:600;line-height:20px;border-radius:99px;white-space:nowrap;border:1px solid color-mix(in srgb,var(--c) 45%,transparent);background:color-mix(in srgb,var(--c) 16%,transparent);color:var(--gh-fg)}',
      '.gh-opt-gray{--c:var(--gh-gray)}.gh-opt-blue{--c:var(--gh-blue)}.gh-opt-green{--c:var(--gh-green)}.gh-opt-yellow{--c:var(--gh-yellow)}',
      '.gh-opt-orange{--c:var(--gh-orange)}.gh-opt-red{--c:var(--gh-red)}.gh-opt-pink{--c:var(--gh-pink)}.gh-opt-purple{--c:var(--gh-purple)}',
      '.gh-swatch{width:12px;height:12px;border-radius:50%;flex:none;background:var(--c);display:inline-block}',
      /* add-field + dialogs */
      '.gh-fieldpop{min-width:260px}',
      '.gh-li-row{display:flex;align-items:center;gap:2px}',
      '.gh-li-row>.gh-menu-item:first-child{flex:1;min-width:0}',
      '.gh-li-more.gh-menu-item{width:30px;flex:none;justify-content:center;padding:6px 0;opacity:0;transition:opacity .12s}',
      '.gh-li-row:hover .gh-li-more,.gh-li-row:focus-within .gh-li-more,.gh-li-row.gh-li-open .gh-li-more{opacity:1}',
      '.gh-li-row.gh-li-open>.gh-menu-item:first-child{background:var(--gh-hover,rgba(127,127,127,.12))}',
      '@media (hover:none){.gh-li-more.gh-menu-item{opacity:1}}',
      '.gh-flyout{min-width:200px}',
      '.gh-checklist{display:flex;flex-direction:column;gap:2px;max-height:300px;overflow:auto;border:1px solid var(--gh-line);border-radius:8px;padding:6px}',
      '.gh-checklist label{display:flex;align-items:flex-start;gap:10px;padding:7px 8px;border-radius:6px;cursor:pointer;font-size:13.5px}',
      '.gh-checklist label:hover{background:var(--gh-hover)}',
      '.gh-checklist input{margin-top:2px;width:16px;height:16px;accent-color:var(--gh-accent);flex:none}',
      '.gh-checklist small{display:block;color:var(--gh-muted);font-size:12px;margin-top:1px}',
      '.gh-optrow{display:flex;align-items:center;gap:8px}',
      '.gh-optrow .gh-input{flex:1;min-width:0}',
      '.gh-optrow .gh-select{width:120px;flex:none}',
      '.gh-optlist{display:flex;flex-direction:column;gap:8px}',
      /* roadmap */
      '.gh-rm-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}',
      '.gh-rm-wrap{display:grid;grid-template-columns:minmax(0,1fr) 240px;gap:12px;align-items:start}',
      '.gh-rm-main{border:1px solid var(--gh-line);border-radius:10px;background:var(--gh-canvas);overflow:auto;max-height:calc(100vh - 250px);position:relative}',
      '.gh-rm-grid{position:relative;--rml:240px}',
      '.gh-rm-head,.gh-rm-row{display:flex;min-width:100%}',
      '.gh-rm-head{position:sticky;top:0;z-index:7;background:var(--gh-canvas);border-bottom:1px solid var(--gh-line);height:34px}',
      '.gh-rm-l{position:sticky;left:0;z-index:6;flex:none;width:var(--rml,240px);display:flex;align-items:center;gap:8px;padding:0 10px;background:var(--gh-canvas);border-right:1px solid var(--gh-line);min-width:0}',
      '.gh-rm-head .gh-rm-l{font-size:12px;font-weight:600;color:var(--gh-muted)}',
      '.gh-rm-t{position:relative;flex:none;height:36px}',
      '.gh-rm-head .gh-rm-t{height:34px}',
      '.gh-rm-tick{position:absolute;top:0;bottom:0;border-left:1px solid var(--gh-line-soft);font-size:11.5px;color:var(--gh-muted);padding:9px 0 0 6px;white-space:nowrap}',
      '.gh-rm-row{border-bottom:1px solid var(--gh-line-soft)}',
      '.gh-rm-row:hover .gh-rm-l,.gh-rm-row:hover .gh-rm-t{background:linear-gradient(var(--gh-hover),var(--gh-hover)),var(--gh-canvas)}',
      '.gh-rm-l{font-size:13px}.gh-rm-l .gh-titlelink{font-weight:500;font-size:13px}',
      '.gh-rm-b{position:absolute;top:7px;height:22px;border-radius:6px;background:color-mix(in srgb,var(--gh-accent) 30%,var(--gh-raised));border:1px solid color-mix(in srgb,var(--gh-accent) 70%,transparent);color:var(--gh-fg);font-size:12px;display:flex;align-items:center;cursor:grab;touch-action:none;min-width:8px;user-select:none}',
      '.gh-rm-b.is-fb{border-style:dashed;background:color-mix(in srgb,var(--gh-accent) 14%,var(--gh-raised))}',
      '.gh-rm-b.is-closed{background:color-mix(in srgb,var(--gh-purple) 28%,var(--gh-raised));border-color:color-mix(in srgb,var(--gh-purple) 65%,transparent)}',
      '.gh-rm-b.is-drag{cursor:grabbing;box-shadow:0 0 0 2px var(--gh-accent)}',
      '.gh-rm-b:focus-visible{outline:2px solid var(--gh-accent);outline-offset:2px}',
      '.gh-rm-lbl{padding:0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none;flex:1;min-width:0}',
      '.gh-rm-h{width:8px;align-self:stretch;cursor:ew-resize;flex:none;border-radius:6px}',
      '.gh-rm-h:hover{background:color-mix(in srgb,var(--gh-accent) 45%,transparent)}',
      '.gh-rm-today{position:absolute;top:0;bottom:0;width:2px;background:var(--gh-red);z-index:5;pointer-events:none}',
      '.gh-rm-today span{position:absolute;top:36px;left:4px;font-size:10.5px;font-weight:700;color:var(--gh-red);white-space:nowrap}',
      '.gh-rm-side{border:1px solid var(--gh-line);border-radius:10px;background:var(--gh-canvas);padding:10px;max-height:calc(100vh - 250px);overflow:auto}',
      '.gh-rm-side h4{margin:0 0 4px;font-size:13px;display:flex;align-items:center;gap:6px}',
      '.gh-rm-side p{margin:0 0 8px;font-size:12px;color:var(--gh-muted);line-height:1.45}',
      '.gh-rm-side ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}',
      '.gh-rm-side li{display:flex;align-items:center;gap:6px;padding:4px 2px;font-size:13px;min-width:0}',
      '.gh-rm-tip{font-size:12px;color:var(--gh-muted)}',
      /* danger zone */
      '.gh-dz{border:1px solid color-mix(in srgb,var(--gh-red) 45%,var(--gh-line));border-radius:10px}',
      '.gh-dz-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;flex-wrap:wrap}',
      '.gh-dz-row+.gh-dz-row{border-top:1px solid var(--gh-line-soft)}',
      '.gh-dz-row b{font-size:13.5px}.gh-dz-row p{margin:2px 0 0;font-size:12.5px;color:var(--gh-muted);max-width:340px;line-height:1.45}',
      '.gh-cedit{display:flex;flex-direction:column;gap:8px}',
      /* responsive */
      '@media(max-width:900px){.gh-pane-grid{grid-template-columns:1fr}.gh-pane-side{border-left:0;border-top:1px solid var(--gh-line-soft)}.gh-rm-wrap{grid-template-columns:1fr}}',
      '@media(max-width:720px){.gh-rm-grid{--rml:150px}.gh-vtabs{flex-wrap:nowrap;overflow-x:auto;max-width:100%}.gh-tabs{max-width:100%;overflow-x:auto}}',
      '@media(max-width:720px){',
      '.gh-header{padding:12px}.gh-actions{width:100%}.gh-actions .gh-select{flex:1 1 140px;max-width:none;min-width:0}',
      '.gh-actions .gh-btn-primary{flex:1 1 100%}',
      '.gh-filters{justify-content:flex-start;flex:1 1 100%}.gh-search{flex-basis:100%;max-width:none}',
      '.gh-seg{flex:1 1 100%}.gh-seg button{flex:1;justify-content:center;padding:5px 6px}',
      '.gh-board{scroll-snap-type:x mandatory;gap:10px;margin:0 -12px;padding:0 12px 10px;scroll-padding:0 12px}',
      '.gh-col{flex:0 0 84vw;max-width:84vw;min-width:0;scroll-snap-align:start;max-height:none}',
      '.gh-col--collapsed{flex:0 0 52px;max-width:52px}',
      '.gh-grid2{grid-template-columns:1fr}',
      '.gh-pane-title h2{font-size:18px}',
      '.gh-modal-wrap{padding:0;align-items:stretch}.gh-modal{border-radius:0;min-height:100%}',
      '.gh-modal--sm{min-height:0;margin:auto 12px;border-radius:12px}',
      '.gh-hint{display:none}',
      '.gh-projbtn{flex:1 1 100%;max-width:none}',
      '.gh-ni-b{padding:12px}.gh-ni-f{padding:10px 12px}.gh-chip{max-width:100%}',
      '.gh-pp-b{padding:14px 14px 24px}',
      '}'
    ].join('\n');
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ── page shell ──────────────────────────────────────────────────────── */
  function renderShell() {
    var r = S.root;
    r.innerHTML = [
      '<div class="gh-app">',
      '<div class="gh-header">',
      '  <div class="gh-title-group"><span class="gh-proj-icon">' + svg(P.board, 18) + '</span>',
      '    <div style="min-width:0"><div class="gh-title-row"><h2 class="gh-proj-title" data-ref="title">All Projects</h2><span data-ref="tpill"></span>',
      '    <button type="button" class="gh-iconbtn" data-act="projinfo" data-ref="infoBtn" aria-label="Project details, README and status updates" title="Project details" hidden>' + svg(P.info, 16) + '</button></div>',
      '    <div class="gh-proj-sub" data-ref="sub">Eversoft HRMS Issue &amp; Project Tracking</div></div></div>',
      '  <div class="gh-actions">',
      '    <button type="button" class="gh-btn gh-combo gh-projbtn" data-act="projpick" data-ref="proj" aria-haspopup="dialog"></button>',
      '    <label class="gh-sr" for="gh-team">Team</label><select id="gh-team" class="gh-select" data-ref="team"></select>',
      '    <button type="button" class="gh-btn" data-act="insights" data-ref="insBtn" aria-pressed="false" hidden>' + svg(P.graph, 14) + ' Insights</button>',
      '    <button type="button" class="gh-btn gh-btn-primary" data-act="new" data-ref="newBtn" title="New issue (n)">' + svg(P.plus, 14) + ' New issue</button>',
      '  </div>',
      '</div>',
      '<div class="gh-projempty" data-ref="projEmpty" hidden></div>',
      '<div class="gh-insight" data-ref="insight" hidden></div>',
      '<div class="gh-toolbar">',
      '  <div class="gh-tabs gh-vtabs" role="tablist" aria-label="Views" data-ref="tabs"></div>',
      '  <div class="gh-filters">',
      '    <div class="gh-seg" role="group" aria-label="Issue state" data-ref="seg"></div>',
      '    <div class="gh-search">' + svg(P.search, 14),
      '      <input type="search" class="gh-input" data-ref="q" placeholder="Filter by keyword or by field (assignee:me priority:high)" aria-label="Filter items" autocomplete="off" spellcheck="false">',
      '      <button type="button" class="gh-iconbtn" data-act="clearq" data-ref="qClear" aria-label="Clear filter" hidden>' + svg(P.x, 14) + '</button>',
      '    </div>',
      '    <button type="button" class="gh-btn" data-act="viewmenu" data-ref="viewBtn" aria-haspopup="menu">' + svg(P.sliders, 14) + ' <span data-ref="viewLbl">View</span>' + svg(P.chevDown, 12) + '</button>',
      '  </div>',
      '</div>',
      '<div class="gh-bulk" data-ref="bulk" hidden></div>',
      '<div class="gh-body" data-ref="body"></div>',
      '<div class="gh-hint" aria-hidden="true"><span><span class="gh-kbd">n</span> new issue</span><span><span class="gh-kbd">/</span> filter</span><span><span class="gh-kbd">Ctrl</span>+<span class="gh-kbd">Space</span> add an item</span><span><span class="gh-kbd">Esc</span> close</span><span>Drag cards between columns, or use a card’s <b>…</b> menu to move it.</span></div>',
      '</div>'
    ].join('');
    S.refs = {};
    var els = r.querySelectorAll('[data-ref]');
    for (var i = 0; i < els.length; i++) S.refs[els[i].getAttribute('data-ref')] = els[i];
    S.refs.q.value = S.f.q;
  }

  function renderChrome() {
    if (!S || !S.root || !S.refs.proj) return;
    var R = S.refs;
    var p = projectById(S.f.project);
    R.title.textContent = p ? p.name : 'All Projects';
    R.tpill.innerHTML = projStatusPill(p) + (p && p.archivedAt ? ' <span class="gh-pill gh-tone-gray" title="This project is archived">Archived</span>' : '');
    R.infoBtn.hidden = !p;
    R.sub.textContent = p ? (p.description || p.projectCode || 'Project') : 'Eversoft HRMS Issue & Project Tracking';
    var pl = p ? p.name : (S.f.project ? 'Project #' + S.f.project : 'All projects (' + S.projects.length + ')');
    R.proj.innerHTML = svg(p && isPinned(p.id) ? P.pin : P.table, 14) + '<span>' + esc(pl) + '</span>' + svg(P.chevDown, 12);
    R.proj.setAttribute('aria-label', 'Project: ' + pl + '. Switch project');
    R.projEmpty.hidden = !(S.metaLoaded && !S.projects.length);
    if (!R.projEmpty.hidden && !R.projEmpty.innerHTML) {
      R.projEmpty.innerHTML = '<span><b>No projects yet.</b> A project groups issues and has a short description, a README and status updates.</span>' +
        (canCreateProject() ? '<button type="button" class="gh-btn gh-btn-sm gh-btn-primary" data-act="newproject">' + svg(P.plus, 14) + ' New project</button>' : '');
    }
    R.team.innerHTML = '<option value="">All teams (' + S.teams.length + ')</option>' + S.teams.map(function (x) {
      return '<option value="' + esc(x.id) + '"' + (String(x.id) === S.f.team ? ' selected' : '') + '>' + esc(x.name) + '</option>';
    }).join('') + (S.f.team && !teamById(S.f.team) ? '<option value="' + esc(S.f.team) + '" selected>Team #' + esc(S.f.team) + '</option>' : '');
    R.insBtn.hidden = false;
    R.insBtn.setAttribute('aria-pressed', S.insight ? 'true' : 'false');
    R.newBtn.hidden = !canCreate();
    renderTabs();
    var base = baseFiltered(), nOpen = 0;
    base.forEach(function (t) { if (!isClosed(t)) nOpen++; });
    R.seg.innerHTML = [['open', svg(P.open, 14) + ' Open', nOpen], ['closed', svg(P.closed, 14) + ' Closed', base.length - nOpen], ['all', 'All', base.length]].map(function (s) {
      return '<button type="button" data-state="' + s[0] + '" aria-pressed="' + (S.f.state === s[0]) + '">' + s[1] + (S.loaded ? ' <span class="gh-n">' + s[2] + '</span>' : '') + '</button>';
    }).join('');
    if (document.activeElement !== R.q && R.q.value !== S.f.q) R.q.value = S.f.q;
    R.qClear.hidden = !S.f.q;
    R.viewLbl.textContent = S.f.view === 'board'
      ? 'Group: ' + groupLabel(S.f.group)
      : (S.f.view === 'roadmap' ? 'Zoom: ' + S.vc.zoom.charAt(0).toUpperCase() + S.vc.zoom.slice(1) : 'Sort: ' + sortLabel(S.f.sort));
    renderInsight();
  }
  function sortLabel(k) {
    for (var i = 0; i < SORTS.length; i++) if (SORTS[i][0] === k) return SORTS[i][1];
    var fd = fdef(k);
    return fd ? fd.name : k;
  }
  function groupLabel(g) { if (!g) return 'None'; if (g === 'assignee') return 'Assignees'; var fd = fdef(g); return fd ? fd.name : g; }
  function layoutIcon(l) { return svg(l === 'board' ? P.board : (l === 'table' ? P.table : P.calendar), 14); }
  function renderTabs() {
    var box = S.refs.tabs;
    if (!box) return;
    var ae = document.activeElement, keep = ae && box.contains(ae) ? (ae.getAttribute('data-pv') || ae.getAttribute('data-view') || ae.getAttribute('data-act')) : null;
    var html;
    if (S.f.project && S.views && S.views.length) {
      html = S.views.map(function (v) {
        var on = String(v.id) === String(S.f.pv), dirty = isDirty(v);
        return '<div class="gh-vtab-w' + (on ? ' is-active' : '') + '"><button type="button" class="gh-tab" role="tab" data-pv="' + esc(v.id) + '" aria-selected="' + on + '" title="' + esc(v.name) + (dirty ? ' (unsaved changes)' : '') + '">' +
          layoutIcon(on ? S.f.view : v.layout) + ' <span>' + esc(v.name) + '</span>' + (dirty ? '<span class="gh-dirtydot" aria-label="Unsaved changes" role="img"></span>' : '') + '</button>' +
          (on ? '<button type="button" class="gh-iconbtn" data-act="vmenu" aria-haspopup="menu" aria-label="View options for ' + esc(v.name) + '" title="View options">' + svg(P.chevDown, 14) + '</button>' : '') + '</div>';
      }).join('') + (canConfigure() ? '<button type="button" class="gh-tab gh-newview" data-act="newview" aria-haspopup="menu">' + svg(P.plus, 14) + ' New view</button>' : '');
    } else if (S.f.project && !S.views) {
      html = '<div class="gh-skel" style="height:28px;width:220px" aria-label="Loading views"></div>';
    } else {
      html = LAYOUTS.map(function (l) {
        return '<button type="button" class="gh-tab" role="tab" data-view="' + l + '" aria-selected="' + (S.f.view === l) + '">' + layoutIcon(l) + ' ' + l.charAt(0).toUpperCase() + l.slice(1) + '</button>';
      }).join('');
    }
    if (box.__html === html) return;   // unchanged: keep the nodes (focus, pending clicks)
    box.__html = html;
    box.innerHTML = html;
    if (keep) {
      var el = box.querySelector('[data-pv="' + cssq(keep) + '"],[data-view="' + cssq(keep) + '"],[data-act="' + cssq(keep) + '"]');
      if (el) try { el.focus(); } catch (_) {}
    }
  }

  /* ── Insights: charts for the items currently in view (project, team and
     search filters apply; the Open/Closed toggle does not). Inline SVG, so it
     follows the light/dark theme and needs no chart library. ── */
  var INS_RANGES = [14, 30, 90];
  function insPrefs() { try { return JSON.parse(localStorage.getItem(LS_PREFIX + 'insights') || '{}') || {}; } catch (_) { return {}; } }
  function insSave() { try { localStorage.setItem(LS_PREFIX + 'insights', JSON.stringify({ open: !!S.insight, range: S.insRange })); } catch (_) {} }
  function insFilter(key, qual) {
    // Replace any qualifier of the same key, then add this one.
    var q = String(S.f.q || '').replace(new RegExp('(^|\\s)-?' + key + ':(?:"[^"]*"|\\S+)', 'gi'), ' ');
    if (key === 'is') q = q.replace(/(^|\s)-?no:(?:assignee|due)\b/gi, ' ');
    if (key === 'no') q = q.replace(/(^|\s)-?(?:is:overdue|assignee:(?:"[^"]*"|\S+))/gi, ' ');
    q = (q.replace(/\s+/g, ' ').trim() + ' ' + qual).trim();
    if (S.refs.q) S.refs.q.value = q;
    setFilter({ q: q, state: 'all' });
    var body = S.refs.body;
    if (body && body.scrollIntoView) try { body.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (_) {}
  }
  function shortDay(n) {
    var d = new Date(n * 86400000);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  function niceMax(v) {
    if (v <= 4) return 4;
    var p = Math.pow(10, Math.floor(Math.log(v) / Math.LN10)), n = v / p;
    return (n <= 2 ? 2 : (n <= 5 ? 5 : 10)) * p;
  }
  function burnupSvg(list, days) {
    var td = dayNum(todayISO()), start = td - days + 1, i;
    var addC = [], addD = [], baseC = 0, baseD = 0;
    for (i = 0; i < days; i++) { addC.push(0); addD.push(0); }
    list.forEach(function (t) {
      var cd = dayNum(localISO(t.createdAt));
      if (cd == null || cd < start) baseC++; else if (cd <= td) addC[cd - start]++;
      if (isClosed(t)) {
        var xd = dayNum(localISO(t.closedAt || t.updatedAt));
        if (xd == null || xd < start) baseD++; else if (xd <= td) addD[xd - start]++;
      }
    });
    var tot = [], dn = [], c = baseC, d = baseD;
    for (i = 0; i < days; i++) { c += addC[i]; d += addD[i]; tot.push(c); dn.push(Math.min(d, c)); }
    var W = 640, H = 210, L = 38, R = 14, T = 14, B = 28, max = niceMax(Math.max(1, c));
    function x(k) { return L + (days === 1 ? 0 : k * (W - L - R) / (days - 1)); }
    function y(v) { return T + (H - T - B) * (1 - v / max); }
    function line(a) { return a.map(function (v, k) { return (k ? 'L' : 'M') + x(k).toFixed(1) + ' ' + y(v).toFixed(1); }).join(''); }
    var grid = [0, max / 2, max].map(function (v) {
      return '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '" class="gh-ch-grid"/>' +
        '<text x="' + (L - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end" class="gh-ch-tick">' + Math.round(v) + '</text>';
    }).join('');
    var xl = [0, Math.floor((days - 1) / 2), days - 1].map(function (k, j) {
      return '<text x="' + x(k) + '" y="' + (H - 8) + '" text-anchor="' + (j === 0 ? 'start' : (j === 2 ? 'end' : 'middle')) + '" class="gh-ch-tick">' + esc(shortDay(start + k)) + '</text>';
    }).join('');
    var open = 'M' + tot.map(function (v, k) { return x(k).toFixed(1) + ' ' + y(v).toFixed(1); }).join('L') +
      'L' + dn.slice().reverse().map(function (v, k) { return x(days - 1 - k).toFixed(1) + ' ' + y(v).toFixed(1); }).join('L') + 'Z';
    var done = 'M' + x(0) + ' ' + y(0) + 'L' + dn.map(function (v, k) { return x(k).toFixed(1) + ' ' + y(v).toFixed(1); }).join('L') + 'L' + x(days - 1) + ' ' + y(0) + 'Z';
    var hit = '', w = (W - L - R) / Math.max(1, days - 1);
    for (i = 0; i < days; i++) {
      hit += '<rect x="' + (x(i) - w / 2).toFixed(1) + '" y="' + T + '" width="' + w.toFixed(1) + '" height="' + (H - T - B) + '" class="gh-ch-hit"><title>' +
        esc(shortDay(start + i)) + ': ' + tot[i] + ' total · ' + dn[i] + ' completed · ' + (tot[i] - dn[i]) + ' open' + '</title></rect>';
    }
    var openedN = 0, closedN = 0;
    for (i = 0; i < days; i++) { openedN += addC[i]; closedN += addD[i]; }
    return {
      opened: openedN, closed: closedN,
      svg: '<svg class="gh-ch-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Burn-up for the last ' + days + ' days: ' + c + ' items in total, ' + dn[days - 1] + ' completed">' +
        grid + '<path d="' + open + '" class="gh-ch-area-open"/><path d="' + done + '" class="gh-ch-area-done"/>' +
        '<path d="' + line(tot) + '" class="gh-ch-line" style="stroke:var(--gh-green)"/><path d="' + line(dn) + '" class="gh-ch-line" style="stroke:var(--gh-purple)"/>' +
        '<circle cx="' + x(days - 1) + '" cy="' + y(tot[days - 1]) + '" r="3.5" style="fill:var(--gh-green)"/><circle cx="' + x(days - 1) + '" cy="' + y(dn[days - 1]) + '" r="3.5" style="fill:var(--gh-purple)"/>' +
        xl + hit + '</svg>'
    };
  }
  function donutSvg(segs, total, center) {
    var r = 52, C = 2 * Math.PI * r, off = 0;
    var arcs = total ? segs.filter(function (g) { return g.n; }).map(function (g) {
      var len = g.n / total * C, a = '<circle r="' + r + '" cx="70" cy="70" class="gh-ch-arc" style="stroke:var(--gh-' + g.tone + ')" stroke-dasharray="' + len.toFixed(2) + ' ' + (C - len).toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) + '"><title>' + esc(g.label) + ': ' + g.n + '</title></circle>';
      off += len;
      return a;
    }).join('') : '';
    return '<svg class="gh-ch-donut" viewBox="0 0 140 140" role="img" aria-label="' + esc(segs.map(function (g) { return g.label + ' ' + g.n; }).join(', ')) + '">' +
      '<circle r="' + r + '" cx="70" cy="70" class="gh-ch-track"/><g transform="rotate(-90 70 70)">' + arcs + '</g>' +
      '<text x="70" y="68" text-anchor="middle" class="gh-ch-big">' + esc(center[0]) + '</text><text x="70" y="88" text-anchor="middle" class="gh-ch-tick">' + esc(center[1]) + '</text></svg>';
  }
  function barRows(rows, max) {
    // rows: [{label, sub, parts:[{n,tone,title}], key, q, aria}]
    return rows.map(function (r) {
      var tot = 0;
      r.parts.forEach(function (x) { tot += x.n; });
      var bar = r.parts.filter(function (x) { return x.n; }).map(function (x) {
        return '<i style="width:' + (x.n / max * 100).toFixed(2) + '%;background:var(--gh-' + x.tone + ')" title="' + esc(x.title + ': ' + x.n) + '"></i>';
      }).join('');
      var inner = '<span class="gh-ch-lbl">' + (r.pre || '') + '<span class="gh-ch-name">' + esc(r.label) + '</span></span>' +
        '<span class="gh-ch-track2">' + bar + '</span><b class="gh-ch-n">' + tot + '</b>';
      return r.q ? '<button type="button" class="gh-ch-row" data-act="insq" data-key="' + esc(r.key) + '" data-q="' + esc(r.q) + '" aria-label="' + esc(r.aria || (r.label + ': ' + tot)) + '. Show these items" title="Show these items">' + inner + '</button>'
        : '<div class="gh-ch-row">' + inner + '</div>';
    }).join('');
  }
  function legend(items) {
    return '<div class="gh-ch-legend">' + items.map(function (x) { return '<span><i style="background:var(--gh-' + x[1] + ')"></i>' + esc(x[0]) + '</span>'; }).join('') + '</div>';
  }
  function insightHtml() {
    var list = baseFiltered(), td = dayNum(todayISO());
    var c = { todo: 0, inprogress: 0, review: 0, done: 0 }, due = { overdue: 0, week: 0, later: 0, none: 0 };
    var pr = {}, who = {}, order = [];
    list.forEach(function (t) {
      var st = stageOf(t), closed = st === 'done', pid = prioOf(t.priority).id;
      c[st]++;
      pr[pid] = pr[pid] || { open: 0, closed: 0 };
      pr[pid][closed ? 'closed' : 'open']++;
      if (closed) return;
      var raw = String(t.due || '').trim(), dd = dayNum(dueISO(t.due));
      if (!raw) due.none++; else if (dd == null) due.later++; else if (dd < td) due.overdue++; else if (dd <= td + 7) due.week++; else due.later++;
      var k = String(t.assigneeEmail || t.assignee || '').toLowerCase();
      if (!who[k]) { who[k] = { email: t.assigneeEmail || '', name: t.assignee || t.assigneeEmail || '', todo: 0, inprogress: 0, review: 0, n: 0 }; order.push(k); }
      who[k][st]++; who[k].n++;
    });
    var total = list.length, open = total - c.done, pct = total ? Math.round(c.done / total * 100) : 0;
    var days = S.insRange, bu = burnupSvg(list, days), b = S.burndown;

    var head = '<div class="gh-ins-head"><h3>' + svg(P.graph, 16) + ' Insights <span class="gh-muted">' + esc(S.f.project ? '· this project' : '· all projects') +
      (S.f.q || S.f.team ? ' · filtered' : '') + '</span></h3>' +
      '<div class="gh-seg" role="group" aria-label="Burn-up range">' + INS_RANGES.map(function (d) {
        return '<button type="button" data-act="insrange" data-days="' + d + '" aria-pressed="' + (d === days) + '">' + d + ' days</button>';
      }).join('') + '</div>' +
      '<button type="button" class="gh-iconbtn" data-act="insights" aria-label="Close insights" title="Close insights">' + svg(P.x || P.close || P.plus, 16) + '</button></div>';

    var tiles = '<div class="gh-ins-tiles">' +
      '<div class="gh-stat">Total items<b>' + total + '</b></div>' +
      '<div class="gh-stat">Open<b>' + open + '</b></div>' +
      '<div class="gh-stat">Completed<b>' + c.done + ' <small>' + pct + '%</small></b><div class="gh-bar"><i style="width:' + pct + '%"></i></div></div>' +
      '<button type="button" class="gh-stat gh-stat-btn" data-act="insq" data-key="is" data-q="is:overdue" title="Show overdue items">Overdue<b' + (due.overdue ? ' class="gh-tone-red"' : '') + '>' + due.overdue + '</b></button>' +
      '<div class="gh-stat">Opened · ' + days + 'd<b>' + bu.opened + '</b></div>' +
      '<div class="gh-stat">Closed · ' + days + 'd<b>' + bu.closed + '</b></div>' +
      (S.f.project ? (b ? '<div class="gh-stat">Hours logged / allocated<b>' + esc(b.spentHours) + ' / ' + esc(b.allocatedHours) + '</b><div class="gh-bar"><i style="width:' + Math.min(100, b.burnRatePercent || 0) + '%"></i></div></div>'
                        : '<div class="gh-stat">Hours<b class="gh-muted">…</b></div>') : '') +
      '</div>';

    if (!total) {
      return head + tiles + '<div class="gh-ch-empty">No items match the current filters, so there is nothing to chart yet.</div>';
    }

    var burn = '<section class="gh-ch gh-ch-wide" aria-label="Burn-up"><div class="gh-ch-h"><h4>Burn-up</h4>' +
      legend([['Total items', 'green'], ['Completed', 'purple']]) + '</div>' + bu.svg +
      '<p class="gh-ch-note">The gap between the lines is the open work. Hover a day for its numbers.</p></section>';

    var statusRows = STATUSES.map(function (s) { return { id: s.id, label: s.label, tone: s.tone, n: c[s.id] }; });
    var status = '<section class="gh-ch" aria-label="Status"><div class="gh-ch-h"><h4>Status</h4></div><div class="gh-ch-donutwrap">' +
      donutSvg(statusRows, total, [pct + '%', 'complete']) + '<div class="gh-ch-keys">' + statusRows.map(function (s) {
        var q = s.id === 'done' ? 'is:closed' : 'is:' + s.id;
        return '<button type="button" class="gh-ch-key" data-act="insq" data-key="is" data-q="' + q + '" aria-label="' + esc(s.label) + ': ' + s.n + '. Show these items"><i style="background:var(--gh-' + s.tone + ')"></i><span>' + esc(s.label) + '</span><b>' + s.n + '</b></button>';
      }).join('') + '</div></div></section>';

    order.sort(function (a, b2) { return who[b2].n - who[a].n || String(who[a].name).localeCompare(String(who[b2].name)); });
    var top = order.slice(0, 8), amax = 1;
    top.forEach(function (k) { amax = Math.max(amax, who[k].n); });
    var people = '<section class="gh-ch" aria-label="Open items by assignee"><div class="gh-ch-h"><h4>Open items by assignee</h4>' +
      legend([['To Do', 'green'], ['In Progress', 'yellow'], ['In Review', 'blue']]) + '</div>' +
      (top.length ? '<div class="gh-ch-bars">' + barRows(top.map(function (k) {
        var w = who[k], nm = k ? w.name : 'No assignee';
        var q = !k ? 'no:assignee' : 'assignee:' + (w.email ? w.email : '"' + String(w.name).replace(/"/g, '') + '"');
        return { label: nm, pre: k ? avatar(w.name, w.email, 18) : '', key: k ? 'assignee' : 'no', q: q, aria: nm + ': ' + w.n + ' open',
                 parts: [{ n: w.todo, tone: 'green', title: 'To Do' }, { n: w.inprogress, tone: 'yellow', title: 'In Progress' }, { n: w.review, tone: 'blue', title: 'In Review' }] };
      }), amax) + '</div>' + (order.length > top.length ? '<p class="gh-ch-note">+' + (order.length - top.length) + ' more people</p>' : '')
        : '<div class="gh-ch-empty">Nothing open. 🎉</div>') + '</section>';

    var pmax = 1, prs = PRIORITIES.slice();
    Object.keys(pr).forEach(function (k) { if (!prs.some(function (x) { return x.id === k; })) prs.push(prioOf(k)); });
    prs = prs.filter(function (x) { return pr[x.id]; });
    prs.forEach(function (x) { pmax = Math.max(pmax, pr[x.id].open + pr[x.id].closed); });
    var prio = '<section class="gh-ch" aria-label="Priority"><div class="gh-ch-h"><h4>Priority</h4>' + legend([['Open', 'blue'], ['Closed', 'purple']]) + '</div>' +
      '<div class="gh-ch-bars">' + barRows(prs.map(function (x) {
        return { label: x.label, pre: '<i class="gh-ch-dot" style="background:var(--gh-' + x.tone + ')"></i>', key: 'priority', q: 'priority:' + x.id,
                 parts: [{ n: pr[x.id].open, tone: 'blue', title: 'Open' }, { n: pr[x.id].closed, tone: 'purple', title: 'Closed' }] };
      }), pmax) + '</div></section>';

    var dmax = Math.max(1, due.overdue, due.week, due.later, due.none);
    var dueBox = '<section class="gh-ch" aria-label="Due dates of open items"><div class="gh-ch-h"><h4>Due dates · open items</h4></div><div class="gh-ch-bars">' + barRows([
      { label: 'Overdue', key: 'is', q: 'is:overdue', parts: [{ n: due.overdue, tone: 'red', title: 'Overdue' }] },
      { label: 'Next 7 days', parts: [{ n: due.week, tone: 'yellow', title: 'Due in the next 7 days' }] },
      { label: 'Later', parts: [{ n: due.later, tone: 'blue', title: 'Due later' }] },
      { label: 'No due date', key: 'no', q: 'no:due', parts: [{ n: due.none, tone: 'gray', title: 'No due date' }] }
    ], dmax) + '</div></section>';

    return head + tiles + '<div class="gh-ins-grid">' + burn + status + people + prio + dueBox + '</div>';
  }
  function renderInsight() {
    var box = S.refs.insight;
    if (!box) return;
    if (!S.insight) { box.hidden = true; box.__html = ''; return; }
    box.hidden = false;
    var html = S.loaded ? insightHtml() : '<div class="gh-skel" style="height:180px" aria-label="Loading insights"></div>';
    if (box.__html !== html) {
      var ae = document.activeElement, keep = ae && box.contains(ae) ? (ae.getAttribute('data-q') || ae.getAttribute('data-days') || ae.getAttribute('data-act')) : null;
      box.__html = html;
      box.innerHTML = html;
      if (keep) {
        var el = box.querySelector('[data-q="' + cssq(keep) + '"],[data-days="' + cssq(keep) + '"],[data-act="' + cssq(keep) + '"]');
        if (el) try { el.focus({ preventScroll: true }); } catch (_) {}
      }
    }
    if (S.f.project && !S.burndown && !S.burndownLoading) {
      var pid = S.f.project, st = S;
      S.burndownLoading = true;
      req('/api/projects/' + pid + '/burndown').then(function (d) {
        if (st !== S || !S.root) return;
        S.burndownLoading = false;
        if (S.f.project !== pid) return;
        S.burndown = d || { spentHours: 0, allocatedHours: 0, burnRatePercent: 0 };
        renderInsight();
      }, function () {
        if (st !== S || !S.root) return;
        S.burndownLoading = false;
        if (S.f.project !== pid) return;
        S.burndown = { spentHours: '–', allocatedHours: '–', burnRatePercent: 0 };
        renderInsight();
      });
    }
  }

  /* ── body: board / table ─────────────────────────────────────────────── */
  function renderBody() {
    if (!S || !S.root || !S.refs.body) return;
    var body = S.refs.body;
    var keepScroll = saveScroll(body);
    if (!S.loaded) {
      body.innerHTML = S.error ? errorHtml() : skeletonHtml();
      renderBulk([]);
      return;
    }
    if (S.error && !S.tasks.length) { body.innerHTML = errorHtml(); renderBulk([]); return; }
    var list = sortList(applyState(baseFiltered()));
    if (!S.tasks.length && S.f.view !== 'table') {
      body.innerHTML = '<div class="gh-empty">' + svg(P.open, 24) + '<h3>No issues yet</h3><div>Issues you create show up here on the board.</div>' +
        (canCreate() ? '<button type="button" class="gh-btn gh-btn-primary" data-act="new">' + svg(P.plus, 14) + ' New issue</button>' : '') + '</div>';
      renderBulk([]);
      return;
    }
    var ae = document.activeElement, addFocus = ae && ae.getAttribute && ae.getAttribute('data-ref') === 'addrow' && body.contains(ae);
    var addVal = addFocus ? ae.value : null, fsel = !addFocus && ae && body.contains(ae) ? focusKey(ae) : null;
    body.innerHTML = (S.error ? errorHtml() : '') + (S.f.view === 'table' ? tableHtml(list) : (S.f.view === 'roadmap' ? roadmapHtml(list) : boardHtml(list)));
    renderBulk(list);
    restoreScroll(body, keepScroll);
    if (addFocus) { var ar = body.querySelector('[data-ref="addrow"]'); if (ar) { ar.value = addVal; try { ar.focus({ preventScroll: true }); } catch (_) {} } }
    else if (fsel) { var fe = body.querySelector(fsel); if (fe) try { fe.focus({ preventScroll: true }); } catch (_) {} }
    if (S.f.view === 'roadmap' && keepScroll.rx == null) scrollRoadmapToday(false);
    if (S.quickAdd) {
      var qa = body.querySelector('.gh-qa input');
      if (qa) { qa.value = S.quickAddDraft || ''; qa.focus(); }
    }
  }
  function focusKey(el) {
    var a = function (n) { return el.getAttribute(n); };
    if (a('data-bar')) return '[data-bar="' + cssq(a('data-bar')) + '"]';
    if (a('data-cell')) return '[data-cell="' + cssq(a('data-cell')) + '"][data-id="' + cssq(a('data-id')) + '"]';
    if (a('data-resize')) return '[data-resize="' + cssq(a('data-resize')) + '"]';
    if (a('data-sort')) return '[data-sort="' + cssq(a('data-sort')) + '"]';
    if (a('data-zoom')) return '[data-zoom="' + cssq(a('data-zoom')) + '"]';
    if (a('data-act')) return '[data-act="' + cssq(a('data-act')) + '"]' + (a('data-field') ? '[data-field="' + cssq(a('data-field')) + '"]' : '') + (a('data-id') ? '[data-id="' + cssq(a('data-id')) + '"]' : '');
    return null;
  }
  function saveScroll(body) {
    var out = { cols: {} }, tw = body.querySelector('.gh-tablewrap'), bd = body.querySelector('.gh-board'), rm = body.querySelector('.gh-rm-main');
    if (tw) { out.tx = tw.scrollLeft; out.ty = tw.scrollTop; }
    if (bd) out.bx = bd.scrollLeft;
    if (rm && S.rmZoom === S.vc.zoom) { out.rx = rm.scrollLeft; out.ry = rm.scrollTop; }
    var cols = body.querySelectorAll('.gh-col-body');
    for (var i = 0; i < cols.length; i++) out.cols[cols[i].getAttribute('data-drop')] = cols[i].scrollTop;
    return out;
  }
  function restoreScroll(body, s) {
    var tw = body.querySelector('.gh-tablewrap'), bd = body.querySelector('.gh-board'), rm = body.querySelector('.gh-rm-main');
    if (rm && s.rx != null) { rm.scrollLeft = s.rx; rm.scrollTop = s.ry; }
    if (rm) S.rmZoom = S.vc.zoom;
    if (tw && s.ty != null) { tw.scrollLeft = s.tx; tw.scrollTop = s.ty; }
    if (bd && s.bx != null) bd.scrollLeft = s.bx;
    var cols = body.querySelectorAll('.gh-col-body');
    for (var i = 0; i < cols.length; i++) { var v = s.cols[cols[i].getAttribute('data-drop')]; if (v) cols[i].scrollTop = v; }
  }
  function errorHtml() {
    return '<div class="gh-error" role="alert"><span>' + esc(S.error) + '</span><button type="button" class="gh-btn gh-btn-sm" data-act="retry">Retry</button></div>';
  }
  function skeletonHtml() {
    if (S.f.view === 'table') {
      var rows = '';
      for (var i = 0; i < 8; i++) rows += '<div class="gh-skel" style="height:34px;margin:8px 12px"></div>';
      return '<div class="gh-tablewrap" aria-busy="true" aria-label="Loading issues">' + rows + '</div>';
    }
    var cols = '';
    for (var c = 0; c < 4; c++) {
      cols += '<div class="gh-col" aria-hidden="true"><div class="gh-col-h"><div class="gh-skel" style="height:14px;width:45%"></div></div><div class="gh-col-body">';
      for (var k = 0; k < 3 - (c % 2); k++) cols += '<div class="gh-skel" style="height:' + (70 + (k * 13) % 30) + 'px"></div>';
      cols += '</div></div>';
    }
    return '<div class="gh-board" aria-busy="true" aria-label="Loading issues">' + cols + '</div>';
  }

  function columns(list) { return groupsFor(list, S.f.group || 'status'); }
  /* Groups (board columns / table sections) of ``list`` by field ``g``. */
  function groupsFor(list, g) {
    function bucket(items, keyOf, defs, noneLabel, extra) {
      var by = {};
      items.forEach(function (t) { var k = keyOf(t); (by[k] = by[k] || []).push(t); });
      var out = defs.map(function (d) { var o = extra(d); o.items = by[d.v] || []; delete by[d.v]; return o; });
      Object.keys(by).forEach(function (k) { if (k) { var o = extra({ v: k, label: k }); o.items = by[k]; out.push(o); } });
      var none = extra({ v: '', label: noneLabel });
      none.items = by[''] || [];
      out.push(none);
      return out;
    }
    if (g === 'priority') {
      return PRIORITIES.map(function (p) {
        return { key: 'p:' + p.id, field: 'priority', value: p.id, label: p.label, tone: p.tone, items: list.filter(function (t) { return prioOf(t.priority).id === p.id; }) };
      });
    }
    if (g === 'type') {
      return TYPES.map(function (x) {
        return { key: 'y:' + x.id, field: 'issueType', value: x.id, label: x.label, tone: x.tone, icon: TICON[x.id], items: list.filter(function (t) { return typeOf(t.issueType).id === x.id; }) };
      });
    }
    if (g === 'milestone') {
      var proj = projectById(S.f.project), ms = (proj && proj.milestones) || [], names = {};
      list.forEach(function (t) { if (t.milestoneId) names[t.milestoneId] = t.milestoneTitle || ('Milestone #' + t.milestoneId); });
      ms.forEach(function (m) { names[m.id] = m.title; });
      var defs = ms.map(function (m) { return { v: String(m.id), label: m.title }; });
      Object.keys(names).forEach(function (id) { if (!defs.some(function (d) { return d.v === String(id); })) defs.push({ v: String(id), label: names[id] }); });
      return bucket(list, function (t) { return t.milestoneId ? String(t.milestoneId) : ''; }, defs, 'No milestone', function (d) {
        return { key: 'm:' + d.v, field: 'milestoneId', value: d.v ? Number(d.v) : null, label: d.label, tone: 'gray', icon: P.milestone };
      });
    }
    if (g === 'team') {
      var tdefs = S.teams.map(function (x) { return { v: String(x.id), label: x.name }; });
      list.forEach(function (t) { if (t.teamId && !tdefs.some(function (d) { return d.v === String(t.teamId); })) tdefs.push({ v: String(t.teamId), label: t.teamName || ('Team #' + t.teamId) }); });
      var cols = bucket(list, function (t) { return t.teamId ? String(t.teamId) : ''; }, tdefs, 'No team', function (d) {
        return { key: 't:' + d.v, field: 'teamId', value: d.v ? Number(d.v) : null, label: d.label, tone: 'gray', icon: P.people };
      });
      return cols.filter(function (c) { return c.items.length || !c.value; });
    }
    var fd = /^f:\d+$/.test(g || '') ? fdef(g) : null;
    if (fd && fd.custom) {
      var cf = fd.custom, cdefs = cf.type === 'single_select'
        ? ((cf.options && cf.options.choices) || []).map(function (c) { return { v: c.id, label: c.name, color: c.color }; })
        : (cf.iterations || []).map(function (it) { return { v: it.id, label: it.title, hint: fmtDue(it.start) + ' – ' + fmtDue(it.end) }; });
      return bucket(list, function (t) { var v = fieldVal(t, cf.id); return v == null ? '' : String(v); }, cdefs, 'No ' + cf.name, function (d) {
        return { key: 'f' + cf.id + ':' + d.v, custom: cf, value: d.v || null, label: d.label, color: d.color, hint: d.hint, tone: 'gray' };
      });
    }
    if (g === 'assignee' || g === 'assignees') {
      var map = {}, order = [];
      list.forEach(function (t) {
        var k = String(t.assigneeEmail || t.assignee || '').toLowerCase();
        if (!map[k]) { map[k] = { key: 'a:' + k, field: 'assignee', value: t.assigneeEmail || '', name: t.assignee || t.assigneeEmail || '', label: k ? (t.assignee || t.assigneeEmail) : 'No assignee', items: [] }; order.push(k); }
        map[k].items.push(t);
      });
      if (!map['']) { map[''] = { key: 'a:', field: 'assignee', value: '', name: '', label: 'No assignee', items: [] }; order.push(''); }
      order.sort(function (a, b) { if (!a) return -1; if (!b) return 1; return map[a].label.toLowerCase() < map[b].label.toLowerCase() ? -1 : 1; });
      return order.map(function (k) { return map[k]; });
    }
    return STATUSES.map(function (s) {
      return { key: 's:' + s.id, field: 'stage', value: s.id, label: s.label, tone: s.tone, hint: s.hint, items: list.filter(function (t) { return stageOf(t) === s.id; }) };
    });
  }
  function colByKey(key) {
    var cols = columns(sortList(applyState(baseFiltered())));
    for (var i = 0; i < cols.length; i++) if (cols[i].key === key) return cols[i];
    return null;
  }

  function boardHtml(list) {
    var editable = canEdit();
    return '<div class="gh-board" role="list" aria-label="Board">' + columns(list).map(function (c) {
      var collapsed = !!S.collapsed[c.key];
      var dot = colDot(c);
      if (collapsed) {
        return '<section class="gh-col gh-col--collapsed" role="listitem" data-col="' + esc(c.key) + '" data-act="expand" title="Expand ' + esc(c.label) + '" aria-label="' + esc(c.label) + ' (collapsed, ' + c.items.length + ' items)">' +
          '<button type="button" class="gh-iconbtn" data-act="expand" data-col="' + esc(c.key) + '" aria-label="Expand column ' + esc(c.label) + '">' + svg(P.chevRight, 14) + '</button>' +
          '<div class="gh-col-vert">' + dot + '<span>' + esc(c.label) + '</span><span class="gh-count">' + c.items.length + '</span></div></section>';
      }
      var cards = c.items.length ? c.items.map(function (t) { return cardHtml(t, editable); }).join('')
        : '<div class="gh-col-empty">' + (c.field === 'stage' && c.value === 'done' && S.f.state === 'open'
          ? 'Closed items are hidden. <button type="button" data-state="all">Show all</button>'
          : (c.field === 'stage' && c.value !== 'done' && S.f.state === 'closed' ? 'Only closed items are shown.' : 'No items')) + '</div>';
      var foot = '';
      if (canCreate()) {
        foot = S.quickAdd === c.key
          ? '<form class="gh-qa" data-col="' + esc(c.key) + '"><label class="gh-sr" for="gh-qa-' + esc(c.key) + '">New item title</label><input id="gh-qa-' + esc(c.key) + '" class="gh-input" maxlength="255" placeholder="Type a title, press Enter" autocomplete="off"><div class="gh-qa-hint">Enter to add · Esc to cancel</div></form>'
          : '<button type="button" class="gh-btn gh-btn-invisible gh-add" data-act="quickadd" data-col="' + esc(c.key) + '">' + svg(P.plus, 14) + ' Add item</button>';
      }
      return '<section class="gh-col" role="listitem" data-col="' + esc(c.key) + '" aria-label="' + esc(c.label) + ', ' + c.items.length + ' items">' +
        '<header class="gh-col-h">' + dot + '<h3 class="gh-col-title">' + esc(c.label) + '</h3><span class="gh-count">' + c.items.length + '</span>' +
        '<button type="button" class="gh-iconbtn" data-act="colmenu" data-col="' + esc(c.key) + '" aria-haspopup="menu" aria-label="Column options for ' + esc(c.label) + '">' + svg(P.kebab, 16) + '</button></header>' +
        (c.hint ? '<div class="gh-col-hint">' + esc(c.hint) + '</div>' : '') +
        '<div class="gh-col-body" data-drop="' + esc(c.key) + '">' + cards + '</div>' +
        (foot ? '<div class="gh-col-f">' + foot + '</div>' : '') + '</section>';
    }).join('') + '</div>';
  }

  function colDot(c) {
    if (c.field === 'assignee') return avatar(c.name, c.value || c.name, 18);
    if (c.color) return '<span class="gh-swatch gh-opt-' + esc(c.color) + '" aria-hidden="true"></span>';
    if (c.icon) return '<span class="gh-tone-' + (c.tone || 'gray') + '" aria-hidden="true">' + svg(c.icon, 14) + '</span>';
    return '<span class="gh-dot gh-tone-' + (c.tone || 'gray') + '" aria-hidden="true"></span>';
  }
  function cardHtml(t, editable) {
    var labels = parseLabels(t.labels);
    var pr = prioOf(t.priority);
    var progress = Math.max(0, Math.min(100, Number(t.progress) || 0));
    var due = String(t.due || '').trim();
    var active = S.pane && String(S.pane.id) === String(t.id);
    var who = personName(t), vis = {};
    visibleFields().forEach(function (id) { vis[id] = true; });
    var extra = visibleFields().filter(function (id) { return ['assignees', 'priority', 'type', 'labels', 'milestone', 'due', 'subissues', 'parent', 'updated'].indexOf(id) === -1; })
      .map(function (id) { return cardChip(t, id); }).join('');
    var si = t.subIssues || {};
    return '<article class="gh-card' + (active ? ' is-active' : '') + '" tabindex="0" data-id="' + esc(t.id) + '"' + (editable ? ' draggable="true"' : '') +
      ' aria-label="' + esc(t.title + ', ' + statusOf(stageOf(t)).label + (who ? ', assigned to ' + who : '')) + '">' +
      '<div class="gh-card-top">' + stateIcon(t, 14) + '<span class="gh-ref" title="' + esc(t.taskCode || '') + '">' + esc(ref(t)) + '</span>' +
      (t.projectCode ? '<span class="gh-card-proj" title="' + esc(t.projectName) + '">· ' + esc(t.projectCode) + '</span>' : '') +
      '<button type="button" class="gh-iconbtn" data-act="cardmenu" data-id="' + esc(t.id) + '" aria-haspopup="menu" aria-label="Actions for ' + esc(ref(t)) + ' (move to…)">' + svg(P.kebab, 14) + '</button></div>' +
      '<h4 class="gh-card-title">' + esc(t.title) + '</h4>' +
      (vis.parent && t.parentId ? '<div class="gh-card-top" title="Parent issue">' + svg(P.crossRef, 12) + ' <span class="gh-ellip">#' + esc(t.parentId) + ' ' + esc(t.parentTitle || '') + '</span></div>' : '') +
      '<div class="gh-chips">' + (vis.priority ? '<span class="gh-pill gh-tone-' + pr.tone + '">' + esc(pr.label) + '</span>' : '') +
      (vis.type && typeOf(t.issueType).id !== 'task' ? '<span class="gh-pill gh-tone-' + typeOf(t.issueType).tone + '" title="Issue type">' + svg(TICON[typeOf(t.issueType).id], 12) + ' ' + esc(typeOf(t.issueType).label) + '</span>' : '') +
      (vis.labels ? labels.map(function (l) { return labelChip(l); }).join('') : '') +
      (vis.milestone && t.milestoneTitle ? '<span class="gh-pill gh-tone-gray">' + svg(P.milestone, 12) + ' ' + esc(t.milestoneTitle) + '</span>' : '') + extra + '</div>' +
      (progress > 0 ? '<div class="gh-progress" title="' + progress + '% complete" role="progressbar" aria-valuenow="' + progress + '" aria-valuemin="0" aria-valuemax="100"><i style="width:' + progress + '%"></i></div>' : '') +
      (vis.subissues && si.total ? '<div class="gh-card-top">' + cellInner(t, 'subissues') + '</div>' : '') +
      '<div class="gh-card-foot">' + (vis.assignees ? '<span class="gh-who">' + avatar(who, t.assigneeEmail || who, 20) + '<span>' + esc(who || 'Unassigned') + '</span></span>' : '<span class="gh-who"></span>') +
      (vis.due && due ? '<span class="gh-meta' + (isOverdue(t) ? ' gh-overdue' : '') + '" title="Due ' + esc(due) + (isOverdue(t) ? ' (overdue)' : '') + '">' + svg(P.calendar, 12) + ' ' + esc(fmtDue(due)) + '</span>' : '') +
      (vis.updated ? '<span class="gh-meta" title="Updated">' + timeEl(t.updatedAt || t.createdAt) + '</span>' : '') +
      (t.commentCount ? '<span class="gh-meta" title="' + t.commentCount + ' comments">' + svg(P.comment, 12) + ' ' + esc(t.commentCount) + '</span>' : '') +
      '</div></article>';
  }

  /* GitHub Projects table: row number, Title, the view's visible fields,
     "+" (Add field). Columns have a "…" menu and a resize handle; cells
     are edited in place; the last row adds an item (Ctrl+Space). */
  function tableHtml(list) {
    var editable = canEdit(), cols = visibleFields();
    var shown = list.slice(0, S.limit);
    var nSel = 0;
    shown.forEach(function (t) { if (S.selected[t.id]) nSel++; });
    var numW = COL_W.num, titleW = colWidth('title'), total = numW + titleW + 44;
    cols.forEach(function (id) { total += colWidth(id); });
    function th(id) {
      var fd = id === 'title' ? { id: 'title', name: 'Title' } : fdef(id), on = S.f.sort === id || (id === 'assignees' && S.f.sort === 'assignee');
      return '<th class="' + (id === 'title' ? 'gh-c-title' : '') + '" data-col="' + esc(id) + '" scope="col" aria-sort="' + (on ? (S.f.dir === 'asc' ? 'ascending' : 'descending') : 'none') + '">' +
        '<div class="gh-th"><button type="button" class="gh-th-btn" data-sort="' + esc(id) + '" title="Sort by ' + esc(fd.name) + '">' + esc(fd.name) +
        (on ? '<span class="gh-arrow" aria-hidden="true">' + (S.f.dir === 'asc' ? '▲' : '▼') + '</span>' : '') + '</button>' +
        '<button type="button" class="gh-iconbtn" data-act="colfield" data-field="' + esc(id) + '" aria-haspopup="menu" aria-label="Field options for ' + esc(fd.name) + '" title="Field options">' + svg(P.kebab, 14) + '</button></div>' +
        '<span class="gh-resize" data-resize="' + esc(id) + '" role="separator" aria-orientation="vertical" aria-valuenow="' + colWidth(id) + '" aria-valuemin="48" aria-valuemax="900" tabindex="0" aria-label="Resize ' + esc(fd.name) + ' column (arrow keys)"></span></th>';
    }
    function row(t, n) {
      var sel = !!S.selected[t.id];
      return '<tr data-id="' + esc(t.id) + '"' + (sel ? ' class="is-selected"' : '') + '>' +
        '<td class="gh-c-num"><div class="gh-numcell"><input type="checkbox" data-act="sel" data-id="' + esc(t.id) + '"' + (sel ? ' checked' : '') + ' aria-label="Select ' + esc(ref(t)) + '"><span>' + n + '</span></div></td>' +
        '<td class="gh-c-title"><div class="gh-t-title">' + stateIcon(t, 16) + '<button type="button" class="gh-titlelink" data-act="open" data-id="' + esc(t.id) + '" title="' + esc(t.title) + '">' + esc(t.title) + '</button><span class="gh-ref">' + esc(ref(t)) + '</span></div></td>' +
        cols.map(function (id) {
          var inner = cellInner(t, id), ro = cellReadOnly(id) || !editable;
          if (id === 'parent' && t.parentId && ro) inner = '<span class="gh-ellip">' + inner + '</span>';
          return '<td data-col="' + esc(id) + '">' + (ro
            ? '<span class="gh-cell is-ro">' + inner + '</span>'
            : '<button type="button" class="gh-cell" data-cell="' + esc(id) + '" data-id="' + esc(t.id) + '" aria-label="' + esc(fdef(id).name + ' of ' + ref(t) + '. Edit') + '">' + inner + '</button>') + '</td>';
        }).join('') + '<td></td></tr>';
    }
    var body = '', n = 0, span = cols.length + 3;
    if (!list.length) body = '<tr><td colspan="' + span + '" style="height:auto;padding:22px 12px;text-align:center" class="gh-muted">' + (S.tasks.length ? 'No items match the current filters.' : 'No issues yet.') + '</td></tr>';
    else if (S.f.tgroup) {
      groupsFor(shown, S.f.tgroup).forEach(function (g) {
        if (!g.items.length) return;
        body += '<tr class="gh-grp"><td colspan="' + span + '"><span class="gh-grp-h">' + colDot(g) + '<span>' + esc(g.label) + '</span><span class="gh-count">' + g.items.length + '</span></span></td></tr>';
        g.items.forEach(function (t) { body += row(t, ++n); });
      });
    } else shown.forEach(function (t) { body += row(t, ++n); });
    if (canCreate()) {
      body += '<tr class="gh-addrow"><td class="gh-c-num"></td><td class="gh-c-title" colspan="' + (span - 1) + '"><label class="gh-addrow-in">' + svg(P.plus, 16) +
        '<span class="gh-sr">Add an item</span><input data-ref="addrow" maxlength="255" autocomplete="off" placeholder="You can use Control + Space to add an item" aria-keyshortcuts="Control+Space"></label></td></tr>';
    }
    var allSel = shown.length > 0 && nSel === shown.length;
    return '<div class="gh-tablewrap"><table class="gh-table gh-ftable' + (nSel ? ' has-sel' : '') + '" style="width:' + total + 'px;--numw:' + numW + 'px" aria-label="Issues table" aria-rowcount="' + list.length + '">' +
      '<colgroup><col style="width:' + numW + 'px"><col data-colw="title" style="width:' + titleW + 'px">' + cols.map(function (id) { return '<col data-colw="' + esc(id) + '" style="width:' + colWidth(id) + 'px">'; }).join('') + '<col style="width:44px"></colgroup>' +
      '<thead><tr><th class="gh-c-num" scope="col"><div class="gh-numcell" style="padding:0 8px 0 6px"><input type="checkbox" data-act="selall"' + (allSel ? ' checked' : '') + ' aria-label="Select all shown issues"><span aria-hidden="true">#</span></div></th>' +
      th('title') + cols.map(th).join('') +
      '<th class="gh-c-plus" scope="col"><button type="button" class="gh-iconbtn" data-act="addfield" aria-haspopup="dialog" aria-label="Add field" title="Add field">' + svg(P.plus, 16) + '</button></th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<div class="gh-more"><span>Showing ' + shown.length + ' of ' + list.length + '</span>' +
      (list.length > shown.length ? '<button type="button" class="gh-btn gh-btn-sm" data-act="more">Load ' + Math.min(PAGE, list.length - shown.length) + ' more</button>' : '') + '</div>';
  }
  function priorityOptions(cur) {
    var opts = PRIORITIES.slice();
    if (!PRIORITIES.some(function (p) { return p.id === cur; })) opts.push(prioOf(cur));
    return opts.map(function (p) { return '<option value="' + esc(p.id) + '"' + (p.id === cur ? ' selected' : '') + '>' + esc(p.label) + '</option>'; }).join('');
  }
  function filteredEmpty() {
    return '<div class="gh-empty">' + svg(P.search, 22) + '<h3>No items match</h3><div>Nothing matches the current filters.</div>' +
      '<button type="button" class="gh-btn" data-act="clearall">Clear filters</button></div>';
  }

  function selectedVisible(list) {
    var ids = [];
    (list || []).slice(0, S.limit).forEach(function (t) { if (S.selected[t.id]) ids.push(t.id); });
    return ids;
  }
  function renderBulk(list) {
    var bar = S.refs.bulk;
    if (!bar) return;
    var ids = S.f.view === 'table' ? selectedVisible(list) : [];
    if (!ids.length) { bar.hidden = true; bar.innerHTML = ''; return; }
    bar.hidden = false;
    var ed = canEdit();
    bar.innerHTML = '<strong>' + ids.length + ' selected</strong>' +
      (ed ? '<label class="gh-sr" for="gh-bulk-st">Set status</label><select id="gh-bulk-st" class="gh-select" data-bulk="stage"><option value="">Set status…</option>' + STATUSES.map(function (s) { return '<option value="' + s.id + '">' + s.label + '</option>'; }).join('') + '</select>' +
        '<label class="gh-sr" for="gh-bulk-pr">Set priority</label><select id="gh-bulk-pr" class="gh-select" data-bulk="priority"><option value="">Set priority…</option>' + PRIORITIES.map(function (p) { return '<option value="' + p.id + '">' + p.label + '</option>'; }).join('') + '</select>' +
        '<button type="button" class="gh-btn gh-btn-sm" data-act="bulkassign">Assign…</button>' +
        '<button type="button" class="gh-btn gh-btn-sm" data-act="bulkclose">' + svg(P.closed, 14) + ' Close</button>' : '') +
      (canDelete() ? '<button type="button" class="gh-btn gh-btn-sm gh-btn-danger" data-act="bulkdelete">' + svg(P.trash, 14) + ' Delete</button>' : '') +
      '<button type="button" class="gh-btn gh-btn-sm gh-btn-invisible" data-act="bulkclear">Clear selection</button>';
  }
  function currentSelection() { return selectedVisible(sortList(applyState(baseFiltered()))).map(findTask).filter(Boolean); }

  function runBulk(tasks, patchFor, verb) {
    if (!tasks.length) return;
    var ok = 0, fail = 0, lastErr = '';
    Promise.all(tasks.map(function (t) {
      var patch = patchFor(t);
      if (!patch) return null;
      return updateTask(t, patch, { silent: true }).then(function () { ok++; }, function (e) { fail++; lastErr = e.message; });
    })).then(function () {
      if (!S || !S.root) return;
      S.selected = {};
      renderChrome(); renderBody();
      if (fail) toast(verb + ': ' + ok + ' updated, ' + fail + ' failed. ' + lastErr, 'err');
      else toast(verb + ': ' + ok + ' issue' + (ok === 1 ? '' : 's') + ' updated.');
    });
    renderBody();
  }

  /* ── board actions ───────────────────────────────────────────────────── */
  function patchForColumn(t, col) {
    if (!col) return null;
    if (col.custom) { var cur = fieldVal(t, col.custom.id); return String(cur == null ? '' : cur) === String(col.value || '') ? null : { __custom: true }; }
    if (col.field === 'issueType') return typeOf(t.issueType).id === col.value ? null : { issueType: col.value };
    if (col.field === 'milestoneId' || col.field === 'teamId') {
      var now = t[col.field] == null ? null : Number(t[col.field]);
      if (now === col.value) return null;
      var pt = {}; pt[col.field] = col.value;
      return pt;
    }
    if (col.field === 'stage') return stageOf(t) === col.value ? null : { stage: col.value };
    if (col.field === 'priority') return prioOf(t.priority).id === col.value ? null : { priority: col.value };
    if (col.field === 'assignee') {
      if (String(t.assigneeEmail || '').toLowerCase() === String(col.value || '').toLowerCase() && (col.value || personName(t) === '')) return null;
      return col.value ? { assigneeEmail: col.value, assignee: col.name || col.value } : { assigneeEmail: '', assignee: '' };
    }
    return null;
  }
  function moveTo(t, col) {
    if (!canEdit()) { toast("You don't have permission to edit issues.", 'err'); return; }
    var patch = patchForColumn(t, col);
    if (!patch) return;
    if (patch.__custom) { setFieldValue(t, col.custom, col.value).then(function () { toast(ref(t) + ' moved to ' + col.label + '.'); }, function () {}); return; }
    updateTask(t, patch).then(function () {
      toast(ref(t) + ' moved to ' + col.label + '.');
    }, function () {});
  }
  function quickCreate(colKey, title) {
    var col = colByKey(colKey);
    var body = { title: title, stage: 'todo', priority: 'medium' };
    if (col && col.field === 'stage') body.stage = col.value;
    if (col && col.field === 'priority') body.priority = col.value;
    if (col && col.field === 'assignee' && col.value) { body.assigneeEmail = col.value; body.assignee = col.name; }
    if (col && col.field === 'issueType') body.issueType = col.value;
    if (col && col.field === 'milestoneId' && col.value) body.milestoneId = col.value;
    if (S.f.project) body.projectId = Number(S.f.project);
    if (S.f.team) body.teamId = Number(S.f.team);
    if (col && col.field === 'teamId' && col.value) body.teamId = col.value;
    return createTask(body).then(function (row) {
      if (row && col && col.custom && col.value) setFieldValue(row, col.custom, col.value).then(null, function () {});
      toast('Created ' + (row ? ref(row) : 'issue') + ' in ' + (col ? col.label : 'the board') + '.');
      return row;
    });
  }

  /* ── popover menus ───────────────────────────────────────────────────── */
  var menu = null;
  function closeMenu(focusBack) {
    closeFlyout();
    if (!menu) return;
    var m = menu;
    menu = null;
    if (m.el.parentNode) m.el.parentNode.removeChild(m.el);
    if (m.onClose) try { m.onClose(); } catch (_) {}
    if (focusBack && m.anchor && document.contains(m.anchor)) { try { m.anchor.focus(); } catch (_) {} }
  }
  // Where the control that opened the last pop-up was. A pop-up opened from
  // inside another one (e.g. a project's "…" in the project picker) closes the
  // first, which detaches its anchor: it then measures 0,0 and the menu landed
  // in the top-left corner. Remember the anchor's position at click/key time.
  var lastAnchor = null, lastAnchorRect = null;
  function rememberAnchor(e) {
    var t = e.target && e.target.closest ? e.target.closest('button, a, [role="button"], [tabindex]') : null;
    if (!t && e.type === 'keydown') t = document.activeElement;
    if (t && t.getBoundingClientRect) { lastAnchor = t; lastAnchorRect = t.getBoundingClientRect(); }
  }
  document.addEventListener('mousedown', rememberAnchor, true);
  document.addEventListener('keydown', rememberAnchor, true);
  function vw() { var d = document.documentElement; return Math.min(window.innerWidth, (d && d.clientWidth) || window.innerWidth); }
  function vh() { var d = document.documentElement; return Math.min(window.innerHeight, (d && d.clientHeight) || window.innerHeight); }
  function placePop(el, anchor) {
    var r = anchor.getBoundingClientRect();
    if ((!document.contains(anchor) || (!r.width && !r.height)) && lastAnchorRect &&
        (lastAnchor === anchor || (lastAnchor && anchor.contains && anchor.contains(lastAnchor)) || !document.contains(anchor))) {
      r = lastAnchorRect;
    }
    var w = el.offsetWidth, h = el.offsetHeight;
    var left = Math.min(Math.max(8, r.right - w), vw() - w - 8);
    if (r.left + w <= vw() - 8 && r.left >= 8) left = r.left;
    var top = r.bottom + 4;
    if (top + h > vh() - 8) top = Math.max(8, r.top - h - 4);
    el.style.left = Math.max(8, left) + 'px';
    el.style.top = top + 'px';
  }
  function popKeys(el, e) {
    var items = Array.prototype.slice.call(el.querySelectorAll('.gh-menu-item:not([disabled])'));
    if (!items.length) return;
    var i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
    else if (e.key === 'Tab') { closeMenu(true); }
  }
  function openMenu(anchor, items, onPick, label) {
    closeMenu();
    var el = document.createElement('div');
    el.className = 'gh-layer gh-pop';
    el.setAttribute('role', 'menu');
    if (label) el.setAttribute('aria-label', label);
    el.innerHTML = items.map(function (it) {
      if (it.sep) return '<div class="gh-menu-sep" role="separator"></div>';
      if (it.header) return '<div class="gh-menu-h">' + esc(it.header) + '</div>';
      return '<button type="button" role="' + (it.checked != null ? 'menuitemradio' : 'menuitem') + '"' + (it.checked != null ? ' aria-checked="' + !!it.checked + '"' : '') +
        ' class="gh-menu-item' + (it.danger ? ' gh-danger' : '') + '" data-v="' + esc(it.v) + '"' + (it.disabled ? ' disabled' : '') + (it.title ? ' title="' + esc(it.title) + '"' : '') + '>' +
        (it.checked != null ? '<span class="gh-check" aria-hidden="true">' + (it.checked ? '✓' : '') + '</span>' : '') +
        (it.icon || '') + '<span>' + esc(it.label) + '</span>' + (it.hint ? '<small>' + esc(it.hint) + '</small>' : '') + '</button>';
    }).join('');
    document.body.appendChild(el);
    placePop(el, anchor);
    menu = { el: el, anchor: anchor };
    el.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-v]') : null;
      if (!b || b.disabled) return;
      var v = b.getAttribute('data-v');
      closeMenu(true);
      onPick(v);
    });
    el.addEventListener('keydown', function (e) { popKeys(el, e); });
    var first = el.querySelector('.gh-menu-item:not([disabled])');
    if (first) first.focus();
  }

  /* Assignee picker: known people first, then /api/tasks/assignees as you type. */
  function knownPeople(teamId) {
    var out = [], seen = {};
    function add(email, name) {
      email = String(email || '').toLowerCase().trim();
      if (!email || seen[email]) return;
      seen[email] = 1;
      if (S.people && name && !S.people[email]) S.people[email] = String(name);
      out.push({ email: email, name: name || email });
    }
    var m = me();
    var team = teamId ? teamById(teamId) : null;
    if (team) {
      if (team.lead && team.lead.email) add(team.lead.email, team.lead.name);
      (team.members || []).forEach(function (p) { add(p.email, p.name); });
      return out;
    }
    if (m.email) add(m.email, m.name || m.email);
    S.teams.forEach(function (t) {
      if (t.lead && t.lead.email) add(t.lead.email, t.lead.name);
      (t.members || []).forEach(function (p) { add(p.email, p.name); });
    });
    S.tasks.forEach(function (t) { if (t.assigneeEmail) add(t.assigneeEmail, t.assignee); });
    out.sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; });
    if (m.email) { out = out.filter(function (p) { return p.email !== m.email; }); out.unshift({ email: m.email, name: (m.name || m.email) + ' (you)' }); }
    return out;
  }
  function openPicker(anchor, opts, onPick) {
    closeMenu();
    opts = opts || {};
    var el = document.createElement('div');
    el.className = 'gh-layer gh-pop gh-picker';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Choose an assignee');
    el.innerHTML = '<input class="gh-input" type="text" placeholder="Search people by name or email" aria-label="Search people" autocomplete="off"><div class="gh-picker-list" role="listbox"></div>';
    document.body.appendChild(el);
    var input = el.querySelector('input'), list = el.querySelector('.gh-picker-list');
    var token = 0, timer = null, local = knownPeople(opts.teamId), remote = [];
    function draw() {
      var q = input.value.trim().toLowerCase();
      var seen = {}, rows = [];
      local.concat(remote).forEach(function (p) {
        if (seen[p.email]) return;
        if (q && p.email.indexOf(q) === -1 && String(p.name).toLowerCase().indexOf(q) === -1) return;
        seen[p.email] = 1;
        rows.push(p);
      });
      var cur = String(opts.current || '').toLowerCase();
      list.innerHTML = (opts.allowNone !== false ? '<button type="button" class="gh-menu-item" role="option" data-email=""><span class="gh-check">' + (!cur ? '✓' : '') + '</span>' + avatar('', '', 20) + '<span>No assignee</span></button>' : '') +
        rows.slice(0, 30).map(function (p) {
          return '<button type="button" class="gh-menu-item" role="option" aria-selected="' + (p.email === cur) + '" data-email="' + esc(p.email) + '" data-name="' + esc(String(p.name).replace(/ \(you\)$/, '')) + '"><span class="gh-check">' + (p.email === cur ? '✓' : '') + '</span>' +
            avatar(p.name, p.email, 20) + '<span>' + esc(p.name) + '</span><small>' + esc(p.email) + '</small></button>';
        }).join('') + (!rows.length ? '<div class="gh-picker-empty">' + (q ? 'No matching people' + (opts.teamId ? ' in this team' : '') + '.' : 'Type to search people.') + '</div>' : '');
    }
    input.addEventListener('input', function () {
      draw();
      clearTimeout(timer);
      var q = input.value.trim();
      if (!q) return;
      var my = ++token;
      timer = setTimeout(function () {
        req('/api/tasks/assignees?q=' + encodeURIComponent(q) + (opts.teamId ? '&teamId=' + encodeURIComponent(opts.teamId) : '')).then(function (rows) {
          if (my !== token || !menu || menu.el !== el) return;
          remote = (rows || []).map(function (p) { return { email: String(p.email || '').toLowerCase(), name: p.name || p.email }; });
          remote.forEach(function (p) { if (!S.people[p.email]) S.people[p.email] = p.name; });
          draw();
        }, function () {});
      }, 200);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); var f = list.querySelector('.gh-menu-item'); if (f) f.focus(); }
      else if (e.key === 'Enter') { e.preventDefault(); var hit = list.querySelectorAll('.gh-menu-item')[input.value.trim() ? 1 : 0] || list.querySelector('.gh-menu-item'); if (hit) hit.click(); }
    });
    list.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowUp' && document.activeElement === list.querySelector('.gh-menu-item')) { e.preventDefault(); input.focus(); return; }
      popKeys(list, e);
    });
    list.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-email]') : null;
      if (!b) return;
      var email = b.getAttribute('data-email');
      closeMenu(true);
      onPick(email ? { email: email, name: b.getAttribute('data-name') || email } : null);
    });
    draw();
    placePop(el, anchor);
    menu = { el: el, anchor: anchor, onClose: function () { clearTimeout(timer); token++; } };
    input.focus();
  }
  function assignPatch(p) { return p ? { assigneeEmail: p.email, assignee: p.name || p.email } : { assigneeEmail: '', assignee: '' }; }

  function openCardMenu(anchor, t) {
    var cols = columns(sortList(applyState(baseFiltered())));
    var cur = null;
    cols.forEach(function (c) { if (!patchForColumn(t, c)) cur = c; });
    var items = [{ header: 'Move to' }];
    cols.forEach(function (c) {
      items.push({ v: 'move:' + c.key, label: c.label, checked: c === cur, disabled: !canEdit() || c === cur });
    });
    if (S.f.group !== 'status') {
      items.push({ sep: true }, { header: 'Status' });
      STATUSES.forEach(function (s) { items.push({ v: 'stage:' + s.id, label: s.label, checked: stageOf(t) === s.id, disabled: !canEdit() || stageOf(t) === s.id }); });
    }
    items.push({ sep: true }, { v: 'open', label: 'Open issue' }, { v: 'copy', label: 'Copy link' });
    if (canEdit()) items.push({ v: isClosed(t) ? 'reopen' : 'close', label: isClosed(t) ? 'Reopen issue' : 'Close issue' });
    openMenu(anchor, items, function (v) {
      if (v.indexOf('move:') === 0) {
        var key = v.slice(5), col = null;
        cols.forEach(function (c) { if (c.key === key) col = c; });
        moveTo(t, col);
      } else if (v.indexOf('stage:') === 0) moveTo(t, { field: 'stage', value: v.slice(6), label: statusOf(v.slice(6)).label });
      else if (v === 'open') openIssue(t.id);
      else if (v === 'copy') copyLink(t);
      else if (v === 'close') moveTo(t, { field: 'stage', value: 'done', label: 'Done' });
      else if (v === 'reopen') moveTo(t, { field: 'stage', value: 'todo', label: 'To Do' });
    }, 'Actions for ' + ref(t));
  }
  function openColMenu(anchor, key) {
    var col = colByKey(key);
    var items = [{ v: 'collapse', label: 'Collapse column' }];
    if (canCreate()) items.push({ v: 'add', label: 'Add item' });
    if (col && col.field === 'stage') items.push({ sep: true }, { v: 'only', label: 'Filter to this status' });
    openMenu(anchor, items, function (v) {
      if (v === 'collapse') { S.collapsed[key] = true; savePrefs(); renderBody(); }
      else if (v === 'add') { S.quickAdd = key; S.quickAddDraft = ''; renderBody(); }
      else if (v === 'only' && col) setFilter({ q: (S.f.q.replace(/(^|\s)-?status:\S+/g, '').trim() + ' status:' + col.value).trim() }, { push: true });
    }, 'Column options');
  }
  function groupChoices() {
    var out = [['status', 'Status'], ['assignee', 'Assignees'], ['priority', 'Priority'], ['type', 'Type'], ['milestone', 'Milestone'], ['team', 'Team']];
    S.fields.forEach(function (cf) { if (cf.type === 'single_select' || cf.type === 'iteration') out.push(['f:' + cf.id, cf.name]); });
    return out;
  }
  function openViewMenu(anchor) {
    var items, sorts = SORTS.slice();
    S.fields.forEach(function (cf) { sorts.push(['f:' + cf.id, cf.name]); });
    if (S.f.view === 'roadmap') {
      items = [{ header: 'Zoom' }].concat(ZOOMS.map(function (z) { return { v: 'zoom:' + z[0], label: z[1], checked: S.vc.zoom === z[0] }; }));
      items.push({ sep: true }, { v: 'fields', label: 'Fields…' });
    } else if (S.f.view === 'board') {
      items = [{ header: 'Group by' }].concat(groupChoices().map(function (g) {
        return { v: 'group:' + g[0], label: g[1], checked: S.f.group === g[0] };
      }));
      items.push({ sep: true }, { v: 'fields', label: 'Fields shown on cards…' }, { sep: true }, { header: 'Sort cards by' });
    } else {
      items = [{ header: 'Group by' }, { v: 'tgroup:', label: 'No grouping', checked: !S.f.tgroup }].concat(groupChoices().map(function (g) {
        return { v: 'tgroup:' + g[0], label: g[1], checked: S.f.tgroup === g[0] };
      }));
      items.push({ sep: true }, { header: 'Sort by' });
    }
    if (S.f.view !== 'roadmap') {
      sorts.forEach(function (s) { items.push({ v: 'sort:' + s[0], label: s[1], checked: S.f.sort === s[0] }); });
      items.push({ sep: true }, { v: 'dir:asc', label: 'Ascending', checked: S.f.dir === 'asc' }, { v: 'dir:desc', label: 'Descending', checked: S.f.dir === 'desc' });
    }
    if (S.f.view === 'board' && Object.keys(S.collapsed).length) items.push({ sep: true }, { v: 'expandall', label: 'Expand all columns' });
    openMenu(anchor, items, function (v) {
      var i = v.indexOf(':'), k = i === -1 ? v : v.slice(0, i), val = i === -1 ? '' : v.slice(i + 1);
      if (k === 'group') setFilter({ group: val }, { push: true });
      else if (k === 'tgroup') setFilter({ tgroup: val }, { push: true });
      else if (k === 'sort') setFilter({ sort: val }, { push: true });
      else if (k === 'dir') setFilter({ dir: val }, { push: true });
      else if (k === 'zoom') { S.vc = { fields: S.vc.fields, widths: S.vc.widths, zoom: val }; vcChanged(); }
      else if (v === 'fields') openAddFieldMenu(anchor);
      else if (v === 'expandall') { S.collapsed = {}; savePrefs(); renderBody(); }
    }, 'View options');
  }

  function copyLink(t) {
    var url = location.origin + BASE + '/issue/' + t.id;
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = url; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      document.body.removeChild(ta);
      toast(ok ? 'Link copied.' : 'Copy this link: ' + url, ok ? 'ok' : 'err');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(function () { toast('Link copied.'); }, fallback);
    else fallback();
  }

  /* ── dialogs ─────────────────────────────────────────────────────────── */
  function openModal(html, opts) {
    opts = opts || {};
    var wrap = document.createElement('div');
    wrap.className = 'gh-layer gh-modal-wrap';
    wrap.innerHTML = '<div class="gh-backdrop" data-x="1"></div>' + html;
    document.body.appendChild(wrap);
    var prevFocus = document.activeElement;
    var entry = {
      el: wrap,
      close: function () {
        var i = S ? S.modals.indexOf(entry) : -1;
        if (i !== -1) S.modals.splice(i, 1);
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
        if (opts.onClose) try { opts.onClose(); } catch (_) {}
        if (prevFocus && document.contains(prevFocus)) try { prevFocus.focus(); } catch (_) {}
      },
      /* Esc / backdrop / Cancel: ask first when the dialog holds unsaved input. */
      requestClose: function () {
        if (opts.confirmClose && opts.confirmClose()) {
          confirmBox({ title: opts.confirmTitle || 'Discard changes?', body: opts.confirmBody || 'You have unsaved changes. They will be lost.', ok: 'Discard', danger: true })
            .then(function (ok) { if (ok) entry.close(); });
        } else entry.close();
      }
    };
    S.modals.push(entry);
    wrap.addEventListener('click', function (e) { if (e.target.getAttribute && e.target.getAttribute('data-x')) entry.requestClose(); });
    wrap.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var f = wrap.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]');
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    return entry;
  }
  function confirmBox(o) {
    return new Promise(function (resolve) {
      var done = false;
      var m = openModal('<div class="gh-modal gh-modal--sm" role="alertdialog" aria-modal="true" aria-labelledby="gh-cf-t" aria-describedby="gh-cf-b">' +
        '<div class="gh-modal-h"><h3 id="gh-cf-t">' + esc(o.title) + '</h3></div>' +
        '<div class="gh-modal-b"><p id="gh-cf-b">' + esc(o.body) + '</p></div>' +
        '<div class="gh-modal-f"><button type="button" class="gh-btn" data-x="1">Cancel</button><button type="button" class="gh-btn ' + (o.danger ? 'gh-btn-danger' : 'gh-btn-primary') + '" data-ok="1">' + esc(o.ok || 'OK') + '</button></div></div>',
        { onClose: function () { if (!done) { done = true; resolve(false); } } });
      m.el.querySelector('[data-ok]').onclick = function () { done = true; m.close(); resolve(true); };
      m.el.querySelector('[data-ok]').focus();
    });
  }

  function allLabels(extra) {
    var all = LABELS.map(function (l) { return l.name; });
    S.tasks.forEach(function (t) { parseLabels(t.labels).forEach(function (n) { if (all.indexOf(n) === -1) all.push(n); }); });
    (extra || []).forEach(function (n) { if (all.indexOf(n) === -1) all.push(n); });
    return all;
  }
  function labelDesc(n) { for (var i = 0; i < LABELS.length; i++) if (LABELS[i].name === n) return LABELS[i].desc; return ''; }
  function cssq(v) { return String(v).replace(/["\\]/g, '\\$&'); }

  /* Searchable list popover (single or multi select) used by the field chips
     and the project picker. items: [{header}] | [{v, label, html, hint, checked}] */
  /* ── Flyout: a row's options shown NEXT TO an open picker without closing
     it (hover a project in the project picker, or click its "…"). ── */
  var flyout = null;
  function closeFlyout(focusBack) {
    if (!flyout) return;
    var f = flyout;
    flyout = null;
    clearTimeout(f.timer);
    if (f.row) f.row.classList.remove('gh-li-open');
    if (f.more) f.more.setAttribute('aria-expanded', 'false');
    if (f.el.parentNode) f.el.parentNode.removeChild(f.el);
    if (focusBack && f.more && document.contains(f.more)) { try { f.more.focus(); } catch (_) {} }
  }
  function openFlyout(row, more, items, onPick, label, focusFirst) {
    if (flyout && flyout.row === row) { if (focusFirst) { var f0 = flyout.el.querySelector('.gh-menu-item:not([disabled])'); if (f0) f0.focus(); } return; }
    closeFlyout();
    var el = document.createElement('div');
    el.className = 'gh-layer gh-pop gh-flyout';
    el.style.zIndex = '100031';
    el.setAttribute('role', 'menu');
    if (label) el.setAttribute('aria-label', label);
    el.innerHTML = items.map(function (it) {
      if (it.sep) return '<div class="gh-menu-sep" role="separator"></div>';
      return '<button type="button" role="menuitem" class="gh-menu-item' + (it.danger ? ' gh-danger' : '') + '" data-v="' + esc(it.v) + '"><span>' + esc(it.label) + '</span></button>';
    }).join('');
    document.body.appendChild(el);
    // Beside the row: to the right of the picker, or to the left if no room.
    var pick = row.closest('.gh-pop') || row, pr = pick.getBoundingClientRect(), rr = row.getBoundingClientRect();
    var w = el.offsetWidth, h = el.offsetHeight;
    var left = pr.right + 4;
    if (left + w > vw() - 8) {
      // No room on the right: on the left of the picker, or else below the row.
      if (pr.left - w - 4 >= 8) left = pr.left - w - 4;
      else left = Math.max(8, Math.min(rr.left + 24, vw() - w - 8));
    }
    var top = Math.min(Math.max(8, rr.top - 6), vh() - h - 8);
    if (left < pr.right && left + w > pr.left) top = Math.min(rr.bottom + 2, vh() - h - 8);   // overlapping: drop it under the row
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    row.classList.add('gh-li-open');
    if (more) more.setAttribute('aria-expanded', 'true');
    flyout = { el: el, row: row, more: more, timer: 0 };
    el.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-v]') : null;
      if (!b) return;
      var v = b.getAttribute('data-v');
      closeMenu(true);
      onPick(v);
    });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); closeFlyout(true); return; }
      popKeys(el, e);
    });
    el.addEventListener('mouseenter', function () { if (flyout) clearTimeout(flyout.timer); });
    el.addEventListener('mouseleave', function () { scheduleFlyoutClose(); });
    if (focusFirst) { var first = el.querySelector('.gh-menu-item:not([disabled])'); if (first) first.focus(); }
  }
  var aim = { x: 0, y: 0, px: 0, py: 0 };
  document.addEventListener('mousemove', function (e) { aim.px = aim.x; aim.py = aim.y; aim.x = e.clientX; aim.y = e.clientY; }, true);
  function aimingAtFlyout() {
    if (!flyout || !flyout.el) return false;
    var r = flyout.el.getBoundingClientRect(), right = r.left > aim.px;
    var ex = right ? r.left : r.right;                  // the near edge
    var dx = ex - aim.px;
    if (!dx || (right ? aim.x < aim.px : aim.x > aim.px)) return false;  // not moving towards it
    // inside the triangle (previous point, near-top corner, near-bottom corner), with some slack
    var t = (aim.x - aim.px) / dx;
    if (t < 0 || t > 1.05) return false;
    var top = aim.py + (r.top - 40 - aim.py) * t, bottom = aim.py + (r.bottom + 40 - aim.py) * t;
    return aim.y >= top && aim.y <= bottom;
  }
  function scheduleFlyoutClose() {
    if (!flyout) return;
    clearTimeout(flyout.timer);
    flyout.timer = setTimeout(function () { closeFlyout(); }, aimingAtFlyout() ? 600 : 350);
  }

  function openListPop(anchor, cfg) {
    closeMenu();
    var el = document.createElement('div');
    el.className = 'gh-layer gh-pop gh-picker' + (cfg.wide ? ' gh-picker-wide' : '');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', cfg.title);
    el.innerHTML = '<div class="gh-menu-h">' + esc(cfg.title) + '</div>' +
      (cfg.top ? '<div class="gh-picker-top">' + cfg.top.map(function (f) { return '<button type="button" class="gh-menu-item" data-footer="1" data-v="' + esc(f.v) + '">' + f.html + '</button>'; }).join('') + '<div class="gh-menu-sep"></div></div>' : '') +
      (cfg.search === false ? '' : '<input class="gh-input" type="text" placeholder="' + esc(cfg.placeholder || 'Filter') + '" aria-label="' + esc(cfg.placeholder || 'Filter') + '" autocomplete="off">') +
      '<div class="gh-picker-list" role="listbox" aria-label="' + esc(cfg.title) + '"' + (cfg.multi ? ' aria-multiselectable="true"' : '') + '></div>';
    document.body.appendChild(el);
    var input = el.querySelector('input'), list = el.querySelector('.gh-picker-list');
    if (cfg.top) el.querySelector('.gh-picker-top').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-v]') : null;
      if (!b) return;
      closeMenu(true);
      cfg.onPick(b.getAttribute('data-v'));
    });
    function draw() {
      var q = input ? input.value.trim().toLowerCase() : '';
      var items = typeof cfg.items === 'function' ? cfg.items() : cfg.items;
      var html = '', any = false, header = null, exact = false;
      items.forEach(function (it) {
        if (it.header) { header = it.header; return; }
        var lab = String(it.label || '').toLowerCase();
        if (lab === q) exact = true;
        if (q && lab.indexOf(q) === -1) return;
        if (header) { html += '<div class="gh-menu-h">' + esc(header) + '</div>'; header = null; }
        any = true;
        var btn = '<button type="button" class="gh-menu-item" role="option" data-v="' + esc(it.v) + '" aria-selected="' + !!it.checked + '"' + (it.disabled ? ' disabled aria-disabled="true"' : '') + '>' +
          '<span class="gh-check" aria-hidden="true">' + (it.checked ? '✓' : '') + '</span>' + (it.html || '<span>' + esc(it.label) + '</span>') +
          (it.hint ? '<small>' + esc(it.hint) + '</small>' : '') + '</button>';
        html += it.more ? '<div class="gh-li-row">' + btn + '<button type="button" class="gh-menu-item gh-li-more" data-more="' + esc(it.v) + '" aria-label="' + esc(it.more) + '" title="' + esc(it.more) + '">' + svg(P.kebab, 14) + '</button></div>' : btn;
      });
      if (!any) html += '<div class="gh-picker-empty">' + esc(cfg.empty || 'Nothing found.') + '</div>';
      if (cfg.create && input && q && !exact) {
        html += '<div class="gh-menu-sep"></div><button type="button" class="gh-menu-item" data-create="1">' + svg(P.plus, 14) + '<span>' + esc(cfg.create.label) + ': “' + esc(input.value.trim()) + '”</span></button>';
      }
      (cfg.footer || []).forEach(function (f, i) {
        html += (i === 0 ? '<div class="gh-menu-sep"></div>' : '') + '<button type="button" class="gh-menu-item" data-footer="1" data-v="' + esc(f.v) + '">' + f.html + '</button>';
      });
      list.innerHTML = html;
    }
    list.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b || b.disabled) return;
      if (b.getAttribute('data-more')) {
        if (cfg.moreItems) {
          var row0 = b.closest('.gh-li-row');
          if (flyout && flyout.row === row0) closeFlyout(); else showMore(row0, true);
          return;
        }
        if (cfg.onMore) cfg.onMore(b.getAttribute('data-more'), b);
        return;
      }
      if (b.getAttribute('data-create')) { var nv = input.value.trim(); closeMenu(true); cfg.create.onCreate(nv); return; }
      var v = b.getAttribute('data-v');
      if (cfg.multi && !b.getAttribute('data-footer')) {
        cfg.onPick(v);
        draw();
        var again = list.querySelector('[data-v="' + cssq(v) + '"]');
        if (again) again.focus();
        return;
      }
      closeMenu(true);
      cfg.onPick(v);
    });
    if (input) {
      input.addEventListener('input', draw);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); var f = list.querySelector('.gh-menu-item'); if (f) f.focus(); }
        else if (e.key === 'Enter') { e.preventDefault(); var hit = list.querySelector('.gh-menu-item'); if (hit) hit.click(); }
        else if (e.key === 'Tab') closeMenu(true);
      });
    }
    function showMore(row, focusFirst) {
      if (!row || !cfg.moreItems) return;
      var more = row.querySelector('[data-more]');
      var v = more && more.getAttribute('data-more');
      var spec = v ? cfg.moreItems(v) : null;
      if (spec) openFlyout(row, more, spec.items, spec.onPick, spec.label, focusFirst);
    }
    if (cfg.moreItems) {
      // Hover a row → its options appear beside it (the picker stays open).
      list.addEventListener('mouseover', function (e) {
        var row = e.target.closest ? e.target.closest('.gh-li-row') : null;
        if (!row) return;
        if (flyout && flyout.row === row) { clearTimeout(flyout.timer); return; }
        clearTimeout(list._hoverT);
        var wait = flyout && aimingAtFlyout() ? 450 : 160;   // heading for the open options: don't swap them yet
        list._hoverT = setTimeout(function () { if (document.contains(row) && row.matches(':hover')) showMore(row, false); }, wait);
      });
      list.addEventListener('mouseout', function (e) {
        var row = e.target.closest ? e.target.closest('.gh-li-row') : null;
        if (row && !row.contains(e.relatedTarget)) { clearTimeout(list._hoverT); if (flyout && flyout.row === row) scheduleFlyoutClose(); }
      });
    }
    list.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowUp' && input && document.activeElement === list.querySelector('.gh-menu-item')) { e.preventDefault(); input.focus(); return; }
      if (cfg.moreItems && e.key === 'ArrowRight') {
        var row = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.gh-li-row') : null;
        if (row) { e.preventDefault(); showMore(row, true); return; }
      }
      popKeys(list, e);
    });
    draw();
    placePop(el, anchor);
    menu = { el: el, anchor: anchor, onClose: cfg.onClose };
    var first = input || list.querySelector('.gh-menu-item[aria-selected="true"]') || list.querySelector('.gh-menu-item');
    if (first) first.focus();
  }
  function openDatePop(anchor, cur, onPick, title) {
    closeMenu();
    title = title || 'Due date';
    var el = document.createElement('div');
    el.className = 'gh-layer gh-pop gh-datepop';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', title);
    el.innerHTML = '<div class="gh-menu-h">' + esc(title) + '</div><input type="date" class="gh-input" value="' + esc(cur || '') + '" aria-label="' + esc(title) + '">' +
      '<div class="gh-box-actions"><button type="button" class="gh-btn gh-btn-sm" data-clear="1">Clear</button><button type="button" class="gh-btn gh-btn-sm gh-btn-primary" data-ok="1">Apply</button></div>';
    document.body.appendChild(el);
    var inp = el.querySelector('input');
    function done(v) { closeMenu(true); onPick(v); }
    el.querySelector('[data-ok]').onclick = function () { var v = inp.value; if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { inp.focus(); return; } done(v); };
    el.querySelector('[data-clear]').onclick = function () { done(''); };
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); el.querySelector('[data-ok]').click(); } });
    placePop(el, anchor);
    menu = { el: el, anchor: anchor };
    inp.focus();
  }

  /* ── shared markdown editor ──────────────────────────────────────────────
     mdeHtml() renders one; behaviour is delegated from document listeners
     (installed in mount) so it survives the pane/panel re-rendering. State
     per editor key lives in S.mde[key] = { tab, onSubmit, onFile }.
     Embedded images are shown in the textarea as short "img:N" tokens and
     expanded back to their data URLs by mdeValue(), so the text stays
     readable while the stored markdown remains self-contained. */
  var MDE_TOOLS = [
    ['heading', 'Heading', P.heading], ['bold', 'Bold (Ctrl+B)', P.bold], ['italic', 'Italic (Ctrl+I)', P.italic],
    ['quote', 'Quote (Ctrl+Shift+.)', P.quote], ['code', 'Code (Ctrl+E)', P.code], ['link', 'Link (Ctrl+K)', P.link], '|',
    ['ul', 'Bulleted list (Ctrl+Shift+8)', P.listUl], ['ol', 'Numbered list (Ctrl+Shift+7)', P.listOl], ['task', 'Task list (Ctrl+Shift+L)', P.tasklist], '|',
    ['mention', 'Mention a person (@)', P.mention], ['ref', 'Reference an issue (#)', P.crossRef], ['saved', 'Saved replies', P.reply], ['undo', 'Undo (Ctrl+Z)', P.undo]
  ];
  var SAVED_REPLIES = [
    ['Thanks', 'Thanks for raising this!'],
    ['Looks good', 'Looks good to me. 👍'],
    ['Need more info', 'Could you share more details — the page, the steps you took and a screenshot?'],
    ['Bug report template', '### Steps to reproduce\n1. \n2. \n\n### Expected\n\n### Actual\n'],
    ['Checklist', '- [ ] \n- [ ] \n- [ ] ']
  ];
  var IMG_MAX = 1024 * 1024, FILE_MAX = 10 * 1024 * 1024;
  function mdeState(key) { return S.mde[key] || (S.mde[key] = { tab: 'write' }); }
  function regImg(url) {
    for (var k in S.imgs) if (Object.prototype.hasOwnProperty.call(S.imgs, k) && S.imgs[k] === url) return k;
    var nk = String(++S.imgSeq);
    S.imgs[nk] = url;
    return nk;
  }
  function collapseImgs(v) {
    return String(v || '').replace(/\]\((data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+\/=]+)\)/gi, function (_, url) { return '](img:' + regImg(url) + ')'; });
  }
  function expandImgs(v) { return String(v || '').replace(/\]\(img:(\d+)\)/g, function (all, k) { return S.imgs[k] ? '](' + S.imgs[k] + ')' : all; }); }
  function mdeEl(key) { return document.querySelector('.gh-mde[data-mde="' + cssq(key) + '"]'); }
  function mdeTa(key) { var ed = mdeEl(key); return ed ? ed.querySelector('.gh-mde-ta') : null; }
  function mdeValue(key) { var ta = mdeTa(key); return ta ? expandImgs(ta.value) : ''; }
  function mdeSet(key, v) { var ed = mdeEl(key), ta = mdeTa(key); if (ta) ta.value = collapseImgs(v); if (ed) setTab(ed, 'write'); }
  function previewHtml(v) {
    return String(v || '').trim() ? md(expandImgs(v)) : '<span class="gh-placeholder">Nothing to preview</span>';
  }
  function mdeHtml(o) {
    var st = mdeState(o.key), pv = st.tab === 'preview', val = collapseImgs(o.value || '');
    var tid = o.id || ('gh-mde-' + o.key), first = true;
    var tools = MDE_TOOLS.map(function (t) {
      if (t === '|') return '<span class="gh-mde-sep" aria-hidden="true"></span>';
      var b = '<button type="button" class="gh-mde-tool" data-mde-cmd="' + t[0] + '" title="' + esc(t[1]) + '" aria-label="' + esc(t[1]) + '" tabindex="' + (first ? '0' : '-1') + '">' + svg(t[2], 16) + '</button>';
      first = false;
      return b;
    }).join('');
    return '<div class="gh-mde' + (o.cls ? ' ' + o.cls : '') + '" data-mde="' + esc(o.key) + '">' +
      '<div class="gh-mde-head"><div class="gh-mde-tabs" role="tablist" aria-label="' + esc(o.label || 'Markdown') + ' editor mode">' +
      '<button type="button" role="tab" class="gh-mde-tab" data-mde-tab="write" aria-selected="' + !pv + '" tabindex="' + (pv ? '-1' : '0') + '">Write</button>' +
      '<button type="button" role="tab" class="gh-mde-tab" data-mde-tab="preview" aria-selected="' + pv + '" tabindex="' + (pv ? '0' : '-1') + '">Preview</button></div>' +
      '<div class="gh-mde-tools" role="toolbar" aria-label="Text formatting" aria-controls="' + esc(tid) + '"' + (pv ? ' hidden' : '') + '>' + tools + '</div></div>' +
      '<div class="gh-mde-body"' + (pv ? ' hidden' : '') + '>' +
      '<label class="gh-sr" for="' + esc(tid) + '">' + esc(o.label || 'Markdown') + '</label>' +
      '<textarea id="' + esc(tid) + '" class="gh-textarea gh-mde-ta"' + (o.ref ? ' data-ref="' + esc(o.ref) + '"' : '') + ' aria-autocomplete="list" aria-describedby="' + esc(tid) + '-hint"' +
      ' placeholder="' + esc(o.placeholder || 'Type your description here…') + '" style="min-height:' + (o.minH || 140) + 'px">' + esc(val) + '</textarea>' +
      '<label class="gh-mde-drop" title="Images (PNG, JPEG, GIF, WebP) up to 1 MB are embedded' + (o.files === 'images' ? '' : '; other files are attached to the issue') + '">' +
      '<input type="file" class="gh-sr" data-mde-file multiple' + (o.files === 'images' ? ' accept="image/png,image/jpeg,image/gif,image/webp"' : '') + '>' + svg(P.paperclip, 14) +
      '<span id="' + esc(tid) + '-hint">Paste, drop, or click to add files' + (o.files === 'images' ? ' (images)' : '') + '</span></label></div>' +
      '<div class="gh-mde-preview gh-md" role="tabpanel" aria-label="Preview"' + (pv ? '' : ' hidden') + '>' + (pv ? previewHtml(val) : '') + '</div></div>';
  }
  function setTab(ed, tab) {
    var st = mdeState(ed.getAttribute('data-mde'));
    st.tab = tab;
    var tabs = ed.querySelectorAll('[data-mde-tab]');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-mde-tab') === tab;
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
      tabs[i].setAttribute('tabindex', on ? '0' : '-1');
    }
    var body = ed.querySelector('.gh-mde-body'), pv = ed.querySelector('.gh-mde-preview'), tools = ed.querySelector('.gh-mde-tools'), ta = ed.querySelector('.gh-mde-ta');
    if (tab === 'preview') { pv.style.minHeight = Math.max(120, body.offsetHeight || 0) + 'px'; pv.innerHTML = previewHtml(ta.value); }
    body.hidden = tab === 'preview';
    pv.hidden = tab !== 'preview';
    tools.hidden = tab === 'preview';
  }
  function refreshPreviews(scope) {
    var eds = scope.querySelectorAll('.gh-mde');
    for (var i = 0; i < eds.length; i++) {
      if (mdeState(eds[i].getAttribute('data-mde')).tab === 'preview') eds[i].querySelector('.gh-mde-preview').innerHTML = previewHtml(eds[i].querySelector('.gh-mde-ta').value);
    }
  }
  /* Replace [start,end) with text through the browser's editing stack, so
     native undo (Ctrl+Z and the Undo button) keeps working. */
  function taReplace(ta, start, end, text, selStart, selEnd) {
    ta.focus();
    ta.setSelectionRange(start, end);
    var ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (_) {}
    if (!ok || ta.value.slice(start, start + text.length) !== text) {
      ta.setRangeText(text, start, end, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    var a = selStart != null ? selStart : start + text.length;
    ta.setSelectionRange(a, selEnd != null ? selEnd : a);
  }
  var LIST_MARK = /^(\s*)([-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d{1,9}[.)]\s+)/;
  function mdeCmd(ta, cmd, anchor) {
    var v = ta.value, s = ta.selectionStart, e = ta.selectionEnd, sel = v.slice(s, e);
    function wrap(pre, post) {
      if (sel && v.slice(s - pre.length, s) === pre && v.slice(e, e + post.length) === post) { taReplace(ta, s - pre.length, e + post.length, sel, s - pre.length, e - pre.length); return; }
      if (sel.length > pre.length + post.length && sel.indexOf(pre) === 0 && sel.slice(-post.length) === post) {
        var inner0 = sel.slice(pre.length, sel.length - post.length);
        taReplace(ta, s, e, inner0, s, s + inner0.length);
        return;
      }
      taReplace(ta, s, e, pre + sel + post, s + pre.length, s + pre.length + sel.length);
    }
    function lines(test, make) {
      var ls = v.lastIndexOf('\n', s - 1) + 1, endAt = e > s && v.charAt(e - 1) === '\n' ? e - 1 : e;
      var le = v.indexOf('\n', endAt);
      if (le === -1) le = v.length;
      var block = v.slice(ls, le), arr = block.split('\n');
      var filled = arr.filter(function (l) { return l.trim(); });
      var all = filled.length > 0 && filled.every(function (l) { return test.test(l); });
      var k = 0;
      var out = arr.map(function (l) {
        if (!l.trim() && arr.length > 1) return l;
        if (all) return l.replace(test, function (m0) { return (m0.match(/^\s*/) || [''])[0]; });
        return make(l, k++);
      }).join('\n');
      if (s === e) { var c = Math.max(ls, s + (out.length - block.length)); taReplace(ta, ls, le, out, c, c); }
      else taReplace(ta, ls, le, out, ls, ls + out.length);
    }
    function relist(mark) {
      return function (l, k) {
        var m = LIST_MARK.exec(l), ind = m ? m[1] : (l.match(/^\s*/) || [''])[0];
        return ind + (typeof mark === 'function' ? mark(k) : mark) + (m ? l.slice(m[0].length) : l.slice(ind.length));
      };
    }
    switch (cmd) {
      case 'bold': wrap('**', '**'); break;
      case 'italic': wrap('_', '_'); break;
      case 'code': if (sel.indexOf('\n') !== -1) wrap('```\n', '\n```'); else wrap('`', '`'); break;
      case 'link':
        if (/^(https?:\/\/|mailto:)\S+$/.test(sel)) taReplace(ta, s, e, '[](' + sel + ')', s + 1, s + 1);
        else taReplace(ta, s, e, '[' + sel + '](url)', s + sel.length + 3, s + sel.length + 6);
        break;
      case 'heading': lines(/^\s{0,3}#{1,6}\s+/, function (l) { return '### ' + l.replace(/^\s{0,3}#{1,6}\s+/, ''); }); break;
      case 'quote': lines(/^\s{0,3}>\s?/, function (l) { return '> ' + l; }); break;
      case 'ul': lines(/^\s*[-*+]\s+(?!\[[ xX]\])/, relist('- ')); break;
      case 'ol': lines(/^\s*\d{1,9}[.)]\s+/, relist(function (k) { return (k + 1) + '. '; })); break;
      case 'task': lines(/^\s*[-*+]\s+\[[ xX]\]\s+/, relist('- [ ] ')); break;
      case 'mention': case 'ref':
        taReplace(ta, s, e, (s > 0 && !/\s/.test(v.charAt(s - 1)) ? ' ' : '') + (cmd === 'mention' ? '@' : '#'));
        acCheck(ta);
        break;
      case 'saved':
        openMenu(anchor || ta, SAVED_REPLIES.map(function (r, i) { return { v: String(i), label: r[0], hint: r[1].split('\n')[0].slice(0, 28) }; }), function (i) {
          var r = SAVED_REPLIES[+i];
          if (r && document.contains(ta)) taReplace(ta, s, e, r[1]);
        }, 'Saved replies');
        break;
      case 'undo': ta.focus(); try { document.execCommand('undo'); } catch (_) {} break;
    }
  }
  function listEnter(ta) {
    var v = ta.value, s = ta.selectionStart;
    if (s !== ta.selectionEnd) return false;
    var ls = v.lastIndexOf('\n', s - 1) + 1, le = v.indexOf('\n', s);
    if (le === -1) le = v.length;
    var m = /^(\s*)([-*+]\s+\[[ xX]\]\s|[-*+]\s|(\d{1,9})([.)])\s)(.*)$/.exec(v.slice(ls, le));
    if (!m || s < ls + m[1].length + m[2].length) return false;
    if (!m[5].trim()) { taReplace(ta, ls, le, ''); return true; }       // empty item ends the list
    var marker = m[3] ? (Number(m[3]) + 1) + m[4] + ' ' : m[2].replace(/\[[xX]\]/, '[ ]');
    taReplace(ta, s, s, '\n' + m[1] + marker);
    return true;
  }
  function listIndent(ta, outdent) {
    var v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    var ls = v.lastIndexOf('\n', s - 1) + 1, le = v.indexOf('\n', e);
    if (le === -1) le = v.length;
    var block = v.slice(ls, le), arr = block.split('\n');
    if (!arr.some(function (l) { return l.trim(); }) || !arr.every(function (l) { return !l.trim() || /^\s*([-*+]|\d{1,9}[.)])\s/.test(l); })) return false;
    var out = arr.map(function (l) { return outdent ? l.replace(/^ {1,2}/, '') : (l.trim() ? '  ' + l : l); }).join('\n');
    if (out === block) return true;
    if (s === e) { var c = Math.max(ls, s + (out.split('\n')[0].length - arr[0].length)); taReplace(ta, ls, le, out, c, c); }
    else taReplace(ta, ls, le, out, ls, ls + out.length);
    return true;
  }
  function readDataUrl(f) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(String(r.result)); };
      r.onerror = function () { rej(r.error); };
      r.readAsDataURL(f);
    });
  }
  function fmtSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function mdeFiles(ed, files) {
    if (!ed || !files) return;
    var key = ed.getAttribute('data-mde'), st = mdeState(key), ta = ed.querySelector('.gh-mde-ta');
    Array.prototype.slice.call(files).forEach(function (f) {
      var name = String(f.name || 'file').replace(/[\[\]()\r\n]/g, '').slice(0, 120) || 'file';
      if (/^image\/(png|jpe?g|gif|webp)$/i.test(f.type || '')) {
        if (f.size > IMG_MAX) { toast('“' + name + '” is ' + fmtSize(f.size) + '. Images up to 1 MB can be embedded.', 'err'); return; }
        readDataUrl(f).then(function (url) {
          if (!document.contains(ta)) return;
          if (mdeState(key).tab === 'preview') setTab(ed, 'write');
          var s = ta.selectionStart, pre = s > 0 && ta.value.charAt(s - 1) !== '\n' ? '\n' : '';
          taReplace(ta, s, ta.selectionEnd, pre + '![' + name + '](img:' + regImg(url) + ')\n');
        }, function () { toast('Could not read “' + name + '”.', 'err'); });
      } else if (st.onFile) {
        if (f.size > FILE_MAX) { toast('“' + name + '” is ' + fmtSize(f.size) + '. Attachments can be up to 10 MB.', 'err'); return; }
        readDataUrl(f).then(function (url) { st.onFile({ name: name, mime: f.type || 'application/octet-stream', data: url, size: f.size }); },
          function () { toast('Could not read “' + name + '”.', 'err'); });
      } else toast('Only images (PNG, JPEG, GIF, WebP) can be added here.', 'err');
    });
  }

  /* @mention / #issue autocomplete */
  function caretXY(ta, pos) {
    var cs = getComputedStyle(ta), div = document.createElement('div');
    ['boxSizing', 'width', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'paddingTop', 'paddingRight',
     'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'textTransform', 'wordSpacing', 'tabSize']
      .forEach(function (p) { div.style[p] = cs[p]; });
    div.style.position = 'fixed'; div.style.visibility = 'hidden'; div.style.whiteSpace = 'pre-wrap'; div.style.overflowWrap = 'break-word';
    div.style.top = '0'; div.style.left = '-9999px'; div.style.borderStyle = 'solid';
    div.textContent = ta.value.slice(0, pos);
    var sp = document.createElement('span');
    sp.textContent = '\u200b';
    div.appendChild(sp);
    document.body.appendChild(div);
    var r = ta.getBoundingClientRect(), lh = parseFloat(cs.lineHeight) || 20;
    var x = r.left + sp.offsetLeft - ta.scrollLeft, y = r.top + sp.offsetTop - ta.scrollTop + lh;
    document.body.removeChild(div);
    return { x: x, y: Math.min(Math.max(y, r.top + lh), r.bottom), lh: lh };
  }
  function acClose() {
    if (!S || !S.ac) return;
    var a = S.ac;
    S.ac = null;
    clearTimeout(a.timer);
    if (a.el && a.el.parentNode) a.el.parentNode.removeChild(a.el);
    if (a.ta) { a.ta.removeAttribute('aria-activedescendant'); a.ta.removeAttribute('aria-controls'); a.ta.setAttribute('aria-expanded', 'false'); }
  }
  function acCheck(ta) {
    if (!S) return;
    var s = ta.selectionStart;
    if (s !== ta.selectionEnd) { acClose(); return; }
    var m = /(^|[\s(\[])([@#])([\w.+@-]{0,60})$/.exec(ta.value.slice(0, s));
    if (!m || (m[2] === '#' && /[^\w-]/.test(m[3]))) { acClose(); return; }
    var q = m[3], start = s - q.length - 1;
    if (!S.ac || S.ac.ta !== ta || S.ac.kind !== m[2] || S.ac.start !== start) { acClose(); S.ac = { ta: ta, kind: m[2], start: start, idx: 0, remote: [], timer: null, seq: 0 }; }
    var a = S.ac;
    a.q = q;
    acDraw();
    if (a.kind === '@' && q && !/@.+\./.test(q)) {
      clearTimeout(a.timer);
      var my = ++a.seq;
      a.timer = setTimeout(function () {
        req('/api/tasks/assignees?q=' + encodeURIComponent(q)).then(function (rows) {
          if (S.ac !== a || my !== a.seq) return;
          a.remote = (rows || []).map(function (p) { return { email: String(p.email || '').toLowerCase(), name: p.name || p.email }; });
          a.remote.forEach(function (p) { if (!S.people[p.email]) S.people[p.email] = p.name; });
          acDraw();
        }, function () {});
      }, 200);
    }
  }
  function acItems() {
    var a = S.ac, q = a.q.toLowerCase();
    if (a.kind === '@') {
      var seen = {}, rows = [];
      knownPeople('').concat(a.remote).forEach(function (p) {
        var em = p.email, nm = String(p.name || em).replace(/ \(you\)$/, '');
        if (!em || seen[em]) return;
        if (q && em.indexOf(q) !== 0 && nm.toLowerCase().indexOf(q) === -1) return;
        seen[em] = 1;
        rows.push({ v: em, html: avatar(nm, em, 20) + '<span>' + esc(nm) + '</span><small>' + esc(em) + '</small>' });
      });
      return rows.slice(0, 8);
    }
    return S.tasks.filter(function (t) { return !q || String(t.id).indexOf(q) === 0 || String(t.title || '').toLowerCase().indexOf(q) !== -1; })
      .slice(0, 8).map(function (t) { return { v: String(t.id), html: stateIcon(t, 14) + '<span class="gh-ref">#' + esc(t.id) + '</span><span class="gh-ac-t">' + esc(t.title) + '</span>' }; });
  }
  function acDraw() {
    var a = S.ac;
    if (!a) return;
    a.items = acItems();
    if (!a.el) {
      a.el = document.createElement('div');
      a.el.className = 'gh-layer gh-pop gh-ac';
      a.el.id = 'gh-ac';
      a.el.setAttribute('role', 'listbox');
      document.body.appendChild(a.el);
      a.el.addEventListener('mousedown', function (e) { e.preventDefault(); });
      a.el.addEventListener('click', function (e) { var b = e.target.closest ? e.target.closest('[data-i]') : null; if (b) acPick(+b.getAttribute('data-i')); });
    }
    a.el.setAttribute('aria-label', a.kind === '@' ? 'Mention a person' : 'Reference an issue');
    if (a.idx >= a.items.length) a.idx = 0;
    a.el.innerHTML = '<div class="gh-menu-h">' + (a.kind === '@' ? 'People' : 'Issues') + '</div>' + (a.items.length ? a.items.map(function (it, i) {
      return '<div class="gh-menu-item" role="option" id="gh-ac-' + i + '" data-i="' + i + '" aria-selected="' + (i === a.idx) + '">' + it.html + '</div>';
    }).join('') : '<div class="gh-picker-empty">' + (a.kind === '@' ? (a.q ? 'No matching people.' : 'Type a name or email.') : 'No matching issues.') + '</div>');
    a.ta.setAttribute('aria-controls', 'gh-ac');
    a.ta.setAttribute('aria-expanded', 'true');
    if (a.items.length) a.ta.setAttribute('aria-activedescendant', 'gh-ac-' + a.idx); else a.ta.removeAttribute('aria-activedescendant');
    var xy = caretXY(a.ta, a.start), w = a.el.offsetWidth, h = a.el.offsetHeight;
    var top = xy.y + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, xy.y - xy.lh - h - 4);
    a.el.style.left = Math.max(8, Math.min(xy.x, window.innerWidth - w - 8)) + 'px';
    a.el.style.top = top + 'px';
  }
  function acKey(e) {
    var a = S.ac;
    if (!a || !a.items) return false;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); acClose(); return true; }
    if (!a.items.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      a.idx = (a.idx + (e.key === 'ArrowDown' ? 1 : -1) + a.items.length) % a.items.length;
      acDraw();
      return true;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); acPick(a.idx); return true; }
    return false;
  }
  function acPick(i) {
    var a = S.ac;
    if (!a || !a.items[i]) return;
    var it = a.items[i], ta = a.ta, end = ta.selectionStart;
    acClose();
    taReplace(ta, a.start, end, a.kind + it.v + ' ');
  }

  /* document-level editor events */
  function mdeOf(e) { return e.target && e.target.closest ? e.target.closest('.gh-mde') : null; }
  function onMdeClick(e) {
    var ed = mdeOf(e);
    if (!ed) return;
    var tab = e.target.closest('[data-mde-tab]');
    if (tab) {
      var which = tab.getAttribute('data-mde-tab');
      setTab(ed, which);
      if (which === 'write') ed.querySelector('.gh-mde-ta').focus(); else tab.focus();
      return;
    }
    var tool = e.target.closest('[data-mde-cmd]');
    if (tool) { e.preventDefault(); mdeCmd(ed.querySelector('.gh-mde-ta'), tool.getAttribute('data-mde-cmd'), tool); return; }
    if (e.target.classList.contains('gh-mde-ta')) acCheck(e.target);
  }
  function onMdeKey(e) {
    if (!S || !S.root) return;
    var t = e.target;
    if (!t || !t.closest) return;
    if (S.ac && t === S.ac.ta && acKey(e)) return;
    var ed = t.closest('.gh-mde');
    if (!ed) return;
    if (t.hasAttribute('data-mde-tab') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      var nt = t.getAttribute('data-mde-tab') === 'write' ? 'preview' : 'write';
      setTab(ed, nt);
      ed.querySelector('[data-mde-tab="' + nt + '"]').focus();
      return;
    }
    if (t.classList.contains('gh-mde-tool') && /^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key)) {
      e.preventDefault();
      var tools = Array.prototype.slice.call(ed.querySelectorAll('.gh-mde-tool')), i = tools.indexOf(t);
      var n = e.key === 'Home' ? 0 : e.key === 'End' ? tools.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tools.length) % tools.length;
      tools.forEach(function (b, k) { b.setAttribute('tabindex', k === n ? '0' : '-1'); });
      tools[n].focus();
      return;
    }
    if (!t.classList.contains('gh-mde-ta')) return;
    var mod = e.ctrlKey || e.metaKey, k = String(e.key || '').toLowerCase();
    if (mod && e.key === 'Enter') {
      var st = mdeState(ed.getAttribute('data-mde'));
      if (st.onSubmit) { e.preventDefault(); e.stopPropagation(); st.onSubmit(); }
      return;
    }
    if (mod && !e.altKey) {
      var c = null;
      if (!e.shiftKey && k === 'b') c = 'bold';
      else if (!e.shiftKey && k === 'i') c = 'italic';
      else if (!e.shiftKey && k === 'k') c = 'link';
      else if (!e.shiftKey && k === 'e') c = 'code';
      else if (e.shiftKey && (e.code === 'Digit8' || k === '*')) c = 'ul';
      else if (e.shiftKey && (e.code === 'Digit7' || k === '&')) c = 'ol';
      else if (e.shiftKey && k === 'l') c = 'task';
      else if (e.shiftKey && (e.code === 'Period' || k === '>')) c = 'quote';
      if (c) { e.preventDefault(); e.stopPropagation(); mdeCmd(t, c); }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing) { if (listEnter(t)) e.preventDefault(); return; }
    if (e.key === 'Tab' && !e.altKey) { if (listIndent(t, e.shiftKey)) { e.preventDefault(); e.stopPropagation(); } }
  }
  function onMdeInput(e) { if (e.target && e.target.classList && e.target.classList.contains('gh-mde-ta')) acCheck(e.target); }
  function onMdeBlur(e) { if (S && S.ac && e.target === S.ac.ta) acClose(); }
  function onMdePaste(e) {
    var ta = e.target;
    if (!ta || !ta.classList || !ta.classList.contains('gh-mde-ta')) return;
    var files = e.clipboardData && e.clipboardData.files;
    if (!files || !files.length) return;
    e.preventDefault();
    mdeFiles(ta.closest('.gh-mde'), files);
  }
  function hasFiles(e) { var ty = e.dataTransfer && e.dataTransfer.types; return !!ty && Array.prototype.indexOf.call(ty, 'Files') !== -1; }
  function onMdeDragOver(e) { var ed = mdeOf(e); if (!ed || !hasFiles(e)) return; e.preventDefault(); ed.classList.add('is-drag'); }
  function onMdeDragLeave(e) { var ed = mdeOf(e); if (ed && !ed.contains(e.relatedTarget)) ed.classList.remove('is-drag'); }
  function onMdeDrop(e) {
    var ed = mdeOf(e);
    if (!ed || !e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    ed.classList.remove('is-drag');
    mdeFiles(ed, e.dataTransfer.files);
  }
  function onMdeChange(e) {
    if (!e.target || !e.target.hasAttribute || !e.target.hasAttribute('data-mde-file')) return;
    mdeFiles(e.target.closest('.gh-mde'), e.target.files);
    e.target.value = '';
  }

  /* ── "Create new issue" dialog (GitHub style) ────────────────────────── */
  function openNewIssue(preset) {
    if (!S || !S.root) return;
    if (!canCreate()) { toast("You don't have permission to create issues.", 'err'); return; }
    preset = preset || {};
    var d = {
      assignee: null, labels: [], type: preset.issueType || 'task', typeSet: !!preset.issueType,
      priority: preset.priority || 'medium', prioSet: !!preset.priority,
      projectId: preset.projectId != null ? String(preset.projectId) : S.f.project, milestoneId: '',
      stage: preset.stage || 'todo', due: '', teamId: S.f.team || '', file: null,
      extra: { due: false, team: !!S.f.team, status: !!preset.stage && preset.stage !== 'todo' }
    };
    var busy = false;
    S.mde.ni = { tab: 'write', onFile: function (f) {
      if (d.file) toast('Replaced “' + d.file.name + '”: an issue has one file attachment (images are embedded in the text).');
      d.file = f;
      drawAtt();
    } };
    var m = openModal('<div class="gh-modal gh-ni" role="dialog" aria-modal="true" aria-labelledby="gh-ni-t">' +
      '<div class="gh-ni-h"><button type="button" class="gh-iconbtn" data-ni="back" aria-label="Back" title="Back">' + svg(P.arrowLeft, 16) + '</button>' +
      '<h3 id="gh-ni-t">Create new issue in <span data-ref="niProj"></span></h3>' +
      '<button type="button" class="gh-iconbtn" data-ni="close" aria-label="Close" title="Close (Esc)">' + svg(P.x, 16) + '</button></div>' +
      '<div class="gh-ni-b">' +
      '<div class="gh-formerr" role="alert" data-ref="err" hidden></div>' +
      '<div class="gh-field"><label for="gh-ni-title">Add a title <span class="gh-req" aria-hidden="true">*</span></label>' +
      '<input id="gh-ni-title" class="gh-input gh-ni-title" maxlength="255" autocomplete="off" placeholder="Title" aria-required="true" aria-describedby="gh-ni-terr"><div class="gh-ferr" id="gh-ni-terr" data-ferr="title"></div></div>' +
      '<div class="gh-field"><span class="gh-flabel">Add a description</span>' +
      mdeHtml({ key: 'ni', id: 'gh-ni-desc', label: 'Description', placeholder: 'Type your description here…', minH: 190, files: 'any' }) + '</div>' +
      '<div class="gh-ni-att" data-ref="att" hidden></div>' +
      '<div class="gh-ni-chips" data-ref="chips" role="group" aria-label="Issue fields"></div>' +
      '<div class="gh-ferr" data-ferr="chips" role="alert"></div>' +
      '</div>' +
      '<div class="gh-ni-f"><label class="gh-check-lbl"><input type="checkbox" data-ref="more"> Create more</label><span class="gh-sp"></span>' +
      '<button type="button" class="gh-btn" data-ni="cancel">Cancel</button>' +
      '<button type="button" class="gh-btn gh-btn-primary" data-ref="submit" title="Create (Ctrl+Enter)" aria-keyshortcuts="Control+Enter"><span data-ref="submitLbl">Create</span> <span class="gh-kbd-inv" aria-hidden="true">⌃⏎</span></button></div></div>',
      {
        confirmClose: function () { return dirty(); }, confirmTitle: 'Discard this issue?',
        confirmBody: 'The title and description you typed will be lost.',
        onClose: function () { if (S && S.mde) delete S.mde.ni; acClose(); }
      });
    var el = m.el;
    function q(sel) { return el.querySelector(sel); }
    function dirty() { return !!(q('#gh-ni-title').value.trim() || mdeValue('ni').trim() || d.file); }
    function drawHead() { var p = projectById(d.projectId); q('[data-ref="niProj"]').textContent = p ? p.name : 'Eversoft HRMS'; }
    function chip(id, icon, label, valHtml, valText, solid, disabledWhy) {
      return '<button type="button" class="gh-chip' + (valHtml ? ' is-set' : '') + (solid ? ' is-solid' : '') + '" data-chip="' + id + '" aria-haspopup="dialog"' +
        (disabledWhy ? ' disabled title="' + esc(disabledWhy) + '"' : ' title="' + esc(label) + '"') + ' aria-label="' + esc(label + (valText ? ': ' + valText : '')) + '">' +
        (id === 'assignee' && valHtml ? '' : svg(icon, 14)) + '<span>' + (valHtml || esc(label)) + '</span></button>';
    }
    function drawChips() {
      var p = projectById(d.projectId), ms = p && p.milestones ? p.milestones : [], mso = null;
      ms.forEach(function (x) { if (String(x.id) === d.milestoneId) mso = x; });
      var ty = typeOf(d.type), pr = prioOf(d.priority), team = teamById(d.teamId), stt = statusOf(d.stage);
      var h = chip('assignee', P.person, 'Assignee', d.assignee ? avatar(d.assignee.name, d.assignee.email, 16) + esc(d.assignee.name) : '', d.assignee && d.assignee.name) +
        chip('label', P.tag, 'Label', d.labels.length ? d.labels.map(function (l) { return labelChip(l); }).join('') : '', d.labels.join(', ')) +
        chip('type', d.typeSet ? TICON[ty.id] : P.open, 'Issue type', d.typeSet ? '<span class="gh-tone-' + ty.tone + '">' + esc(ty.label) + '</span>' : '', d.typeSet ? ty.label : '') +
        chip('priority', P.arrowUp, 'Priority', d.prioSet ? '<span class="gh-tone-' + pr.tone + '">' + esc(pr.label) + '</span>' : '', d.prioSet ? pr.label : '') +
        chip('project', P.table, p ? 'Project' : 'No project', p ? esc(p.name) : '', p ? p.name : '', true) +
        chip('milestone', P.milestone, 'Milestone', mso ? esc(mso.title) : '', mso ? mso.title : '', false, p ? (ms.length ? '' : 'This project has no milestones') : 'Choose a project first');
      if (d.extra.due) h += chip('due', P.calendar, 'Due date', d.due ? esc(fmtDue(d.due)) : '', d.due);
      if (d.extra.team) h += chip('team', P.people, 'Team', team ? esc(team.name) : '', team ? team.name : '');
      if (d.extra.status) h += chip('status', P.open, 'Status', '<span class="gh-tone-' + stt.tone + '">' + esc(stt.label) + '</span>', stt.label);
      if (!(d.extra.due && d.extra.team && d.extra.status)) h += '<button type="button" class="gh-chip gh-chip--icon" data-chip="more" aria-haspopup="dialog" aria-label="Add a field (due date, team, status)" title="Add a field">' + svg(P.plus, 14) + '</button>';
      q('[data-ref="chips"]').innerHTML = h;
    }
    function redraw(id) { drawChips(); var c = q('[data-chip="' + id + '"]'); if (c) try { c.focus(); } catch (_) {} }
    function drawAtt() {
      var box = q('[data-ref="att"]');
      box.hidden = !d.file;
      box.innerHTML = d.file ? '<span class="gh-filechip">' + svg(P.file, 14) + '<span>' + esc(d.file.name) + '</span><small class="gh-muted">' + esc(fmtSize(d.file.size || 0)) + '</small>' +
        '<button type="button" class="gh-iconbtn" data-rmfile="1" aria-label="Remove attachment ' + esc(d.file.name) + '">' + svg(P.x, 14) + '</button></span>' : '';
    }
    q('[data-ref="att"]').addEventListener('click', function (e) { if (e.target.closest('[data-rmfile]')) { d.file = null; drawAtt(); q('#gh-ni-desc').focus(); } });
    q('[data-ref="chips"]').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-chip]') : null;
      if (!b || b.disabled) return;
      var id = b.getAttribute('data-chip');
      if (id === 'assignee') {
        openPicker(b, { teamId: d.teamId, current: d.assignee && d.assignee.email }, function (p) { d.assignee = p; q('[data-ferr="chips"]').textContent = ''; redraw('assignee'); });
      } else if (id === 'label') {
        openListPop(b, {
          title: 'Apply labels to this issue', placeholder: 'Filter labels', multi: true, empty: 'No labels match.',
          items: function () {
            return allLabels(d.labels).map(function (n) {
              return { v: n, label: n, html: '<span class="gh-lbl-dot" style="--h:' + labelHue(n) + '" aria-hidden="true"></span><span>' + esc(n) + '</span>', hint: labelDesc(n), checked: d.labels.indexOf(n) !== -1 };
            });
          },
          onPick: function (n) {
            var i = d.labels.indexOf(n);
            if (i === -1) d.labels.push(n); else d.labels.splice(i, 1);
            if (JSON.stringify(d.labels).length > 500) { d.labels.pop(); toast('Too many labels on one issue.', 'err'); }
            drawChips();
          },
          create: { label: 'Create new label', onCreate: function (v) {
            v = v.replace(/\s+/g, '-').toLowerCase().slice(0, 40);
            if (v && d.labels.indexOf(v) === -1) d.labels.push(v);
            redraw('label');
          } },
          onClose: function () { setTimeout(function () { var c = q('[data-chip="label"]'); if (c && !menu) c.focus(); }, 0); }
        });
      } else if (id === 'type') {
        openListPop(b, { title: 'Select issue type', search: false, items: TYPES.map(function (t) {
          return { v: t.id, label: t.label, hint: t.desc, checked: d.typeSet && d.type === t.id, html: '<span class="gh-tone-' + t.tone + '">' + svg(TICON[t.id], 14) + '</span><span>' + esc(t.label) + '</span>' };
        }), onPick: function (v) { d.type = v; d.typeSet = true; redraw('type'); } });
      } else if (id === 'priority') {
        openListPop(b, { title: 'Select priority', search: false, items: PRIORITIES.map(function (p) {
          return { v: p.id, label: p.label, checked: d.prioSet && d.priority === p.id, html: '<span class="gh-tone-' + p.tone + '">●</span><span>' + esc(p.label) + '</span>' };
        }), onPick: function (v) { d.priority = v; d.prioSet = true; redraw('priority'); } });
      } else if (id === 'project') {
        openListPop(b, { title: 'Select project', placeholder: 'Filter projects', empty: 'No projects found.',
          items: [{ v: '', label: 'No project', checked: !d.projectId }].concat(sortedProjects().map(function (p) {
            return { v: String(p.id), label: p.name, hint: p.projectCode, checked: String(p.id) === d.projectId, html: (isPinned(p.id) ? '<span class="gh-tone-blue">' + svg(P.pin, 14) + '</span>' : svg(P.table, 14)) + '<span>' + esc(p.name) + '</span>' + projStatusPill(p) };
          })),
          onPick: function (v) { if (v !== d.projectId) { d.projectId = v; d.milestoneId = ''; } drawHead(); redraw('project'); } });
      } else if (id === 'milestone') {
        var p = projectById(d.projectId);
        openListPop(b, { title: 'Set milestone', placeholder: 'Filter milestones', empty: 'No milestones.',
          items: [{ v: '', label: 'No milestone', checked: !d.milestoneId }].concat((p && p.milestones || []).map(function (x) {
            return { v: String(x.id), label: x.title, hint: x.dueDate ? 'Due ' + fmtDue(x.dueDate) : '', checked: String(x.id) === d.milestoneId };
          })),
          onPick: function (v) { d.milestoneId = v; redraw('milestone'); } });
      } else if (id === 'due') {
        openDatePop(b, d.due, function (v) { d.due = v; redraw('due'); });
      } else if (id === 'team') {
        openListPop(b, { title: 'Select team', placeholder: 'Filter teams', empty: 'No teams.',
          items: [{ v: '', label: 'No team', checked: !d.teamId }].concat(S.teams.map(function (t) { return { v: String(t.id), label: t.name, hint: t.department || '', checked: String(t.id) === d.teamId }; })),
          onPick: function (v) {
            d.teamId = v;
            var team = teamById(v);
            // The API requires the assignee to belong to the chosen team.
            if (d.assignee && team && !knownPeople(team.id).some(function (p) { return p.email === d.assignee.email; })) {
              d.assignee = null;
              q('[data-ferr="chips"]').textContent = 'Assignee cleared: not a member of ' + team.name + '.';
            }
            redraw('team');
          } });
      } else if (id === 'status') {
        openListPop(b, { title: 'Select status', search: false, items: STATUSES.map(function (s) {
          return { v: s.id, label: s.label, hint: s.hint, checked: d.stage === s.id, html: '<span class="gh-tone-' + s.tone + '">' + svg(P.open, 14) + '</span><span>' + esc(s.label) + '</span>' };
        }), onPick: function (v) { d.stage = v; redraw('status'); } });
      } else if (id === 'more') {
        openListPop(b, { title: 'Add a field', search: false, empty: 'All fields added.',
          items: [['due', 'Due date', P.calendar], ['team', 'Team', P.people], ['status', 'Status', P.open]].filter(function (x) { return !d.extra[x[0]]; })
            .map(function (x) { return { v: x[0], label: x[1], html: svg(x[2], 14) + '<span>' + x[1] + '</span>' }; }),
          onPick: function (v) { d.extra[v] = true; drawChips(); var c = q('[data-chip="' + v + '"]'); if (c) { c.focus(); c.click(); } } });
      }
    });
    function setBusy(on) {
      busy = on;
      var btn = q('[data-ref="submit"]');
      btn.disabled = on;
      q('[data-ref="submitLbl"]').textContent = on ? 'Creating…' : 'Create';
    }
    function submit() {
      if (busy) return;
      var tIn = q('#gh-ni-title'), title = tIn.value.trim(), errs = {};
      if (!title) errs.title = 'Title is required.';
      else if (title.length > 255) errs.title = 'Title must be 255 characters or fewer.';
      if (d.due && !/^\d{4}-\d{2}-\d{2}$/.test(d.due)) errs.chips = 'Enter a valid due date.';
      q('[data-ferr="title"]').textContent = errs.title || '';
      q('[data-ferr="chips"]').textContent = errs.chips || '';
      tIn.setAttribute('aria-invalid', errs.title ? 'true' : 'false');
      if (errs.title || errs.chips) { toast(errs.title || errs.chips, 'err'); if (errs.title) tIn.focus(); return; }
      var body = { title: title, description: mdeValue('ni'), priority: d.priority, stage: d.stage, due: d.due, labels: JSON.stringify(d.labels), issueType: d.type };
      if (d.projectId) body.projectId = Number(d.projectId);
      if (d.milestoneId) body.milestoneId = Number(d.milestoneId);
      if (d.teamId) body.teamId = Number(d.teamId);
      if (d.assignee) { body.assigneeEmail = d.assignee.email; body.assignee = d.assignee.name; }
      if (d.file) { body.attachmentFileName = d.file.name; body.attachmentFileMime = d.file.mime; body.attachmentFileData = d.file.data; }
      var errBox = q('[data-ref="err"]');
      errBox.hidden = true;
      setBusy(true);
      createTask(body).then(function (row) {
        setBusy(false);
        toast('Issue ' + (row ? ref(row) : '') + ' created.');
        if (row && !applyState(baseFiltered()).some(function (t) { return t.id === row.id; })) toast(ref(row) + " doesn't match the current filters, so it isn't shown.", 'ok');
        if (q('[data-ref="more"]').checked) {
          tIn.value = '';
          mdeSet('ni', '');
          d.file = null;
          drawAtt();
          tIn.focus();
        } else m.close();
      }, function (err) {
        setBusy(false);
        errBox.textContent = err.message;
        errBox.hidden = false;
        toast(err.message, 'err');
      });
    }
    q('[data-ref="submit"]').addEventListener('click', submit);
    el.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('[data-ni]')) m.requestClose(); });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); return; }
      if (e.key === 'Enter' && e.target.id === 'gh-ni-title') { e.preventDefault(); q('#gh-ni-desc').focus(); }
    });
    drawHead();
    drawChips();
    q('#gh-ni-title').focus();
  }

  /* ── projects: pins, picker, side panel, new project ────────────────── */
  function pinsKey() { return 'hrms-tasks-pins:' + (me().email || 'anon'); }
  function getPins() {
    try { var a = JSON.parse(localStorage.getItem(pinsKey()) || '[]'); return Array.isArray(a) ? a.map(String) : []; } catch (_) { return []; }
  }
  function isPinned(id) { return getPins().indexOf(String(id)) !== -1; }
  function togglePin(id) {
    var pins = getPins(), i = pins.indexOf(String(id));
    if (i === -1) pins.unshift(String(id)); else pins.splice(i, 1);
    try { localStorage.setItem(pinsKey(), JSON.stringify(pins)); } catch (_) {}
    return i === -1;
  }
  /* Mirrors api/project_views.py: project.create / project.edit (or
     project.manage) / project.delete, and a project's own manager may edit
     and configure that project. */
  function canCreateProject() { return can('project.create'); }
  function canEditProject() { return can('project.edit') || can('project.manage'); }
  function canDeleteProject() { return can('project.delete'); }
  function isProjectManager(p) { return !!p && !!me().email && String(p.projectManager || '').toLowerCase() === me().email; }
  function canManageProject(p) { return !!p && (canEditProject() || isProjectManager(p)); }
  function canPostStatus(p) { return canManageProject(p); }
  function sortedProjects(withArchived) {
    var pins = getPins();
    return S.projects.filter(function (p) { return withArchived || !p.archivedAt || String(p.id) === S.f.project; }).sort(function (a, b) {
      var pa = pins.indexOf(String(a.id)), pb = pins.indexOf(String(b.id));
      if ((pa !== -1) !== (pb !== -1)) return pa !== -1 ? -1 : 1;
      if (pa !== -1) return pa - pb;
      return String(a.name || '').toLowerCase() < String(b.name || '').toLowerCase() ? -1 : 1;
    });
  }
  function replaceProject(row) {
    if (!row || row.id == null) return;
    for (var i = 0; i < S.projects.length; i++) if (String(S.projects[i].id) === String(row.id)) { S.projects[i] = row; return; }
    S.projects.unshift(row);
  }
  function openProjectPicker(anchor) {
    openListPop(anchor, {
      title: 'Switch project', wide: true, placeholder: 'Filter projects',
      empty: S.projErr ? S.projErr : S.projects.length ? 'No matching projects.' : 'No projects yet.',
      items: function () {
        var pins = getPins(), list = sortedProjects(S.showArchived);
        var out = [{ v: '', label: 'All projects', checked: !S.f.project, html: svg(P.board, 14) + '<span>All projects</span>' }];
        function item(p, pinned) {
          return { v: String(p.id), label: p.name + ' ' + (p.projectCode || ''), checked: String(p.id) === S.f.project, more: 'More actions for ' + p.name,
            html: (pinned ? '<span class="gh-tone-blue" title="Pinned">' + svg(P.pin, 14) + '</span>' : svg(P.table, 14)) + '<span>' + esc(p.name) + '</span>' + projStatusPill(p) +
              (p.archivedAt ? ' <span class="gh-pill gh-tone-gray">Archived</span>' : ''),
            hint: p.projectCode };
        }
        var pinned = list.filter(function (p) { return pins.indexOf(String(p.id)) !== -1 && !p.archivedAt; });
        var rest = list.filter(function (p) { return pins.indexOf(String(p.id)) === -1 && !p.archivedAt; });
        var arch = list.filter(function (p) { return !!p.archivedAt; });
        if (pinned.length) { out.push({ header: 'Pinned' }); pinned.forEach(function (p) { out.push(item(p, true)); }); }
        if (rest.length) { out.push({ header: pinned.length ? 'Other projects' : 'Projects' }); rest.forEach(function (p) { out.push(item(p, false)); }); }
        if (arch.length) { out.push({ header: 'Archived' }); arch.forEach(function (p) { out.push(item(p, false)); }); }
        return out;
      },
      footer: (S.projErr ? [{ v: '__retry', html: '<span class="gh-check" aria-hidden="true">⚠</span><span>' + esc(S.projErr) + ' — click to retry</span>' }]
        : (!S.projects.length && !canCreateProject()) ? [{ v: '__none', html: '<span class="gh-check" aria-hidden="true">ℹ</span><span>No projects yet. Ask an HR Manager, Manager or Team Lead to create one.</span>' }] : []).concat(S.projects.some(function (p) { return p.archivedAt; }) ? [{ v: '__arch', html: '<span class="gh-check" aria-hidden="true">' + (S.showArchived ? '✓' : '') + '</span><span>Show archived projects (' +
        S.projects.filter(function (p) { return p.archivedAt; }).length + ')</span>' }] : [])
        .concat(canCreateProject() ? [{ v: '__new', html: svg(P.plus, 14) + '<span>New project</span>' }] : []),
      onMore: function (v, b) { var p = projectById(v); if (p) openProjectMore(b, p); },
      moreItems: function (v) {
        var p = projectById(v);
        if (!p) return null;
        return { items: projectMoreItems(p), label: 'Actions for ' + p.name, onPick: function (a) { doProjectAction(a, p); } };
      },
      onPick: function (v) {
        if (v === '__new') openNewProject();
        else if (v === '__retry') { loadMeta(); }
        else if (v === '__none') { /* information only */ }
        else if (v === '__arch') { S.showArchived = !S.showArchived; setTimeout(function () { if (S && S.refs.proj) openProjectPicker(S.refs.proj); }, 0); }
        else setFilter({ project: v }, { push: true });
      }
    });
  }

  function openProjectPanel(id) {
    if (!S || !S.root || !id) return;
    closeMenu();
    S.pp = { id: String(id), editDesc: false, editReadme: false, form: null, updates: null, uerr: '', busy: false, focus: null, descDraft: null, readmeDraft: null };
    S.mde.readme = { tab: 'write' };
    S.mde.supd = { tab: 'write' };
    renderPP();
    loadUpdates();
    if (!projectById(id)) refreshProject(id).then(null, function (e) { if (S && S.pp) { toast(e.message, 'err'); closePP(); } });
  }
  function closePP() {
    if (!S || !S.pp) return;
    S.pp = null;
    acClose();
    var w = document.getElementById('gh-ppanel');
    if (w && w.parentNode) w.parentNode.removeChild(w);
    var b = S.root && S.root.querySelector('[data-act="projinfo"]');
    if (b && !b.hidden) try { b.focus(); } catch (_) {}
  }
  function loadUpdates() {
    var pp = S.pp, st = S;
    if (!pp) return;
    req('/api/projects/' + pp.id + '/status-updates').then(function (rows) {
      if (st !== S || S.pp !== pp) return;
      pp.updates = Array.isArray(rows) ? rows : [];
      pp.uerr = '';
      renderPP();
    }, function (e) {
      if (st !== S || S.pp !== pp) return;
      pp.updates = pp.updates || [];
      pp.uerr = e.message;
      renderPP();
    });
  }
  function refreshProject(id) {
    var st = S;
    return req('/api/projects/' + id).then(function (row) {
      if (st !== S || !S.root) return row;
      replaceProject(row);
      renderChrome();
      if (S.pp) renderPP();
      return row;
    });
  }
  function saveProject(p, patch, msg) {
    var st = S;
    return req('/api/projects/' + p.id, { method: 'PUT', body: patch }).then(function (row) {
      if (st !== S) return row;
      replaceProject(row);
      renderChrome();
      toast(msg);
      return row;
    }, function (e) { if (st === S) toast(e.message, 'err'); throw e; });
  }
  function renderPP() {
    if (!S || !S.pp) return;
    var pp = S.pp, p = projectById(pp.id);
    var wrap = document.getElementById('gh-ppanel'), fresh = !wrap;
    if (fresh) {
      wrap = document.createElement('div');
      wrap.id = 'gh-ppanel';
      wrap.className = 'gh-layer gh-pane-wrap';
      document.body.appendChild(wrap);
      wrap.addEventListener('click', ppClick);
      wrap.addEventListener('input', ppInput);
      wrap.addEventListener('change', ppInput);
      wrap.addEventListener('keydown', ppKeys);
    }
    var sc = wrap.querySelector('.gh-pane-scroll'), sTop = sc ? sc.scrollTop : 0;
    var ae = document.activeElement, focusSel = null;
    if (ae && wrap.contains(ae)) {
      if (ae.getAttribute('data-pp')) focusSel = '[data-pp="' + ae.getAttribute('data-pp') + '"]' + (ae.getAttribute('data-uid') ? '[data-uid="' + ae.getAttribute('data-uid') + '"]' : '');
      else if (ae.id) focusSel = '#' + ae.id;
    }
    if (p) {
      mdeState('readme').onSubmit = function () { ppClick({ target: wrap.querySelector('[data-pp="savereadme"]') }); };
      mdeState('supd').onSubmit = function () { saveUpdate(p); };
    }
    wrap.innerHTML = '<div class="gh-backdrop" data-pp="close"></div><aside class="gh-pane gh-pp" role="dialog" aria-modal="true" aria-labelledby="gh-pp-title">' +
      (p ? ppHtml(p, pp) : '<div class="gh-pp-h"><h2 id="gh-pp-title">Project</h2><button type="button" class="gh-iconbtn" data-pp="close" aria-label="Close">' + svg(P.x, 16) + '</button></div>' +
        '<div class="gh-pane-scroll"><div class="gh-pp-b"><div class="gh-skel" style="height:24px;width:50%"></div><div class="gh-skel" style="height:120px"></div></div></div>') + '</aside>';
    refreshPreviews(wrap);
    var sc2 = wrap.querySelector('.gh-pane-scroll');
    if (sc2 && !fresh) sc2.scrollTop = sTop;
    var target = (pp.focus && wrap.querySelector(pp.focus)) || (focusSel && wrap.querySelector(focusSel)) || (fresh ? wrap.querySelector('.gh-pp-h [data-pp="close"]') : null);
    pp.focus = null;
    if (target) try { target.focus({ preventScroll: !fresh && !pp.scrollTo }); } catch (_) {}
  }
  function ppHtml(p, pp) {
    var edit = canManageProject(p), del = canDeleteProject(), post = canPostStatus(p), pinned = isPinned(p.id);
    var head = '<div class="gh-pp-h"><span class="gh-proj-icon" aria-hidden="true">' + svg(P.table, 16) + '</span><h2 id="gh-pp-title">' + esc(p.name) + '</h2>' +
      (p.latestStatus ? pstatusPill(p.latestStatus) : '') +
      '<button type="button" class="gh-iconbtn" data-pp="pin" aria-pressed="' + pinned + '" aria-label="' + (pinned ? 'Unpin project' : 'Pin project to the top of the project list') + '" title="' + (pinned ? 'Unpin' : 'Pin') + ' project">' + svg(P.pin, 16) + '</button>' +
      '<button type="button" class="gh-iconbtn" data-pp="close" aria-label="Close project panel (Esc)" title="Close">' + svg(P.x, 16) + '</button></div>';
    var dv = pp.descDraft != null ? pp.descDraft : (p.description || '');
    var desc = '<section aria-labelledby="gh-pp-dh"><div class="gh-pp-sh"><h3 id="gh-pp-dh">Short description</h3>' +
      (edit && !pp.editDesc ? '<button type="button" class="gh-iconbtn" data-pp="editdesc" aria-label="Edit short description" title="Edit">' + svg(P.pencil, 14) + '</button>' : '') + '</div>' +
      (pp.editDesc
        ? '<label class="gh-sr" for="gh-pp-desc">Short description</label><input id="gh-pp-desc" class="gh-input gh-w100" data-ref="ppDesc" maxlength="255" value="' + esc(dv) + '" placeholder="A short description of this project" aria-describedby="gh-pp-dn">' +
          '<div class="gh-pp-row"><span id="gh-pp-dn" class="gh-counter" data-ref="ppDescN">' + dv.length + ' / 255</span><span class="gh-sp"></span>' +
          '<button type="button" class="gh-btn gh-btn-sm" data-pp="canceldesc">Cancel</button><button type="button" class="gh-btn gh-btn-sm gh-btn-primary" data-pp="savedesc">Save</button></div>'
        : (p.description ? '<p class="gh-pp-text">' + esc(p.description) + '</p>' : '<p class="gh-pp-empty">' + (edit ? 'Add a short description so people know what this project is for.' : 'No description.') + '</p>')) + '</section>';
    var readme = '<section aria-labelledby="gh-pp-rh"><div class="gh-pp-sh"><h3 id="gh-pp-rh">' + svg(P.book, 14) + ' README</h3>' +
      (edit && !pp.editReadme ? '<button type="button" class="gh-iconbtn" data-pp="editreadme" aria-label="Edit README" title="Edit">' + svg(P.pencil, 14) + '</button>' : '') + '</div>' +
      (pp.editReadme
        ? mdeHtml({ key: 'readme', id: 'gh-pp-readme', value: pp.readmeDraft != null ? pp.readmeDraft : (p.readme || ''), label: 'README', minH: 200, files: 'images',
            placeholder: 'Let everyone know what this project is about, how to use it and link to important resources.' }) +
          '<div class="gh-box-actions"><button type="button" class="gh-btn gh-btn-sm" data-pp="cancelreadme">Cancel</button><button type="button" class="gh-btn gh-btn-sm gh-btn-primary" data-pp="savereadme">Save</button></div>'
        : (String(p.readme || '').trim() ? '<div class="gh-md gh-pp-readme" data-readme="1">' + md(p.readme, { interactive: edit }) + '</div>'
          : '<p class="gh-pp-empty">Let everyone know what this project is about, how to use it and link to important resources.</p>')) + '</section>';
    var ups = pp.updates, list;
    if (ups == null) list = '<div class="gh-skel" style="height:90px"></div>';
    else if (!ups.length) {
      list = pp.form ? '' : '<div class="gh-su-empty"><span class="gh-su-ic">' + svg(P.pulse, 20) + '</span><h4>Add a project status update</h4>' +
        '<p>Let people know how the project is going: whether it is on track, any blockers, and its start and target dates. The latest update shows next to the project name.</p>' +
        '<div class="gh-su-acts">' + (post ? '<button type="button" class="gh-btn gh-btn-primary" data-pp="addupd">Add update</button>' : '<span class="gh-muted">Only the project manager or project editors can post updates.</span>') +
        '<button type="button" class="gh-linkbtn" data-pp="learn" aria-haspopup="dialog">Learn more</button></div></div>';
    } else list = ups.map(function (u, i) { return updHtml(u, p, i === 0); }).join('');
    var status = '<section aria-labelledby="gh-pp-sh"><div class="gh-pp-sh"><h3 id="gh-pp-sh">' + svg(P.pulse, 14) + ' Status updates</h3>' +
      (post && ups && ups.length && !pp.form ? '<button type="button" class="gh-btn gh-btn-sm" data-pp="addupd">' + svg(P.plus, 14) + ' Add update</button>' : '') + '</div>' +
      (pp.uerr ? '<div class="gh-error" role="alert"><span>Status updates could not be loaded: ' + esc(pp.uerr) + '</span><button type="button" class="gh-btn gh-btn-sm" data-pp="reload">Retry</button></div>' : '') +
      (pp.form ? supdFormHtml(pp.form) : '') + '<div class="gh-su-list">' + list + '</div></section>';
    var teams = (p.contributingTeams || []).map(function (t) { return t.name; }).join(', ');
    var ts = p.taskStats || {};
    var state = ''; PROJ_STATES.forEach(function (x) { if (x[0] === p.status) state = x[1]; });
    var meta = '<section aria-labelledby="gh-pp-mh"><div class="gh-pp-sh"><h3 id="gh-pp-mh">Details</h3>' +
      (edit ? '<button type="button" class="gh-btn gh-btn-sm" data-pp="editproj">' + svg(P.pencil, 14) + ' Edit project</button>' : '') + '</div><dl class="gh-pp-meta">' +
      '<dt>Code</dt><dd>' + esc(p.projectCode || '—') + '</dd><dt>State</dt><dd>' + esc(state || p.status || '—') + '</dd>' +
      '<dt>Manager</dt><dd>' + esc((S.people[String(p.projectManager || '').toLowerCase()] || p.projectManager) || '—') + '</dd>' +
      '<dt>Dates</dt><dd>' + esc(p.startDate ? fmtDue(p.startDate) : '—') + ' → ' + esc(p.targetEndDate ? fmtDue(p.targetEndDate) : '—') + '</dd>' +
      '<dt>Teams</dt><dd>' + esc(teams || '—') + '</dd>' +
      '<dt>Issues</dt><dd>' + esc((ts.total || 0) + ' total · ' + (ts.done || 0) + ' done (' + (ts.completionRate || 0) + '%)') + '</dd>' +
      (p.archivedAt ? '<dt>Archived</dt><dd>' + esc(fmtAbs(p.archivedAt)) + '</dd>' : '') + '</dl></section>';
    var danger = (edit || del) ? '<section aria-labelledby="gh-pp-zh"><div class="gh-pp-sh"><h3 id="gh-pp-zh" class="gh-tone-red">Danger zone</h3></div><div class="gh-dz">' +
      (edit ? '<div class="gh-dz-row"><div><b>' + (p.archivedAt ? 'Restore project' : 'Archive project') + '</b><p>' + (p.archivedAt
        ? 'Show this project in the project picker again.'
        : 'Hide it from the project picker. Issues, views and fields are kept and you can restore it any time.') + '</p></div>' +
      '<button type="button" class="gh-btn gh-btn-sm" data-pp="archive">' + (p.archivedAt ? 'Restore' : 'Archive') + '</button></div>' : '') +
      (del ? '<div class="gh-dz-row"><div><b>Delete project</b><p>Permanently delete this project, its views, fields, milestones and status updates. Its issues are kept and unlinked.</p></div>' +
      '<button type="button" class="gh-btn gh-btn-sm gh-btn-danger" data-pp="delete">Delete project</button></div>' : '') + '</div></section>' : '';
    return head + '<div class="gh-pane-scroll"><div class="gh-pp-b">' + desc + readme + '<hr class="gh-pp-div">' + status + meta + danger + '</div></div>';
  }
  function supdFormHtml(f) {
    return '<div class="gh-su-form" role="group" aria-labelledby="gh-su-fh"><h4 id="gh-su-fh" class="gh-su-fh">' + (f.id ? 'Edit status update' : 'New status update') + '</h4>' +
      '<fieldset class="gh-su-st"><legend>Status</legend>' + PSTATUS.map(function (s) {
        return '<label><input type="radio" name="gh-su-status" value="' + s.id + '" data-su="status"' + (f.status === s.id ? ' checked' : '') + '><span class="gh-pill gh-tone-' + s.tone + '">' + esc(s.label) + '</span></label>';
      }).join('') + '</fieldset>' +
      '<div class="gh-grid2"><div class="gh-field"><label for="gh-su-start">Start date</label><input id="gh-su-start" type="date" class="gh-input" data-su="start" value="' + esc(f.start || '') + '"></div>' +
      '<div class="gh-field"><label for="gh-su-target">Target date</label><input id="gh-su-target" type="date" class="gh-input" data-su="target" value="' + esc(f.target || '') + '"></div></div>' +
      '<div class="gh-ferr" data-ref="suErr" role="alert">' + esc(f.err || '') + '</div>' +
      '<div class="gh-field"><span class="gh-flabel">Update</span>' + mdeHtml({ key: 'supd', id: 'gh-su-body', value: f.body || '', label: 'Status update', minH: 120, files: 'images',
        placeholder: 'What happened since the last update? Any blockers or risks?' }) + '</div>' +
      '<div class="gh-box-actions"><button type="button" class="gh-btn" data-pp="cancelupd">Cancel</button>' +
      '<button type="button" class="gh-btn gh-btn-primary" data-pp="saveupd"' + (S.pp && S.pp.busy ? ' disabled' : '') + '>' + (f.id ? 'Save update' : 'Post update') + '</button></div></div>';
  }
  function updHtml(u, p, latest) {
    var mine = !!me().email && String(u.authorEmail || '').toLowerCase() === me().email, may = mine || canPostStatus(p);
    var dates = (u.startDate ? 'Start ' + fmtDue(u.startDate) : '') + (u.targetDate ? (u.startDate ? ' · ' : '') + 'Target ' + fmtDue(u.targetDate) : '');
    var who = u.authorName || u.authorEmail || 'Someone';
    return '<article class="gh-box gh-su-item" aria-label="Status update by ' + esc(who) + '"><div class="gh-box-h">' + avatar(who, u.authorEmail, 20) + '<strong>' + esc(who) + '</strong> ' + timeEl(u.createdAt) + ' ' + pstatusPill(u) +
      (latest ? ' <span class="gh-badge">Latest</span>' : '') +
      '<span class="gh-sp">' + (may ? '<button type="button" class="gh-iconbtn" data-pp="editupd" data-uid="' + esc(u.id) + '" aria-label="Edit status update" title="Edit">' + svg(P.pencil, 14) + '</button>' +
        '<button type="button" class="gh-iconbtn" data-pp="delupd" data-uid="' + esc(u.id) + '" aria-label="Delete status update" title="Delete">' + svg(P.trash, 14) + '</button>' : '') + '</span></div>' +
      (dates ? '<div class="gh-su-dates">' + svg(P.calendar, 12) + ' ' + esc(dates) + '</div>' : '') +
      (String(u.body || '').trim() ? '<div class="gh-box-b gh-md">' + md(u.body) + '</div>' : '<div class="gh-box-b gh-muted">No details.</div>') + '</article>';
  }
  function ppInput(e) {
    var pp = S && S.pp, t = e.target;
    if (!pp) return;
    if (t.getAttribute('data-ref') === 'ppDesc') {
      pp.descDraft = t.value;
      var n = S && document.querySelector('#gh-ppanel [data-ref="ppDescN"]');
      if (n) { n.textContent = t.value.length + ' / 255'; n.classList.toggle('is-over', t.value.length > 255); }
    } else if (pp.form && t.getAttribute('data-su')) {
      var k = t.getAttribute('data-su');
      if (k === 'status') { if (t.checked) pp.form.status = t.value; } else pp.form[k] = t.value;
    } else if (t.classList && t.classList.contains('gh-mde-ta')) {
      var key = t.closest('.gh-mde').getAttribute('data-mde');
      if (key === 'readme') pp.readmeDraft = t.value;
      else if (key === 'supd' && pp.form) pp.form.body = t.value;
    }
  }
  function ppKeys(e) {
    var t = e.target;
    if (t.getAttribute && t.getAttribute('data-ref') === 'ppDesc' && e.key === 'Enter') { e.preventDefault(); ppClick({ target: document.querySelector('#gh-ppanel [data-pp="savedesc"]') }); return; }
    if (e.key === 'Tab') {
      var f = Array.prototype.filter.call(document.querySelectorAll('#gh-ppanel .gh-pp button:not([disabled]),#gh-ppanel .gh-pp input:not([disabled]),#gh-ppanel .gh-pp textarea,#gh-ppanel .gh-pp a[href]'),
        function (x) { return x.offsetParent !== null && x.getAttribute('tabindex') !== '-1'; });
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  }
  function ppClick(e) {
    var t = e.target;
    if (!t || !S || !S.pp) return;
    var pp = S.pp, p = projectById(pp.id);
    var cb = t.closest && t.closest('[data-readme] .gh-md-cb[data-task]');
    if (cb && p) {
      var nd = toggleTaskSrc(p.readme || '', +cb.getAttribute('data-task'));
      if (nd != null) saveProject(p, { readme: nd }, 'README updated.').then(function () { renderPP(); }, function () { renderPP(); });
      return;
    }
    var b = t.closest ? t.closest('[data-pp]') : null;
    if (!b) return;
    var act = b.getAttribute('data-pp');
    if (act === 'close') { closePP(); return; }
    if (!p) return;
    switch (act) {
      case 'pin':
        var on = togglePin(p.id);
        renderPP(); renderChrome();
        toast(on ? 'Pinned “' + p.name + '”. It now appears first in the project picker.' : 'Unpinned “' + p.name + '”.');
        break;
      case 'editdesc': pp.editDesc = true; pp.descDraft = null; pp.focus = '#gh-pp-desc'; renderPP(); break;
      case 'canceldesc': pp.editDesc = false; pp.descDraft = null; pp.focus = '[data-pp="editdesc"]'; renderPP(); break;
      case 'savedesc':
        var inp = document.querySelector('#gh-pp-desc'), v = inp ? inp.value.trim() : '';
        if (v.length > 255) { toast('Short description must be 255 characters or fewer.', 'err'); if (inp) inp.focus(); return; }
        if (v === (p.description || '')) { pp.editDesc = false; pp.focus = '[data-pp="editdesc"]'; renderPP(); return; }
        saveProject(p, { description: v }, 'Short description saved.').then(function () {
          if (S.pp !== pp) return;
          pp.editDesc = false; pp.descDraft = null; pp.focus = '[data-pp="editdesc"]'; renderPP();
        }, function () {});
        break;
      case 'editreadme': pp.editReadme = true; pp.readmeDraft = null; S.mde.readme = { tab: 'write' }; pp.focus = '#gh-pp-readme'; renderPP(); break;
      case 'cancelreadme': pp.editReadme = false; pp.readmeDraft = null; pp.focus = '[data-pp="editreadme"]'; renderPP(); break;
      case 'savereadme':
        var rv = mdeValue('readme');
        saveProject(p, { readme: rv }, 'README saved.').then(function () {
          if (S.pp !== pp) return;
          pp.editReadme = false; pp.readmeDraft = null; pp.focus = '[data-pp="editreadme"]'; renderPP();
        }, function () {});
        break;
      case 'addupd':
        var ls = p.latestStatus;
        pp.form = { id: null, status: (ls && ls.status) || 'on_track', start: (ls && ls.startDate) || p.startDate || '', target: (ls && ls.targetDate) || p.targetEndDate || '', body: '' };
        S.mde.supd = { tab: 'write' };
        pp.focus = '[data-su="status"]:checked';
        renderPP();
        break;
      case 'editupd':
        var u = null;
        (pp.updates || []).forEach(function (x) { if (String(x.id) === b.getAttribute('data-uid')) u = x; });
        if (!u) return;
        pp.form = { id: u.id, status: u.status, start: u.startDate || '', target: u.targetDate || '', body: collapseImgs(u.body || '') };
        S.mde.supd = { tab: 'write' };
        pp.focus = '#gh-su-body';
        renderPP();
        break;
      case 'cancelupd': pp.form = null; pp.focus = '[data-pp="addupd"]'; renderPP(); break;
      case 'saveupd': saveUpdate(p); break;
      case 'delupd':
        var uid = b.getAttribute('data-uid'), st = S;
        confirmBox({ title: 'Delete status update?', body: 'This status update will be permanently removed.', ok: 'Delete', danger: true }).then(function (ok) {
          if (!ok || st !== S) return;
          req('/api/projects/' + p.id + '/status-updates/' + uid, { method: 'DELETE' }).then(function () {
            toast('Status update deleted.');
            loadUpdates();
            refreshProject(p.id).then(null, function () {});
          }, function (err) { toast(err.message, 'err'); });
        });
        break;
      case 'reload': pp.uerr = ''; loadUpdates(); break;
      case 'learn': openHelpPop(b); break;
      case 'editproj': openEditProject(p); break;
      case 'archive': setArchived(p, !p.archivedAt); break;
      case 'delete': openDeleteProject(p); break;
    }
  }
  function saveUpdate(p) {
    var pp = S.pp;
    if (!pp || !pp.form || pp.busy) return;
    var f = pp.form;
    f.body = (mdeTa('supd') || {}).value || f.body || '';
    if (f.start && f.target && f.target < f.start) { f.err = 'Target date cannot be before the start date.'; renderPP(); toast(f.err, 'err'); return; }
    f.err = '';
    var body = { status: f.status || 'on_track', startDate: f.start || null, targetDate: f.target || null, body: expandImgs(f.body) };
    pp.busy = true;
    renderPP();
    var st = S;
    req('/api/projects/' + p.id + '/status-updates' + (f.id ? '/' + f.id : ''), { method: f.id ? 'PATCH' : 'POST', body: body }).then(function () {
      if (st !== S) return;
      pp.busy = false;
      toast(f.id ? 'Status update saved.' : 'Status update posted.');
      if (S.pp === pp) { pp.form = null; pp.focus = '[data-pp="addupd"]'; }
      loadUpdates();
      refreshProject(p.id).then(null, function () {});
    }, function (e) {
      if (st !== S) return;
      pp.busy = false;
      f.err = e.message;
      toast(e.message, 'err');
      if (S.pp === pp) renderPP();
    });
  }
  function openHelpPop(anchor) {
    closeMenu();
    var el = document.createElement('div');
    el.className = 'gh-layer gh-pop gh-help';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'About project status updates');
    el.innerHTML = '<div class="gh-help-h"><b>About project status updates</b><button type="button" class="gh-iconbtn" data-close="1" aria-label="Close">' + svg(P.x, 14) + '</button></div>' +
      '<p>A status update is a short, dated note about the project’s health. Pick a status, set the start and target dates, and describe progress and blockers in Markdown.</p>' +
      '<p>The newest update’s status is shown next to the project name and in the project picker. The project manager and people who can edit projects may post updates.</p>' +
      '<ul>' + PSTATUS.map(function (s) { return '<li>' + pstatusPill(s.id) + '</li>'; }).join('') + '</ul>';
    document.body.appendChild(el);
    placePop(el, anchor);
    menu = { el: el, anchor: anchor };
    var x = el.querySelector('[data-close]');
    x.onclick = function () { closeMenu(true); };
    x.focus();
  }

  function openNewProject() {
    if (!S || !S.root) return;
    if (!canCreateProject()) { toast("You don't have permission to create projects.", 'err'); return; }
    closeMenu();
    var teams = [];
    S.mde.npreadme = { tab: 'write' };
    var m = openModal('<form class="gh-modal" role="dialog" aria-modal="true" aria-labelledby="gh-np-t" novalidate>' +
      '<div class="gh-modal-h"><h3 id="gh-np-t">Create a new project</h3><button type="button" class="gh-iconbtn" data-x="1" aria-label="Close">' + svg(P.x, 16) + '</button></div>' +
      '<div class="gh-modal-b"><div class="gh-formerr" role="alert" data-ref="err" hidden></div>' +
      '<div class="gh-field"><label for="gh-np-name">Project name <span class="gh-req" aria-hidden="true">*</span></label><input id="gh-np-name" class="gh-input" maxlength="200" autocomplete="off" aria-required="true" placeholder="e.g. HRMS" aria-describedby="gh-np-nerr"><div class="gh-ferr" id="gh-np-nerr" data-ferr="name"></div></div>' +
      '<div class="gh-field"><label for="gh-np-desc">Short description</label><input id="gh-np-desc" class="gh-input" maxlength="255" autocomplete="off" placeholder="What is this project about?" aria-describedby="gh-np-dn"><div class="gh-counter" id="gh-np-dn" data-ref="dn">0 / 255</div></div>' +
      '<div class="gh-field"><span class="gh-flabel">README <span class="gh-muted">(optional)</span></span>' +
      mdeHtml({ key: 'npreadme', id: 'gh-np-readme', label: 'README', minH: 120, files: 'images', placeholder: 'Let everyone know what this project is about, how to use it and link to important resources.' }) + '</div>' +
      '<div class="gh-field"><label for="gh-np-st">Status</label><select id="gh-np-st" class="gh-select">' + PROJ_STATES.map(function (x) { return '<option value="' + x[0] + '"' + (x[0] === 'active' ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select></div>' +
      '<div class="gh-grid2"><div class="gh-field"><label for="gh-np-start">Start date</label><input id="gh-np-start" type="date" class="gh-input"></div>' +
      '<div class="gh-field"><label for="gh-np-target">Target date</label><input id="gh-np-target" type="date" class="gh-input" aria-describedby="gh-np-terr"><div class="gh-ferr" id="gh-np-terr" data-ferr="target"></div></div></div>' +
      '<div class="gh-field"><span class="gh-flabel" id="gh-np-tl">Teams</span><div class="gh-teampick" role="group" aria-labelledby="gh-np-tl" data-ref="teams"></div></div>' +
      '</div><div class="gh-modal-f"><button type="button" class="gh-btn" data-x="1">Cancel</button><button type="submit" class="gh-btn gh-btn-primary" data-ref="npSubmit">Create project</button></div></form>',
      {
        confirmClose: function () { return !!(m.el.querySelector('#gh-np-name').value.trim() || m.el.querySelector('#gh-np-desc').value.trim() || mdeValue('npreadme').trim()); },
        confirmTitle: 'Discard this project?', confirmBody: 'The details you entered will be lost.',
        onClose: function () { if (S && S.mde) delete S.mde.npreadme; }
      });
    var el = m.el;
    function q(s) { return el.querySelector(s); }
    function drawTeams() {
      q('[data-ref="teams"]').innerHTML = S.teams.length ? S.teams.map(function (t) {
        return '<button type="button" data-team="' + esc(t.id) + '" aria-pressed="' + (teams.indexOf(String(t.id)) !== -1) + '">' + esc(t.name) + '</button>';
      }).join('') : '<span class="gh-muted" style="font-size:12.5px">No teams yet.</span>';
    }
    drawTeams();
    q('[data-ref="teams"]').addEventListener('click', function (e) {
      var b = e.target.closest('[data-team]');
      if (!b) return;
      var id = b.getAttribute('data-team'), i = teams.indexOf(id);
      if (i === -1) teams.push(id); else teams.splice(i, 1);
      b.setAttribute('aria-pressed', i === -1 ? 'true' : 'false');
    });
    q('#gh-np-desc').addEventListener('input', function () {
      var n = q('[data-ref="dn"]');
      n.textContent = this.value.length + ' / 255';
      n.classList.toggle('is-over', this.value.length > 255);
    });
    var busy = false;
    function submit(e) {
      if (e) e.preventDefault();
      if (busy) return;
      var name = q('#gh-np-name').value.trim(), desc = q('#gh-np-desc').value.trim(), start = q('#gh-np-start').value, target = q('#gh-np-target').value;
      var errs = {};
      if (!name) errs.name = 'Project name is required.';
      if (start && target && target < start) errs.target = 'Target date cannot be before the start date.';
      q('[data-ferr="name"]').textContent = errs.name || '';
      q('[data-ferr="target"]').textContent = errs.target || '';
      q('#gh-np-name').setAttribute('aria-invalid', errs.name ? 'true' : 'false');
      if (errs.name || errs.target) { toast(errs.name || errs.target, 'err'); (errs.name ? q('#gh-np-name') : q('#gh-np-target')).focus(); return; }
      var body = { name: name, description: desc.slice(0, 255), readme: mdeValue('npreadme'), status: q('#gh-np-st').value,
        startDate: start || null, targetEndDate: target || null, contributingTeamIds: teams.map(Number) };
      var btn = q('[data-ref="npSubmit"]'), errBox = q('[data-ref="err"]');
      busy = true; btn.disabled = true; btn.textContent = 'Creating…'; errBox.hidden = true;
      var st = S;
      req('/api/projects', { method: 'POST', body: body }).then(function (row) {
        if (st !== S) return;
        replaceProject(row);
        m.close();
        toast('Project “' + row.name + '” created.');
        setFilter({ project: String(row.id) }, { push: true });
        openProjectPanel(row.id);
      }, function (err) {
        busy = false; btn.disabled = false; btn.textContent = 'Create project';
        errBox.textContent = err.message; errBox.hidden = false;
        toast(err.message, 'err');
      });
    }
    q('form').addEventListener('submit', submit);
    mdeState('npreadme').onSubmit = function () { submit(); };
    q('#gh-np-name').focus();
  }

  /* Edit an existing project: name, short description, state, manager,
     dates, allocated hours and teams (the README is edited in the panel).
     PUT /api/projects/<id>; the code stays fixed. Changing the manager needs
     project.edit — a project's own manager cannot hand it over. */
  function openEditProject(p) {
    if (!S || !S.root || !p) return;
    if (!canManageProject(p)) { toast("You don't have permission to edit this project.", 'err'); return; }
    closeMenu();
    var teams = (p.contributingTeamIds || (p.contributingTeams || []).map(function (t) { return t.id; })).map(String);
    var mgrEditable = canEditProject();
    var people = knownPeople('');
    var init = {
      name: p.name || '', desc: p.description || '', status: p.status || 'active', mgr: String(p.projectManager || ''),
      start: p.startDate || '', target: p.targetEndDate || '', hours: p.allocatedHours != null ? String(Number(p.allocatedHours) || 0) : '0', teams: teams.slice().sort().join(',')
    };
    var m = openModal('<form class="gh-modal" role="dialog" aria-modal="true" aria-labelledby="gh-ep-t" novalidate>' +
      '<div class="gh-modal-h"><h3 id="gh-ep-t">Edit project <span class="gh-muted">' + esc(p.projectCode || '') + '</span></h3><button type="button" class="gh-iconbtn" data-x="1" aria-label="Close">' + svg(P.x, 16) + '</button></div>' +
      '<div class="gh-modal-b"><div class="gh-formerr" role="alert" data-ref="err" hidden></div>' +
      '<div class="gh-field"><label for="gh-ep-name">Project name <span class="gh-req" aria-hidden="true">*</span></label><input id="gh-ep-name" class="gh-input" maxlength="200" autocomplete="off" aria-required="true" value="' + esc(init.name) + '" aria-describedby="gh-ep-nerr"><div class="gh-ferr" id="gh-ep-nerr" data-ferr="name"></div></div>' +
      '<div class="gh-field"><label for="gh-ep-desc">Short description</label><input id="gh-ep-desc" class="gh-input" maxlength="255" autocomplete="off" value="' + esc(init.desc) + '" placeholder="What is this project about?" aria-describedby="gh-ep-dn"><div class="gh-counter" id="gh-ep-dn" data-ref="dn">' + init.desc.length + ' / 255</div></div>' +
      '<div class="gh-grid2"><div class="gh-field"><label for="gh-ep-st">Status</label><select id="gh-ep-st" class="gh-select">' + PROJ_STATES.map(function (x) { return '<option value="' + x[0] + '"' + (x[0] === init.status ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select></div>' +
      '<div class="gh-field"><label for="gh-ep-mgr">Project manager</label><input id="gh-ep-mgr" class="gh-input" type="email" list="gh-ep-people" autocomplete="off" placeholder="name@company.com" value="' + esc(init.mgr) + '"' + (mgrEditable ? '' : ' disabled aria-describedby="gh-ep-mh"') + '>' +
      '<datalist id="gh-ep-people">' + people.map(function (x) { return '<option value="' + esc(x.email) + '">' + esc(x.name) + '</option>'; }).join('') + '</datalist>' +
      (mgrEditable ? '' : '<div class="gh-counter" id="gh-ep-mh">Only project editors can change the manager.</div>') + '<div class="gh-ferr" data-ferr="mgr"></div></div></div>' +
      '<div class="gh-grid2"><div class="gh-field"><label for="gh-ep-start">Start date</label><input id="gh-ep-start" type="date" class="gh-input" value="' + esc(init.start) + '"></div>' +
      '<div class="gh-field"><label for="gh-ep-target">Target date</label><input id="gh-ep-target" type="date" class="gh-input" value="' + esc(init.target) + '" aria-describedby="gh-ep-terr"><div class="gh-ferr" id="gh-ep-terr" data-ferr="target"></div></div></div>' +
      '<div class="gh-field"><label for="gh-ep-hours">Allocated hours</label><input id="gh-ep-hours" type="number" min="0" step="0.5" class="gh-input" style="max-width:180px" value="' + esc(init.hours) + '" aria-describedby="gh-ep-herr"><div class="gh-ferr" id="gh-ep-herr" data-ferr="hours"></div></div>' +
      '<div class="gh-field"><span class="gh-flabel" id="gh-ep-tl">Teams</span><div class="gh-teampick" role="group" aria-labelledby="gh-ep-tl" data-ref="teams"></div></div>' +
      '</div><div class="gh-modal-f"><button type="button" class="gh-btn" data-x="1">Cancel</button><button type="submit" class="gh-btn gh-btn-primary" data-ref="epSubmit">Save changes</button></div></form>',
      {
        confirmClose: function () { return changed(); },
        confirmTitle: 'Discard your changes?', confirmBody: 'The changes you made to this project will be lost.'
      });
    var el = m.el;
    function q(s) { return el.querySelector(s); }
    function cur() {
      return { name: q('#gh-ep-name').value.trim(), desc: q('#gh-ep-desc').value.trim(), status: q('#gh-ep-st').value,
               mgr: q('#gh-ep-mgr').value.trim(), start: q('#gh-ep-start').value, target: q('#gh-ep-target').value,
               hours: q('#gh-ep-hours').value.trim(), teams: teams.slice().sort().join(',') };
    }
    function changed() { var c = cur(); for (var k in init) if (String(c[k]) !== String(init[k])) return true; return false; }
    function drawTeams() {
      var all = S.teams.slice();
      (p.contributingTeams || []).forEach(function (t) { if (!all.some(function (x) { return String(x.id) === String(t.id); })) all.push(t); });
      q('[data-ref="teams"]').innerHTML = all.length ? all.map(function (t) {
        return '<button type="button" data-team="' + esc(t.id) + '" aria-pressed="' + (teams.indexOf(String(t.id)) !== -1) + '">' + esc(t.name) + '</button>';
      }).join('') : '<span class="gh-muted" style="font-size:12.5px">No teams yet.</span>';
    }
    drawTeams();
    q('[data-ref="teams"]').addEventListener('click', function (e) {
      var b = e.target.closest('[data-team]');
      if (!b) return;
      var id = b.getAttribute('data-team'), i = teams.indexOf(id);
      if (i === -1) teams.push(id); else teams.splice(i, 1);
      b.setAttribute('aria-pressed', i === -1 ? 'true' : 'false');
    });
    q('#gh-ep-desc').addEventListener('input', function () {
      var n = q('[data-ref="dn"]');
      n.textContent = this.value.length + ' / 255';
      n.classList.toggle('is-over', this.value.length > 255);
    });
    var busy = false;
    function submit(e) {
      if (e) e.preventDefault();
      if (busy) return;
      var c = cur(), errs = {};
      if (!c.name) errs.name = 'Project name is required.';
      if (c.start && c.target && c.target < c.start) errs.target = 'Target date cannot be before the start date.';
      if (c.hours !== '' && !(Number(c.hours) >= 0)) errs.hours = 'Allocated hours must be 0 or more.';
      if (mgrEditable && c.mgr && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.mgr)) errs.mgr = 'Enter the manager’s email address.';
      ['name', 'target', 'hours', 'mgr'].forEach(function (k) { var x = q('[data-ferr="' + k + '"]'); if (x) x.textContent = errs[k] || ''; });
      q('#gh-ep-name').setAttribute('aria-invalid', errs.name ? 'true' : 'false');
      var first = errs.name ? '#gh-ep-name' : (errs.mgr ? '#gh-ep-mgr' : (errs.target ? '#gh-ep-target' : (errs.hours ? '#gh-ep-hours' : '')));
      if (first) { toast(errs.name || errs.mgr || errs.target || errs.hours, 'err'); q(first).focus(); return; }
      if (!changed()) { m.close(); return; }
      var body = { name: c.name, description: c.desc.slice(0, 255), status: c.status, startDate: c.start || null,
                   targetEndDate: c.target || null, allocatedHours: c.hours === '' ? 0 : Number(c.hours), contributingTeamIds: teams.map(Number) };
      if (mgrEditable && c.mgr.toLowerCase() !== init.mgr.toLowerCase()) body.projectManager = c.mgr.toLowerCase();
      var btn = q('[data-ref="epSubmit"]'), errBox = q('[data-ref="err"]');
      busy = true; btn.disabled = true; btn.textContent = 'Saving…'; errBox.hidden = true;
      var st = S;
      req('/api/projects/' + p.id, { method: 'PUT', body: body }).then(function (row) {
        if (st !== S) return;
        replaceProject(row);
        m.close();
        renderChrome();
        if (S.pp) renderPP();
        toast('Project “' + row.name + '” updated.');
      }, function (err) {
        busy = false; btn.disabled = false; btn.textContent = 'Save changes';
        errBox.textContent = err.message; errBox.hidden = false;
        toast(err.message, 'err');
      });
    }
    q('form').addEventListener('submit', submit);
    q('#gh-ep-name').focus();
    q('#gh-ep-name').select();
  }

  /* ── issue pane ──────────────────────────────────────────────────────── */
  function openIssue(id, opts) {
    opts = opts || {};
    id = String(id);
    if (S.pane && S.pane.id === id) { renderPane(); return; }
    S.pane = { id: id, comments: null, cseq: 0, editTitle: false, editDesc: false, draft: '', busy: false };
    if (!opts.fromRoute) writeUrl(!opts.replace);
    else writeUrl(false);
    renderPane();
    loadComments();
    if (S.loaded && !findTask(id)) fetchMissing(id);
    markActiveCard();
  }
  function closePane(opts) {
    opts = opts || {};
    if (!S || !S.pane) return;
    var id = S.pane.id;
    S.pane = null;
    var wrap = document.getElementById('gh-pane');
    if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
    if (!opts.fromRoute) writeUrl(true);
    markActiveCard();
    var card = S.root && S.root.querySelector('[data-id="' + id + '"]');
    if (card && !opts.noFocus) try { card.focus({ preventScroll: true }); } catch (_) {}
  }
  function markActiveCard() {
    if (!S || !S.root) return;
    var cards = S.root.querySelectorAll('.gh-card');
    for (var i = 0; i < cards.length; i++) cards[i].classList.toggle('is-active', !!S.pane && cards[i].getAttribute('data-id') === S.pane.id);
  }
  function loadComments() {
    var p = S.pane;
    if (!p) return;
    var my = ++p.cseq, st = S;
    req('/api/tasks/' + p.id + '/comments').then(function (rows) {
      if (st !== S || S.pane !== p || my !== p.cseq) return;
      p.comments = Array.isArray(rows) ? rows : [];
      p.cerr = '';
      renderPane();
    }, function (e) {
      if (st !== S || S.pane !== p || my !== p.cseq) return;
      p.comments = p.comments || [];
      p.cerr = e.message;
      renderPane();
    });
  }
  function refreshTimeline() { if (S.pane) loadComments(); }
  function parseReactions(raw) {
    var r = raw;
    if (typeof raw === 'string') { try { r = JSON.parse(raw || '{}'); } catch (_) { r = {}; } }
    return r && typeof r === 'object' ? r : {};
  }
  function emojiFor(key) { for (var i = 0; i < REACTIONS.length; i++) if (REACTIONS[i][0] === key) return REACTIONS[i][1]; return key; }

  function renderPane() {
    if (!S || !S.pane) return;
    var p = S.pane, t = findTask(p.id);
    var wrap = document.getElementById('gh-pane');
    var fresh = !wrap;
    if (fresh) {
      wrap = document.createElement('div');
      wrap.id = 'gh-pane';
      wrap.className = 'gh-layer gh-pane-wrap';
      document.body.appendChild(wrap);
      wrap.addEventListener('click', paneClick);
      wrap.addEventListener('change', paneChange);
      wrap.addEventListener('input', function (e) {
        var r = e.target.getAttribute('data-ref');
        if (r === 'draft' && S.pane) {
          S.pane.draft = e.target.value;
          var cb = wrap.querySelector('[data-act="close"]');
          if (cb) cb.lastChild.textContent = ' ' + (e.target.value.trim() ? 'Close with comment' : 'Close issue');
        } else if (e.target.getAttribute('data-field') === 'progress') {
          var lbl = wrap.querySelector('[data-ref="progVal"]');
          if (lbl) lbl.textContent = e.target.value + '%';
        }
      });
      wrap.addEventListener('keydown', paneKeys);
    }
    var scroller = wrap.querySelector('.gh-pane-scroll'), sTop = scroller ? scroller.scrollTop : 0;
    var focusSel = null, ae = document.activeElement;
    if (ae && wrap.contains(ae)) focusSel = ae.getAttribute('data-act') ? '[data-act="' + ae.getAttribute('data-act') + '"]' : (ae.getAttribute('data-field') ? '[data-field="' + ae.getAttribute('data-field') + '"]' : (ae.getAttribute('data-ref') ? '[data-ref="' + ae.getAttribute('data-ref') + '"]' : null));
    var titleDraft = wrap.querySelector('[data-ref="titleInput"]'), descDraft = wrap.querySelector('[data-ref="descInput"]');
    var tVal = titleDraft ? titleDraft.value : null, dVal = descDraft ? descDraft.value : null;
    if (!t) {
      wrap.innerHTML = '<div class="gh-backdrop" data-act="closepane"></div><aside class="gh-pane" role="dialog" aria-modal="true" aria-label="Issue #' + esc(p.id) + '">' +
        '<div class="gh-pane-h"><span class="gh-crumb">Issue #' + esc(p.id) + '</span><span class="gh-sp"></span><button type="button" class="gh-iconbtn" data-act="closepane" aria-label="Close">' + svg(P.x, 16) + '</button></div>' +
        '<div class="gh-pane-scroll"><div class="gh-pane-main"><div class="gh-skel" style="height:28px;width:60%"></div><div class="gh-skel" style="height:120px"></div><div class="gh-skel" style="height:80px"></div></div></div></aside>';
      if (fresh) { var x = wrap.querySelector('[data-act="closepane"].gh-iconbtn'); if (x) x.focus(); }
      return;
    }
    mdeState('cmt').onSubmit = function () { postComment(false); };
    mdeState('desc').onSubmit = function () { var sb = document.querySelector('#gh-pane [data-act="savedesc"]'); if (sb) sb.click(); };
    mdeState('desc').onFile = function (f) {
      var tk = paneTask();
      if (!tk) return;
      var replacing = tk.attachmentFileName;
      updateTask(tk, { attachmentFileName: f.name, attachmentFileMime: f.mime, attachmentFileData: f.data }).then(function () {
        toast((replacing ? 'Replaced “' + replacing + '” with “' : 'Attached “') + f.name + '”. An issue has one file attachment; images are embedded in the text.');
      }, function () {});
    };
    if (S.ac && wrap.contains(S.ac.ta)) acClose();
    wrap.innerHTML = '<div class="gh-backdrop" data-act="closepane"></div><aside class="gh-pane" role="dialog" aria-modal="true" aria-labelledby="gh-pane-title">' + paneHtml(t, p) + '</aside>';
    if (tVal != null) { var ti = wrap.querySelector('[data-ref="titleInput"]'); if (ti) ti.value = tVal; }
    if (dVal != null) { var di = wrap.querySelector('[data-ref="descInput"]'); if (di) di.value = dVal; }
    refreshPreviews(wrap);
    var sc = wrap.querySelector('.gh-pane-scroll');
    if (sc && !fresh) sc.scrollTop = sTop;
    var target = (focusSel && wrap.querySelector(focusSel)) || (fresh ? wrap.querySelector('.gh-pane-h [data-act="closepane"]') : null);
    if (p.focus) { target = wrap.querySelector(p.focus) || target; p.focus = null; }
    if (target) try { target.focus({ preventScroll: true }); } catch (_) {}
  }

  function paneHtml(t, p) {
    var st = stageOf(t), closed = st === 'done', ed = canEdit(), m = me();
    var who = personName(t), labels = parseLabels(t.labels), pr = prioOf(t.priority);
    var proj = projectById(t.projectId);
    var milestones = proj && proj.milestones ? proj.milestones : [];
    var iso = dueISO(t.due), progress = Math.max(0, Math.min(100, Number(t.progress) || 0));
    var nComments = (p.comments || []).filter(function (c) { return (c.commentType || 'comment') === 'comment'; }).length;
    var head = '<div class="gh-pane-h"><span class="gh-crumb">' + svg(P.board, 14) + ' ' + esc(t.projectName || 'All Projects') + ' / ' + esc(ref(t)) + (t.taskCode ? ' · ' + esc(t.taskCode) : '') + '</span>' +
      '<span class="gh-sp"></span><button type="button" class="gh-btn gh-btn-sm gh-btn-invisible" data-act="copylink">' + svg(P.link, 14) + ' Copy link</button>' +
      '<button type="button" class="gh-iconbtn" data-act="closepane" aria-label="Close issue pane (Esc)">' + svg(P.x, 16) + '</button></div>';
    var title = p.editTitle
      ? '<div class="gh-pane-title"><label class="gh-sr" for="gh-pane-title-in">Title</label><input id="gh-pane-title-in" class="gh-input" data-ref="titleInput" maxlength="255" value="' + esc(t.title) + '"><button type="button" class="gh-btn gh-btn-sm gh-btn-primary" data-act="savetitle">Save</button><button type="button" class="gh-btn gh-btn-sm" data-act="canceltitle">Cancel</button></div><h2 id="gh-pane-title" class="gh-sr">' + esc(t.title) + '</h2>'
      : '<div class="gh-pane-title"><h2 id="gh-pane-title">' + esc(t.title) + '<span class="gh-ref">' + esc(ref(t)) + '</span></h2>' + (ed ? '<button type="button" class="gh-btn gh-btn-sm" data-act="edittitle">Edit</button>' : '') + '</div>';
    var statebar = '<div class="gh-statebar"><span class="gh-statebadge ' + (closed ? 'is-closed' : 'is-open') + '">' + svg(closed ? P.closed : P.open, 14) + ' ' + (closed ? 'Closed' : 'Open') + '</span>' +
      '<span class="gh-pill gh-tone-' + statusOf(st).tone + '">' + esc(statusOf(st).label) + '</span>' +
      '<span class="gh-pill gh-tone-' + typeOf(t.issueType).tone + '" title="Issue type">' + svg(TICON[typeOf(t.issueType).id], 12) + ' ' + esc(typeOf(t.issueType).label) + '</span>' +
      '<span>' + (t.createdBy ? '<b>' + esc(t.createdBy) + '</b> opened this ' : 'Opened ') + timeEl(t.createdAt) + ' · ' + nComments + ' comment' + (nComments === 1 ? '' : 's') + '</span></div>';

    var desc = '<div class="gh-box"><div class="gh-box-h">' + avatar(t.createdBy || 'Author', t.createdBy, 20) + '<strong>' + esc(t.createdBy || 'Author') + '</strong> opened ' + timeEl(t.createdAt) +
      '<span class="gh-sp"><span class="gh-badge">Author</span>' + (ed && !p.editDesc ? '<button type="button" class="gh-iconbtn" data-act="editdesc" aria-label="Edit description">' + svg(P.pencil, 14) + '</button>' : '') + '</span></div>' +
      '<div class="gh-box-b">' + (p.editDesc
        ? mdeHtml({ key: 'desc', id: 'gh-desc-in', ref: 'descInput', value: t.description || '', label: 'Description', minH: 160, files: 'any' }) +
          '<div class="gh-box-actions"><button type="button" class="gh-btn gh-btn-sm" data-act="canceldesc">Cancel</button><button type="button" class="gh-btn gh-btn-sm gh-btn-primary" data-act="savedesc">Save</button></div>'
        : (String(t.description || '').trim() ? '<div class="gh-md" data-desc="1">' + md(t.description, { interactive: ed }) + '</div>' : '<span class="gh-placeholder">No description provided.</span>')) + '</div></div>';

    var attach = '';
    if (t.imageFileData || t.attachmentFileData) {
      attach = '<div class="gh-box"><div class="gh-box-h"><strong>Attachments</strong></div><div class="gh-box-b gh-attach hrms-gh-attach">' +
        (/^data:image\//.test(t.imageFileData || '') ? '<a href="' + esc(t.imageFileData) + '" download="' + esc(t.imageFileName || 'image') + '"><img src="' + esc(t.imageFileData) + '" alt="' + esc(t.imageFileName || 'Attached image') + '"></a>' : '') +
        (t.attachmentFileData ? '<a href="' + esc(t.attachmentFileData) + '" download="' + esc(t.attachmentFileName || 'attachment') + '">📎 ' + esc(t.attachmentFileName || 'Download attachment') + '</a>' : '') +
        '</div></div>';
    }
    var reject = t.rejectReason ? '<div class="gh-warnbox"><b>Rejected by assignee:</b> ' + esc(t.rejectReason) + '</div>' : '';

    var timeline = '';
    if (p.comments == null) timeline = '<div class="gh-skel" style="height:70px"></div>';
    else {
      timeline = p.comments.map(function (c) {
        var type = c.commentType || 'comment';
        if (type !== 'comment') {
          return '<div class="gh-event"><span class="gh-evdot">' + svg(P.board, 12) + '</span><span><b>' + esc(c.authorName || c.authorEmail) + '</b> ' + esc(c.body) + ' · ' + timeEl(c.createdAt) + '</span></div>';
        }
        var mine = m.email && String(c.authorEmail || '').toLowerCase() === m.email;
        var re = parseReactions(c.reactions), chips = '';
        Object.keys(re).forEach(function (k) {
          var users = Array.isArray(re[k]) ? re[k] : [];
          if (!users.length) return;
          var meIn = users.map(function (u) { return String(u).toLowerCase(); }).indexOf(m.email) !== -1;
          chips += '<button type="button" class="gh-react' + (meIn ? ' is-mine' : '') + '" data-act="react" data-cid="' + esc(c.id) + '" data-emoji="' + esc(k) + '" aria-pressed="' + meIn + '" title="' + esc(users.join(', ')) + '">' + esc(emojiFor(k)) + ' ' + users.length + '</button>';
        });
        return '<div class="gh-cmt">' + avatar(c.authorName || c.authorEmail, c.authorEmail, 32) +
          '<div class="gh-box"><div class="gh-box-h"><strong>' + esc(c.authorName || c.authorEmail) + '</strong> commented ' + timeEl(c.createdAt) +
          '<span class="gh-sp">' + (t.createdBy && String(t.createdBy).toLowerCase() === String(c.authorEmail || '').toLowerCase() ? '<span class="gh-badge">Author</span>' : '') +
          (mine && String(p.editCid) !== String(c.id) ? '<button type="button" class="gh-iconbtn" data-act="editcomment" data-cid="' + esc(c.id) + '" aria-label="Edit comment">' + svg(P.pencil, 14) + '</button>' : '') +
          ((mine || canDelete()) ? '<button type="button" class="gh-iconbtn" data-act="delcomment" data-cid="' + esc(c.id) + '" aria-label="Delete comment">' + svg(P.trash, 14) + '</button>' : '') + '</span></div>' +
          (String(p.editCid) === String(c.id)
            ? '<div class="gh-box-b gh-cedit">' + mdeHtml({ key: 'cedit', id: 'gh-cedit-in', value: c.body || '', label: 'Edit comment', minH: 100, files: 'images' }) +
              '<div class="gh-box-actions" style="margin-top:0"><button type="button" class="gh-btn gh-btn-sm" data-act="canceledit" data-cid="' + esc(c.id) + '">Cancel</button>' +
              '<button type="button" class="gh-btn gh-btn-sm gh-btn-primary" data-act="saveedit" data-cid="' + esc(c.id) + '">Update comment</button></div></div>'
            : '<div class="gh-box-b gh-md">' + md(c.body) + '</div>') +
          '<div class="gh-reacts">' + chips + '<button type="button" class="gh-react" data-act="addreact" data-cid="' + esc(c.id) + '" aria-haspopup="menu" aria-label="Add reaction">' + svg(P.smiley, 14) + '</button></div></div></div>';
      }).join('');
      if (p.cerr) timeline += '<div class="gh-error" role="alert"><span>Comments could not be loaded: ' + esc(p.cerr) + '</span><button type="button" class="gh-btn gh-btn-sm" data-act="reloadcomments">Retry</button></div>';
    }
    var composer = '<div class="gh-box gh-composer"><div class="gh-box-h"><strong>Add a comment</strong></div><div class="gh-box-b">' +
      mdeHtml({ key: 'cmt', id: 'gh-cmt-in', ref: 'draft', value: p.draft || '', label: 'Comment', placeholder: 'Use Markdown to format your comment', minH: 110, files: 'images' }) +
      '<div class="gh-box-actions">' + (ed ? (closed
        ? '<button type="button" class="gh-btn" data-act="reopen">' + svg(P.open, 14) + ' Reopen issue</button>'
        : '<button type="button" class="gh-btn" data-act="close"><span class="gh-tone-purple">' + svg(P.closed, 14) + '</span><span> ' + (String(p.draft || '').trim() ? 'Close with comment' : 'Close issue') + '</span></button>') : '') +
      '<button type="button" class="gh-btn gh-btn-primary" data-act="comment"' + (p.busy ? ' disabled' : '') + '>Comment</button></div></div></div>';

    function sf(label, inner, action) { return '<div class="gh-sf"><div class="gh-sf-h"><span>' + label + '</span>' + (action || '') + '</div>' + inner + '</div>'; }
    var side = '';
    side += sf('Assignees', ed ? '<button type="button" class="gh-cellbtn" data-act="assign" data-field="assignee">' + avatar(who, t.assigneeEmail || who, 20) + '<span' + (who ? '' : ' class="gh-muted"') + '>' + esc(who || 'No one — assign') + '</span></button>'
      : '<span class="gh-sf-val">' + esc(who || 'No one') + '</span>');
    side += sf('<label for="gh-f-stage">Status</label>', ed ? '<select id="gh-f-stage" class="gh-select" data-field="stage">' + STATUSES.map(function (s) { return '<option value="' + s.id + '"' + (s.id === st ? ' selected' : '') + '>' + s.label + '</option>'; }).join('') + '</select>'
      : '<span class="gh-tone-' + statusOf(st).tone + '">' + esc(statusOf(st).label) + '</span>');
    var ty = typeOf(t.issueType);
    side += sf('<label for="gh-f-type">Type</label>', ed ? '<select id="gh-f-type" class="gh-select" data-field="issueType">' + TYPES.map(function (x) { return '<option value="' + x.id + '"' + (x.id === ty.id ? ' selected' : '') + '>' + x.label + '</option>'; }).join('') + '</select>'
      : '<span class="gh-tone-' + ty.tone + '">' + esc(ty.label) + '</span>');
    side += sf('<label for="gh-f-prio">Priority</label>', ed ? '<select id="gh-f-prio" class="gh-select" data-field="priority">' + priorityOptions(pr.id) + '</select>'
      : '<span class="gh-tone-' + pr.tone + '">' + esc(pr.label) + '</span>');
    side += sf('Labels', '<div class="gh-chips" style="margin-top:0">' + (labels.length ? labels.map(function (l) {
      return labelChip(l, ed ? '<button type="button" data-act="rmlabel" data-label="' + esc(l) + '" aria-label="Remove label ' + esc(l) + '">' + svg(P.x, 12) + '</button>' : '');
    }).join('') : '<span class="gh-muted">None yet</span>') + '</div>', ed ? '<button type="button" class="gh-iconbtn" data-act="editlabels" aria-haspopup="menu" aria-label="Edit labels">' + svg(P.pencil, 14) + '</button>' : '');
    side += sf('<label for="gh-f-team">Team</label>', ed ? '<select id="gh-f-team" class="gh-select" data-field="teamId"><option value="">No team</option>' + S.teams.map(function (x) { return '<option value="' + esc(x.id) + '"' + (String(x.id) === String(t.teamId) ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') +
      (t.teamId && !teamById(t.teamId) ? '<option value="' + esc(t.teamId) + '" selected>' + esc(t.teamName || ('Team #' + t.teamId)) + '</option>' : '') + '</select>'
      : '<span class="gh-sf-val">' + esc(t.teamName || 'None') + '</span>');
    side += sf('<label for="gh-f-proj">Project</label>', ed ? '<select id="gh-f-proj" class="gh-select" data-field="projectId"><option value="">No project</option>' + S.projects.map(function (x) { return '<option value="' + esc(x.id) + '"' + (String(x.id) === String(t.projectId) ? ' selected' : '') + '>' + esc((x.projectCode ? x.projectCode + ' — ' : '') + x.name + (projStatusText(x) ? ' · ' + projStatusText(x) : '')) + '</option>'; }).join('') + '</select>'
      : '<span class="gh-sf-val">' + esc(t.projectName || 'None') + '</span>');
    side += sf('<label for="gh-f-ms">Milestone</label>', ed ? '<select id="gh-f-ms" class="gh-select" data-field="milestoneId"' + (t.projectId ? '' : ' disabled title="Choose a project first"') + '><option value="">No milestone</option>' + milestones.map(function (x) { return '<option value="' + esc(x.id) + '"' + (String(x.id) === String(t.milestoneId) ? ' selected' : '') + '>' + esc(x.title) + '</option>'; }).join('') +
      (t.milestoneId && !milestones.some(function (x) { return String(x.id) === String(t.milestoneId); }) ? '<option value="' + esc(t.milestoneId) + '" selected>' + esc(t.milestoneTitle || 'Milestone') + '</option>' : '') + '</select>'
      : '<span class="gh-sf-val">' + esc(t.milestoneTitle || 'None') + '</span>');
    side += sf('<label for="gh-f-due">Due date</label>', ed ? (iso || !t.due ? '' : '<span class="gh-muted">' + esc(t.due) + '</span>') + '<input id="gh-f-due" type="date" class="gh-input' + (isOverdue(t) ? ' gh-overdue' : '') + '" data-field="due" value="' + esc(iso) + '">' + (isOverdue(t) ? '<span class="gh-overdue">Overdue</span>' : '')
      : '<span class="gh-sf-val' + (isOverdue(t) ? ' gh-overdue' : '') + '">' + esc(t.due ? fmtDue(t.due) : 'None') + '</span>');
    side += sf('<label for="gh-f-start">Start date</label>', ed ? '<input id="gh-f-start" type="date" class="gh-input" data-field="startDate" value="' + esc(t.startDate || '') + '">'
      : '<span class="gh-sf-val">' + esc(t.startDate ? fmtDue(t.startDate) : 'None') + '</span>');
    side += sf('<label for="gh-f-target">Target date</label>', ed ? '<input id="gh-f-target" type="date" class="gh-input" data-field="targetDate" value="' + esc(t.targetDate || '') + '"' + (t.startDate ? ' min="' + esc(t.startDate) + '"' : '') + '>'
      : '<span class="gh-sf-val">' + esc(t.targetDate ? fmtDue(t.targetDate) : 'None') + '</span>');
    side += sf('<label for="gh-f-effort">Effort</label>', ed ? '<input id="gh-f-effort" type="number" min="0" step="any" class="gh-input" data-field="effort" value="' + esc(t.effort == null ? '' : t.effort) + '" placeholder="e.g. 3">'
      : '<span class="gh-sf-val">' + esc(t.effort == null || t.effort === '' ? 'None' : t.effort) + '</span>');
    side += sf('Parent issue', ed ? '<button type="button" class="gh-cellbtn" data-act="pcell" data-cellid="parent">' + (t.parentId ? cellInner(t, 'parent') : '<span class="gh-muted">None — set parent</span>') + '</button>'
      : '<span class="gh-sf-val">' + (t.parentId ? '<a class="gh-xref" href="' + BASE + '/issue/' + esc(t.parentId) + '">#' + esc(t.parentId) + '</a> ' + esc(t.parentTitle || '') : 'None') + '</span>');
    if (t.parentId && ed) side += '<div class="gh-sf-val gh-md" style="font-size:12px;margin-top:-6px;padding-bottom:6px"><a class="gh-xref" href="' + BASE + '/issue/' + esc(t.parentId) + '">Open parent #' + esc(t.parentId) + '</a></div>';
    if (t.subIssues && t.subIssues.total) side += sf('Sub-issues', '<span class="gh-sf-val">' + cellInner(t, 'subissues') + '</span>');
    side += sf('Reviewers', ed ? '<button type="button" class="gh-cellbtn" data-act="pcell" data-cellid="reviewers">' + (t.reviewerEmail ? cellInner(t, 'reviewers') : '<span class="gh-muted">None — add</span>') + '</button>'
      : '<span class="gh-sf-val">' + esc(reviewerName(t) || 'None') + '</span>');
    if (t.projectId && String(t.projectId) === String(S.f.project) && S.fields.length) {
      S.fields.forEach(function (cf) {
        var id = 'f:' + cf.id, has = fieldVal(t, cf.id) != null;
        side += sf(esc(cf.name), ed ? '<button type="button" class="gh-cellbtn" data-act="pcell" data-cellid="' + esc(id) + '">' + (has ? cellInner(t, id) : '<span class="gh-muted">None</span>') + '</button>'
          : '<span class="gh-sf-val">' + (has ? cellInner(t, id) : 'None') + '</span>');
      });
    }
    if (t.closedAt) side += sf('Closed', '<span class="gh-sf-val">' + timeEl(t.closedAt) + '</span>');
    side += sf('<label for="gh-f-prog">Progress</label>', ed ? '<div class="gh-range"><input id="gh-f-prog" type="range" min="0" max="100" step="5" value="' + progress + '" data-field="progress" aria-valuetext="' + progress + '%"><span data-ref="progVal">' + progress + '%</span></div>'
      : '<div class="gh-progress" style="margin-top:0"><i style="width:' + progress + '%"></i></div><span class="gh-muted">' + progress + '%</span>');
    if (t.estimatedHours != null && t.estimatedHours !== '') side += sf('Estimate', '<span class="gh-sf-val">' + esc(t.estimatedHours) + ' h</span>');
    if (t.teamLead) side += sf('Team lead', '<span class="gh-sf-val">' + esc(t.teamLead) + '</span>');
    if (t.blockedByIds && t.blockedByIds.length) side += sf('Blocked by', '<span class="gh-sf-val gh-md">' + t.blockedByIds.map(function (b) { return '<a class="gh-xref" href="' + BASE + '/issue/' + esc(b) + '">#' + esc(b) + '</a>'; }).join(', ') + '</span>');
    side += sf('Updated', '<span class="gh-sf-val">' + (timeEl(t.updatedAt || t.createdAt) || '—') + '</span>');
    if (canDelete()) {
      var canDel = st === 'todo';
      side += '<div class="gh-pane-foot"><button type="button" class="gh-btn gh-btn-sm gh-btn-danger" data-act="delete"' + (canDel ? '' : ' disabled title="Only issues in To Do can be deleted. Close it instead."') + '>' + svg(P.trash, 14) + ' Delete issue</button>' +
        (canDel ? '' : '<span class="gh-muted" style="font-size:12px">Only To Do issues can be deleted.</span>') + '</div>';
    }
    return head + '<div class="gh-pane-scroll"><div class="gh-pane-top">' + title + statebar + '</div><div class="gh-pane-grid"><div class="gh-pane-main">' + reject + desc + attach +
      '<div class="gh-timeline" aria-label="Timeline">' + timeline + '</div>' + composer + '</div><div class="gh-pane-side">' + side + '</div></div></div>';
  }

  function paneTask() { return S && S.pane ? findTask(S.pane.id) : null; }
  function paneClick(e) {
    var b = e.target.closest ? e.target.closest('[data-act]') : null;
    var xref = e.target.closest ? e.target.closest('a.gh-xref') : null;
    if (xref) { e.preventDefault(); var mm = /\/issue\/(\d+)/.exec(xref.getAttribute('href') || ''); if (mm) { closePane({ noFocus: true }); openIssue(mm[1]); } return; }
    var tcb = e.target.closest ? e.target.closest('[data-desc] .gh-md-cb[data-task]') : null;
    if (tcb) {
      // GitHub-style task list: ticking a box in the description saves it.
      var tt = paneTask();
      if (!tt || !canEdit()) { e.preventDefault(); return; }
      var nd = toggleTaskSrc(tt.description || '', +tcb.getAttribute('data-task'));
      if (nd == null) { e.preventDefault(); return; }
      S.pane.focus = '[data-desc] .gh-md-cb[data-task="' + tcb.getAttribute('data-task') + '"]';
      updateTask(tt, { description: nd }).then(null, function () {});
      return;
    }
    if (!b) return;
    var act = b.getAttribute('data-act'), t = paneTask(), p = S.pane;
    if (act === 'closepane') { closePane(); return; }
    if (!t || !p) return;
    switch (act) {
      case 'copylink': copyLink(t); break;
      case 'edittitle': p.editTitle = true; p.focus = '[data-ref="titleInput"]'; renderPane(); break;
      case 'canceltitle': p.editTitle = false; p.focus = '[data-act="edittitle"]'; renderPane(); break;
      case 'savetitle': saveTitle(); break;
      case 'editdesc': p.editDesc = true; S.mde.desc = { tab: 'write' }; p.focus = '[data-ref="descInput"]'; renderPane(); break;
      case 'canceldesc': p.editDesc = false; p.focus = '[data-act="editdesc"]'; renderPane(); break;
      case 'savedesc':
        var dv = mdeValue('desc');
        p.editDesc = false; p.focus = '[data-act="editdesc"]';
        if (dv === (t.description || '')) { renderPane(); break; }
        updateTask(t, { description: dv || '' }).then(function () { toast('Description saved.'); }, function () { if (S.pane === p) { p.editDesc = true; renderPane(); } });
        break;
      case 'assign':
        openPicker(b, { teamId: t.teamId, current: t.assigneeEmail }, function (person) { updateTask(t, assignPatch(person)).then(null, function () {}); });
        break;
      case 'pcell': editCell(b, t, b.getAttribute('data-cellid')); break;
      case 'editcomment':
        var ec = null;
        (p.comments || []).forEach(function (c) { if (String(c.id) === b.getAttribute('data-cid')) ec = c; });
        if (!ec) return;
        p.editCid = String(ec.id);
        S.mde.cedit = { tab: 'write', onSubmit: function () { var sb = document.querySelector('#gh-pane [data-act="saveedit"]'); if (sb) sb.click(); } };
        p.focus = '#gh-cedit-in';
        renderPane();
        break;
      case 'canceledit': p.editCid = null; p.focus = '[data-act="editcomment"][data-cid="' + b.getAttribute('data-cid') + '"]'; renderPane(); break;
      case 'saveedit': saveCommentEdit(t, b.getAttribute('data-cid')); break;
      case 'editlabels': openLabelMenu(b, t); break;
      case 'rmlabel':
        var keep = parseLabels(t.labels).filter(function (l) { return l !== b.getAttribute('data-label'); });
        updateTask(t, { labels: JSON.stringify(keep) }).then(null, function () {});
        break;
      case 'comment': postComment(false); break;
      case 'close': postComment(true, 'done'); break;
      case 'reopen': postComment(true, 'todo'); break;
      case 'react': react(t, b.getAttribute('data-cid'), b.getAttribute('data-emoji')); break;
      case 'addreact':
        openMenu(b, REACTIONS.map(function (r) { return { v: r[0], label: r[1] + '  ' + r[0] }; }), function (v) { react(t, b.getAttribute('data-cid'), v); }, 'Pick a reaction');
        break;
      case 'delcomment': deleteComment(t, b.getAttribute('data-cid')); break;
      case 'reloadcomments': loadComments(); break;
      case 'delete': deleteIssues([t]); break;
    }
  }
  function paneChange(e) {
    var el = e.target, field = el.getAttribute('data-field'), t = paneTask();
    if (!field || !t) return;
    var v = el.value, patch = {};
    if (field === 'teamId' || field === 'projectId' || field === 'milestoneId') {
      patch[field] = v ? Number(v) : null;
      if (field === 'projectId' && String(t.projectId || '') !== v) patch.milestoneId = null;
    } else if (field === 'progress') patch.progress = Number(v) || 0;
    else if (field === 'startDate' || field === 'targetDate') {
      patch[field] = v || null;
      var s2 = field === 'startDate' ? v : t.startDate, e2 = field === 'targetDate' ? v : t.targetDate;
      if (s2 && e2 && e2 < s2) { toast('The target date cannot be before the start date.', 'err'); renderPane(); return; }
    } else if (field === 'effort') {
      if (v !== '' && (!isFinite(Number(v)) || Number(v) < 0)) { toast('Effort must be a positive number.', 'err'); renderPane(); return; }
      patch.effort = v === '' ? null : Number(v);
    }
    else patch[field] = v;
    updateTask(t, patch).then(null, function () {});
  }
  function paneKeys(e) {
    var el = e.target;
    if (el.getAttribute && el.getAttribute('data-ref') === 'titleInput') {
      if (e.key === 'Enter') { e.preventDefault(); saveTitle(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); S.pane.editTitle = false; renderPane(); }
    }
    if (e.key === 'Tab') {
      var f = document.querySelectorAll('#gh-pane .gh-pane button:not([disabled]),#gh-pane .gh-pane input:not([disabled]),#gh-pane .gh-pane select:not([disabled]),#gh-pane .gh-pane textarea,#gh-pane .gh-pane a[href]');
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  }
  function saveTitle() {
    var t = paneTask(), p = S.pane;
    var inp = document.querySelector('#gh-pane [data-ref="titleInput"]');
    if (!t || !inp) return;
    var v = inp.value.trim();
    if (!v) { toast('Title cannot be empty.', 'err'); inp.focus(); return; }
    p.editTitle = false; p.focus = '[data-act="edittitle"]';
    if (v === t.title) { renderPane(); return; }
    updateTask(t, { title: v }).then(function () { toast('Title updated.'); }, function () {});
  }
  function openLabelMenu(anchor, t) {
    var cur = parseLabels(t.labels);
    var all = LABELS.map(function (l) { return l.name; });
    S.tasks.forEach(function (x) { parseLabels(x.labels).forEach(function (n) { if (all.indexOf(n) === -1) all.push(n); }); });
    cur.forEach(function (n) { if (all.indexOf(n) === -1) all.push(n); });
    var items = [{ header: 'Apply labels' }].concat(all.map(function (n) {
      var d = ''; LABELS.forEach(function (l) { if (l.name === n) d = l.desc; });
      return { v: 'l:' + n, label: n, checked: cur.indexOf(n) !== -1, hint: d };
    }));
    items.push({ sep: true }, { v: 'new', label: 'Create a new label…' });
    openMenu(anchor, items, function (v) {
      if (v === 'new') { promptLabel(t); return; }
      var n = v.slice(2), next = cur.slice(), i = next.indexOf(n);
      if (i === -1) next.push(n); else next.splice(i, 1);
      if (JSON.stringify(next).length > 500) { toast('Too many labels on this issue.', 'err'); return; }
      updateTask(t, { labels: JSON.stringify(next) }).then(null, function () {});
    }, 'Labels');
  }
  function promptLabel(t) {
    var m = openModal('<form class="gh-modal gh-modal--sm" role="dialog" aria-modal="true" aria-labelledby="gh-nl-t"><div class="gh-modal-h"><h3 id="gh-nl-t">New label</h3></div>' +
      '<div class="gh-modal-b"><div class="gh-field"><label for="gh-nl-in">Label name</label><input id="gh-nl-in" class="gh-input" maxlength="40" autocomplete="off" placeholder="e.g. needs-design"></div></div>' +
      '<div class="gh-modal-f"><button type="button" class="gh-btn" data-x="1">Cancel</button><button type="submit" class="gh-btn gh-btn-primary">Add label</button></div></form>');
    var inp = m.el.querySelector('#gh-nl-in');
    inp.focus();
    m.el.querySelector('form').addEventListener('submit', function (e) {
      e.preventDefault();
      var v = inp.value.trim().replace(/\s+/g, '-').toLowerCase();
      if (!v) { inp.focus(); return; }
      var next = parseLabels(t.labels);
      if (next.indexOf(v) === -1) next.push(v);
      m.close();
      updateTask(t, { labels: JSON.stringify(next) }).then(null, function () {});
    });
  }
  function postComment(changeState, stage) {
    var t = paneTask(), p = S.pane;
    if (!t || !p || p.busy) return;
    var text = expandImgs(String(p.draft || '')).trim();
    if (!changeState && !text) { toast('Write a comment first.', 'err'); var ta = document.querySelector('#gh-pane [data-ref="draft"]'); if (ta) ta.focus(); return; }
    p.busy = true;
    var st = S;
    var first = text ? req('/api/tasks/' + t.id + '/comments', { method: 'POST', body: { body: text, commentType: 'comment' } }) : Promise.resolve(null);
    first.then(function (c) {
      if (st !== S) return;
      if (c) {
        p.draft = '';
        S.mde.cmt = { tab: 'write' };
        acClose();
        t.commentCount = (Number(t.commentCount) || 0) + 1;
        if (S.pane === p) { p.comments = (p.comments || []).concat([c]); }
      }
      if (changeState) {
        return updateTask(t, { stage: stage }).then(function () { toast(stage === 'done' ? 'Issue closed.' : 'Issue reopened.'); }, function () {});
      }
      renderBody();
    }).then(function () {
      if (st !== S) return;
      p.busy = false;
      if (S.pane === p) { p.focus = '[data-ref="draft"]'; renderPane(); }
    }, function (e) {
      if (st !== S) return;
      p.busy = false;
      toast(e.message, 'err');
      if (S.pane === p) renderPane();
    });
  }
  function saveCommentEdit(t, cid) {
    var p = S.pane, st = S;
    if (!p || p.busy) return;
    var text = mdeValue('cedit').trim();
    if (!text) { toast('A comment cannot be empty.', 'err'); return; }
    p.busy = true;
    req('/api/tasks/' + t.id + '/comments/' + cid, { method: 'PATCH', body: { body: text } }).then(function (c) {
      if (st !== S) return;
      p.busy = false;
      if (S.pane !== p) return;
      p.comments = (p.comments || []).map(function (x) { return String(x.id) === String(cid) ? c : x; });
      p.editCid = null;
      p.focus = '[data-act="editcomment"][data-cid="' + cid + '"]';
      renderPane();
      toast('Comment updated.');
    }, function (e) {
      if (st !== S) return;
      p.busy = false;
      toast(e.message, 'err');
    });
  }
  function react(t, cid, emoji) {
    var p = S.pane, st = S;
    if (!p || !p.comments) return;
    var c = null;
    p.comments.forEach(function (x) { if (String(x.id) === String(cid)) c = x; });
    if (!c) return;
    var before = c.reactions, re = parseReactions(c.reactions), em = me().email, users = (re[emoji] || []).slice();
    var i = users.map(function (u) { return String(u).toLowerCase(); }).indexOf(em);
    if (i === -1) users.push(em); else users.splice(i, 1);
    re[emoji] = users;
    c.reactions = JSON.stringify(re);
    p.focus = '[data-act="addreact"][data-cid="' + cid + '"]';
    renderPane();
    req('/api/tasks/' + t.id + '/comments/' + cid + '/reactions', { method: 'POST', body: { emoji: emoji } }).then(function (d) {
      if (st !== S || !d || !d.reactions) return;
      c.reactions = JSON.stringify(d.reactions);
      if (S.pane === p) renderPane();
    }, function (e) {
      if (st !== S) return;
      c.reactions = before;
      if (S.pane === p) renderPane();
      toast(e.message, 'err');
    });
  }
  function deleteComment(t, cid) {
    var p = S.pane, st = S;
    confirmBox({ title: 'Delete comment?', body: 'This comment will be permanently removed.', ok: 'Delete', danger: true }).then(function (ok) {
      if (!ok || st !== S) return;
      req('/api/tasks/' + t.id + '/comments/' + cid, { method: 'DELETE' }).then(function () {
        if (st !== S) return;
        if (S.pane === p) p.comments = (p.comments || []).filter(function (c) { return String(c.id) !== String(cid); });
        t.commentCount = Math.max(0, (Number(t.commentCount) || 0) - 1);
        renderBody();
        if (S.pane === p) renderPane();
        toast('Comment deleted.');
      }, function (e) { toast(e.message, 'err'); });
    });
  }
  function deleteIssues(list) {
    var deletable = list.filter(function (t) { return stageOf(t) === 'todo'; });
    var skipped = list.length - deletable.length;
    if (!deletable.length) { toast('Only issues in To Do can be deleted. Close them instead.', 'err'); return; }
    var st = S;
    confirmBox({
      title: deletable.length === 1 ? 'Delete ' + ref(deletable[0]) + '?' : 'Delete ' + deletable.length + ' issues?',
      body: (deletable.length === 1 ? '“' + deletable[0].title + '”' : 'The selected To Do issues') + ' will be permanently deleted with their comments. This cannot be undone.' +
        (skipped ? ' ' + skipped + ' selected issue' + (skipped === 1 ? ' is' : 's are') + ' not in To Do and will be kept.' : ''),
      ok: 'Delete', danger: true
    }).then(function (ok) {
      if (!ok || st !== S) return;
      var okN = 0, fail = 0, lastErr = '';
      Promise.all(deletable.map(function (t) {
        return req('/api/tasks/' + t.id, { method: 'DELETE' }).then(function () {
          okN++;
          S.tasks = S.tasks.filter(function (x) { return x.id !== t.id; });
          delete S.extra[String(t.id)];
          delete S.selected[t.id];
          if (S.pane && S.pane.id === String(t.id)) closePane({ noFocus: true });
        }, function (e) { fail++; lastErr = e.message; });
      })).then(function () {
        if (st !== S || !S.root) return;
        renderChrome(); renderBody();
        if (fail) toast('Deleted ' + okN + ', ' + fail + ' failed. ' + lastErr, 'err');
        else toast('Deleted ' + okN + ' issue' + (okN === 1 ? '' : 's') + '.');
      });
    });
  }

  /* ── roadmap ─────────────────────────────────────────────────────────── */
  function zoomPpd() { for (var i = 0; i < ZOOMS.length; i++) if (ZOOMS[i][0] === S.vc.zoom) return ZOOMS[i][2]; return 12; }
  function utcDate(n) { return new Date(n * 86400000); }
  function alignStart(n) {
    var d = utcDate(n);
    return S.vc.zoom === 'week' ? n - ((d.getUTCDay() + 6) % 7) : n - (d.getUTCDate() - 1);
  }
  function roadmapHtml(list) {
    var ppd = zoomPpd(), today = dayNum(todayISO()), ed = canEdit();
    var dated = [], undated = [];
    list.forEach(function (t) { var sp = spanOf(t); if (sp) dated.push({ t: t, sp: sp }); else undated.push(t); });
    dated.sort(function (a, b) { return (a.sp.s - b.sp.s) || (a.sp.e - b.sp.e) || (a.t.id - b.t.id); });
    var lo = today - 14, hi = today + (S.vc.zoom === 'quarter' ? 270 : (S.vc.zoom === 'week' ? 42 : 90));
    dated.forEach(function (d) { lo = Math.min(lo, d.sp.s - 7); hi = Math.max(hi, d.sp.e + 14); });
    lo = alignStart(lo);
    var W = (hi - lo + 1) * ppd;
    S.rm = { lo: lo, ppd: ppd };
    var ticks = '';
    for (var n = lo; n <= hi; n++) {
      var d = utcDate(n), lab = '';
      if (S.vc.zoom === 'week' && d.getUTCDay() === 1) lab = MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate();
      else if (S.vc.zoom !== 'week' && d.getUTCDate() === 1) lab = S.vc.zoom === 'quarter' ? MONTHS[d.getUTCMonth()] + (d.getUTCMonth() === 0 ? ' ' + d.getUTCFullYear() : '') : MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
      if (lab) ticks += '<span class="gh-rm-tick" style="left:' + ((n - lo) * ppd) + 'px">' + esc(lab) + '</span>';
    }
    var grid = ticks.replace(/>[^<]*<\/span>/g, '></span>');
    var rows = dated.map(function (x) {
      var t = x.t, sp = x.sp, left = (sp.s - lo) * ppd, width = Math.max(ppd, (sp.e - sp.s + 1) * ppd);
      var range = fmtDue(isoOfDay(sp.s)) + ' – ' + fmtDue(isoOfDay(sp.e));
      return '<div class="gh-rm-row" data-id="' + esc(t.id) + '"><div class="gh-rm-l">' + stateIcon(t, 14) +
        '<button type="button" class="gh-titlelink" data-act="open" data-id="' + esc(t.id) + '" title="' + esc(t.title) + '">' + esc(t.title) + '</button></div>' +
        '<div class="gh-rm-t" style="width:' + W + 'px">' + grid +
        '<div class="gh-rm-b' + (sp.fb ? ' is-fb' : '') + (isClosed(t) ? ' is-closed' : '') + '" data-bar="' + esc(t.id) + '" tabindex="0" role="button" style="left:' + left + 'px;width:' + width + 'px"' +
        ' title="' + esc(range + (sp.fb ? ' (created → due; drag to set start and target dates)' : '')) + '"' +
        ' aria-label="' + esc(ref(t) + ' ' + t.title + ', ' + range + (ed ? '. Arrow keys move it a day, Shift plus arrow keys change the target date, Enter opens it' : '')) + '">' +
        (ed ? '<span class="gh-rm-h" data-edge="s" aria-hidden="true" title="Drag to change the start date"></span>' : '') +
        '<span class="gh-rm-lbl">' + esc(t.title) + '</span>' +
        (ed ? '<span class="gh-rm-h" data-edge="e" aria-hidden="true" title="Drag to change the target date"></span>' : '') + '</div></div></div>';
    }).join('');
    if (!dated.length) rows = '<div class="gh-rm-row"><div class="gh-rm-l gh-muted" style="font-size:12.5px">No dated items</div><div class="gh-rm-t" style="width:' + W + 'px">' + grid + '</div></div>';
    var todayLine = today >= lo && today <= hi ? '<div class="gh-rm-today" style="left:calc(var(--rml) + ' + ((today - lo) * ppd + Math.floor(ppd / 2)) + 'px)"><span>Today</span></div>' : '';
    var side = '<aside class="gh-rm-side" aria-labelledby="gh-rm-nd"><h4 id="gh-rm-nd">' + svg(P.calendar, 14) + ' No dates <span class="gh-count">' + undated.length + '</span></h4>' +
      '<p>Set a start date, target date or due date to place an item on the roadmap.</p>' +
      (undated.length ? '<ul>' + undated.slice(0, 200).map(function (t) {
        return '<li>' + stateIcon(t, 14) + '<button type="button" class="gh-titlelink" data-act="open" data-id="' + esc(t.id) + '" title="' + esc(t.title) + '">' + esc(t.title) + '</button>' +
          (ed ? '<button type="button" class="gh-iconbtn" data-cell="start" data-id="' + esc(t.id) + '" aria-label="Set start date of ' + esc(ref(t)) + '" title="Set start date">' + svg(P.calendar, 14) + '</button>' : '') + '</li>';
      }).join('') + '</ul>' : '<p class="gh-muted">Every item has dates.</p>') + '</aside>';
    return '<div class="gh-rm"><div class="gh-rm-top"><div class="gh-seg" role="group" aria-label="Zoom">' + ZOOMS.map(function (z) {
      return '<button type="button" data-zoom="' + z[0] + '" aria-pressed="' + (S.vc.zoom === z[0]) + '">' + z[1] + '</button>';
    }).join('') + '</div><button type="button" class="gh-btn gh-btn-sm" data-act="rmtoday">Today</button>' +
      '<span class="gh-rm-tip">' + (ed ? 'Drag a bar to move it, or drag its ends to change the start and target dates.' : 'Bars run from the start date to the target date.') + ' Dashed bars use created → due.</span></div>' +
      '<div class="gh-rm-wrap"><div class="gh-rm-main"><div class="gh-rm-grid" style="width:calc(var(--rml) + ' + W + 'px)">' +
      '<div class="gh-rm-head"><div class="gh-rm-l">Title</div><div class="gh-rm-t" style="width:' + W + 'px">' + ticks + '</div></div>' +
      rows + todayLine + '</div></div>' + side + '</div></div>';
  }
  function scrollRoadmapToday(smooth) {
    var rm = S.refs.body && S.refs.body.querySelector('.gh-rm-main');
    if (!rm || !S.rm) return;
    var x = (dayNum(todayISO()) - S.rm.lo) * S.rm.ppd - rm.clientWidth / 3;
    try { rm.scrollTo({ left: Math.max(0, x), behavior: smooth ? 'smooth' : 'auto' }); } catch (_) { rm.scrollLeft = Math.max(0, x); }
  }
  function commitSpan(t, s, e) {
    updateTask(t, { startDate: isoOfDay(s), targetDate: isoOfDay(e) }).then(function () {
      toast(ref(t) + ': ' + fmtDue(isoOfDay(s)) + ' → ' + fmtDue(isoOfDay(e)) + '.');
    }, function () {});
  }
  function onRmDown(e) {
    var bar = e.target.closest && e.target.closest('.gh-rm-b');
    if (!bar || !S.root.contains(bar) || (e.button != null && e.button > 0)) return;
    var t = findTask(bar.getAttribute('data-bar')), sp = t && spanOf(t);
    if (!sp) return;
    var edge = e.target.getAttribute ? e.target.getAttribute('data-edge') : null;
    S.rmDrag = { t: t, bar: bar, mode: edge || 'move', x0: e.clientX, s0: sp.s, e0: sp.e, s: sp.s, e: sp.e, moved: false, ed: canEdit() };
    try { bar.setPointerCapture(e.pointerId); } catch (_) {}
    if (S.rmDrag.ed) bar.classList.add('is-drag');
    e.preventDefault();
  }
  function onRmMove(e) {
    var d = S && S.rmDrag;
    if (!d) return;
    if (Math.abs(e.clientX - d.x0) > 3) d.moved = true;
    if (!d.ed || !d.moved) return;
    var dd = Math.round((e.clientX - d.x0) / S.rm.ppd);
    if (d.mode === 'move') { d.s = d.s0 + dd; d.e = d.e0 + dd; }
    else if (d.mode === 's') { d.s = Math.min(d.s0 + dd, d.e0); d.e = d.e0; }
    else { d.e = Math.max(d.e0 + dd, d.s0); d.s = d.s0; }
    d.bar.style.left = ((d.s - S.rm.lo) * S.rm.ppd) + 'px';
    d.bar.style.width = Math.max(S.rm.ppd, (d.e - d.s + 1) * S.rm.ppd) + 'px';
    d.bar.title = fmtDue(isoOfDay(d.s)) + ' – ' + fmtDue(isoOfDay(d.e));
  }
  function onRmUp() {
    var d = S && S.rmDrag;
    if (!d) return;
    S.rmDrag = null;
    d.bar.classList.remove('is-drag');
    if (!d.moved) { openIssue(d.t.id); return; }
    if (!d.ed) return;
    if (d.s === d.s0 && d.e === d.e0) { renderBody(); return; }
    commitSpan(d.t, d.s, d.e);
  }
  function rmKey(e, bar) {
    var t = findTask(bar.getAttribute('data-bar')), sp = t && spanOf(t);
    if (!sp) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openIssue(t.id); return; }
    if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || !canEdit()) return;
    e.preventDefault();
    var dd = e.key === 'ArrowRight' ? 1 : -1;
    if (e.shiftKey) commitSpan(t, sp.s, Math.max(sp.s, sp.e + dd));
    else commitSpan(t, sp.s + dd, sp.e + dd);
  }

  /* ── cell editors (table, roadmap, issue pane) ───────────────────────── */
  function openInputPop(anchor, o, onPick) {
    closeMenu();
    var el = document.createElement('div');
    el.className = 'gh-layer gh-pop gh-datepop';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', o.title);
    el.innerHTML = '<div class="gh-menu-h">' + esc(o.title) + '</div><input class="gh-input" type="' + (o.type === 'number' ? 'number' : 'text') + '"' + (o.type === 'number' ? ' step="any" inputmode="decimal"' : ' maxlength="1024"') +
      ' value="' + esc(o.value == null ? '' : o.value) + '" aria-label="' + esc(o.title) + '"><div class="gh-ferr" data-err="1" role="alert"></div>' +
      '<div class="gh-box-actions"><button type="button" class="gh-btn gh-btn-sm" data-clear="1">Clear</button><button type="button" class="gh-btn gh-btn-sm gh-btn-primary" data-ok="1">Apply</button></div>';
    document.body.appendChild(el);
    var inp = el.querySelector('input');
    function done(v) { closeMenu(true); onPick(v); }
    el.querySelector('[data-ok]').onclick = function () {
      var v = inp.value.trim();
      if (o.type === 'number' && v !== '' && !isFinite(Number(v))) { el.querySelector('[data-err]').textContent = 'Enter a number.'; inp.focus(); return; }
      done(v === '' ? null : (o.type === 'number' ? Number(v) : v));
    };
    el.querySelector('[data-clear]').onclick = function () { done(null); };
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); el.querySelector('[data-ok]').click(); } });
    placePop(el, anchor);
    menu = { el: el, anchor: anchor };
    inp.focus(); inp.select();
  }
  function editCell(anchor, t, id) {
    if (!t || !canEdit()) return;
    var fd = fdef(id);
    if (!fd || fd.ro) return;
    function upd(patch) { updateTask(t, patch).then(null, function () {}); }
    switch (id) {
      case 'assignees': openPicker(anchor, { teamId: t.teamId, current: t.assigneeEmail }, function (p) { upd(assignPatch(p)); }); return;
      case 'reviewers': openPicker(anchor, { current: t.reviewerEmail }, function (p) { upd({ reviewerEmail: p ? p.email : '' }); }); return;
      case 'status':
        openListPop(anchor, { title: 'Status', search: false, items: STATUSES.map(function (s) {
          return { v: s.id, label: s.label, hint: s.hint, checked: stageOf(t) === s.id, html: '<span class="gh-tone-' + s.tone + '">' + svg(s.id === 'done' ? P.closed : P.open, 14) + '</span><span>' + esc(s.label) + '</span>' };
        }), onPick: function (v) { if (v !== stageOf(t)) upd({ stage: v }); } });
        return;
      case 'priority':
        openListPop(anchor, { title: 'Priority', search: false, items: PRIORITIES.map(function (p) {
          return { v: p.id, label: p.label, checked: prioOf(t.priority).id === p.id, html: '<span class="gh-tone-' + p.tone + '">●</span><span>' + esc(p.label) + '</span>' };
        }), onPick: function (v) { upd({ priority: v }); } });
        return;
      case 'type':
        openListPop(anchor, { title: 'Issue type', search: false, items: TYPES.map(function (x) {
          return { v: x.id, label: x.label, hint: x.desc, checked: typeOf(t.issueType).id === x.id, html: '<span class="gh-tone-' + x.tone + '">' + svg(TICON[x.id], 14) + '</span><span>' + esc(x.label) + '</span>' };
        }), onPick: function (v) { upd({ issueType: v }); } });
        return;
      case 'labels': openLabelMenu(anchor, t); return;
      case 'milestone':
        var proj = projectById(t.projectId);
        if (!proj) { toast('Add the issue to a project first: milestones belong to a project.', 'err'); return; }
        openListPop(anchor, { title: 'Milestone', placeholder: 'Filter milestones', empty: 'This project has no milestones.',
          items: [{ v: '', label: 'No milestone', checked: !t.milestoneId }].concat((proj.milestones || []).map(function (m) {
            return { v: String(m.id), label: m.title, hint: m.dueDate ? 'Due ' + fmtDue(m.dueDate) : '', checked: String(m.id) === String(t.milestoneId) };
          })), onPick: function (v) { upd({ milestoneId: v ? Number(v) : null }); } });
        return;
      case 'team':
        openListPop(anchor, { title: 'Team', placeholder: 'Filter teams', empty: 'No teams.',
          items: [{ v: '', label: 'No team', checked: !t.teamId }].concat(S.teams.map(function (x) { return { v: String(x.id), label: x.name, checked: String(x.id) === String(t.teamId) }; })),
          onPick: function (v) { upd({ teamId: v ? Number(v) : null }); } });
        return;
      case 'parent':
        openListPop(anchor, { title: 'Parent issue', placeholder: 'Search issues by title or #number', empty: 'No matching issues.',
          items: function () {
            return [{ v: '', label: 'No parent issue', checked: !t.parentId }].concat(S.tasks.filter(function (x) { return x.id !== t.id && x.parentId !== t.id; }).slice(0, 300).map(function (x) {
              return { v: String(x.id), label: '#' + x.id + ' ' + x.title, checked: String(x.id) === String(t.parentId), html: stateIcon(x, 14) + '<span class="gh-ref">#' + esc(x.id) + '</span><span class="gh-ac-t">' + esc(x.title) + '</span>' };
            }));
          },
          onPick: function (v) { upd({ parentId: v ? Number(v) : null }); } });
        return;
      case 'start': case 'target':
        openDatePop(anchor, id === 'start' ? t.startDate : t.targetDate, function (v) {
          var patch = {}; patch[id === 'start' ? 'startDate' : 'targetDate'] = v || null;
          var s2 = id === 'start' ? v : t.startDate, e2 = id === 'target' ? v : t.targetDate;
          if (s2 && e2 && e2 < s2) { toast('The target date cannot be before the start date.', 'err'); return; }
          upd(patch);
        }, fd.name);
        return;
      case 'due': openDatePop(anchor, dueISO(t.due), function (v) { upd({ due: v || '' }); }, 'Due date'); return;
      case 'effort': openInputPop(anchor, { title: 'Effort', type: 'number', value: t.effort }, function (v) {
        if (v != null && v < 0) { toast('Effort cannot be negative.', 'err'); return; }
        upd({ effort: v });
      }); return;
    }
    if (!fd.custom) return;
    var cf = fd.custom, cur = fieldVal(t, cf.id);
    function setv(v) { setFieldValue(t, cf, v).then(null, function () {}); }
    if (String(t.projectId || '') !== String(cf.projectId)) { toast('“' + cf.name + '” belongs to another project. Move the issue to that project first.', 'err'); return; }
    if (cf.type === 'single_select') {
      openListPop(anchor, { title: cf.name, placeholder: 'Filter options', empty: 'No options.',
        items: [{ v: '', label: 'No ' + cf.name, checked: cur == null }].concat(((cf.options && cf.options.choices) || []).map(function (c) {
          return { v: c.id, label: c.name, checked: cur === c.id, html: '<span class="gh-swatch gh-opt-' + esc(c.color) + '" aria-hidden="true"></span><span>' + esc(c.name) + '</span>', hint: c.description || '' };
        })), onPick: function (v) { setv(v || null); } });
    } else if (cf.type === 'iteration') {
      openListPop(anchor, { title: cf.name, search: false, empty: 'No iterations.',
        items: [{ v: '', label: 'No ' + cf.name, checked: cur == null }].concat((cf.iterations || []).map(function (it) {
          var now = todayISO() >= it.start && todayISO() <= it.end;
          return { v: it.id, label: it.title, checked: cur === it.id, hint: fmtDue(it.start) + ' – ' + fmtDue(it.end) + (now ? ' · current' : '') };
        })), onPick: function (v) { setv(v || null); } });
    } else if (cf.type === 'date') openDatePop(anchor, cur || '', function (v) { setv(v || null); }, cf.name);
    else openInputPop(anchor, { title: cf.name, type: cf.type === 'number' ? 'number' : 'text', value: cur }, setv);
  }

  /* ── field menus + dialogs ───────────────────────────────────────────── */
  function setVcFields(list) { S.vc = { fields: list, widths: S.vc.widths || {}, zoom: S.vc.zoom || 'month' }; vcChanged(); }
  function toggleField(id) {
    var list = (S.vc.fields || []).slice(), i = list.indexOf(id);
    if (i === -1) list.push(id); else list.splice(i, 1);
    setVcFields(list);
  }
  function openAddFieldMenu(anchor) {
    openListPop(anchor, {
      title: 'Fields', placeholder: 'Filter fields', multi: true, empty: 'No fields match.',
      top: [{ v: '__addissue', html: svg(P.plus, 14) + '<span>Add field</span>' }],
      items: function () {
        var vis = S.vc.fields || [];
        var out = [{ v: 'title', label: 'Title', checked: true, disabled: true, hint: 'Always shown' }];
        FIELD_DEFS.forEach(function (f) { out.push({ v: f.id, label: f.name, checked: vis.indexOf(f.id) !== -1 }); });
        if (S.fields.length) {
          out.push({ header: 'Project fields' });
          S.fields.forEach(function (cf) { out.push({ v: 'f:' + cf.id, label: cf.name, hint: ftypeLabel(cf.type), checked: vis.indexOf('f:' + cf.id) !== -1 }); });
        }
        return out;
      },
      footer: S.f.project && canConfigure() ? [{ v: '__newfield', html: svg(P.plus, 14) + '<span>New project field</span>' }] : [],
      onPick: function (v) {
        if (v === '__addissue') openAddIssueFields();
        else if (v === '__newfield') openFieldDialog(null);
        else if (v !== 'title') toggleField(v);
      }
    });
  }
  function ftypeLabel(t) { for (var i = 0; i < FTYPES.length; i++) if (FTYPES[i][0] === t) return FTYPES[i][1]; return t; }
  function openAddIssueFields() {
    var vis = S.vc.fields || [];
    var cand = FIELD_DEFS.filter(function (f) { return f.issue && vis.indexOf(f.id) === -1; });
    var proj = projectById(S.f.project), canNew = !!proj && canConfigure();
    var m = openModal('<form class="gh-modal gh-modal--sm" role="dialog" aria-modal="true" aria-labelledby="gh-aif-t" aria-describedby="gh-aif-d" novalidate>' +
      '<div class="gh-modal-h"><h3 id="gh-aif-t">Add issue fields</h3><button type="button" class="gh-iconbtn" data-x="1" aria-label="Close">' + svg(P.x, 16) + '</button></div>' +
      '<div class="gh-modal-b"><p id="gh-aif-d">Issue fields are shared by every issue in every project. Add them to this view to show and edit them here, on board cards and on the roadmap.</p>' +
      '<p>Need something specific to this project? ' + (canNew ? '<button type="button" class="gh-linkbtn" data-create="1"><strong>Create a project field</strong></button>'
        : '<span class="gh-muted">' + (proj ? 'Only people who can edit issues can create project fields.' : 'Select a project to create project fields.') + '</span>') + '</p>' +
      (cand.length ? '<fieldset class="gh-checklist" style="margin:0"><legend class="gh-sr">Issue fields to add</legend>' + cand.map(function (f) {
        return '<label><input type="checkbox" value="' + esc(f.id) + '"><span><b>' + esc(f.name) + '</b><small>' + esc(f.desc || '') + '</small></span></label>';
      }).join('') + '</fieldset>' : '<p class="gh-muted">Every issue field is already in this view.</p>') +
      '</div><div class="gh-modal-f"><button type="button" class="gh-btn" data-x="1">Cancel</button><button type="submit" class="gh-btn gh-btn-primary" data-ref="aifAdd" disabled>Add</button></div></form>');
    var el = m.el, add = el.querySelector('[data-ref="aifAdd"]');
    function picked() { return Array.prototype.map.call(el.querySelectorAll('.gh-checklist input:checked'), function (i) { return i.value; }); }
    el.addEventListener('change', function () { var n = picked().length; add.disabled = !n; add.textContent = n > 1 ? 'Add ' + n + ' fields' : 'Add'; });
    el.querySelector('form').addEventListener('submit', function (e) {
      e.preventDefault();
      var ids = picked();
      if (!ids.length) return;
      m.close();
      setVcFields((S.vc.fields || []).concat(ids.filter(function (x) { return (S.vc.fields || []).indexOf(x) === -1; })));
      toast('Added ' + ids.map(function (x) { return fdef(x).name; }).join(', ') + ' to this view.');
    });
    var cr = el.querySelector('[data-create]');
    if (cr) cr.onclick = function () { m.close(); openFieldDialog(null); };
    var first = el.querySelector('.gh-checklist input') || el.querySelector('[data-create]') || add;
    if (first) first.focus();
  }
  function openFieldDialog(cf) {
    var pid = S.f.project;
    if (!pid) { toast('Select a project to create project fields.', 'err'); return; }
    if (!canConfigure()) { toast("You don't have permission to change this project's fields.", 'err'); return; }
    var editing = !!cf, d = {
      name: cf ? cf.name : '', type: cf ? cf.type : 'text',
      choices: cf && cf.options && cf.options.choices ? cf.options.choices.map(copy) : [{ name: '', color: 'gray' }],
      weeks: cf && cf.options && cf.options.weeks || 2, start: cf && cf.options && cf.options.start || '', count: cf && cf.options && cf.options.count || 6
    };
    var m = openModal('<form class="gh-modal gh-modal--sm" role="dialog" aria-modal="true" aria-labelledby="gh-fd-t" novalidate>' +
      '<div class="gh-modal-h"><h3 id="gh-fd-t">' + (editing ? 'Edit field' : 'Create a project field') + '</h3><button type="button" class="gh-iconbtn" data-x="1" aria-label="Close">' + svg(P.x, 16) + '</button></div>' +
      '<div class="gh-modal-b"><div class="gh-formerr" role="alert" data-ref="err" hidden></div>' +
      '<div class="gh-field"><label for="gh-fd-name">Field name <span class="gh-req" aria-hidden="true">*</span></label><input id="gh-fd-name" class="gh-input" maxlength="100" autocomplete="off" aria-required="true" value="' + esc(d.name) + '" placeholder="e.g. Size, Sprint, Estimate"></div>' +
      '<div class="gh-field"><label for="gh-fd-type">Field type</label><select id="gh-fd-type" class="gh-select"' + (editing ? ' disabled title="A field\'s type cannot be changed"' : '') + '>' +
      FTYPES.map(function (x) { return '<option value="' + x[0] + '"' + (x[0] === d.type ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select></div>' +
      '<div data-ref="opts"></div></div>' +
      '<div class="gh-modal-f"><button type="button" class="gh-btn" data-x="1">Cancel</button><button type="submit" class="gh-btn gh-btn-primary" data-ref="fdSave">' + (editing ? 'Save' : 'Create field') + '</button></div></form>',
      { confirmClose: function () { return !editing && !!m.el.querySelector('#gh-fd-name').value.trim(); }, confirmTitle: 'Discard this field?', confirmBody: 'The field has not been created yet.' });
    var el = m.el;
    function q(s) { return el.querySelector(s); }
    function readOpts() {
      var rows = el.querySelectorAll('[data-opt]');
      if (rows.length) d.choices = Array.prototype.map.call(rows, function (r, i) {
        return { id: (d.choices[i] || {}).id, name: r.querySelector('input').value, color: r.querySelector('select').value };
      });
      if (q('#gh-fd-weeks')) { d.weeks = Number(q('#gh-fd-weeks').value) || 2; d.start = q('#gh-fd-start').value; d.count = Number(q('#gh-fd-count').value) || 6; }
    }
    function drawOpts() {
      var box = q('[data-ref="opts"]');
      if (d.type === 'single_select') {
        box.innerHTML = '<div class="gh-field"><span class="gh-flabel" id="gh-fd-ol">Options</span><div class="gh-optlist" role="group" aria-labelledby="gh-fd-ol">' + d.choices.map(function (c, i) {
          return '<div class="gh-optrow" data-opt="' + i + '"><span class="gh-swatch gh-opt-' + esc(c.color || 'gray') + '" aria-hidden="true"></span>' +
            '<input class="gh-input" maxlength="60" value="' + esc(c.name || '') + '" placeholder="Option name" aria-label="Option ' + (i + 1) + ' name">' +
            '<select class="gh-select" aria-label="Option ' + (i + 1) + ' colour">' + FCOLORS.map(function (col) { return '<option value="' + col + '"' + (col === (c.color || 'gray') ? ' selected' : '') + '>' + col.charAt(0).toUpperCase() + col.slice(1) + '</option>'; }).join('') + '</select>' +
            '<button type="button" class="gh-iconbtn" data-rmopt="' + i + '" aria-label="Remove option ' + (i + 1) + '"' + (d.choices.length < 2 ? ' disabled' : '') + '>' + svg(P.x, 14) + '</button></div>';
        }).join('') + '</div><button type="button" class="gh-btn gh-btn-sm" data-addopt="1" style="align-self:flex-start">' + svg(P.plus, 14) + ' Add option</button></div>';
      } else if (d.type === 'iteration') {
        box.innerHTML = '<div class="gh-grid2"><div class="gh-field"><label for="gh-fd-weeks">Duration</label><select id="gh-fd-weeks" class="gh-select">' +
          [1, 2, 3, 4, 6, 8].map(function (w) { return '<option value="' + w + '"' + (w === Number(d.weeks) ? ' selected' : '') + '>' + w + ' week' + (w > 1 ? 's' : '') + '</option>'; }).join('') + '</select></div>' +
          '<div class="gh-field"><label for="gh-fd-start">Starts on</label><input id="gh-fd-start" type="date" class="gh-input" value="' + esc(d.start) + '"></div></div>' +
          '<div class="gh-field"><label for="gh-fd-count">Number of iterations</label><input id="gh-fd-count" type="number" min="1" max="52" class="gh-input" value="' + esc(d.count) + '"></div>' +
          (editing ? '<p class="gh-muted" style="font-size:12.5px">Issues set to an iteration that no longer exists are cleared.</p>' : '');
      } else box.innerHTML = '';
    }
    q('#gh-fd-type').addEventListener('change', function () { readOpts(); d.type = this.value; drawOpts(); });
    el.addEventListener('change', function (e) {
      var sel = e.target.closest && e.target.closest('[data-opt] select');
      if (sel) { var sw = sel.parentNode.querySelector('.gh-swatch'); sw.className = 'gh-swatch gh-opt-' + sel.value; }
    });
    el.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('[data-addopt],[data-rmopt]');
      if (!a) return;
      readOpts();
      if (a.hasAttribute('data-addopt')) { d.choices.push({ name: '', color: FCOLORS[d.choices.length % FCOLORS.length] }); drawOpts(); var ins = el.querySelectorAll('[data-opt] input'); ins[ins.length - 1].focus(); }
      else { d.choices.splice(+a.getAttribute('data-rmopt'), 1); drawOpts(); var f0 = el.querySelector('[data-opt] input'); if (f0) f0.focus(); }
    });
    var busy = false;
    q('form').addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy) return;
      readOpts();
      var name = q('#gh-fd-name').value.trim(), err = q('[data-ref="err"]');
      if (!name) { err.textContent = 'Field name is required.'; err.hidden = false; q('#gh-fd-name').focus(); return; }
      var body = { name: name };
      if (!editing) body.type = d.type;
      if (d.type === 'single_select') {
        var ch = d.choices.filter(function (c) { return String(c.name || '').trim(); });
        if (!ch.length) { err.textContent = 'Add at least one option.'; err.hidden = false; return; }
        body.options = { choices: ch };
      } else if (d.type === 'iteration') body.options = { weeks: d.weeks, start: d.start || null, count: d.count };
      busy = true; q('[data-ref="fdSave"]').disabled = true; err.hidden = true;
      var st = S;
      req('/api/projects/' + pid + '/fields' + (editing ? '/' + cf.id : ''), { method: editing ? 'PATCH' : 'POST', body: body }).then(function (row) {
        if (st !== S) return;
        m.close();
        if (S.f.project !== pid) return;
        var i, found = false;
        for (i = 0; i < S.fields.length; i++) if (S.fields[i].id === row.id) { S.fields[i] = row; found = true; }
        if (!found) S.fields.push(row);
        if (!editing && (S.vc.fields || []).indexOf('f:' + row.id) === -1) setVcFields((S.vc.fields || []).concat(['f:' + row.id]));
        else { renderChrome(); renderBody(); }
        if (editing && row.valuesRemoved) loadTasks();
        toast(editing ? 'Field “' + row.name + '” saved.' : 'Field “' + row.name + '” created and added to this view.');
      }, function (er) {
        busy = false; q('[data-ref="fdSave"]').disabled = false;
        err.textContent = er.message; err.hidden = false;
      });
    });
    drawOpts();
    q('#gh-fd-name').focus();
  }
  function deleteField(cf) {
    var st = S, pid = S.f.project;
    confirmBox({ title: 'Delete field “' + cf.name + '”?', body: 'The field and its values on every issue in this project will be permanently deleted. Views that show it will stop showing it.', ok: 'Delete field', danger: true }).then(function (ok) {
      if (!ok || st !== S) return;
      req('/api/projects/' + pid + '/fields/' + cf.id, { method: 'DELETE' }).then(function () {
        if (st !== S) return;
        S.fields = S.fields.filter(function (x) { return x.id !== cf.id; });
        S.tasks.forEach(function (t) { if (t.fields) delete t.fields[String(cf.id)]; });
        var key = 'f:' + cf.id;
        if (S.f.group === key) S.f.group = 'status';
        if (S.f.tgroup === key) S.f.tgroup = '';
        if (S.f.sort === key) S.f.sort = 'updated';
        setVcFields((S.vc.fields || []).filter(function (x) { return x !== key; }));
        toast('Field “' + cf.name + '” deleted.');
      }, function (e) { toast(e.message, 'err'); });
    });
  }
  function openFieldMenu(anchor, id) {
    var fd = fdef(id);
    if (!fd) return;
    var list = visibleFields(), i = list.indexOf(id), items = [
      { v: 'asc', label: 'Sort ascending', checked: S.f.sort === id && S.f.dir === 'asc' },
      { v: 'desc', label: 'Sort descending', checked: S.f.sort === id && S.f.dir === 'desc' }
    ];
    var gk = id === 'assignees' ? 'assignee' : id, cur = S.f.view === 'board' ? S.f.group : S.f.tgroup;
    if (fd.group) items.push({ sep: true }, cur === gk ? { v: 'ungroup', label: 'Remove grouping', disabled: S.f.view === 'board' && gk === 'status' } : { v: 'group', label: 'Group by ' + fd.name });
    if (id !== 'title') {
      items.push({ sep: true }, { v: 'left', label: 'Move left', disabled: i <= 0 }, { v: 'right', label: 'Move right', disabled: i === -1 || i >= list.length - 1 },
                 { v: 'hide', label: 'Hide field' });
    }
    if (fd.custom && canConfigure()) {
      items.push({ sep: true }, { v: 'edit', label: fd.custom.type === 'single_select' || fd.custom.type === 'iteration' ? 'Edit field…' : 'Rename field…' },
                 { v: 'delete', label: 'Delete field…', danger: true });
    }
    anchor.setAttribute('aria-expanded', 'true');
    openMenu(anchor, items, function (v) {
      if (v === 'asc' || v === 'desc') setFilter({ sort: id === 'assignees' ? 'assignee' : id, dir: v }, { push: true });
      else if (v === 'group') setFilter(S.f.view === 'board' ? { group: gk } : { tgroup: gk }, { push: true });
      else if (v === 'ungroup') setFilter(S.f.view === 'board' ? { group: 'status' } : { tgroup: '' }, { push: true });
      else if (v === 'hide') setVcFields((S.vc.fields || []).filter(function (x) { return x !== id; }));
      else if (v === 'left' || v === 'right') {
        var l = visibleFields(), j = l.indexOf(id), k = v === 'left' ? j - 1 : j + 1;
        if (j < 0 || k < 0 || k >= l.length) return;
        l[j] = l[k]; l[k] = id;
        setVcFields(l);
        setTimeout(function () { var b = S.root && S.root.querySelector('[data-act="colfield"][data-field="' + cssq(id) + '"]'); if (b) b.focus(); }, 0);
      } else if (v === 'edit') openFieldDialog(fd.custom);
      else if (v === 'delete') deleteField(fd.custom);
    }, 'Field options for ' + fd.name);
    if (menu) menu.onClose = function () { anchor.removeAttribute('aria-expanded'); };
  }
  /* Column resizing: pointer drag on the header edge, or arrow keys. */
  function onResizeDown(e) {
    var h = e.target.closest && e.target.closest('[data-resize]');
    if (!h || !S.root.contains(h)) return;
    e.preventDefault();
    var id = h.getAttribute('data-resize'), col = S.root.querySelector('col[data-colw="' + cssq(id) + '"]'), table = h.closest('table');
    S.resize = { id: id, x0: e.clientX, w0: colWidth(id), col: col, table: table, tw0: table ? table.offsetWidth : 0, h: h, w: colWidth(id) };
    h.classList.add('is-active');
    try { h.setPointerCapture(e.pointerId); } catch (_) {}
  }
  function onResizeMove(e) {
    var r = S && S.resize;
    if (!r) return;
    r.w = Math.max(48, Math.min(900, Math.round(r.w0 + e.clientX - r.x0)));
    if (r.col) r.col.style.width = r.w + 'px';
    if (r.table) r.table.style.width = (r.tw0 + r.w - r.w0) + 'px';
  }
  function onResizeUp() {
    var r = S && S.resize;
    if (!r) return;
    S.resize = null;
    r.h.classList.remove('is-active');
    if (r.w === r.w0) return;
    setWidth(r.id, r.w);
  }
  function setWidth(id, w) {
    var widths = copy(S.vc.widths || {});
    widths[id] = w;
    S.vc = { fields: S.vc.fields, widths: widths, zoom: S.vc.zoom };
    vcChanged();
  }

  /* ── delete project (GitHub-style name confirmation) ─────────────────── */
  function openDeleteProject(p) {
    var todo = 0;
    if (String(S.f.project) === String(p.id)) S.tasks.forEach(function (t) { if (String(t.projectId) === String(p.id) && stageOf(t) === 'todo') todo++; });
    else todo = (p.taskStats && p.taskStats.todo) || 0;
    var total = (p.taskStats && p.taskStats.total) || 0;
    var m = openModal('<form class="gh-modal gh-modal--sm" role="alertdialog" aria-modal="true" aria-labelledby="gh-dp-t" aria-describedby="gh-dp-d" novalidate>' +
      '<div class="gh-modal-h"><h3 id="gh-dp-t">Delete project</h3><button type="button" class="gh-iconbtn" data-x="1" aria-label="Close">' + svg(P.x, 16) + '</button></div>' +
      '<div class="gh-modal-b"><div class="gh-warnbox" id="gh-dp-d">This permanently deletes <b>' + esc(p.name) + '</b> with its views, custom fields and their values, milestones and status updates. ' +
      'Its ' + total + ' issue' + (total === 1 ? '' : 's') + ' are kept and removed from the project. This cannot be undone.</div>' +
      (todo && canDelete() ? '<label class="gh-check-lbl"><input type="checkbox" data-ref="dpTodo"> Also delete ' + todo + ' issue' + (todo === 1 ? '' : 's') + ' that ' + (todo === 1 ? 'is' : 'are') + ' in To Do</label>' : '') +
      '<div class="gh-field"><label for="gh-dp-in">To confirm, type “<b>' + esc(p.name) + '</b>” in the box below</label><input id="gh-dp-in" class="gh-input" autocomplete="off" spellcheck="false"></div>' +
      '<div class="gh-formerr" role="alert" data-ref="err" hidden></div></div>' +
      '<div class="gh-modal-f"><button type="button" class="gh-btn" data-x="1">Cancel</button><button type="submit" class="gh-btn gh-btn-danger" data-ref="dpGo" disabled>Delete this project</button></div></form>');
    var el = m.el, inp = el.querySelector('#gh-dp-in'), go = el.querySelector('[data-ref="dpGo"]');
    inp.addEventListener('input', function () { go.disabled = inp.value.trim() !== String(p.name || '').trim(); });
    el.querySelector('form').addEventListener('submit', function (e) {
      e.preventDefault();
      if (go.disabled) return;
      var cb = el.querySelector('[data-ref="dpTodo"]'), st = S, err = el.querySelector('[data-ref="err"]');
      go.disabled = true; go.textContent = 'Deleting…';
      req('/api/projects/' + p.id, { method: 'DELETE', body: { confirmName: inp.value.trim(), deleteTodoIssues: !!(cb && cb.checked) } }).then(function (d) {
        if (st !== S) return;
        m.close();
        closePP();
        S.projects = S.projects.filter(function (x) { return String(x.id) !== String(p.id); });
        toast('Deleted “' + p.name + '”. ' + (d.unlinked || 0) + ' issue' + (d.unlinked === 1 ? '' : 's') + ' kept' + (d.deleted ? ', ' + d.deleted + ' To Do issue' + (d.deleted === 1 ? '' : 's') + ' deleted' : '') + '.');
        if (String(S.f.project) === String(p.id)) setFilter({ project: '' }, { push: true });
        else { renderChrome(); loadTasks(); }
      }, function (er) {
        go.disabled = false; go.textContent = 'Delete this project';
        err.textContent = er.message; err.hidden = false;
      });
    });
    inp.focus();
  }
  function setArchived(p, on) {
    var st = S;
    return req('/api/projects/' + p.id + (on ? '/archive' : '/unarchive'), { method: 'POST' }).then(function (row) {
      if (st !== S) return;
      replaceProject(row);
      renderChrome();
      if (S.pp) renderPP();
      toast(on ? 'Archived “' + row.name + '”. It is hidden from the project picker; use “Show archived” to find it.' : 'Restored “' + row.name + '”.');
    }, function (e) { toast(e.message, 'err'); });
  }
  function projectMoreItems(p) {
    var items = [{ v: 'open', label: 'Open project' }, { v: 'details', label: 'Project details' }, { v: 'pin', label: isPinned(p.id) ? 'Unpin' : 'Pin to top' }];
    var ed = canManageProject(p), del = canDeleteProject();
    if (ed) items.splice(2, 0, { v: 'edit', label: 'Edit project…' });
    if (ed || del) items.push({ sep: true });
    if (ed) items.push({ v: 'archive', label: p.archivedAt ? 'Restore (unarchive)' : 'Archive project' });
    if (del) items.push({ v: 'delete', label: 'Delete project…', danger: true });
    return items;
  }
  function doProjectAction(v, p) {
    if (v === 'open') setFilter({ project: String(p.id) }, { push: true });
    else if (v === 'details') openProjectPanel(p.id);
    else if (v === 'edit') openEditProject(p);
    else if (v === 'pin') { togglePin(p.id); renderChrome(); }
    else if (v === 'archive') setArchived(p, !p.archivedAt);
    else if (v === 'delete') openDeleteProject(p);
  }
  function openProjectMore(anchor, p) {
    openMenu(anchor, projectMoreItems(p), function (v) { doProjectAction(v, p); }, 'Actions for ' + p.name);
  }

  /* ── root event delegation ───────────────────────────────────────────── */
  function onRootClick(e) {
    var t = e.target;
    var st = t.closest('[data-state]');
    if (st && S.root.contains(st)) { setFilter({ state: st.getAttribute('data-state') }, { push: true }); return; }
    var vw = t.closest('[data-view]');
    if (vw) { setFilter({ view: vw.getAttribute('data-view') }, { push: true }); return; }
    var pv = t.closest('[data-pv]');
    if (pv) { if (String(pv.getAttribute('data-pv')) !== String(S.f.pv)) selectView(pv.getAttribute('data-pv'), { push: true }); return; }
    var zm = t.closest('[data-zoom]');
    if (zm) { S.vc = { fields: S.vc.fields, widths: S.vc.widths, zoom: zm.getAttribute('data-zoom') }; vcChanged(); return; }
    var so = t.closest('[data-sort]');
    if (so) {
      var key = so.getAttribute('data-sort');
      if (key === 'assignees') key = 'assignee';
      setFilter(S.f.sort === key ? { dir: S.f.dir === 'asc' ? 'desc' : 'asc' } : { sort: key, dir: /^(title|assignee|team|status|due|start|target|labels|milestone|type|reviewers|parent)$/.test(key) || /^f:/.test(key) ? 'asc' : 'desc' }, { push: true });
      return;
    }
    var cell = t.closest('[data-cell]');
    if (cell && S.root.contains(cell)) { editCell(cell, findTask(cell.getAttribute('data-id')), cell.getAttribute('data-cell')); return; }
    var a = t.closest('[data-act]');
    if (a && S.root.contains(a)) {
      var act = a.getAttribute('data-act'), id = a.getAttribute('data-id'), task = id ? findTask(id) : null;
      switch (act) {
        case 'new': openNewIssue(); return;
        case 'vmenu': openViewTabMenu(a); return;
        case 'newview': openNewViewMenu(a); return;
        case 'colfield': openFieldMenu(a, a.getAttribute('data-field')); return;
        case 'addfield': openAddFieldMenu(a); return;
        case 'rmtoday': scrollRoadmapToday(true); return;
        case 'projpick': openProjectPicker(a); return;
        case 'projinfo': if (S.f.project) openProjectPanel(S.f.project); return;
        case 'newproject': openNewProject(); return;
        case 'insights': S.insight = !S.insight; insSave(); renderChrome(); return;
        case 'insrange': S.insRange = Number(a.getAttribute('data-days')) || 30; insSave(); renderInsight(); return;
        case 'insq': insFilter(a.getAttribute('data-key'), a.getAttribute('data-q')); return;
        case 'clearq': S.refs.q.value = ''; setFilter({ q: '' }); S.refs.q.focus(); return;
        case 'clearall': S.refs.q.value = ''; setFilter({ q: '', state: 'all', team: '', project: '' }, { push: true }); return;
        case 'viewmenu': openViewMenu(a); return;
        case 'retry': S.error = ''; loadTasks(); return;
        case 'colmenu': openColMenu(a, a.getAttribute('data-col')); return;
        case 'expand': delete S.collapsed[a.getAttribute('data-col')]; savePrefs(); renderBody(); return;
        case 'quickadd': S.quickAdd = a.getAttribute('data-col'); S.quickAddDraft = ''; renderBody(); return;
        case 'cardmenu': if (task) openCardMenu(a, task); return;
        case 'open': if (task) openIssue(task.id); return;
        case 'assign': if (task) openPicker(a, { teamId: task.teamId, current: task.assigneeEmail }, function (p) { updateTask(task, assignPatch(p)).then(null, function () {}); }); return;
        case 'more': S.limit += PAGE; renderBody(); return;
        case 'bulkclear': S.selected = {}; renderBody(); return;
        case 'bulkclose': runBulk(currentSelection(), function (x) { return isClosed(x) ? null : { stage: 'done' }; }, 'Close'); return;
        case 'bulkdelete': deleteIssues(currentSelection()); return;
        case 'bulkassign':
          var sel = currentSelection();
          openPicker(a, { teamId: S.f.team || '' }, function (p) { runBulk(sel, function () { return assignPatch(p); }, 'Assign'); });
          return;
      }
    }
    var card = t.closest('.gh-card');
    if (card && !t.closest('button,a,input,select,textarea')) { openIssue(card.getAttribute('data-id')); }
  }
  function onRootChange(e) {
    var el = e.target, ref_ = el.getAttribute('data-ref');
    if (ref_ === 'proj') { setFilter({ project: el.value }, { push: true }); return; }
    if (ref_ === 'team') { setFilter({ team: el.value }, { push: true }); return; }
    var edit = el.getAttribute('data-edit');
    if (edit) {
      var t = findTask(el.getAttribute('data-id'));
      if (!t) return;
      var patch = {};
      patch[edit] = el.value;
      updateTask(t, patch).then(null, function () {});
      return;
    }
    var bulk = el.getAttribute('data-bulk');
    if (bulk && el.value) {
      var v = el.value, label = bulk === 'stage' ? statusOf(v).label : prioOf(v).label;
      runBulk(currentSelection(), function (x) {
        if (bulk === 'stage') return stageOf(x) === v ? null : { stage: v };
        return prioOf(x.priority).id === v ? null : { priority: v };
      }, 'Set ' + (bulk === 'stage' ? 'status' : 'priority') + ' to ' + label);
      return;
    }
    var act = el.getAttribute('data-act');
    if (act === 'sel') {
      if (el.checked) S.selected[el.getAttribute('data-id')] = true; else delete S.selected[el.getAttribute('data-id')];
      var tr = el.closest('tr'); if (tr) tr.classList.toggle('is-selected', el.checked);
      var list = sortList(applyState(baseFiltered()));
      renderBulk(list);
      var all = S.root.querySelector('[data-act="selall"]');
      if (all) { var n = selectedVisible(list).length; all.checked = n > 0 && n === Math.min(list.length, S.limit); all.indeterminate = n > 0 && !all.checked; }
    } else if (act === 'selall') {
      var lst = sortList(applyState(baseFiltered())).slice(0, S.limit);
      S.selected = {};
      if (el.checked) lst.forEach(function (x) { S.selected[x.id] = true; });
      renderBody();
    }
  }
  function onRootInput(e) {
    if (e.target === S.refs.q) {
      var v = e.target.value;
      S.refs.qClear.hidden = !v;
      clearTimeout(S.qTimer);
      S.qTimer = setTimeout(function () { if (S && S.root) setFilter({ q: v }); }, 150);
    } else if (e.target.closest && e.target.closest('.gh-qa')) S.quickAddDraft = e.target.value;
  }
  function onRootKey(e) {
    var t = e.target;
    if (t.getAttribute && t.getAttribute('data-ref') === 'addrow') {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); t.value = ''; t.blur(); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var title = t.value.trim();
      if (!title || t.disabled) return;
      t.disabled = true;
      var body = { title: title, stage: 'todo', priority: 'medium' };
      if (S.f.project) body.projectId = Number(S.f.project);
      if (S.f.team) body.teamId = Number(S.f.team);
      createTask(body).then(function (row) {
        var again = S.root && S.root.querySelector('[data-ref="addrow"]');
        if (again) { again.disabled = false; again.value = ''; again.focus(); }
        toast('Added ' + (row ? ref(row) : 'item') + '.');
      }, function (err) {
        var again = S.root && S.root.querySelector('[data-ref="addrow"]');
        if (again) { again.disabled = false; again.focus(); }
        toast(err.message, 'err');
      });
      return;
    }
    if (t.classList && t.classList.contains('gh-rm-b')) { rmKey(e, t); return; }
    if (t.hasAttribute && t.hasAttribute('data-resize') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      var rid = t.getAttribute('data-resize');
      setWidth(rid, Math.max(48, Math.min(900, colWidth(rid) + (e.key === 'ArrowRight' ? 16 : -16))));
      return;
    }
    var qa = t.closest && t.closest('.gh-qa');
    if (qa) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); var key = S.quickAdd; S.quickAdd = null; renderBody(); var b = S.root.querySelector('[data-act="quickadd"][data-col="' + key + '"]'); if (b) b.focus(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        var v = t.value.trim(), col = qa.getAttribute('data-col');
        if (!v || t.disabled) return;
        t.disabled = true;
        quickCreate(col, v).then(function () {
          S.quickAddDraft = '';
          var again = S.root && S.root.querySelector('.gh-qa input');
          if (again) { again.disabled = false; again.value = ''; again.focus(); }
        }, function (err) {
          t.disabled = false; t.focus();
          toast(err.message, 'err');
        });
      }
      return;
    }
    if (t === S.refs.q) {
      if (e.key === 'Escape') { e.stopPropagation(); t.blur(); }
      else if (e.key === 'Enter') { clearTimeout(S.qTimer); setFilter({ q: t.value }, { push: true }); }
      return;
    }
    if (t.classList && t.classList.contains('gh-card') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openIssue(t.getAttribute('data-id')); }
      else if (e.key === 'm' || e.key === 'M' || (e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
        e.preventDefault();
        var task = findTask(t.getAttribute('data-id')), btn = t.querySelector('[data-act="cardmenu"]');
        if (task && btn) openCardMenu(btn, task);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        var sib = e.key === 'ArrowDown' ? t.nextElementSibling : t.previousElementSibling;
        if (sib && sib.classList.contains('gh-card')) { e.preventDefault(); sib.focus(); }
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        var colEl = t.closest('.gh-col'), next = colEl;
        do { next = e.key === 'ArrowRight' ? next.nextElementSibling : next.previousElementSibling; } while (next && !next.querySelector('.gh-card'));
        if (next) { e.preventDefault(); next.querySelector('.gh-card').focus(); }
      }
    }
  }
  function onRootSubmit(e) { if (e.target.classList && e.target.classList.contains('gh-qa')) e.preventDefault(); }
  function colFromEl(el) { var c = el && el.closest ? el.closest('.gh-col') : null; return c && S.root.contains(c) ? c : null; }
  function onDragStart(e) {
    var card = e.target.closest && e.target.closest('.gh-card');
    if (!card || !canEdit()) return;
    S.dragId = card.getAttribute('data-id');
    try { e.dataTransfer.setData('text/plain', S.dragId); e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
    card.classList.add('is-dragging');
  }
  function onDragOver(e) {
    if (!S.dragId) return;
    var col = colFromEl(e.target);
    if (!col) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
    var prev = S.root.querySelectorAll('.gh-col.is-over');
    for (var i = 0; i < prev.length; i++) if (prev[i] !== col) prev[i].classList.remove('is-over');
    col.classList.add('is-over');
  }
  function onDragLeave(e) {
    var col = colFromEl(e.target);
    if (col && !col.contains(e.relatedTarget)) col.classList.remove('is-over');
  }
  function onDrop(e) {
    var col = colFromEl(e.target);
    if (!col || !S.dragId) return;
    e.preventDefault();
    col.classList.remove('is-over');
    var t = findTask(S.dragId);
    S.dragId = null;
    var c = colByKey(col.getAttribute('data-col'));
    if (t && c) moveTo(t, c);
  }
  function onDragEnd() {
    S.dragId = null;
    if (!S.root) return;
    var els = S.root.querySelectorAll('.is-dragging,.is-over');
    for (var i = 0; i < els.length; i++) els[i].classList.remove('is-dragging', 'is-over');
  }

  /* ── document-level: shortcuts, outside clicks, history ──────────────── */
  function typingIn(el) {
    if (!el) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }
  function onDocKey(e) {
    if (!S || !S.root) return;
    if (e.key === 'Escape') {
      if (menu) { e.preventDefault(); closeMenu(true); return; }
      if (S.modals.length) { e.preventDefault(); S.modals[S.modals.length - 1].requestClose(); return; }
      if (S.pp) {
        var pae = document.activeElement;
        if (pae && (pae.tagName === 'TEXTAREA' || pae.getAttribute('data-ref') === 'ppDesc') && pae.value) { pae.blur(); return; }
        e.preventDefault(); closePP(); return;
      }
      if (S.pane) {
        var ae = document.activeElement;
        if (ae && ae.getAttribute && (ae.getAttribute('data-ref') === 'descInput' || ae.getAttribute('data-ref') === 'draft' || ae.tagName === 'TEXTAREA') && ae.value) { ae.blur(); return; }
        e.preventDefault(); closePane(); return;
      }
      return;
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.code === 'Space' || e.key === ' ') && !S.modals.length && !S.pane && !S.pp) {
      if (S.ac && document.activeElement === S.ac.ta) return;
      e.preventDefault();
      closeMenu();
      if (S.f.view === 'table') {
        var ar = S.root.querySelector('[data-ref="addrow"]');
        if (ar) { ar.scrollIntoView({ block: 'nearest' }); ar.focus(); }
        else if (canCreate()) openNewIssue();
      } else if (S.f.view === 'board' && canCreate()) {
        var c0 = columns(sortList(applyState(baseFiltered())))[0];
        if (c0) { S.quickAdd = c0.key; S.quickAddDraft = ''; delete S.collapsed[c0.key]; renderBody(); }
      } else if (canCreate()) openNewIssue();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || typingIn(e.target) || menu || S.modals.length) return;
    if (e.key === '/') { e.preventDefault(); if (S.pane) closePane({ noFocus: true }); S.refs.q.focus(); S.refs.q.select(); }
    else if ((e.key === 'n' || e.key === 'c') && canCreate()) { e.preventDefault(); openNewIssue(); }
  }
  function onDocDown(e) {
    if (flyout && flyout.el.contains(e.target)) return;
    if (menu && !menu.el.contains(e.target) && !(menu.anchor && menu.anchor.contains(e.target))) closeMenu();
  }
  function onPop() {
    if (!S || !S.root) return;
    var p = location.pathname.replace(/\/+$/, '');
    if (p !== BASE && p.indexOf(BASE + '/') !== 0) return;
    var u = urlFilters();
    var next = sanitize(u.f);
    var projChanged = next.project !== S.f.project, pvChanged = next.pv !== S.f.pv;
    if (!projChanged && pvChanged) stashDraft();
    S.f = next;
    S.limit = PAGE;
    if (!projChanged && pvChanged && viewById(S.f.pv)) { var vv = viewById(S.f.pv); var keepF = copy(S.f); applyCfg(S.vdraft[vv.id] || viewCfg(vv)); ['view', 'state', 'q', 'sort', 'dir', 'group', 'tgroup'].forEach(function (k) { S.f[k] = keepF[k]; }); }
    savePrefs();
    if (S.refs.q) S.refs.q.value = S.f.q;
    if (projChanged) { S.burndown = null; if (!S.f.project) S.vc = cleanVc((loadPrefs() || {}).vc); loadTasks(); loadProjectMeta(); }
    renderChrome();
    renderBody();
    syncRoute();
  }
  function syncRoute() {
    if (!S || !S.root) return;
    var id = issueFromPath();
    if (id && (!S.pane || S.pane.id !== id)) openIssue(id, { fromRoute: true });
    else if (!id && S.pane) closePane({ fromRoute: true, noFocus: true });
    // Sidebar "Task Tracker" link drops the query: put the current view back.
    if (location.search !== qs() && !urlFilters().focus) writeUrl(false);
  }
  function listen(target, type, fn, opt) {
    target.addEventListener(type, fn, opt || false);
    S.cleanup.push(function () { target.removeEventListener(type, fn, opt || false); });
  }

  /* ── mount / unmount ─────────────────────────────────────────────────── */
  function mount(root) {
    if (S && S.root) unmount();
    injectStyle();
    S = fresh();
    S.root = root;
    var u = urlFilters();
    if (u.any) S.f = sanitize(u.f);
    else {
      var pr = loadPrefs();
      S.f = sanitize(pr && pr.f);
    }
    var prefs = loadPrefs();
    if (prefs && prefs.collapsed && typeof prefs.collapsed === 'object') S.collapsed = prefs.collapsed;
    S.vc = cleanVc(prefs && prefs.vc);
    if (u.any && S.f.project) {
      // filters in the link override the saved view once it has loaded
      var o = {};
      ['view', 'state', 'q', 'sort', 'dir', 'group', 'tgroup'].forEach(function (k) { if (Object.prototype.hasOwnProperty.call(u.f, k)) o[k] = S.f[k]; });
      S.pendingUrl = o;
    }
    if (u.focus) S.focusTitle = u.focus;
    renderShell();
    renderChrome();
    renderBody();
    listen(root, 'click', onRootClick);
    listen(root, 'change', onRootChange);
    listen(root, 'input', onRootInput);
    listen(root, 'keydown', onRootKey);
    listen(root, 'submit', onRootSubmit);
    listen(root, 'dragstart', onDragStart);
    listen(root, 'dragover', onDragOver);
    listen(root, 'dragleave', onDragLeave);
    listen(root, 'drop', onDrop);
    listen(root, 'dragend', onDragEnd);
    listen(root, 'pointerdown', function (e) { onResizeDown(e); if (!S.resize) onRmDown(e); });
    listen(document, 'pointermove', function (e) { if (!S) return; onResizeMove(e); onRmMove(e); });
    listen(document, 'pointerup', function () { if (!S) return; onResizeUp(); onRmUp(); });
    listen(document, 'pointercancel', function () { if (!S) return; onResizeUp(); if (S.rmDrag) { S.rmDrag = null; renderBody(); } });
    listen(document, 'keydown', onMdeKey, true);
    listen(document, 'click', onMdeClick);
    listen(document, 'input', onMdeInput);
    listen(document, 'focusout', onMdeBlur);
    listen(document, 'paste', onMdePaste);
    listen(document, 'dragover', onMdeDragOver);
    listen(document, 'dragleave', onMdeDragLeave);
    listen(document, 'drop', onMdeDrop);
    listen(document, 'change', onMdeChange);
    listen(document, 'keydown', onDocKey);
    listen(document, 'mousedown', onDocDown, true);
    listen(window, 'popstate', onPop);
    listen(window, 'resize', function () { closeMenu(); });
    savePrefs();
    var id = issueFromPath();
    if (id) openIssue(id, { fromRoute: true });
    else if (!u.focus) writeUrl(false);
    loadMeta();
    loadTasks();
    loadProjectMeta();
  }
  function update() {
    if (!S || !S.root) return;
    syncRoute();
  }
  function unmount() {
    if (!S) return;
    closeMenu();
    acClose();
    if (S.ctrl) { try { S.ctrl.abort(); } catch (_) {} }
    clearTimeout(S.qTimer);
    S.cleanup.forEach(function (fn) { try { fn(); } catch (_) {} });
    S.modals.slice().forEach(function (m) { try { m.close(); } catch (_) {} });
    S.pp = null;
    ['gh-pane', 'gh-ppanel', 'gh-toasts', 'gh-ac'].forEach(function (id) { var el = document.getElementById(id); if (el && el.parentNode) el.parentNode.removeChild(el); });
    S.seq++;
    S.root = null;
    S.pane = null;
  }

  function register() {
    SC = window.HRMSSidecar;
    SC.register({ base: BASE, title: 'Task Tracker', mount: mount, update: update, unmount: unmount });
  }
  if (window.HRMSSidecar) register();
  else {
    var tries = 0;
    var iv = setInterval(function () {
      if (window.HRMSSidecar) { clearInterval(iv); register(); }
      else if (++tries > 100) clearInterval(iv);
    }, 50);
  }
})();
