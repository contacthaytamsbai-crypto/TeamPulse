'use strict';

const root = document.getElementById('app');
const STATUS_LABELS = {
  pending: 'Pending', in_progress: 'In progress', review: 'Review', completed: 'Completed', blocked: 'Blocked'
};
let currentUser = null;
let appState = null;
let socket = null;
let activeTab = 'overview';
let filterStatus = 'all';
let filterAssignee = 'all';
let showTaskForm = false;
let showMemberForm = false;
let latestInvite = null;
let toastTimer = null;
let inviteBaseUrl = window.location.origin;
let networkBaseUrls = [];

// Invitation links carry the one-time code in the URL fragment. Fragments are
// not sent to the web server, and the registration form pre-fills both fields.
function readInviteFromUrl() {
  const fragment = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
  const params = new URLSearchParams(fragment);
  return {
    username: (params.get('username') || '').trim().toLowerCase(),
    invitationCode: (params.get('invite') || '').trim().toUpperCase()
  };
}

function makeInvitationUrl(invite) {
  const url = new URL((inviteBaseUrl || window.location.origin).replace(/\/$/, '') + window.location.pathname);
  url.search = window.location.search;
  url.hash = new URLSearchParams({ username: invite.username, invite: invite.code }).toString();
  return url.toString();
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    credentials: 'same-origin'
  });
  let payload = {};
  try { payload = await response.json(); } catch { payload = {}; }
  if (response.status === 401 && url !== '/api/login' && url !== '/api/setup') {
    currentUser = null;
    appState = null;
    if (socket) socket.disconnect();
    renderAuth(false);
    throw new Error(payload.error || 'Please sign in again.');
  }
  if (!response.ok) throw new Error(payload.error || 'Something went wrong.');
  return payload;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function initials(name = '') { return name.trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase() || '?'; }
function dateLabel(value) {
  if (!value) return 'No deadline';
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
function timeAgo(value) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
function showToast(message) {
  const old = document.querySelector('.toast');
  if (old) old.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.remove(), 3200);
}
function statusPill(status) { return `<span class="pill status-${status}">${escapeHtml(STATUS_LABELS[status] || status)}</span>`; }

function renderAuth(needsSetup, mode = 'login') {
  const isRegister = !needsSetup && mode === 'register';
  const heading = needsSetup ? 'Create your workspace' : isRegister ? 'Create your account' : 'Welcome back';
  const description = needsSetup
    ? 'Set up the workspace and create the first admin account. You can invite teammates after signing in.'
    : isRegister
      ? 'Enter the username and invitation code your admin gave you, then choose your own password.'
      : 'Sign in with your own username and password. New teammates can create their account using an invitation from the admin.';
  const inviteFromUrl = readInviteFromUrl();
  const authFields = needsSetup
    ? `<div class="field"><label for="auth-name">YOUR NAME</label><input id="auth-name" name="name" required minlength="2" maxlength="40" placeholder="e.g. Alex Morgan" autocomplete="name"></div>`
    : '';
  const credentialsFields = isRegister
    ? `<div class="field"><label for="auth-invite">INVITATION CODE</label><input id="auth-invite" name="invitationCode" required minlength="10" maxlength="10" pattern="[A-Fa-f0-9]{10}" autocapitalize="characters" spellcheck="false" value="${escapeHtml(inviteFromUrl.invitationCode)}" placeholder="Auto-filled from your invite link"></div>
       <div class="field"><label for="auth-password">CHOOSE PASSWORD (6–72 CHARACTERS)</label><input id="auth-password" name="password" required minlength="6" maxlength="72" type="password" autocomplete="new-password" placeholder="Create your password"></div>
       <div class="field"><label for="auth-confirm-password">CONFIRM PASSWORD</label><input id="auth-confirm-password" name="confirmPassword" required minlength="6" maxlength="72" type="password" autocomplete="new-password" placeholder="Enter it again"></div>`
    : `<div class="field"><label for="auth-password">${needsSetup ? 'ADMIN PASSWORD (6–72 CHARACTERS)' : 'PASSWORD'}</label><input id="auth-password" name="password" required minlength="6" maxlength="72" type="password" autocomplete="${needsSetup ? 'new-password' : 'current-password'}" placeholder="Enter your password"></div>`;

  root.innerHTML = `
    <div class="auth-wrap"><section class="auth-card">
      <div class="auth-brand"><div class="brand-mark">TP</div><div><h1>TeamPulse</h1><div class="eyebrow">Team workspace</div></div></div>
      <h2>${heading}</h2>
      <p>${description}</p>
      <form id="auth-form">
        ${authFields}
        <div class="field"><label for="auth-username">USERNAME</label><input id="auth-username" name="username" required minlength="3" maxlength="24" pattern="[a-zA-Z0-9._-]+" autocomplete="username" value="${isRegister ? escapeHtml(inviteFromUrl.username) : ''}" placeholder="your.username"></div>
        ${credentialsFields}
        <button class="btn btn-primary full" type="submit">${needsSetup ? 'Create workspace' : isRegister ? 'Create account' : 'Sign in'} <span aria-hidden="true">→</span></button>
        <div id="auth-error" class="error" role="alert"></div>
      </form>
      ${!needsSetup ? `<div class="auth-links">${isRegister ? `Already have an account? <button type="button" class="auth-link" data-auth-mode="login">Sign in</button>` : `New teammate? <button type="button" class="auth-link" data-auth-mode="register">Create account</button>`}</div>` : ''}
      <div class="footer-note">${needsSetup ? 'The first account becomes the workspace admin.' : 'Only teammates invited by the admin can register.'}</div>
    </section></div>`;

  document.getElementById('auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    if (isRegister && body.password !== body.confirmPassword) {
      document.getElementById('auth-error').textContent = 'The passwords do not match.';
      return;
    }
    delete body.confirmPassword;
    if (isRegister) body.invitationCode = String(body.invitationCode || '').trim().toUpperCase();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    const error = document.getElementById('auth-error');
    button.disabled = true; button.textContent = 'Please wait…'; error.textContent = '';
    const endpoint = needsSetup ? '/api/setup' : isRegister ? '/api/claim-invite' : '/api/login';
    try {
      const result = await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
      currentUser = result.user;
      // Remove the one-time invite code from the address bar after successful use.
      if (isRegister && window.location.hash) history.replaceState(null, '', window.location.pathname + window.location.search);
      await loadWorkspace();
    } catch (err) {
      error.textContent = err.message;
      button.disabled = false;
      button.textContent = needsSetup ? 'Create workspace →' : isRegister ? 'Create account →' : 'Sign in →';
    }
  });
}

async function loadWorkspace() {
  const state = await api('/api/state');
  appState = state;
  currentUser = state.user;
  activeTab = 'overview';
  connectSocket();
  renderApp();
}

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ transports: ['websocket', 'polling'] });
  socket.on('presence:update', ids => {
    if (appState) { appState.onlineIds = ids; renderApp(); }
  });
  socket.on('data:changed', async () => {
    try { appState = await api('/api/state'); renderApp(); } catch (error) { /* auth handler already handles this */ }
  });
  socket.on('connect_error', error => {
    if (error.message === 'Unauthorized') showToast('Session expired. Please sign in again.');
  });
}

function getStats() {
  const tasks = appState.tasks || [];
  return {
    total: tasks.length,
    completed: tasks.filter(task => task.status === 'completed').length,
    active: tasks.filter(task => task.status === 'in_progress' || task.status === 'review').length,
    blocked: tasks.filter(task => task.status === 'blocked').length,
    pending: tasks.filter(task => task.status === 'pending').length
  };
}

function renderHeader() {
  return `<header class="topbar">
    <div class="brand"><div class="brand-mark">TP</div><div><div class="brand-name">TeamPulse</div><span class="brand-sub">Team workspace</span></div></div>
    <div class="top-user"><div class="user-chip"><div class="avatar">${escapeHtml(initials(currentUser.name))}</div><span class="user-fullname">${escapeHtml(currentUser.name)} <span class="muted">@${escapeHtml(currentUser.username)}</span></span>${currentUser.role === 'admin' ? '<span class="role-tag">Admin</span>' : ''}</div><button class="btn btn-ghost" data-action="switch-account" title="Sign out and let another teammate sign in">Switch account</button></div>
  </header>`;
}
function renderTabs() {
  const tabs = [['overview', 'Overview'], ['tasks', 'Tasks'], ['team', 'Team']];
  return `<nav class="tabs">${tabs.map(([id, label]) => `<button class="tab ${activeTab === id ? 'active' : ''}" data-tab="${id}">${label}${id === 'tasks' ? `<span class="muted"> · ${appState.tasks.length}</span>` : ''}</button>`).join('')}</nav>`;
}
function renderStats() {
  const s = getStats();
  const cards = [
    ['Total tasks', s.total, 'Across this workspace', ''],
    ['Completed', s.completed, s.total ? `${Math.round(s.completed / s.total * 100)}% of all tasks` : 'Nothing completed yet', 'blue'],
    ['In progress / review', s.active, 'Being worked on', 'orange'],
    ['Blocked', s.blocked, 'Need attention', 'red']
  ];
  return `<div class="stats-grid">${cards.map(([label, value, hint, color]) => `<article class="stat-card"><div class="stat-top"><span>${label}</span><span class="stat-dot ${color}"></span></div><div class="stat-number">${value}</div><div class="stat-hint">${hint}</div></article>`).join('')}</div>`;
}
function renderProgressPanel() {
  const s = getStats();
  const percent = s.total ? Math.round(s.completed / s.total * 100) : 0;
  return `<section class="panel"><div class="panel-heading"><div><div class="eyebrow">Project health</div><h3 style="margin-top:5px">Overall progress</h3></div><strong style="font:600 25px 'Space Grotesk';color:var(--accent)">${percent}%</strong></div>
    <div class="progress-line"><div class="progress-fill" style="width:${percent}%"></div></div>
    <div class="progress-meta"><span>${s.completed} of ${s.total} tasks completed</span><span>${s.total - s.completed} remaining</span></div>
    <div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:20px" class="small muted"><span>● ${s.pending} pending</span><span style="color:var(--blue)">● ${s.active} active / review</span><span style="color:var(--red)">● ${s.blocked} blocked</span></div>
  </section>`;
}
function renderActivity() {
  const activity = appState.activity || [];
  if (!activity.length) return '<div class="empty-state">Your team activity will appear here.</div>';
  return `<div class="activity-list">${activity.slice(0, 8).map(item => `<div class="activity-item"><div class="activity-icon">${item.action.includes('status') ? '↻' : item.action.includes('created') ? '+' : '•'}</div><div class="activity-copy"><strong>${escapeHtml(item.userName)}</strong> ${escapeHtml(item.action)}${item.taskTitle ? ` <strong>“${escapeHtml(item.taskTitle)}”</strong>` : ''}<time>${timeAgo(item.createdAt)}</time></div></div>`).join('')}</div>`;
}
function renderOnlineMembers(limit = 7) {
  const ids = new Set(appState.onlineIds || []);
  const members = [...appState.members].sort((a, b) => Number(ids.has(b.id)) - Number(ids.has(a.id)) || a.name.localeCompare(b.name));
  const onlineCount = members.filter(member => ids.has(member.id)).length;
  return `<section class="panel"><div class="panel-heading"><h3>Team presence</h3><div class="online-summary"><span class="presence-dot" style="background:var(--green)"></span>${onlineCount} online</div></div>
    <div class="member-list">${members.slice(0, limit).map(member => `<div class="member-row"><div class="member-main"><div class="avatar">${escapeHtml(initials(member.name))}</div><div><div class="member-name">${escapeHtml(member.name)} ${member.id === currentUser.id ? '<span class="muted" style="font-weight:400">(you)</span>' : ''}</div><div class="member-role">${member.role === 'admin' ? 'Administrator' : 'Team member'}</div></div></div><div class="presence ${ids.has(member.id) ? 'online' : ''}"><span class="presence-dot"></span>${ids.has(member.id) ? 'Online' : 'Offline'}</div></div>`).join('') || '<div class="empty-state">No team members yet.</div>'}</div>
    ${members.length > limit ? `<button class="btn btn-ghost" data-tab="team" style="margin-top:12px">View all members →</button>` : ''}
  </section>`;
}
function renderRecentTasks() {
  const tasks = [...appState.tasks].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 4);
  return `<section class="panel"><div class="panel-heading"><h3>Recently updated</h3><button class="btn btn-ghost" data-tab="tasks">All tasks →</button></div>${tasks.length ? `<div class="task-list">${tasks.map(task => renderTask(task, true)).join('')}</div>` : '<div class="empty-state"><div class="empty-icon">✦</div>No tasks yet. Add your first task to get started.</div>'}</section>`;
}
function renderTask(task, compact = false) {
  const memberOptions = appState.members.map(member => `<option value="${member.id}" ${member.id === task.assigneeId ? 'selected' : ''}>${escapeHtml(member.name)}</option>`).join('');
  return `<article class="task-card" data-task-id="${task.id}"><div><div class="task-title">${escapeHtml(task.title)}</div>${task.description && !compact ? `<div class="task-description">${escapeHtml(task.description)}</div>` : ''}<div class="task-meta">${statusPill(task.status)}<span class="priority-${task.priority}">${escapeHtml(task.priority.toUpperCase())} priority</span><span>◉ ${escapeHtml(task.assigneeName)}</span><span>Due: ${dateLabel(task.deadline)}</span></div></div>
    <div class="task-controls"><select aria-label="Change task status" data-task-status="${task.id}">${Object.entries(STATUS_LABELS).map(([value, label]) => `<option value="${value}" ${task.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select>${!compact ? `<select aria-label="Assign task" data-task-assignee="${task.id}">${memberOptions}</select>${currentUser.role === 'admin' ? `<button class="btn btn-ghost" data-action="delete-task" data-id="${task.id}" title="Delete task">✕</button>` : ''}` : ''}</div></article>`;
}
function renderOverview() {
  return `${renderStats()}<div class="dashboard-grid"><div style="display:grid;gap:15px">${renderProgressPanel()}${renderRecentTasks()}</div><div style="display:grid;gap:15px">${renderOnlineMembers()}<section class="panel"><div class="panel-heading"><h3>Recent activity</h3><span class="small muted">Live feed</span></div>${renderActivity()}</section></div></div>`;
}
function renderTaskForm() {
  return `<section class="panel form-panel"><div class="panel-heading"><div><div class="eyebrow">New item</div><h3 style="margin-top:5px">Create a task</h3></div><button class="btn btn-ghost" data-action="hide-task-form">✕</button></div>
    <form id="task-form"><div class="form-grid">
      <div class="field span-2"><label>TASK TITLE</label><input name="title" required minlength="3" maxlength="100" placeholder="What needs to get done?"></div>
      <div class="field span-2"><label>DESCRIPTION</label><textarea name="description" maxlength="600" placeholder="Add context, links or acceptance criteria…"></textarea></div>
      <div class="field"><label>ASSIGN TO</label><select name="assigneeId" required>${appState.members.map(member => `<option value="${member.id}" ${member.id === currentUser.id ? 'selected' : ''}>${escapeHtml(member.name)}</option>`).join('')}</select></div>
      <div class="field"><label>PRIORITY</label><select name="priority"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option></select></div>
      <div class="field"><label>DEADLINE</label><input name="deadline" type="date" min="2020-01-01"></div>
    </div><div class="form-actions"><button type="button" class="btn btn-secondary" data-action="hide-task-form">Cancel</button><button type="submit" class="btn btn-primary">Create task</button></div><div id="task-error" class="error"></div></form>
  </section>`;
}
function renderTasks() {
  const members = appState.members;
  let tasks = [...appState.tasks];
  if (filterStatus !== 'all') tasks = tasks.filter(task => task.status === filterStatus);
  if (filterAssignee !== 'all') tasks = tasks.filter(task => task.assigneeId === filterAssignee);
  tasks.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return `${showTaskForm ? renderTaskForm() : ''}<div class="toolbar"><div class="toolbar-left"><select id="status-filter" aria-label="Filter by status"><option value="all" ${filterStatus === 'all' ? 'selected' : ''}>All statuses</option>${Object.entries(STATUS_LABELS).map(([value, label]) => `<option value="${value}" ${filterStatus === value ? 'selected' : ''}>${label}</option>`).join('')}</select><select id="assignee-filter" aria-label="Filter by assignee"><option value="all">All members</option>${members.map(member => `<option value="${member.id}" ${filterAssignee === member.id ? 'selected' : ''}>${escapeHtml(member.name)}</option>`).join('')}</select></div><div class="toolbar-right"><span class="small muted">${tasks.length} task${tasks.length === 1 ? '' : 's'}</span>${!showTaskForm ? '<button class="btn btn-primary" data-action="show-task-form">＋ New task</button>' : ''}</div></div>
    <div class="task-list">${tasks.map(task => renderTask(task)).join('') || '<div class="empty-state"><div class="empty-icon">◌</div>No tasks match this filter.</div>'}</div>`;
}
function renderMemberForm() {
  return `<section class="panel form-panel"><div class="panel-heading"><div><div class="eyebrow">Team access</div><h3 style="margin-top:5px">Invite a teammate</h3></div><button class="btn btn-ghost" data-action="hide-member-form">✕</button></div><form id="member-form"><div class="form-grid">
    <div class="field"><label>FULL NAME</label><input name="name" required minlength="2" maxlength="40" placeholder="Sam Taylor"></div>
    <div class="field"><label>USERNAME</label><input name="username" required minlength="3" maxlength="24" pattern="[a-zA-Z0-9._-]+" placeholder="sam.taylor"></div>
    <div class="field"><label>ROLE</label><select name="role"><option value="member">Team member</option><option value="admin">Administrator</option></select></div>
  </div><p class="small muted" style="line-height:1.6;margin:4px 0 12px">TeamPulse will create a one-time invitation code and a ready-to-send link. Your teammate opens the link, checks the pre-filled username and code, and chooses a password.</p><div class="form-actions"><button type="button" class="btn btn-secondary" data-action="hide-member-form">Cancel</button><button type="submit" class="btn btn-primary">Create invitation</button></div><div id="member-error" class="error"></div></form></section>`;
}

function renderTeam() {
  const ids = new Set(appState.onlineIds || []);
  const ordered = [...appState.members].sort((a, b) => Number(ids.has(b.id)) - Number(ids.has(a.id)) || a.name.localeCompare(b.name));
  const inviteUrl = latestInvite ? makeInvitationUrl(latestInvite) : '';
  const linkChoices = [...new Set([window.location.origin, ...networkBaseUrls])];
  const inviteNotice = latestInvite ? `<section class="panel invite-notice"><div class="panel-heading"><div><div class="eyebrow">One-time invitation</div><h3 style="margin-top:5px">Invite created for ${escapeHtml(latestInvite.name)}</h3></div><button class="btn btn-ghost" data-action="dismiss-invite" aria-label="Dismiss invitation">✕</button></div><p class="small muted">Send the invitation link below. It opens Create account and fills in the username and code automatically.</p><div class="invite-base-picker"><label for="invite-base-url" class="small muted">LINK ADDRESS (choose the address your teammates can open)</label><select id="invite-base-url">${linkChoices.map(value => `<option value="${escapeHtml(value)}" ${value === inviteBaseUrl ? 'selected' : ''}>${escapeHtml(value)}${value === window.location.origin ? ' — current address' : ' — local network'}</option>`).join('')}</select></div><div class="invite-details"><div><span class="small muted">USERNAME</span><strong>${escapeHtml(latestInvite.username)}</strong></div><div><span class="small muted">INVITATION CODE</span><code>${escapeHtml(latestInvite.code)}</code></div><div class="invite-link-block"><span class="small muted">INVITATION LINK</span><a class="invite-url" href="${escapeHtml(inviteUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(inviteUrl)}</a></div><div class="invite-buttons"><button class="btn btn-primary" data-action="copy-invite-link">Copy invitation link</button><button class="btn btn-secondary" data-action="copy-invite">Copy username + code</button></div></div><p class="small muted" style="margin-top:10px">Choose a local network address above when teammates are on the same Wi-Fi. Never send a <code>localhost</code> link. For teammates outside your network, deploy TeamPulse on a public HTTPS address.</p></section>` : '';
  return `${inviteNotice}${showMemberForm ? renderMemberForm() : ''}<div class="toolbar"><div class="toolbar-left"><div class="online-summary"><span class="presence-dot" style="background:var(--green)"></span>${ids.size} online · ${appState.members.length} members</div></div>${currentUser.role === 'admin' && !showMemberForm ? '<button class="btn btn-primary" data-action="show-member-form">＋ Invite teammate</button>' : ''}</div>
    <section class="panel"><div class="panel-heading"><h3>Workspace members</h3><span class="small muted">Live presence</span></div><div class="member-list">${ordered.map(member => {
      const invited = member.accountStatus === 'invited';
      const status = invited ? '<div class="presence invite-pending">Awaiting signup</div>' : `<div class="presence ${ids.has(member.id) ? 'online' : ''}"><span class="presence-dot"></span>${ids.has(member.id) ? 'Online now' : 'Offline'}</div>`;
      const action = currentUser.role === 'admin' && member.id !== currentUser.id
        ? invited
          ? `<button class="btn btn-ghost reset-password-btn" data-action="renew-invite" data-id="${member.id}" data-name="${escapeHtml(member.name)}" data-username="${escapeHtml(member.username)}">Generate invite link</button>`
          : `<div class="member-actions"><button class="btn btn-ghost reset-password-btn" data-action="renew-invite" data-id="${member.id}" data-name="${escapeHtml(member.name)}" data-username="${escapeHtml(member.username)}">Generate invite link</button><button class="btn btn-ghost reset-password-btn" data-action="reset-member-password" data-id="${member.id}" data-name="${escapeHtml(member.name)}">Reset password</button></div>`
        : '';
      return `<div class="member-row"><div class="member-main"><div class="avatar">${escapeHtml(initials(member.name))}</div><div><div class="member-name">${escapeHtml(member.name)} ${member.id === currentUser.id ? '<span class="muted" style="font-weight:400">(you)</span>' : ''}</div><div class="member-role">@${escapeHtml(member.username)} · ${member.role === 'admin' ? 'Administrator' : 'Team member'}</div></div></div><div class="member-side">${status}${action}</div></div>`;
    }).join('')}</div></section>
    <p class="small muted" style="line-height:1.7;margin:14px 2px">Online status is based on an active TeamPulse connection. Invited teammates appear as Awaiting signup until they create their account.</p>`;
}

function renderApp() {
  if (!currentUser || !appState) return;
  const titles = { overview: ['Your team at a glance', 'See project progress, recent work and who is online.'], tasks: ['Tasks', 'Assign work, update statuses and keep blockers visible.'], team: ['Your team', 'See who is online and manage workspace access.'] };
  root.innerHTML = `<div class="shell">${renderHeader()}<div class="page-heading"><div><div class="eyebrow">Workspace / ${activeTab}</div><h1>${titles[activeTab][0]}</h1><p>${titles[activeTab][1]}</p></div><div class="heading-actions">${activeTab !== 'tasks' ? '<button class="btn btn-primary" data-action="quick-task">＋ New task</button>' : ''}</div></div>${renderTabs()}${activeTab === 'overview' ? renderOverview() : activeTab === 'tasks' ? renderTasks() : renderTeam()}<div class="footer-note">TEAMPULSE · LIVE TEAM WORKSPACE</div></div>`;
}

root.addEventListener('click', async event => {
  const authModeButton = event.target.closest('[data-auth-mode]');
  if (authModeButton) { renderAuth(false, authModeButton.dataset.authMode); return; }
  const tabButton = event.target.closest('[data-tab]');
  if (tabButton) { activeTab = tabButton.dataset.tab; showTaskForm = false; showMemberForm = false; renderApp(); return; }
  const actionButton = event.target.closest('[data-action]');
  if (!actionButton) return;
  const action = actionButton.dataset.action;
  if (action === 'show-task-form' || action === 'quick-task') { activeTab = 'tasks'; showTaskForm = true; renderApp(); document.querySelector('#task-form [name="title"]')?.focus(); }
  if (action === 'hide-task-form') { showTaskForm = false; renderApp(); }
  if (action === 'show-member-form') { showMemberForm = true; renderApp(); }
  if (action === 'hide-member-form') { showMemberForm = false; renderApp(); }
  if (action === 'switch-account' || action === 'logout') {
    try { await api('/api/logout', { method: 'POST' }); } catch (error) { /* proceed to local sign-out */ }
    if (socket) socket.disconnect(); currentUser = null; appState = null; renderAuth(false);
  }
  if (action === 'reset-member-password') {
    const memberId = actionButton.dataset.id;
    const memberName = actionButton.dataset.name || 'this teammate';
    const password = prompt(`Set a new temporary password for ${memberName} (6–72 characters):`);
    if (password === null) return;
    if (password.length < 6 || password.length > 72) { showToast('Password must contain 6–72 characters.'); return; }
    try {
      await api(`/api/members/${memberId}/password`, { method: 'PATCH', body: JSON.stringify({ password }) });
      appState = await api('/api/state'); renderApp(); showToast(`Password reset for ${memberName}. Share it privately.`);
    } catch (error) { showToast(error.message); }
  }
  if (action === 'dismiss-invite') { latestInvite = null; renderApp(); }
  if (action === 'copy-invite' && latestInvite) {
    const inviteText = `TeamPulse invitation\nName: ${latestInvite.name}\nUsername: ${latestInvite.username}\nInvitation code: ${latestInvite.code}\nInvitation link: ${makeInvitationUrl(latestInvite)}`;
    try {
      await navigator.clipboard.writeText(inviteText);
      showToast('Invitation details copied.');
    } catch (error) {
      window.prompt('Copy the invitation details below:', inviteText);
    }
  }
  if (action === 'copy-invite-link' && latestInvite) {
    const inviteUrl = makeInvitationUrl(latestInvite);
    try {
      await navigator.clipboard.writeText(inviteUrl);
      showToast('Invitation link copied. Send it to your teammate.');
    } catch (error) {
      window.prompt('Copy this invitation link and send it to your teammate:', inviteUrl);
    }
  }
  if (action === 'renew-invite') {
    const memberId = actionButton.dataset.id;
    const memberName = actionButton.dataset.name || 'this teammate';
    const username = actionButton.dataset.username || '';
    try {
      const result = await api(`/api/members/${memberId}/invitation-code`, { method: 'POST' });
      latestInvite = { name: memberName, username, code: result.invitationCode };
      appState = await api('/api/state'); renderApp();
      showToast(`A new invitation link is ready for ${memberName}. Copy it above and send it to them.`);
    } catch (error) { showToast(error.message); }
  }
  if (action === 'delete-task') {
    const id = actionButton.dataset.id;
    const task = appState.tasks.find(item => item.id === id);
    if (task && confirm(`Delete “${task.title}”? This cannot be undone.`)) {
      try { await api(`/api/tasks/${id}`, { method: 'DELETE' }); appState = await api('/api/state'); renderApp(); showToast('Task deleted.'); }
      catch (error) { showToast(error.message); }
    }
  }
});

root.addEventListener('change', async event => {
  if (event.target.id === 'invite-base-url') { inviteBaseUrl = event.target.value; renderApp(); return; }
  if (event.target.id === 'status-filter') { filterStatus = event.target.value; renderApp(); return; }
  if (event.target.id === 'assignee-filter') { filterAssignee = event.target.value; renderApp(); return; }
  const statusSelect = event.target.closest('[data-task-status]');
  const assigneeSelect = event.target.closest('[data-task-assignee]');
  if (statusSelect) {
    try { await api(`/api/tasks/${statusSelect.dataset.taskStatus}`, { method: 'PATCH', body: JSON.stringify({ status: statusSelect.value }) }); appState = await api('/api/state'); renderApp(); showToast('Task status updated.'); }
    catch (error) { showToast(error.message); }
  }
  if (assigneeSelect) {
    try { await api(`/api/tasks/${assigneeSelect.dataset.taskAssignee}`, { method: 'PATCH', body: JSON.stringify({ assigneeId: assigneeSelect.value }) }); appState = await api('/api/state'); renderApp(); showToast('Task reassigned.'); }
    catch (error) { showToast(error.message); }
  }
});

root.addEventListener('submit', async event => {
  if (event.target.id === 'task-form') {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.target).entries());
    const errorBox = document.getElementById('task-error');
    const button = event.target.querySelector('button[type="submit"]');
    button.disabled = true; button.textContent = 'Creating…'; errorBox.textContent = '';
    try {
      await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
      appState = await api('/api/state'); showTaskForm = false; renderApp(); showToast('Task created.');
    } catch (error) { errorBox.textContent = error.message; button.disabled = false; button.textContent = 'Create task'; }
  }
  if (event.target.id === 'member-form') {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.target).entries());
    const errorBox = document.getElementById('member-error');
    const button = event.target.querySelector('button[type="submit"]');
    button.disabled = true; button.textContent = 'Adding…'; errorBox.textContent = '';
    try {
      const result = await api('/api/members', { method: 'POST', body: JSON.stringify(body) });
      latestInvite = { name: body.name, username: body.username, code: result.invitationCode };
      appState = await api('/api/state'); showMemberForm = false; renderApp(); showToast('Invitation link created. Copy it and send it to your teammate.');
    } catch (error) { errorBox.textContent = error.message; button.disabled = false; button.textContent = 'Create invitation'; }
  }
});

async function boot() {
  try {
    const networkInfo = await api('/api/network-info');
    networkBaseUrls = Array.isArray(networkInfo.localUrls) ? networkInfo.localUrls : [];
    const result = await api('/api/bootstrap');
    const inviteFromUrl = readInviteFromUrl();
    // An invitation link must take precedence over a session already stored in
    // this browser (for example, when a teammate opens it on the admin's PC).
    if (!result.needsSetup && inviteFromUrl.username && inviteFromUrl.invitationCode) {
      renderAuth(false, 'register');
    } else if (result.user) {
      currentUser = result.user;
      await loadWorkspace();
    } else {
      renderAuth(result.needsSetup);
    }
  } catch (error) {
    root.innerHTML = `<div class="auth-wrap"><section class="auth-card"><h2>Could not load TeamPulse</h2><p>${escapeHtml(error.message)}</p><button class="btn btn-primary" onclick="location.reload()">Reload app</button></section></div>`;
  }
}
boot();
