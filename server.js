const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// ─── Cron parser (simple crontab format) ───────────────────────
function parseCron(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, month, dow] = parts.map(p => p.split(',').map(v => {
    if (v.includes('-')) {
      const [start, end] = v.split('-').map(Number);
      return Array.from({ length: end - start + 1 }, (_, i) => start + i);
    }
    if (v.includes('/')) {
      const [base, step] = v.split('/');
      const start = base === '*' ? 0 : Number(base);
      const end = base === '*' ? 59 : 59;
      return Array.from({ length: Math.floor((end - start) / Number(step)) + 1 }, (_, i) => start + i * Number(step));
    }
    return Number(v);
  }));

  const ranges = {
    min: { min: 0, max: 59 },
    hour: { min: 0, max: 23 },
    dom: { min: 1, max: 31 },
    month: { min: 1, max: 12 },
    dow: { min: 0, max: 7 },
  };

  for (const [key, vals] of Object.entries({ min, hour, dom, month, dow })) {
    const { min: rMin, max: rMax } = ranges[key];
    if (!vals.every(v => v >= rMin && v <= rMax)) return null;
  }

  return { min, hour, dom, month, dow };
}

function cronMatches(expr, date = new Date()) {
  const parsed = parseCron(expr);
  if (!parsed) return false;

  const { min, hour, dom, month, dow } = parsed;
  const minutes = new Set(min);
  const hours = new Set(hour);
  const months = new Set(month);
  const dows = new Set(dow.map(d => d === 7 ? 0 : d)); // 7 = Sunday

  return (
    minutes.has(date.getMinutes()) &&
    hours.has(date.getHours()) &&
    (dom.includes(date.getDate()) || dom.includes(32)) &&
    months.has(date.getMonth() + 1) &&
    dows.has(date.getDay())
  );
}

function nextRun(expr) {
  let d = new Date();
  d.setSeconds(0, 0);
  for (let i = 0; i < 525600; i++) { // max 1 year ahead
    d = new Date(d.getTime() + 60000); // +1 min
    if (cronMatches(expr, d)) return d;
  }
  return null;
}

function cronToHuman(expr) {
  const parts = expr.trim().split(/\s+/);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${parts[0]} ${parts[1]} ${parts[2]} ${months[parts[3]-1]} ${days[parts[4]]}`;
}

const app = express();
const PORT = process.env.PORT || 3210;
const WORKSPACE = process.env.WORKSPACE || path.join(__dirname, '..');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Data helpers ────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');

async function readJson(file, fallback = null) {
  try {
    const data = await fs.readFile(path.join(DATA_DIR, file), 'utf-8');
    return JSON.parse(data);
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fs.writeFile(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// ─── Templates ─────────────────────────────────────────────────
const TEMPLATES_FILE = 'templates.json';

app.get('/api/templates', async (req, res) => {
  const templates = await readJson(TEMPLATES_FILE, []);
  res.json(templates);
});

app.post('/api/templates/:id/use', async (req, res) => {
  const templates = await readJson(TEMPLATES_FILE, []);
  const template = templates.find(t => t.id === req.params.id);
  if (!template) return res.status(404).json({ error: 'Template not found' });

  const missions = await readJson(MISSIONS_FILE, []);
  const mission = {
    id: uuidv4(),
    name: template.name + ' (copy)',
    description: template.description,
    steps: template.steps,
    trigger: template.trigger,
    cronExpr: template.cronExpr || '',
    enabled: true,
    createdAt: new Date().toISOString(),
    lastRun: null,
    lastStatus: null,
  };
  missions.push(mission);
  await writeJson(MISSIONS_FILE, missions);
  addLog('mission_created', `Mission "${mission.name}" created from template`);
  res.json(mission);
});

// ─── Execution history ─────────────────────────────────────────
const EXECUTIONS_FILE = 'executions.json';

async function saveExecution(execution) {
  const executions = await readJson(EXECUTIONS_FILE, []);
  executions.push(execution);
  // Keep last 500 executions
  if (executions.length > 500) executions.splice(0, executions.length - 500);
  await writeJson(EXECUTIONS_FILE, executions);
}

app.get('/api/missions/:id/executions', async (req, res) => {
  const executions = await readJson(EXECUTIONS_FILE, []);
  const missionExecs = executions
    .filter(e => e.missionId === req.params.id)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, 50);
  res.json(missionExecs);
});

app.get('/api/executions', async (req, res) => {
  const executions = await readJson(EXECUTIONS_FILE, []);
  res.json(executions.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)).slice(0, 100));
});

// ─── Missions ────────────────────────────────────────────────────
const MISSIONS_FILE = 'missions.json';

app.get('/api/missions', async (req, res) => {
  const missions = await readJson(MISSIONS_FILE, []);
  res.json(missions);
});

app.post('/api/missions', async (req, res) => {
  const missions = await readJson(MISSIONS_FILE, []);
  const mission = {
    id: uuidv4(),
    name: req.body.name,
    description: req.body.description || '',
    steps: req.body.steps || [],
    trigger: req.body.trigger || 'manual', // manual | cron | webhook
    cronExpr: req.body.cronExpr || '',
    enabled: true,
    createdAt: new Date().toISOString(),
    lastRun: null,
    lastStatus: null,
  };
  missions.push(mission);
  await writeJson(MISSIONS_FILE, missions);
  addLog('mission_created', `Mission "${mission.name}" created`);
  res.json(mission);
});

app.put('/api/missions/:id', async (req, res) => {
  const missions = await readJson(MISSIONS_FILE, []);
  const idx = missions.findIndex(m => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Mission not found' });
  missions[idx] = { ...missions[idx], ...req.body, id: missions[idx].id, createdAt: missions[idx].createdAt };
  await writeJson(MISSIONS_FILE, missions);
  addLog('mission_updated', `Mission "${missions[idx].name}" updated`);
  res.json(missions[idx]);
});

app.delete('/api/missions/:id', async (req, res) => {
  let missions = await readJson(MISSIONS_FILE, []);
  const mission = missions.find(m => m.id === req.params.id);
  missions = missions.filter(m => m.id !== req.params.id);
  await writeJson(MISSIONS_FILE, missions);
  if (mission) addLog('mission_deleted', `Mission "${mission.name}" deleted`);
  res.json({ ok: true });
});

app.post('/api/missions/:id/run', async (req, res) => {
  const missions = await readJson(MISSIONS_FILE, []);
  const mission = missions.find(m => m.id === req.params.id);
  if (!mission) return res.status(404).json({ error: 'Mission not found' });

  mission.lastRun = new Date().toISOString();
  mission.lastStatus = 'running';
  await writeJson(MISSIONS_FILE, missions);
  addLog('mission_started', `Mission "${mission.name}" started (manual)`);

  // Execute steps asynchronously
  (async () => {
    const startedAt = new Date().toISOString();
    try {
      const result = await executeMission(mission);
      const duration = Date.now() - Date.now() + 1; // will be set properly below
      mission.lastStatus = result.success ? 'completed' : 'failed';
      await saveExecution({
        id: uuidv4(),
        missionId: mission.id,
        missionName: mission.name,
        startedAt,
        finishedAt: new Date().toISOString(),
        duration: result.duration || 0,
        success: result.success,
        message: result.message,
        stepResults: result.stepResults || [],
      });
      await writeJson(MISSIONS_FILE, missions);
      addLog('mission_finished', `Mission "${mission.name}" ${result.success ? 'completed' : 'failed'}: ${result.message}`);
    } catch (err) {
      mission.lastStatus = 'failed';
      await saveExecution({
        id: uuidv4(),
        missionId: mission.id,
        missionName: mission.name,
        startedAt,
        finishedAt: new Date().toISOString(),
        duration: 0,
        success: false,
        message: err.message,
        stepResults: [],
      });
      await writeJson(MISSIONS_FILE, missions);
      addLog('mission_error', `Mission "${mission.name}" error: ${err.message}`);
    }
  })();

  res.json({ ok: true, mission });
});

// ─── Step execution ──────────────────────────────────────────────
async function executeMission(mission) {
  const startTime = Date.now();
  const stepResults = [];
  for (const step of mission.steps) {
    const stepStart = Date.now();
    let result;
    switch (step.type) {
      case 'command':
        result = await runCommand(step.command);
        break;
      case 'http':
        result = await fetchUrl(step.url, step.method || 'GET');
        break;
      case 'wait':
        result = { success: true, message: `Waited ${step.duration}ms` };
        await new Promise(r => setTimeout(r, step.duration || 1000));
        break;
      case 'log':
        result = { success: true, message: step.message || 'Log entry' };
        addLog('mission_step', `[${mission.name}] ${step.message}`);
        break;
      default:
        result = { success: false, message: `Unknown step type: ${step.type}` };
    }
    stepResults.push({
      step, result,
      duration: Date.now() - stepStart,
    });
    if (!result.success && step.onFailure === 'abort') {
      return { success: false, message: `Step "${step.label || step.type}" failed: ${result.message}`, duration: Date.now() - startTime, stepResults };
    }
  }
  return { success: true, message: `All ${stepResults.length} steps completed`, duration: Date.now() - startTime, stepResults };
}

function runCommand(cmd) {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec(cmd, { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) resolve({ success: false, message: stderr || err.message, output: stdout });
      else resolve({ success: true, message: 'Command executed', output: stdout });
    });
  });
}

function fetchUrl(url, method = 'GET') {
  return new Promise((resolve) => {
    const http = url.startsWith('https') ? require('https') : require('http');
    const req = http.request(url, { method, timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        resolve({ success: res.statusCode >= 200 && res.statusCode < 300, message: `HTTP ${res.statusCode}`, output: data.substring(0, 500) });
      });
    });
    req.on('error', (err) => resolve({ success: false, message: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, message: 'Request timed out' }); });
    req.end();
  });
}

// ─── OpenClaw state ──────────────────────────────────────────────
app.get('/api/state/sessions', async (req, res) => {
  const memoryDir = path.join(WORKSPACE, 'memory');
  try {
    const files = await fs.readdir(memoryDir);
    const dailyNotes = files
      .filter(f => f.endsWith('.md'))
      .map(f => ({ file: f, path: path.join(memoryDir, f) }))
      .sort((a, b) => b.file.localeCompare(a.file));
    res.json(dailyNotes);
  } catch {
    res.json([]);
  }
});

app.get('/api/state/memory', async (req, res) => {
  try {
    const content = await fs.readFile(path.join(WORKSPACE, 'MEMORY.md'), 'utf-8');
    res.json({ content });
  } catch {
    res.json({ content: '' });
  }
});

app.get('/api/state/heartbeat', async (req, res) => {
  const state = await readJson(path.join(WORKSPACE, 'memory', 'heartbeat-state.json'), null);
  res.json(state);
});

app.get('/api/state/config', async (req, res) => {
  try {
    const config = await fs.readFile(path.join(WORKSPACE, '.openclaw.json'), 'utf-8');
    res.json({ content: JSON.stringify(JSON.parse(config), null, 2) });
  } catch {
    res.json({ content: 'No .openclaw.json found' });
  }
});

app.get('/api/state/workspace', async (req, res) => {
  try {
    const entries = await fs.readdir(WORKSPACE, { withFileTypes: true });
    const items = entries
      .filter(e => !e.name.startsWith('.'))
      .map(e => ({ name: e.name, isDirectory: e.isDirectory() }));
    res.json(items);
  } catch {
    res.json([]);
  }
});

// ─── Logs ────────────────────────────────────────────────────────
const LOGS_FILE = 'logs.json';

function addLog(type, message) {
  readJson(LOGS_FILE, []).then((logs) => {
    logs.unshift({
      id: uuidv4(),
      type,
      message,
      timestamp: new Date().toISOString(),
    });
    // Keep last 200 entries
    if (logs.length > 200) logs.length = 200;
    writeJson(LOGS_FILE, logs);
  });
}

app.get('/api/logs', async (req, res) => {
  const logs = await readJson(LOGS_FILE, []);
  res.json(logs);
});

app.delete('/api/logs', async (req, res) => {
  await writeJson(LOGS_FILE, []);
  res.json({ ok: true });
});

// ─── SSE for real-time log updates ───────────────────────────────
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Read existing logs and send them
  readJson(LOGS_FILE, []).then((logs) => {
    for (const log of logs.slice(-20)) {
      res.write(`data: ${JSON.stringify(log)}\n\n`);
    }
  });

  // Listen for new log entries via file polling
  const logPath = path.join(DATA_DIR, LOGS_FILE);
  let lastSize = 0;
  try {
    lastSize = fs.statSync(logPath).size;
  } catch {}

  const interval = setInterval(async () => {
    try {
      const size = (await fs.stat(logPath)).size;
      if (size !== lastSize) {
        lastSize = size;
        const logs = await readJson(LOGS_FILE, []);
        res.write(`data: ${JSON.stringify({ refresh: true })}\n\n`);
      }
    } catch {}
  }, 2000);

  req.on('close', () => clearInterval(interval));
});

// ─── Health ──────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// ─── Cron scheduler ──────────────────────────────────────────────
const cronScheduler = { timers: new Map() };

function startCronScheduler() {
  addLog('scheduler_started', 'Cron scheduler started');

  // Check every 30 seconds
  const interval = setInterval(async () => {
    const missions = await readJson(MISSIONS_FILE, []);
    for (const mission of missions) {
      if (!mission.enabled || mission.trigger !== 'cron' || !mission.cronExpr) continue;
      if (cronMatches(mission.cronExpr)) {
        addLog('cron_trigger', `Cron triggered "${mission.name}"`);
        // Execute mission (similar to run endpoint)
        const startedAt = new Date().toISOString();
        try {
          const result = await executeMission(mission);
          mission.lastRun = new Date().toISOString();
          mission.lastStatus = result.success ? 'completed' : 'failed';
          await saveExecution({
            id: uuidv4(),
            missionId: mission.id,
            missionName: mission.name,
            startedAt,
            finishedAt: new Date().toISOString(),
            duration: result.duration || 0,
            success: result.success,
            message: result.message,
            stepResults: result.stepResults || [],
          });
          await writeJson(MISSIONS_FILE, missions);
          addLog('mission_finished', `Mission "${mission.name}" ${result.success ? 'completed' : 'failed'}: ${result.message}`);
        } catch (err) {
          mission.lastStatus = 'failed';
          await saveExecution({
            id: uuidv4(),
            missionId: mission.id,
            missionName: mission.name,
            startedAt,
            finishedAt: new Date().toISOString(),
            duration: 0,
            success: false,
            message: err.message,
            stepResults: [],
          });
          await writeJson(MISSIONS_FILE, missions);
          addLog('mission_error', `Mission "${mission.name}" error: ${err.message}`);
        }
      }
    }
  }, 30000);

  cronScheduler.timers.set('interval', interval);
}

app.get('/api/cron/next-runs', async (req, res) => {
  const missions = await readJson(MISSIONS_FILE, []);
  const cronMissions = missions
    .filter(m => m.enabled && m.trigger === 'cron' && m.cronExpr)
    .map(m => ({
      id: m.id,
      name: m.name,
      cronExpr: m.cronExpr,
      human: cronToHuman(m.cronExpr),
      nextRun: nextRun(m.cronExpr),
    }));
  res.json(cronMissions);
});

// ─── Catch-all → frontend ────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ───────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Mission Control running at http://localhost:${PORT}`);
  console.log(`📂 Workspace: ${WORKSPACE}`);
  startCronScheduler();
});
