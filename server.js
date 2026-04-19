const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

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
  executeMission(mission).then((result) => {
    mission.lastStatus = result.success ? 'completed' : 'failed';
    writeJson(MISSIONS_FILE, missions);
    addLog('mission_finished', `Mission "${mission.name}" ${result.success ? 'completed' : 'failed'}: ${result.message}`);
  }).catch((err) => {
    mission.lastStatus = 'failed';
    writeJson(MISSIONS_FILE, missions);
    addLog('mission_error', `Mission "${mission.name}" error: ${err.message}`);
  });

  res.json({ ok: true, mission });
});

// ─── Step execution ──────────────────────────────────────────────
async function executeMission(mission) {
  const results = [];
  for (const step of mission.steps) {
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
    results.push({ step, result });
    if (!result.success && step.onFailure === 'abort') {
      return { success: false, message: `Step "${step.label || step.type}" failed: ${result.message}` };
    }
  }
  return { success: true, message: `All ${results.length} steps completed`, results };
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

// ─── Catch-all → frontend ────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ───────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Mission Control running at http://localhost:${PORT}`);
  console.log(`📂 Workspace: ${WORKSPACE}`);
});
