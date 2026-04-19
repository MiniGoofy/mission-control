// ── State ──────────────────────────────────────────────────────
let currentPage = 'dashboard';
let missions = [];
let logs = [];
let sseConnected = false;

// ── Navigation ─────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    const page = btn.dataset.page;
    if (page === currentPage) return;
    currentPage = page;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const titles = { dashboard: 'Dashboard', missions: 'Missions', logs: 'Activity Logs', settings: 'Settings' };
    document.getElementById('page-title').textContent = titles[page] || page;
    render();
  });
});

// ── API helpers ────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json();
}

// ── Render ─────────────────────────────────────────────────────
async function render() {
  const content = document.getElementById('content');
  const actions = document.getElementById('topbar-actions');
  actions.innerHTML = '';

  switch (currentPage) {
    case 'dashboard':
      await renderDashboard(content);
      break;
    case 'missions':
      await renderMissions(content, actions);
      break;
    case 'logs':
      await renderLogsPage(content);
      break;
    case 'settings':
      await renderSettings(content);
      break;
  }
}

// ── Dashboard ──────────────────────────────────────────────────
async function renderDashboard(el) {
  const [health, missionData, heartbeat, wsEntries, cronRuns] = await Promise.all([
    api('/api/health'),
    api('/api/missions'),
    api('/api/state/heartbeat'),
    api('/api/state/workspace'),
    api('/api/cron/next-runs'),
  ]);

  missions = missionData;
  const activeMissions = missions.filter(m => m.enabled).length;
  const completedMissions = missions.filter(m => m.lastStatus === 'completed').length;
  const failedMissions = missions.filter(m => m.lastStatus === 'failed').length;

  el.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="label">Total Missions</div>
        <div class="value blue">${missions.length}</div>
      </div>
      <div class="stat-card">
        <div class="label">Active</div>
        <div class="value green">${activeMissions}</div>
      </div>
      <div class="stat-card">
        <div class="label">Completed</div>
        <div class="value purple">${completedMissions}</div>
      </div>
      <div class="stat-card">
        <div class="label">Failed</div>
        <div class="value yellow">${failedMissions}</div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <h3>OpenClaw Status</h3>
      </div>
      <div class="table-wrap">
        <table>
          <tr>
            <td style="color:var(--text-muted);width:140px">Status</td>
            <td><span class="badge badge-green">${health.status || 'unknown'}</span></td>
          </tr>
          <tr>
            <td style="color:var(--text-muted)">Uptime</td>
            <td>${formatUptime(health.uptime || 0)}</td>
          </tr>
          <tr>
            <td style="color:var(--text-muted)">Workspace</td>
            <td>${wsEntries.length} items</td>
          </tr>
          <tr>
            <td style="color:var(--text-muted)">Heartbeat</td>
            <td>${heartbeat ? formatHeartbeat(heartbeat) : 'Not configured'}</td>
          </tr>
        </table>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <h3>Recent Missions</h3>
      </div>
      ${missions.length === 0 ? `
        <div class="empty-state">
          <div class="icon">🚀</div>
          <h3>No missions yet</h3>
          <p>Create your first mission to get started.</p>
        </div>
      ` : `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Trigger</th><th>Last Run</th><th>Status</th></tr></thead>
            <tbody>
              ${missions.slice(0, 5).map(m => `
                <tr>
                  <td><strong>${esc(m.name)}</strong></td>
                  <td><span class="badge badge-blue">${m.trigger}</span></td>
                  <td>${m.lastRun ? timeAgo(m.lastRun) : '—'}</td>
                  <td>${statusBadge(m.lastStatus)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>

    ${cronRuns.length > 0 ? `
    <div class="section">
      <div class="section-header">
        <h3>Active Cron Jobs</h3>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Mission</th><th>Schedule</th><th>Next Run</th></tr></thead>
          <tbody>
            ${cronRuns.map(c => `
              <tr>
                <td><strong>${esc(c.name)}</strong></td>
                <td style="font-family:var(--mono);font-size:12px">${esc(c.cronExpr)}</td>
                <td>${formatNextRun(c.nextRun)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
    ` : ''}
  `;
}

function formatUptime(s) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatHeartbeat(hb) {
  if (!hb.lastChecks) return 'No checks';
  const checks = Object.keys(hb.lastChecks);
  return `${checks.length} checks configured`;
}

// ── Missions ───────────────────────────────────────────────────
async function renderMissions(el, actions) {
  actions.innerHTML = `
    <button class="btn" onclick="showTemplates()">📋 From Template</button>
    <button class="btn btn-primary" onclick="openModal()">+ New Mission</button>
  `;

  // Fetch cron next-runs
  const cronRuns = await api('/api/cron/next-runs');
  const cronMap = {};
  for (const c of cronRuns) {
    cronMap[c.id] = c;
  }

  if (missions.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="icon">🚀</div>
        <h3>No missions yet</h3>
        <p>Create your first mission to automate tasks and workflows.</p>
        <button class="btn btn-primary" onclick="openModal()">+ Create Mission</button>
      </div>
    `;
    return;
  }

  el.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Trigger</th>
            <th>Cron</th>
            <th>Depends On</th>
            <th>Next Run</th>
            <th>Steps</th>
            <th>Last Run</th>
            <th>Status</th>
            <th>Enabled</th>
            <th style="width:120px">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${missions.map(m => `
            <tr>
              <td><strong>${esc(m.name)}</strong><br><small style="color:var(--text-muted)">${esc(m.description || '').substring(0, 60)}</small></td>
              <td><span class="badge badge-blue">${m.trigger}</span></td>
              <td style="font-family:var(--mono);font-size:12px">${m.cronExpr || '—'}</td>
              <td>${m.dependsOn && m.dependsOn.length > 0 ? m.dependsOn.map(id => {
                const dep = missions.find(x => x.id === id);
                return dep ? esc(dep.name) : id.substring(0, 8);
              }).join(', ') : '<span style="color:var(--text-muted)">—</span>'}</td>
              <td id="next-run-${m.id}">${m.trigger === 'cron' && cronMap[m.id] ? formatNextRun(cronMap[m.id].nextRun) : '—'}</td>
              <td>${(m.steps || []).length}</td>
              <td>${m.lastRun ? timeAgo(m.lastRun) : '—'}</td>
              <td>${statusBadge(m.lastStatus)}</td>
              <td>
                <button class="btn-icon" onclick="toggleMission('${m.id}')" title="${m.enabled ? 'Disable' : 'Enable'}">
                  ${m.enabled ? '✅' : '⏸️'}
                </button>
              </td>
              <td>
                <button class="btn-icon" onclick="runMission('${m.id}')" title="Run">▶️</button>
                <button class="btn-icon" onclick="viewExecHistory('${m.id}', '${esc(m.name)}')" title="History">📜</button>
                <button class="btn-icon" onclick="editMission('${m.id}')" title="Edit">✏️</button>
                <button class="btn-icon" onclick="deleteMission('${m.id}')" title="Delete">🗑️</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function statusBadge(status) {
  if (!status) return '<span class="badge badge-purple">—</span>';
  const map = {
    completed: 'badge-green',
    failed: 'badge-red',
    running: 'badge-yellow',
  };
  return `<span class="badge ${map[status] || 'badge-blue'}">${status}</span>`;
}

// ── Logs page ──────────────────────────────────────────────────
async function renderLogsPage(el) {
  const allLogs = await api('/api/logs');
  if (allLogs.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="icon">📋</div><h3>No logs yet</h3><p>Activity will appear here.</p></div>`;
    return;
  }
  el.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Time</th><th>Type</th><th>Message</th></tr></thead>
        <tbody>
          ${allLogs.map(l => `
            <tr>
              <td style="white-space:nowrap;color:var(--text-muted);font-size:12px">${new Date(l.timestamp).toLocaleString()}</td>
              <td><span class="badge badge-blue">${l.type}</span></td>
              <td>${esc(l.message)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

async function clearLogs() {
  await api('/api/logs', { method: 'DELETE' });
  logs = [];
  render();
}

// ── Settings ───────────────────────────────────────────────────
async function renderSettings(el) {
  const [config, ws, heartbeat] = await Promise.all([
    api('/api/state/config'),
    api('/api/state/workspace'),
    api('/api/state/heartbeat'),
  ]);

  el.innerHTML = `
    <div class="section">
      <div class="section-header"><h3>Configuration</h3></div>
      <div class="table-wrap">
        <pre style="padding:16px;font-family:var(--mono);font-size:12px;overflow-x:auto;white-space:pre-wrap;color:var(--text)">${esc(config.content || 'No config found')}</pre>
      </div>
    </div>

    <div class="section">
      <div class="section-header"><h3>Workspace Files</h3></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Type</th></tr></thead>
          <tbody>
            ${ws.map(w => `
              <tr>
                <td>${w.isDirectory() ? '📁' : '📄'} ${esc(w.name)}</td>
                <td><span class="badge ${w.isDirectory() ? 'badge-purple' : 'badge-blue'}">${w.isDirectory() ? 'Folder' : 'File'}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="section">
      <div class="section-header"><h3>Heartbeat State</h3></div>
      <div class="table-wrap">
        <pre style="padding:16px;font-family:var(--mono);font-size:12px;overflow-x:auto;white-space:pre-wrap;color:var(--text)">${esc(JSON.stringify(heartbeat || {}, null, 2))}</pre>
      </div>
    </div>
  `;
}

// ── Mission Modal ──────────────────────────────────────────────
let editingId = null;

function openModal(mission = null) {
  editingId = mission ? mission.id : null;
  document.getElementById('modal-title').textContent = mission ? 'Edit Mission' : 'New Mission';
  document.getElementById('mission-id').value = mission ? mission.id : '';
  document.getElementById('mission-name').value = mission ? mission.name : '';
  document.getElementById('mission-desc').value = mission ? mission.description : '';
  document.getElementById('mission-trigger').value = mission ? mission.trigger : 'manual';
  document.getElementById('mission-cron').value = mission ? mission.cronExpr || '' : '';
  document.getElementById('mission-depends-on').value = mission && mission.dependsOn ? mission.dependsOn.join(', ') : '';
  toggleCron();

  const editor = document.getElementById('steps-editor');
  editor.innerHTML = '';
  if (mission && mission.steps) {
    mission.steps.forEach(s => addStep(s));
  } else {
    addStep();
  }

  document.getElementById('mission-modal').style.display = 'flex';
}

function closeModal() {
  document.getElementById('mission-modal').style.display = 'none';
  editingId = null;
}

function toggleCron() {
  const trigger = document.getElementById('mission-trigger').value;
  document.getElementById('cron-group').style.display = trigger === 'cron' ? 'block' : 'none';
}

function addStep(data = null) {
  const editor = document.getElementById('steps-editor');
  const num = editor.children.length + 1;
  const div = document.createElement('div');
  div.className = 'step-item';
  div.innerHTML = `
    <div class="step-number">${num}</div>
    <div class="step-fields">
      <input type="text" placeholder="Step label (optional)" value="${data ? data.label || '' : ''}" class="step-label">
      <select class="step-type">
        <option value="command" ${data && data.type === 'command' ? 'selected' : ''}>Run Command</option>
        <option value="http" ${data && data.type === 'http' ? 'selected' : ''}>HTTP Request</option>
        <option value="wait" ${data && data.type === 'wait' ? 'selected' : ''}>Wait</option>
        <option value="log" ${data && data.type === 'log' ? 'selected' : ''}>Log Message</option>
      </select>
      <input type="text" placeholder="Command" value="${data ? data.command || '' : ''}" class="step-command" style="display:${data && data.type !== 'command' ? 'none' : 'block'}">
      <input type="text" placeholder="https://example.com" value="${data ? data.url || '' : ''}" class="step-url" style="display:${data && data.type !== 'http' ? 'none' : 'block'}">
      <select class="step-method" style="display:${data && data.type !== 'http' ? 'none' : 'block'}">
        <option value="GET" ${data && data.method === 'GET' ? 'selected' : ''}>GET</option>
        <option value="POST" ${data && data.method === 'POST' ? 'selected' : ''}>POST</option>
      </select>
      <input type="number" placeholder="Duration (ms)" value="${data ? data.duration || '1000' : '1000'}" class="step-duration" style="display:${data && data.type !== 'wait' ? 'none' : 'block'}">
      <input type="text" placeholder="Message to log" value="${data ? data.message || '' : ''}" class="step-message" style="display:${data && data.type !== 'log' ? 'none' : 'block'}">
      <select class="step-onfailure">
        <option value="continue" ${!data || data.onFailure === 'continue' ? 'selected' : ''}>Continue on failure</option>
        <option value="abort" ${data && data.onFailure === 'abort' ? 'selected' : ''}>Abort mission</option>
      </select>
    </div>
    <div class="step-actions">
      <button type="button" class="btn-icon" onclick="this.closest('.step-item').remove()" title="Remove">✕</button>
    </div>
  `;
  editor.appendChild(div);

  // Show/hide field groups based on step type
  const select = div.querySelector('.step-type');
  select.addEventListener('change', () => {
    const type = select.value;
    div.querySelectorAll('.step-command, .step-url, .step-method, .step-duration, .step-message').forEach(input => {
      input.style.display = 'none';
    });
    const fieldMap = { command: '.step-command', http: '.step-url, .step-method', wait: '.step-duration', log: '.step-message' };
    const fields = fieldMap[type];
    if (fields) div.querySelectorAll(fields).forEach(f => f.style.display = 'block');
  });
}

async function saveMission(e) {
  e.preventDefault();
  const steps = [];
  document.querySelectorAll('#steps-editor .step-item').forEach(item => {
    const type = item.querySelector('.step-type').value;
    const step = { type, label: item.querySelector('.step-label').value, onFailure: item.querySelector('.step-onfailure').value };
    if (type === 'command') step.command = item.querySelector('.step-command').value;
    if (type === 'http') { step.url = item.querySelector('.step-url').value; step.method = item.querySelector('.step-method').value; }
    if (type === 'wait') step.duration = parseInt(item.querySelector('.step-duration').value) || 1000;
    if (type === 'log') step.message = item.querySelector('.step-message').value;
    steps.push(step);
  });

  const payload = {
    name: document.getElementById('mission-name').value,
    description: document.getElementById('mission-desc').value,
    trigger: document.getElementById('mission-trigger').value,
    cronExpr: document.getElementById('mission-cron').value,
    dependsOn: document.getElementById('mission-depends-on').value
      .split(',')
      .map(s => s.trim())
      .filter(s => s),
    steps,
  };

  if (editingId) {
    await api(`/api/missions/${editingId}`, { method: 'PUT', body: payload });
  } else {
    await api('/api/missions', { method: 'POST', body: payload });
  }

  closeModal();
  await loadMissions();
  render();
}

async function editMission(id) {
  const mission = missions.find(m => m.id === id);
  if (mission) openModal(mission);
}

async function deleteMission(id) {
  if (!confirm('Delete this mission?')) return;
  await api(`/api/missions/${id}`, { method: 'DELETE' });
  await loadMissions();
  render();
}

async function toggleMission(id) {
  const mission = missions.find(m => m.id === id);
  if (mission) {
    await api(`/api/missions/${id}`, { method: 'PUT', body: { enabled: !mission.enabled } });
    await loadMissions();
    render();
  }
}

async function runMission(id) {
  await api(`/api/missions/${id}/run`, { method: 'POST' });
  await loadMissions();
  render();
}

async function loadMissions() {
  missions = await api('/api/missions');
}

// ── Execution History ──────────────────────────────────────────
async function viewExecHistory(missionId, missionName) {
  document.getElementById('exec-modal-title').textContent = `Execution History — ${missionName}`;
  const execs = await api(`/api/missions/${missionId}/executions`);
  const content = document.getElementById('exec-modal-content');

  if (execs.length === 0) {
    content.innerHTML = `<div class="empty-state"><div class="icon">📜</div><h3>No executions yet</h3><p>Run this mission to see history here.</p></div>`;
  } else {
    content.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>Duration</th><th>Status</th><th>Message</th></tr></thead>
          <tbody>
            ${execs.map(e => `
              <tr>
                <td style="white-space:nowrap">${new Date(e.startedAt).toLocaleString()}</td>
                <td>${e.duration ? (e.duration >= 1000 ? (e.duration/1000).toFixed(1) + 's' : e.duration + 'ms') : '—'}</td>
                <td>${statusBadge(e.success ? 'completed' : 'failed')}</td>
                <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis" title="${esc(e.message)}">${esc(e.message)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }
  document.getElementById('exec-modal').style.display = 'flex';
}

function closeExecModal() {
  document.getElementById('exec-modal').style.display = 'none';
}

// ── Templates ──────────────────────────────────────────────────
let templates = [];

async function showTemplates() {
  if (templates.length === 0) {
    templates = await api('/api/templates');
  }
  const content = document.getElementById('template-modal-content');
  if (templates.length === 0) {
    content.innerHTML = '<div class="empty-state"><p>No templates available.</p></div>';
  } else {
    content.innerHTML = `
      <div style="display:grid;gap:12px">
        ${templates.map(t => `
          <div style="background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:16px">
            <div style="display:flex;justify-content:space-between;align-items:start">
              <div>
                <h4 style="margin-bottom:4px">${esc(t.name)}</h4>
                <p style="font-size:13px;color:var(--text-muted);margin-bottom:8px">${esc(t.description)}</p>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                  <span class="badge badge-blue">${t.trigger}</span>
                  ${t.cronExpr ? `<span class="badge badge-purple">${t.cronExpr}</span>` : ''}
                  <span class="badge badge-green">${t.steps.length} steps</span>
                </div>
              </div>
              <button class="btn btn-primary btn-sm" onclick="useTemplate('${t.id}')">Use Template</button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }
  document.getElementById('template-modal').style.display = 'flex';
}

function closeTemplateModal() {
  document.getElementById('template-modal').style.display = 'none';
}

async function useTemplate(templateId) {
  const mission = await api(`/api/templates/${templateId}/use`, { method: 'POST' });
  closeTemplateModal();
  await loadMissions();
  render();
}

// ── Logs (SSE) ─────────────────────────────────────────────────
function connectSSE() {
  const evt = new EventSource('/api/stream');

  evt.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.refresh) {
      loadLogs();
      return;
    }
    logs.unshift(data);
    if (logs.length > 100) logs.length = 100;
    appendLogEntry(data);
  };

  evt.onerror = () => {
    // Reconnect automatically
    setTimeout(connectSSE, 3000);
  };

  sseConnected = true;
}

async function loadLogs() {
  logs = await api('/api/logs');
  renderLogsPanel();
}

function renderLogsPanel() {
  const container = document.getElementById('logs-container');
  container.innerHTML = logs.slice(0, 30).map(l => logEntryHTML(l)).join('');
}

function appendLogEntry(log) {
  const container = document.getElementById('logs-container');
  const div = document.createElement('div');
  div.innerHTML = logEntryHTML(log);
  container.prepend(div.firstElementChild);
  // Keep max 30 entries in DOM
  while (container.children.length > 30) container.removeChild(container.lastChild);
}

function logEntryHTML(log) {
  const time = new Date(log.timestamp).toLocaleTimeString();
  return `<div class="log-entry">
    <span class="log-time">${time}</span>
    <span class="log-type">${log.type}</span>
    <span class="log-msg">${esc(log.message)}</span>
  </div>`;
}

// ── Utils ──────────────────────────────────────────────────────
function esc(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatNextRun(date) {
  if (!date) return '—';
  const now = new Date();
  const diff = date - now;
  if (diff < 0) return 'overdue';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `in ${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `in ${days}d`;
}

// ── Init ───────────────────────────────────────────────────────
async function init() {
  await Promise.all([loadMissions(), loadLogs()]);
  render();
  connectSSE();

  // Auto-refresh dashboard every 10s
  setInterval(() => {
    if (currentPage === 'dashboard') render();
  }, 10000);
}

init();
