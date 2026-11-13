const { app, BrowserWindow, ipcMain, dialog, net, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const { spawn } = require('child_process');
const { execFile } = require('child_process');
const { promisify } = require('util');
const netMod = require('net');
const http = require('http');
const crypto = require('crypto');
const execFileP = promisify(execFile);

let root = null;
const aborts = new Map();
let watcher = null, watchTimer = null;
const watchBatch = new Map();
let fileListCache = null;
function stopWatch() {
  clearTimeout(watchTimer); watchTimer = null; watchBatch.clear();
  watcher?.close(); watcher = null;
}
function startWatch() {
  stopWatch();
  if (!root) return;
  try {
    watcher = fsSync.watch(root, { recursive: true }, (event, filename) => {
      if (!filename) return;
      const rel = String(filename).split(path.sep).join('/');
      if (rel.split('/').some((s) => s === 'node_modules' || s === '.git')) return;
      const prev = watchBatch.get(rel) || { rename: false, change: false };
      if (event === 'rename') prev.rename = true; else prev.change = true;
      watchBatch.set(rel, prev);
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        const changes = [...watchBatch].map(([p, e]) => ({ path: p, event: e.rename ? 'rename' : 'change', changed: e.change }));
        watchBatch.clear();
        fileListCache = null;
        for (const w of BrowserWindow.getAllWindows()) w.webContents.send('fs-change', { changes });
      }, 250);
    });
    watcher.on('error', () => {});
  } catch { watcher = null; }
}

const inside = (base, target) => {
  const rel = path.relative(base, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
};
async function safe(p) {
  if (!root) throw new Error('Open a folder first.');
  const full = path.resolve(root, p || '.');
  if (!inside(root, full)) throw new Error('Path is outside the project folder.');
  const realRoot = await fs.realpath(root);
  let probe = full;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      const realFull = probe === full ? real : path.join(real, path.relative(probe, full));
      if (!inside(realRoot, realFull)) throw new Error('Path is outside the project folder.');
      return full;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const parent = path.dirname(probe);
      if (parent === probe) return full;
      probe = parent;
    }
  }
}

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (r.canceled) return null;
  try { root = fsSync.realpathSync.native(r.filePaths[0]); } catch { root = r.filePaths[0]; }
  fileListCache = null;
  startWatch();
  return root;
});

ipcMain.handle('list-dir', async (_e, p) => {
  const entries = await fs.readdir(await safe(p), { withFileTypes: true });
  return entries
    .filter((d) => d.name !== 'node_modules' && d.name !== '.git')
    .map((d) => ({ name: d.name, dir: d.isDirectory() }))
    .sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name));
});

ipcMain.handle('read-file', async (_e, p) => {
  const full = await safe(p);
  const st = await fs.stat(full);
  if (st.isDirectory()) {
    const names = (await fs.readdir(full, { withFileTypes: true }))
      .filter((d) => d.name !== 'node_modules' && d.name !== '.git')
      .map((d) => d.name + (d.isDirectory() ? '/' : ''));
    throw new Error(`"${p || '.'}" is a folder, not a file. Use list_dir to browse it. Contents: ${names.join(', ') || '(empty)'}`);
  }
  if (st.size > 2 * 1024 * 1024) throw new Error('File is too large to read (over 2 MB).');
  return fs.readFile(full, 'utf8');
});

ipcMain.handle('write-file', async (_e, { path: p, content }) => {
  const full = await safe(p);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
  fileListCache = null;
  return 'ok';
});

ipcMain.handle('create-file', async (_e, p) => {
  const full = await safe(p);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, '', { flag: 'wx' }).catch(async (err) => {
    if (err.code !== 'EEXIST') throw err;
  });
  fileListCache = null;
  return full;
});

ipcMain.handle('create-folder', async (_e, p) => {
  const full = await safe(p);
  await fs.mkdir(full, { recursive: true });
  fileListCache = null;
  return full;
});

ipcMain.handle('delete-path', async (_e, p) => {
  const full = await safe(p);
  const st = await fs.stat(full);
  if (st.isDirectory()) {
    await fs.rm(full, { recursive: true, force: true });
  } else {
    await fs.unlink(full);
  }
  fileListCache = null;
  return true;
});

ipcMain.handle('rename-path', async (_e, { oldPath, newPath }) => {
  const oldFull = await safe(oldPath);
  const newFull = await safe(newPath);
  await fs.mkdir(path.dirname(newFull), { recursive: true });
  await fs.rename(oldFull, newFull);
  fileListCache = null;
  return true;
});

// ---- streaming terminal: one place for user commands, agent commands, preview servers, MCP logs ----
const shimsDir = path.join(__dirname, 'shims');
function getChildEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (process.platform === 'win32') {
    const sysRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
    const sys32 = path.join(sysRoot, 'System32');
    const psDir = path.join(sys32, 'WindowsPowerShell', 'v1.0');
    const curPath = env.PATH || env.Path || '';
    const cleanPath = [shimsDir, psDir, sys32, curPath].filter(Boolean).join(path.delimiter);
    env.PATH = cleanPath;
    env.Path = cleanPath;
  }
  return env;
}
if (process.platform === 'win32') {
  process.env = getChildEnv();
}

let termSeq = 0;
const termProcs = new Map();
const sendAll = (ch, data) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send(ch, data); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killProc(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    try {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } catch {
      try { child.kill(); } catch {}
    }
  } else {
    try { child.kill(); } catch {}
  }
}

function startRun(cmd, { source = 'user', cwd, timeout = 0, shell } = {}) {
  const id = 't' + (++termSeq);
  const workdir = cwd || root;
  sendAll('term-start', { id, command: cmd, source, cwd: workdir });
  const env = getChildEnv();
  let child;
  if (process.platform === 'win32' && shell === 'powershell') {
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const psPath = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const exe = fsSync.existsSync(psPath) ? psPath : 'powershell.exe';
    child = spawn(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { cwd: workdir, windowsHide: true, env });
  } else if (process.platform === 'win32' && shell === 'cmd') {
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const cmdPath = process.env.ComSpec || path.join(sysRoot, 'System32', 'cmd.exe');
    const exe = fsSync.existsSync(cmdPath) ? cmdPath : 'cmd.exe';
    child = spawn(exe, ['/d', '/s', '/c', cmd], { cwd: workdir, windowsHide: true, env });
  } else {
    child = spawn(cmd, { cwd: workdir, shell: true, windowsHide: true, env });
  }
  termProcs.set(id, child);
  let out = '', finished = false, timer = null, resolve;
  const promise = new Promise((r) => { resolve = r; });
  const done = (code, extra) => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    termProcs.delete(id);
    if (extra) { out += extra; sendAll('term-data', { id, data: extra }); }
    sendAll('term-exit', { id, code });
    resolve(out || '(no output)');
  };
  const onData = (d) => {
    const s = d.toString();
    out += s;
    if (out.length > 400000) out = out.slice(-400000);
    sendAll('term-data', { id, data: s });
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (err) => done(-1, '\nFailed to start: ' + err.message + '\n'));
  child.on('close', (code) => done(code ?? -1));
  if (timeout > 0) timer = setTimeout(() => {
    sendAll('term-data', { id, data: '\n[command timed out after ' + Math.round(timeout / 1000) + 's]\n' });
    killProc(child);
  }, timeout);
  return { id, promise };
}

ipcMain.handle('run-command', async (_e, cmd) => {
  const cwd = await safe('.');
  return startRun(String(cmd), { source: 'agent', cwd, timeout: 300000 }).promise;
});
ipcMain.handle('term-run', async (_e, cmd, opts = {}) => {
  const cwd = await safe('.');
  return { id: startRun(String(cmd), { source: 'user', cwd, timeout: 0, shell: opts && opts.shell }).id };
});
ipcMain.handle('term-input', (_e, { id, data } = {}) => {
  const child = id ? termProcs.get(id) : [...termProcs.values()].pop();
  if (child && child.stdin && !child.stdin.destroyed && child.stdin.writable) {
    child.stdin.write(String(data || ''));
    return true;
  }
  return false;
});
ipcMain.handle('term-end-input', (_e, id) => {
  const child = id ? termProcs.get(id) : [...termProcs.values()].pop();
  if (child && child.stdin && !child.stdin.destroyed) {
    child.stdin.end();
    return true;
  }
  return false;
});
ipcMain.handle('term-kill', (_e, id) => {
  if (id) { killProc(termProcs.get(id)); }
  else for (const p of termProcs.values()) { killProc(p); }
  return true;
});

// ---- search + quick open ----
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next', '.nuxt', '.cache', 'coverage', 'vendor']);
async function walkFiles(base, rel, out, limit) {
  let entries;
  try { entries = await fs.readdir(path.join(base, rel), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.isSymbolicLink()) continue;
      await walkFiles(base, r, out, limit);
    } else if (e.isFile()) {
      out.push(r);
      if (out.length >= limit) return;
    }
  }
}
async function listAllFiles() {
  if (fileListCache) return fileListCache;
  const base = await safe('.');
  const out = [];
  await walkFiles(base, '', out, 20000);
  fileListCache = out.sort((a, b) => a.localeCompare(b));
  return fileListCache;
}
ipcMain.handle('list-files', () => listAllFiles());
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
ipcMain.handle('search-files', async (_e, { query, caseSensitive = false, regex = false, maxResults = 200 } = {}) => {
  const q = String(query || '');
  if (!q.trim()) return { results: [], truncated: false };
  let re;
  try { re = new RegExp(regex ? q : escapeRe(q), caseSensitive ? 'g' : 'gi'); }
  catch (err) { throw new Error('Invalid search pattern: ' + err.message); }
  const base = await safe('.');
  const files = await listAllFiles();
  const results = [];
  let truncated = false;
  for (const rel of files) {
    let text;
    try {
      const full = path.join(base, rel);
      const st = await fs.stat(full);
      if (st.size > 1024 * 1024) continue;
      text = await fs.readFile(full, 'utf8');
    } catch { continue; }
    if (text.includes('\u0000')) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (!re.test(lines[i])) continue;
      re.lastIndex = 0;
      const m = re.exec(lines[i]);
      results.push({ path: rel, line: i + 1, column: (m?.index ?? 0) + 1, preview: lines[i].trim().slice(0, 240) });
      if (results.length >= maxResults) { truncated = true; break; }
    }
    if (truncated) break;
  }
  return { results, truncated };
});

// ---- project rules ----
const RULE_FILES = ['JEILO.md', 'AGENTS.md', 'CLAUDE.md', '.jeilorules', '.cursorrules'];
ipcMain.handle('project-rules', async () => {
  if (!root) return { path: null, content: '' };
  for (const f of RULE_FILES) {
    try {
      const full = await safe(f);
      const content = await fs.readFile(full, 'utf8');
      return { path: f, content: content.slice(0, 20000) };
    } catch {}
  }
  return { path: null, content: '' };
});

// ---- git ----
async function gitRun(args, opts = {}) {
  if (!root) throw new Error('Open a folder first.');
  const env = getChildEnv(opts.env);
  return execFileP('git', args, { cwd: root, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env });
}
async function git(args, opts = {}) {
  const { stdout } = await gitRun(args, opts);
  return stdout;
}
const gitErr = (e) => new Error(String(e.stderr || e.stdout || e.message || e).trim());
ipcMain.handle('git-status', async () => {
  if (!root) throw new Error('Open a folder first.');
  try {
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const out = await git(['status', '--porcelain=v1', '-uall']);
    const files = [];
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const x = line[0], y = line[1];
      let p = line.slice(3).trim();
      if (p.includes(' -> ')) p = p.split(' -> ').pop();
      const staged = x !== ' ' && x !== '?' && x !== '!';
      const unstaged = y !== ' ' || x === '?';
      files.push({ path: p, x, y, staged, unstaged });
    }
    let ahead = 0, behind = 0;
    try {
      const ab = (await git(['rev-list', '--left-right', '--count', '@{u}...HEAD'])).trim().split(/\s+/).map(Number);
      behind = ab[0] || 0; ahead = ab[1] || 0;
    } catch {}
    return { repo: true, branch, files, ahead, behind };
  } catch (e) {
    if (/not a git repository/i.test(String(e.stderr || e.message))) return { repo: false };
    throw gitErr(e);
  }
});
ipcMain.handle('git-diff', async (_e, { cached = false, path: p } = {}) => {
  if (!root) throw new Error('Open a folder first.');
  const args = ['diff', '--no-color'];
  if (cached) args.push('--cached');
  if (p) args.push('--', p);
  let out = '';
  try { out = await git(args); } catch (e) { throw gitErr(e); }
  if (!out.trim() && p && !cached) {
    try { const text = await fs.readFile(await safe(p), 'utf8'); out = text.split(/\r?\n/).map((l) => '+ ' + l).join('\n'); } catch {}
  }
  return out.slice(0, 200000);
});
ipcMain.handle('git-stage', async (_e, { paths } = {}) => {
  if (!root) throw new Error('Open a folder first.');
  const args = paths && paths.length ? ['add', '--', ...paths] : ['add', '-A'];
  try { await git(args); } catch (e) { throw gitErr(e); }
  return true;
});
ipcMain.handle('git-unstage', async (_e, { paths } = {}) => {
  if (!root) throw new Error('Open a folder first.');
  const p = paths && paths.length ? paths : ['.'];
  try { await git(['restore', '--staged', '--', ...p]); }
  catch { try { await git(['reset', 'HEAD', '--', ...p]); } catch (e) { throw gitErr(e); } }
  return true;
});
ipcMain.handle('git-commit', async (_e, { message }) => {
  if (!root) throw new Error('Open a folder first.');
  if (!String(message || '').trim()) throw new Error('Write a commit message first.');
  try { return await git(['commit', '-m', String(message)]); } catch (e) { throw gitErr(e); }
});

// ---- GitHub: token stays in the main process and is never written to .git/config ----
let authPending = null, googleFlow = null;
function normalizeGithubRemote(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Paste a GitHub repository URL first.');
  const scp = s.match(/^(?:git@|ssh:\/\/git@)github\.com[:/](.+)$/i);
  if (scp) s = 'https://github.com/' + scp[1];
  let u;
  try { u = new URL(s); } catch { throw new Error('Enter a valid GitHub repository URL, such as https://github.com/owner/repo.git.'); }
  if (u.protocol !== 'https:') throw new Error('Use an HTTPS GitHub URL (https://github.com/owner/repo.git).');
  if (!/^(www\.)?github\.com$/i.test(u.hostname)) throw new Error('Only github.com remotes are supported.');
  if (u.username || u.password) throw new Error('Remove the token from the URL and paste it in the token field instead.');
  const parts = u.pathname.replace(/^\/|\/$/g, '').split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('The URL must be a repository URL such as https://github.com/owner/repo.git.');
  u.hostname = 'github.com'; u.search = ''; u.hash = '';
  return u.href.replace(/\/$/, '');
}
async function githubRemoteUrl() {
  if (!root) return null;
  try { return (await git(['remote', 'get-url', 'origin'])).trim() || null; } catch { return null; }
}
function githubAuthEnv() {
  if (!keys.github) throw new Error('Connect a GitHub account first.');
  const basic = Buffer.from('x-access-token:' + keys.github, 'utf8').toString('base64');
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraheader',
    GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic ' + basic,
  };
}
function githubGitError(e) {
  let msg = String(e.stderr || e.stdout || e.message || e).trim();
  if (/Authentication failed|could not read Username|terminal prompts disabled|403/i.test(msg)) {
    msg += '\n\nCheck that the token is valid and has write access to this repository.';
  }
  if (/no tracking information|no upstream branch/i.test(msg)) {
    msg += '\n\nPush first to set the upstream branch.';
  }
  return new Error(msg);
}

// ---- MCP: minimal stdio JSON-RPC client (servers configured in the project) ----
const mcpClients = new Map();
let mcpToolMap = new Map();
let mcpToolDefs = [];
const mcpSanitize = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
class McpClient {
  constructor(name, cfg, cwd) {
    this.name = name; this.cfg = cfg; this.cwd = cwd;
    this.seq = 0; this.pending = new Map(); this.buf = ''; this.tools = []; this.proc = null;
  }
  start() {
    return new Promise((resolve, reject) => {
      sendAll('term-start', { id: 'mcp:' + this.name, command: 'MCP server: ' + this.name, source: 'mcp', cwd: this.cwd });
      try {
        this.proc = spawn(this.cfg.command, this.cfg.args || [], {
          cwd: this.cwd, env: getChildEnv(this.cfg.env),
          stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32',
        });
      } catch (e) { return reject(e); }
      let settled = false;
      const fail = (e) => { if (!settled) { settled = true; reject(e); } };
      this.proc.on('error', fail);
      this.proc.on('close', (code) => {
        if (!settled) { settled = true; reject(new Error('MCP server exited with code ' + code)); }
        for (const p of this.pending.values()) { clearTimeout(p.t); p.reject(new Error('MCP server exited')); }
        this.pending.clear();
      });
      this.proc.stdout.setEncoding('utf8');
      this.proc.stdout.on('data', (d) => {
        this.buf += d;
        let i;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i).trim();
          this.buf = this.buf.slice(i + 1);
          if (line) this.onLine(line);
        }
      });
      this.proc.stderr.on('data', (d) => sendAll('term-data', { id: 'mcp:' + this.name, data: d.toString() }));
      this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'jeilo-ark', version: app.getVersion() } })
        .then(() => { this.notify('notifications/initialized', {}); return this.request('tools/list', {}); })
        .then((r) => { this.tools = Array.isArray(r?.tools) ? r.tools : []; settled = true; resolve(this); })
        .catch(fail);
    });
  }
  send(obj) { try { this.proc.stdin.write(JSON.stringify(obj) + '\n'); } catch {} }
  request(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('MCP request timed out: ' + method)); }, 15000);
      this.pending.set(id, { resolve, reject, t });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }
  onLine(line) {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(p.t);
      if (msg.error) p.reject(new Error(msg.error.message || 'MCP error')); else p.resolve(msg.result);
      return;
    }
    if (msg.id != null && msg.method) this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Not supported by Jeilo ARK' } });
  }
  async callTool(name, args) {
    const r = await this.request('tools/call', { name, arguments: args || {} });
    const parts = Array.isArray(r?.content)
      ? r.content.map((c) => c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : JSON.stringify(c)).filter(Boolean)
      : [];
    const text = parts.join('\n') || (r?.structuredContent ? JSON.stringify(r.structuredContent) : '');
    if (r?.isError) throw new Error(text || 'MCP tool failed.');
    return text || '(no output)';
  }
  close() { if (this.proc) killProc(this.proc); }
}
async function stopMcp() {
  for (const c of mcpClients.values()) c.close();
  mcpClients.clear(); mcpToolMap = new Map(); mcpToolDefs = [];
}
async function reloadMcp() {
  await stopMcp();
  if (!root) return { tools: [], servers: [] };
  let cfg = null;
  for (const f of ['.jeilo/mcp.json', 'mcp.json', '.mcp.json']) {
    try {
      const raw = JSON.parse(await fs.readFile(await safe(f), 'utf8'));
      const candidate = raw.mcpServers || raw.servers || raw;
      if (candidate && typeof candidate === 'object' && Object.keys(candidate).length) { cfg = candidate; break; }
    } catch {}
  }
  if (!cfg) return { tools: [], servers: [] };
  const entries = Object.entries(cfg).filter(([, v]) => v && typeof v === 'object' && v.command);
  await Promise.all(entries.map(async ([name, conf]) => {
    const c = new McpClient(name, conf, root);
    try { await c.start(); mcpClients.set(name, c); } catch { c.close(); }
  }));
  for (const [name, c] of mcpClients) {
    for (const tool of c.tools) {
      const openaiName = ('mcp__' + mcpSanitize(name) + '__' + mcpSanitize(tool.name)).slice(0, 64);
      mcpToolMap.set(openaiName, { client: c, tool: tool.name });
      mcpToolDefs.push({
        type: 'function',
        function: {
          name: openaiName,
          description: String(tool.description || tool.name).slice(0, 1000),
          parameters: tool.inputSchema || { type: 'object', properties: {} },
        },
      });
    }
  }
  return { tools: mcpToolDefs, servers: [...mcpClients.keys()] };
}
ipcMain.handle('mcp-reload', () => reloadMcp());
ipcMain.handle('mcp-call', async (_e, { name, args }) => {
  const m = mcpToolMap.get(name);
  if (!m) throw new Error('Unknown MCP tool: ' + name);
  return m.client.callTool(m.tool, args);
});

// ---- Extensions Hub ----
const EXTENSION_CATALOG = [
  // MCP Tools
  {
    id: 'mcp-fetch',
    type: 'mcp',
    name: 'Fetch & Web Scraper',
    desc: 'Allows the AI assistant to fetch documentation, URLs, and web APIs directly into context.',
    config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-fetch'] },
  },
  {
    id: 'mcp-sqlite',
    type: 'mcp',
    name: 'SQLite Database Explorer',
    desc: 'Inspect SQLite database schemas, run SELECT queries, and debug data with the AI assistant.',
    config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sqlite', '--db', './dev.db'] },
  },
  {
    id: 'mcp-filesystem',
    type: 'mcp',
    name: 'Filesystem Extended Tools',
    desc: 'Deep workspace directory search, metadata inspection, and batch file reading tools.',
    config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
  },
  {
    id: 'mcp-puppeteer',
    type: 'mcp',
    name: 'Puppeteer Browser Automation',
    desc: 'Grants the AI assistant headless browser testing, web scraping, and DOM inspection capabilities.',
    config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'] },
  },
  {
    id: 'mcp-github',
    type: 'mcp',
    name: 'GitHub MCP Tools',
    desc: 'Repository search, issue tracking, and pull request inspection tools for the agent.',
    config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
  },
  {
    id: 'mcp-opencode',
    type: 'mcp',
    name: 'OpenCode Agent Tools',
    desc: 'Integrate the OpenCode open-source AI coding agent tools, project inspection, and workflows.',
    config: { command: 'npx', args: ['-y', 'opencode-mcp'] },
  },
  // Themes
  {
    id: 'theme-dracula',
    type: 'theme',
    name: 'Dracula Dark',
    desc: 'The iconic dark theme with vampire purple accents and rich contrast.',
    theme: {
      id: 'dracula',
      base: 'vs-dark',
      vars: {
        '--bg': '#282a36', '--panel': '#21222c', '--raise': '#343746', '--line': '#44475a',
        '--text': '#f8f8f2', '--dim': '#6272a4', '--accent': '#bd93f9', '--accent-text': '#282a36',
        '--ok': '#50fa7b', '--bad': '#ff5555', '--warn': '#f1fa8c',
      },
      monaco: { 'editor.background': '#282a36', 'editorLineNumber.foreground': '#6272a4', 'editorLineNumber.activeForeground': '#bd93f9', 'editor.lineHighlightBackground': '#21222c', 'editor.selectionBackground': '#44475a', 'editorCursor.foreground': '#bd93f9' },
    },
  },
  {
    id: 'theme-one-dark',
    type: 'theme',
    name: 'One Dark Pro',
    desc: 'Atom\'s beloved dark theme with soft blue accents and soothing background.',
    theme: {
      id: 'one-dark',
      base: 'vs-dark',
      vars: {
        '--bg': '#282c34', '--panel': '#21252b', '--raise': '#2c313a', '--line': '#3a3f4b',
        '--text': '#abb2bf', '--dim': '#5c6370', '--accent': '#61afef', '--accent-text': '#1e1e1e',
        '--ok': '#98c379', '--bad': '#e06c75', '--warn': '#e5c07b',
      },
      monaco: { 'editor.background': '#282c34', 'editorLineNumber.foreground': '#5c6370', 'editorLineNumber.activeForeground': '#61afef', 'editor.lineHighlightBackground': '#21252b', 'editor.selectionBackground': '#3a3f4b', 'editorCursor.foreground': '#61afef' },
    },
  },
  {
    id: 'theme-nord',
    type: 'theme',
    name: 'Nord Frost',
    desc: 'An arctic, north-bluish palette with ice-cyan highlights.',
    theme: {
      id: 'nord',
      base: 'vs-dark',
      vars: {
        '--bg': '#2e3440', '--panel': '#242933', '--raise': '#3b4252', '--line': '#434c5e',
        '--text': '#eceff4', '--dim': '#7b88a1', '--accent': '#88c0d0', '--accent-text': '#2e3440',
        '--ok': '#a3be8c', '--bad': '#bf616a', '--warn': '#ebcb8b',
      },
      monaco: { 'editor.background': '#2e3440', 'editorLineNumber.foreground': '#7b88a1', 'editorLineNumber.activeForeground': '#88c0d0', 'editor.lineHighlightBackground': '#242933', 'editor.selectionBackground': '#434c5e', 'editorCursor.foreground': '#88c0d0' },
    },
  },
  {
    id: 'theme-monokai',
    type: 'theme',
    name: 'Monokai Pro',
    desc: 'Vibrant yellow-green accents designed for code focus and clarity.',
    theme: {
      id: 'monokai',
      base: 'vs-dark',
      vars: {
        '--bg': '#272822', '--panel': '#1e1f1c', '--raise': '#383830', '--line': '#49483e',
        '--text': '#f8f8f2', '--dim': '#75715e', '--accent': '#a6e22e', '--accent-text': '#272822',
        '--ok': '#a6e22e', '--bad': '#f92672', '--warn': '#e6db74',
      },
      monaco: { 'editor.background': '#272822', 'editorLineNumber.foreground': '#75715e', 'editorLineNumber.activeForeground': '#a6e22e', 'editor.lineHighlightBackground': '#1e1f1c', 'editor.selectionBackground': '#49483e', 'editorCursor.foreground': '#a6e22e' },
    },
  },
  {
    id: 'theme-github-dark',
    type: 'theme',
    name: 'GitHub Dark',
    desc: 'GitHub\'s default code viewer dark theme.',
    theme: {
      id: 'github-dark',
      base: 'vs-dark',
      vars: {
        '--bg': '#0d1117', '--panel': '#161b22', '--raise': '#21262d', '--line': '#30363d',
        '--text': '#c9d1d9', '--dim': '#8b949e', '--accent': '#58a6ff', '--accent-text': '#0d1117',
        '--ok': '#3fb950', '--bad': '#f85149', '--warn': '#d29922',
      },
      monaco: { 'editor.background': '#0d1117', 'editorLineNumber.foreground': '#8b949e', 'editorLineNumber.activeForeground': '#58a6ff', 'editor.lineHighlightBackground': '#161b22', 'editor.selectionBackground': '#30363d', 'editorCursor.foreground': '#58a6ff' },
    },
  },
  {
    id: 'theme-solarized-light',
    type: 'theme',
    name: 'Solarized Light',
    desc: 'Warm light palette designed specifically for low eye strain.',
    theme: {
      id: 'solarized-light',
      base: 'vs',
      vars: {
        '--bg': '#fdf6e3', '--panel': '#eee8d5', '--raise': '#e0d9c4', '--line': '#d3cbb7',
        '--text': '#657b83', '--dim': '#93a1a1', '--accent': '#268bd2', '--accent-text': '#ffffff',
        '--ok': '#859900', '--bad': '#dc322f', '--warn': '#b58900',
      },
      monaco: { 'editor.background': '#fdf6e3', 'editorLineNumber.foreground': '#93a1a1', 'editorLineNumber.activeForeground': '#268bd2', 'editor.lineHighlightBackground': '#eee8d5', 'editor.selectionBackground': '#e0d9c4', 'editorCursor.foreground': '#268bd2' },
    },
  },
  // Skills / Rules
  {
    id: 'skill-nextjs',
    type: 'skill',
    name: 'Next.js 15 & React 19 Expert',
    desc: 'App Router, Server Components, Suspense boundaries, and hook rules.',
    rules: '\n## Next.js 15 & React 19 Standards\n- Prefer Server Components by default; add \'use client\' only when state or client hooks are required.\n- Handle streaming loading states with loading.tsx and Suspense.\n- Use Server Actions for mutations with useActionState.\n',
  },
  {
    id: 'skill-fastapi',
    type: 'skill',
    name: 'Python & FastAPI Architect',
    desc: 'Strict typing, Pydantic v2 schemas, async endpoints, and dependency injection.',
    rules: '\n## FastAPI & Python Guidelines\n- Always use Pydantic v2 BaseModel with Field descriptions.\n- Enforce type annotations on all function signatures.\n- Use Depends for database sessions and auth.\n',
  },
  {
    id: 'skill-rust',
    type: 'skill',
    name: 'Rust Systems Specialist',
    desc: 'Zero-cost abstractions, memory ownership, and idiomatic error handling.',
    rules: '\n## Rust Architecture Rules\n- Use Result and Option with ? operator instead of unwrap() or expect().\n- Leverage custom error types with thiserror/anyhow.\n- Favor borrowing (&str, &[T]) over unnecessary allocations.\n',
  },
  {
    id: 'skill-security',
    type: 'skill',
    name: 'OWASP Security Auditor',
    desc: 'Strict input validation, parameterized queries, and safe auth practices.',
    rules: '\n## Security & OWASP Guidelines\n- Never concatenate raw strings into SQL queries or shell commands.\n- Sanitize all user-controlled input before rendering.\n- Never store secrets or sensitive credentials in plain text.\n',
  },
  {
    id: 'skill-testing',
    type: 'skill',
    name: 'TDD & Testing Coach',
    desc: 'Unit test generation, Arrange-Act-Assert structure, and edge-case coverage.',
    rules: '\n## Testing Standards\n- Follow Arrange-Act-Assert (AAA) pattern in all test suites.\n- Test boundary conditions, null/empty cases, and error branches.\n- Keep unit tests isolated and independent.\n',
  },
];

async function getInstalledMcpServers() {
  if (!root) return {};
  for (const f of ['.jeilo/mcp.json', 'mcp.json', '.mcp.json']) {
    try {
      const raw = JSON.parse(await fs.readFile(await safe(f), 'utf8'));
      const candidate = raw.mcpServers || raw.servers || raw;
      if (candidate && typeof candidate === 'object') return candidate;
    } catch {}
  }
  return {};
}

async function saveMcpServer(name, config) {
  if (!root) throw new Error('Open a folder first.');
  const full = await safe('.jeilo/mcp.json');
  let current = { mcpServers: {} };
  try { current = JSON.parse(await fs.readFile(full, 'utf8')); } catch {}
  if (!current.mcpServers) current.mcpServers = {};
  current.mcpServers[name] = config;
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, JSON.stringify(current, null, 2), 'utf8');
  return reloadMcp();
}

async function removeMcpServer(name) {
  if (!root) throw new Error('Open a folder first.');
  const full = await safe('.jeilo/mcp.json');
  let current = { mcpServers: {} };
  try { current = JSON.parse(await fs.readFile(full, 'utf8')); } catch { return; }
  if (current.mcpServers && current.mcpServers[name]) {
    delete current.mcpServers[name];
    await fs.writeFile(full, JSON.stringify(current, null, 2), 'utf8');
  }
  return reloadMcp();
}

ipcMain.handle('ext-list', async () => {
  const mcpServers = await getInstalledMcpServers();
  const rules = root ? (await fs.readFile(await safe('JEILO.md'), 'utf8').catch(() => '')) : '';
  const installedIds = [];
  for (const ext of EXTENSION_CATALOG) {
    if (ext.type === 'mcp' && mcpServers[ext.id.replace('mcp-', '')]) installedIds.push(ext.id);
    if (ext.type === 'skill' && rules.includes(ext.name)) installedIds.push(ext.id);
  }
  const customMcp = [];
  for (const [k, v] of Object.entries(mcpServers)) {
    if (!EXTENSION_CATALOG.some((c) => c.id === 'mcp-' + k)) {
      customMcp.push({ id: 'mcp-' + k, name: k, command: v.command, args: v.args || [] });
    }
  }
  return { catalog: EXTENSION_CATALOG, installed: installedIds, customMcp };
});

ipcMain.handle('ext-install', async (_e, id) => {
  const ext = EXTENSION_CATALOG.find((x) => x.id === id);
  if (!ext) throw new Error('Extension not found: ' + id);
  if (ext.type === 'mcp') {
    await saveMcpServer(ext.id.replace('mcp-', ''), ext.config);
    return { ok: true, mcp: true };
  }
  if (ext.type === 'skill') {
    if (!root) throw new Error('Open a folder first.');
    const full = await safe('JEILO.md');
    let existing = '';
    try { existing = await fs.readFile(full, 'utf8'); } catch {}
    const banner = `\n### [Extension: ${ext.name}]\n`;
    if (!existing.includes(banner)) {
      const updated = (existing.trim() ? existing.trim() + '\n' : '# Project Rules\n') + banner + ext.rules.trim() + '\n';
      await fs.writeFile(full, updated, 'utf8');
    }
    return { ok: true, skill: true };
  }
  if (ext.type === 'theme') {
    return { ok: true, theme: ext.theme };
  }
  return { ok: true };
});

ipcMain.handle('ext-uninstall', async (_e, id) => {
  const ext = EXTENSION_CATALOG.find((x) => x.id === id);
  if (ext && ext.type === 'mcp') {
    await removeMcpServer(ext.id.replace('mcp-', ''));
    return { ok: true, mcp: true };
  }
  if (id.startsWith('mcp-')) {
    await removeMcpServer(id.replace('mcp-', ''));
    return { ok: true, mcp: true };
  }
  if (ext && ext.type === 'skill') {
    if (!root) throw new Error('Open a folder first.');
    const full = await safe('JEILO.md');
    try {
      let text = await fs.readFile(full, 'utf8');
      const banner = `\n### [Extension: ${ext.name}]\n`;
      const idx = text.indexOf(banner);
      if (idx >= 0) {
        const nextIdx = text.indexOf('\n### [Extension: ', idx + banner.length);
        const chunk = nextIdx >= 0 ? text.slice(idx, nextIdx) : text.slice(idx);
        text = text.replace(chunk, '');
        await fs.writeFile(full, text.trim() + '\n', 'utf8');
      }
    } catch {}
    return { ok: true, skill: true };
  }
  return { ok: true };
});

ipcMain.handle('ext-custom-mcp', async (_e, { name, command, args }) => {
  const sanitized = mcpSanitize(name);
  if (!sanitized) throw new Error('Invalid MCP server name.');
  if (!command) throw new Error('Specify a command.');
  const argList = Array.isArray(args) ? args : String(args || '').trim().split(/\s+/).filter(Boolean);
  await saveMcpServer(sanitized, { command, args: argList });
  return { ok: true, name: sanitized };
});

// ---- PHP-friendly preview (php -S) ----
let previewProc = null, previewInfo = null;
function portOpen(host, port) {
  return new Promise((resolve) => {
    const s = netMod.connect({ host, port });
    let done = false;
    const fin = (v) => { if (done) return; done = true; s.destroy(); resolve(v); };
    s.once('connect', () => fin(true));
    s.once('error', () => fin(false));
    s.setTimeout(400, () => fin(false));
  });
}
function stopPreview() {
  const p = previewProc; previewProc = null; previewInfo = null;
  if (p) killProc(p);
}
ipcMain.handle('preview-start', async (_e, { entry } = {}) => {
  if (!root) throw new Error('Open a folder first.');
  stopPreview();
  const docRoot = await safe('.');
  const port = await new Promise((resolve, reject) => {
    const s = netMod.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const host = '127.0.0.1';
  const rel = String(entry || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const url = `http://${host}:${port}/` + rel.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  let spawnErr = null;
  sendAll('term-start', { id: 'preview', command: `php -S ${host}:${port} -t .`, source: 'preview', cwd: docRoot });
  previewProc = spawn('php', ['-S', `${host}:${port}`, '-t', docRoot], { cwd: docRoot, windowsHide: true });
  previewProc.stdout.on('data', (d) => sendAll('term-data', { id: 'preview', data: d.toString() }));
  previewProc.stderr.on('data', (d) => sendAll('term-data', { id: 'preview', data: d.toString() }));
  previewProc.on('error', (err) => { spawnErr = err; });
  previewProc.on('close', (code) => { sendAll('term-exit', { id: 'preview', code: code ?? -1 }); if (previewProc) previewProc = null; previewInfo = null; });
  for (let i = 0; i < 50; i++) {
    if (spawnErr) {
      if (previewProc) killProc(previewProc);
      previewProc = null;
      throw new Error('Could not start PHP: ' + spawnErr.message + '. Is PHP installed and on your PATH?');
    }
    if (await portOpen(host, port)) { previewInfo = { url, port }; return { url, port }; }
    await sleep(120);
  }
  if (previewProc) killProc(previewProc);
  previewProc = null;
  throw new Error('PHP server did not start. Check the Terminal panel for details.');
});
ipcMain.handle('preview-stop', () => { stopPreview(); return true; });
ipcMain.handle('open-external', async (_e, url) => {
  const u = new URL(String(url));
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) links can be opened.');
  await shell.openExternal(u.href);
  return true;
});

// ---- API keys: held only in the main process, encrypted on disk when the OS allows it ----
const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1';
const keys = {};
const keyFile = () => path.join(app.getPath('userData'), 'keys.json');
async function loadKeys() {
  try {
    const raw = JSON.parse(await fs.readFile(keyFile(), 'utf8'));
    for (const [p, v] of Object.entries(raw)) keys[p] = safeStorage.decryptString(Buffer.from(v, 'base64'));
  } catch { /* no saved keys yet */ }
}
async function saveKeys() {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const out = {};
  for (const [p, k] of Object.entries(keys)) out[p] = safeStorage.encryptString(k).toString('base64');
  await fs.writeFile(keyFile(), JSON.stringify(out), { mode: 0o600 });
  return true;
}
const authHeaders = (provider) => (keys[provider] ? { Authorization: 'Bearer ' + keys[provider] } : {});
// The NVIDIA key is only ever sent to NVIDIA's own endpoint.
const resolveUrl = (provider, baseUrl) => (provider === 'nvidia' ? NVIDIA_URL : String(baseUrl || '')).replace(/\/$/, '');

ipcMain.handle('key-status', (_e, provider) => ({ has: !!keys[provider], secure: safeStorage.isEncryptionAvailable() }));
ipcMain.handle('key-set', async (_e, { provider, key }) => { keys[provider] = String(key).trim(); return { persisted: await saveKeys() }; });
ipcMain.handle('key-clear', async (_e, provider) => { delete keys[provider]; await saveKeys(); return true; });

ipcMain.handle('github-status', async () => ({
  hasToken: !!keys.github,
  login: keys.github_login || null,
  secure: safeStorage.isEncryptionAvailable(),
  remote: await githubRemoteUrl(),
}));
ipcMain.handle('github-connect', async (_e, { token } = {}) => {
  const value = String(token || '').trim();
  if (!value) throw new Error('Paste a personal access token first.');
  let res;
  try {
    res = await net.fetch('https://api.github.com/user', {
      headers: {
        Authorization: 'Bearer ' + value,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Jeilo-ARK',
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error('Could not reach GitHub. Check your internet connection and try again.');
  }
  if (res.status === 401) throw new Error('Invalid or expired token.');
  if (!res.ok) throw new Error('GitHub returned HTTP ' + res.status + '.');
  const user = await res.json();
  keys.github = value;
  keys.github_login = user.login || '';
  const persisted = await saveKeys();
  return { login: user.login || '', persisted, secure: safeStorage.isEncryptionAvailable() };
});
ipcMain.handle('github-disconnect', async () => {
  delete keys.github;
  delete keys.github_login;
  await saveKeys();
  return true;
});
ipcMain.handle('github-set-remote', async (_e, { url } = {}) => {
  if (!root) throw new Error('Open a folder first.');
  const remote = normalizeGithubRemote(url);
  try {
    if (await githubRemoteUrl()) await git(['remote', 'set-url', 'origin', remote]);
    else await git(['remote', 'add', 'origin', remote]);
  } catch (e) { throw gitErr(e); }
  return { remote };
});
ipcMain.handle('github-push', async () => {
  if (!root) throw new Error('Open a folder first.');
  const existing = await githubRemoteUrl();
  if (!existing) throw new Error('Set a GitHub remote first.');
  const remote = normalizeGithubRemote(existing);
  if (remote !== existing) await git(['remote', 'set-url', 'origin', remote]);
  const env = githubAuthEnv();
  try {
    const r = await gitRun(['push', '--set-upstream', 'origin', 'HEAD'], { env });
    return (r.stdout || r.stderr || 'Pushed.').trim();
  } catch (e) { throw githubGitError(e); }
});
ipcMain.handle('github-pull', async () => {
  if (!root) throw new Error('Open a folder first.');
  const existing = await githubRemoteUrl();
  if (!existing) throw new Error('Set a GitHub remote first.');
  const remote = normalizeGithubRemote(existing);
  if (remote !== existing) await git(['remote', 'set-url', 'origin', remote]);
  if ((await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim() === 'HEAD') throw new Error('Check out a branch before pulling.');
  const env = githubAuthEnv();
  try {
    const r = await gitRun(['pull', '--ff-only'], { env });
    return (r.stdout || r.stderr || 'Pulled.').trim();
  } catch (e) { throw githubGitError(e); }
});

// ---- OAuth sign-in: gates the IDE, tokens stay encrypted ----
function oauthClientId() {
  return String(process.env.JEILO_GITHUB_CLIENT_ID || process.env.GITHUB_CLIENT_ID || keys.github_oauth_client || '').trim();
}
function oauthClientSource() {
  if (String(process.env.JEILO_GITHUB_CLIENT_ID || process.env.GITHUB_CLIENT_ID || '').trim()) return 'env';
  return keys.github_oauth_client ? 'stored' : '';
}
function oauthUser() {
  if (!keys.github_oauth) return null;
  return { login: keys.github_oauth_login || '', name: keys.github_oauth_name || '', avatar: keys.github_oauth_avatar || '' };
}
function clearGithubOauth() {
  delete keys.github_oauth;
  delete keys.github_oauth_login;
  delete keys.github_oauth_name;
  delete keys.github_oauth_avatar;
}
function clearGoogleOauth() {
  delete keys.google_access_token;
  delete keys.google_refresh_token;
  delete keys.google_expires_at;
  delete keys.google_sub;
  delete keys.google_email;
  delete keys.google_name;
  delete keys.google_picture;
}
function currentProvider() {
  if (keys.auth_provider === 'github' && keys.github_oauth) return 'github';
  if (keys.auth_provider === 'google' && (keys.google_refresh_token || keys.google_access_token)) return 'google';
  if (keys.github_oauth) return 'github';
  if (keys.google_refresh_token || keys.google_access_token) return 'google';
  return null;
}
function authUser() {
  const provider = currentProvider();
  if (provider === 'github') return oauthUser();
  if (provider === 'google') {
    return {
      login: '',
      email: keys.google_email || '',
      name: keys.google_name || '',
      avatar: keys.google_picture || '',
    };
  }
  return null;
}
async function githubProfile(token) {
  const res = await net.fetch('https://api.github.com/user', {
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Jeilo-ARK',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('GitHub profile request failed (HTTP ' + res.status + ').');
  return res.json();
}
async function storeOauth(token, user) {
  clearGoogleOauth();
  keys.github_oauth = token;
  keys.github_oauth_login = user.login || '';
  keys.github_oauth_name = user.name || '';
  keys.github_oauth_avatar = user.avatar_url || '';
  keys.auth_provider = 'github';
  return saveKeys();
}
function googleClientId() {
  return String(process.env.JEILO_GOOGLE_CLIENT_ID || keys.google_client_id || '').trim();
}
function googleClientSecret() {
  return String(process.env.JEILO_GOOGLE_CLIENT_SECRET || keys.google_client_secret || '').trim();
}
function googleClientSource() {
  if (String(process.env.JEILO_GOOGLE_CLIENT_ID || process.env.JEILO_GOOGLE_CLIENT_SECRET || '').trim()) return 'env';
  return keys.google_client_id ? 'stored' : '';
}
function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeGoogleIdToken(token, clientId) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) throw new Error('Invalid Google ID token.');
  const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  if (payload.aud !== clientId) throw new Error('Google token audience mismatch.');
  if (!/^(https:\/\/accounts\.google\.com|accounts\.google\.com)$/.test(payload.iss || '')) throw new Error('Google token issuer mismatch.');
  if (Number(payload.exp || 0) * 1000 < Date.now()) throw new Error('Google token expired.');
  return payload;
}
function googleProfileFromClaims(p) {
  return { sub: p.sub || '', email: p.email || '', name: p.name || '', picture: p.picture || '' };
}
async function googleTokenRequest(params) {
  let res;
  try {
    res = await net.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error('Could not reach Google. Check your internet connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const err = new Error(data.error_description || data.error || 'Google token request failed (HTTP ' + res.status + ').');
    err.googleError = data.error || '';
    err.status = res.status;
    throw err;
  }
  return data;
}
async function googleUserInfo(accessToken) {
  const res = await net.fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('Google profile request failed (HTTP ' + res.status + ').');
  return res.json();
}
async function refreshGoogleAccess() {
  if (!keys.google_refresh_token) {
    const err = new Error('Google session expired.');
    err.code = 'expired';
    throw err;
  }
  if (!googleClientId() || !googleClientSecret()) {
    const err = new Error('Google OAuth client is not configured.');
    err.code = 'expired';
    throw err;
  }
  const data = await googleTokenRequest({
    client_id: googleClientId(),
    client_secret: googleClientSecret(),
    refresh_token: keys.google_refresh_token,
    grant_type: 'refresh_token',
  });
  keys.google_access_token = data.access_token || '';
  keys.google_expires_at = String(Date.now() + (Number(data.expires_in) || 3600) * 1000);
  if (data.refresh_token) keys.google_refresh_token = data.refresh_token;
  await saveKeys();
  return keys.google_access_token;
}
async function storeGoogle(tokens, profile) {
  clearGithubOauth();
  keys.google_access_token = tokens.access_token || '';
  keys.google_refresh_token = tokens.refresh_token || keys.google_refresh_token || '';
  keys.google_expires_at = String(Date.now() + (Number(tokens.expires_in) || 3600) * 1000);
  keys.google_sub = profile.sub || '';
  keys.google_email = profile.email || '';
  keys.google_name = profile.name || '';
  keys.google_picture = profile.picture || '';
  keys.auth_provider = 'google';
  return saveKeys();
}
async function verifyGithub() {
  if (!keys.github_oauth) return { signedIn: false, provider: null, user: null };
  let user;
  try {
    user = await githubProfile(keys.github_oauth);
  } catch (e) {
    if (/HTTP 401/.test(e.message)) {
      clearGithubOauth();
      delete keys.auth_provider;
      await saveKeys();
      return { signedIn: false, provider: null, user: null, expired: true };
    }
    return { signedIn: true, provider: 'github', user: oauthUser(), offline: true };
  }
  keys.github_oauth_login = user.login || '';
  keys.github_oauth_name = user.name || '';
  keys.github_oauth_avatar = user.avatar_url || '';
  keys.auth_provider = 'github';
  await saveKeys();
  return { signedIn: true, provider: 'github', user: oauthUser() };
}
async function verifyGoogle() {
  try {
    let token = keys.google_access_token;
    if (!token || Number(keys.google_expires_at || 0) < Date.now() + 60000) token = await refreshGoogleAccess();
    let profile;
    try {
      profile = await googleUserInfo(token);
    } catch (e) {
      if (!/HTTP 401/.test(e.message)) throw e;
      token = await refreshGoogleAccess();
      profile = await googleUserInfo(token);
    }
    keys.google_sub = profile.sub || keys.google_sub || '';
    keys.google_email = profile.email || keys.google_email || '';
    keys.google_name = profile.name || keys.google_name || '';
    keys.google_picture = profile.picture || keys.google_picture || '';
    keys.auth_provider = 'google';
    await saveKeys();
    return { signedIn: true, provider: 'google', user: authUser() };
  } catch (e) {
    const code = e.code || e.googleError || '';
    if (code === 'expired' || /invalid_grant|invalid_client|unauthorized_client/i.test(code + ' ' + e.message)) {
      clearGoogleOauth();
      delete keys.auth_provider;
      await saveKeys();
      return { signedIn: false, provider: null, user: null, expired: true };
    }
    return { signedIn: true, provider: 'google', user: authUser(), offline: true };
  }
}
ipcMain.handle('auth-status', () => ({
  signedIn: !!currentProvider(),
  provider: currentProvider(),
  user: authUser(),
  clientIdConfigured: !!oauthClientId(),
  clientIdSource: oauthClientSource(),
  googleClientIdConfigured: !!(googleClientId() && googleClientSecret()),
  googleClientSource: googleClientSource(),
}));
ipcMain.handle('auth-set-client', async (_e, { clientId } = {}) => {
  const value = String(clientId || '').trim();
  if (!value) throw new Error('Paste a GitHub OAuth App client ID first.');
  if (!/^[A-Za-z0-9._-]{10,120}$/.test(value)) throw new Error('That does not look like a GitHub OAuth App client ID.');
  keys.github_oauth_client = value;
  const persisted = await saveKeys();
  return { configured: true, persisted };
});
ipcMain.handle('auth-set-google-client', async (_e, { clientId, clientSecret } = {}) => {
  const id = String(clientId || '').trim();
  const secret = String(clientSecret || '').trim();
  if (!id || !secret) throw new Error('Paste both the Google OAuth client ID and client secret.');
  keys.google_client_id = id;
  keys.google_client_secret = secret;
  const persisted = await saveKeys();
  return { configured: true, persisted };
});
ipcMain.handle('auth-start', async () => {
  const clientId = oauthClientId();
  if (!clientId) throw new Error('Set a GitHub OAuth App client ID first.');
  let res;
  try {
    res = await net.fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Jeilo-ARK' },
      body: new URLSearchParams({ client_id: clientId, scope: 'read:user' }).toString(),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error('Could not reach GitHub. Check your internet connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.device_code) throw new Error(data.error_description || data.error || 'GitHub returned HTTP ' + res.status + ' when starting sign-in.');
  authPending = {
    clientId,
    deviceCode: data.device_code,
    interval: Number(data.interval) || 5,
    expiresAt: Date.now() + (Number(data.expires_in) || 900) * 1000,
  };
  return {
    user_code: data.user_code,
    verification_uri: data.verification_uri || 'https://github.com/login/device',
    expires_in: Number(data.expires_in) || 900,
    interval: Number(data.interval) || 5,
  };
});
ipcMain.handle('auth-poll', async () => {
  if (!authPending) throw new Error('No GitHub sign-in is in progress.');
  if (Date.now() > authPending.expiresAt) { authPending = null; return { status: 'expired' }; }
  let res, data;
  try {
    res = await net.fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Jeilo-ARK' },
      body: new URLSearchParams({
        client_id: authPending.clientId,
        device_code: authPending.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error('Could not reach GitHub while checking sign-in.');
  }
  data = await res.json().catch(() => ({}));
  if (data.access_token) {
    let user = { login: '', name: '', avatar_url: '' };
    try { user = await githubProfile(data.access_token); } catch {}
    authPending = null;
    const persisted = await storeOauth(data.access_token, user);
    return { status: 'ok', provider: 'github', user: oauthUser(), persisted, secure: safeStorage.isEncryptionAvailable() };
  }
  if (data.error === 'authorization_pending') return { status: 'pending' };
  if (data.error === 'slow_down') {
    authPending.interval += 5;
    return { status: 'slow_down', interval: authPending.interval };
  }
  if (data.error === 'expired_token') { authPending = null; return { status: 'expired' }; }
  if (data.error === 'access_denied') { authPending = null; return { status: 'denied' }; }
  throw new Error(data.error_description || data.error || 'GitHub sign-in failed.');
});
ipcMain.handle('auth-cancel', () => { authPending = null; return true; });
ipcMain.handle('auth-google-start', async () => {
  if (googleFlow) throw new Error('A Google sign-in is already in progress.');
  const clientId = googleClientId();
  const clientSecret = googleClientSecret();
  if (!clientId || !clientSecret) throw new Error('Set a Google OAuth client ID and client secret first.');
  const state = crypto.randomBytes(24).toString('hex');
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'select_account consent',
    include_granted_scopes: 'true',
  }).toString();
  const result = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      googleFlow = null;
      server.close();
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Google sign-in timed out.')), 5 * 60 * 1000);
    googleFlow = { cancel: (err) => finish(err || new Error('Google sign-in cancelled.')) };
    server.on('request', async (req, res) => {
      if (settled) { res.writeHead(410); res.end('Sign-in is no longer active.'); return; }
      let u;
      try { u = new URL(req.url || '/', redirectUri); } catch { res.writeHead(400); res.end('Bad request'); return; }
      if (u.pathname !== '/oauth2callback') { res.writeHead(404); res.end('Not found'); return; }
      const send = (status, message) => {
        if (res.writableEnded) return;
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
        res.end(`<!doctype html><meta charset="utf-8"><title>Jeilo ARK</title><body style="font-family:system-ui;padding:32px"><h2>${message}</h2><p>You can close this tab and return to Jeilo ARK.</p></body>`);
      };
      const error = u.searchParams.get('error');
      const code = u.searchParams.get('code');
      const gotState = u.searchParams.get('state');
      if (gotState !== state) { send(400, 'Invalid sign-in response.'); finish(new Error('Invalid Google sign-in response.')); return; }
      if (error) { send(400, 'Google sign-in was cancelled.'); finish(new Error('Google sign-in was cancelled or denied.')); return; }
      if (!code) { send(400, 'Invalid sign-in response.'); finish(new Error('Invalid Google sign-in response.')); return; }
      try {
        const tokens = await googleTokenRequest({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          code_verifier: verifier,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        });
        if (settled) return;
        let profile = null;
        if (tokens.id_token) {
          try {
            const claims = decodeGoogleIdToken(tokens.id_token, clientId);
            profile = googleProfileFromClaims(claims);
          } catch {}
        }
        if (!profile) {
          profile = googleProfileFromClaims(await googleUserInfo(tokens.access_token));
          if (settled) return;
        }
        const persisted = await storeGoogle(tokens, profile);
        send(200, 'Signed in.');
        finish(null, { status: 'ok', provider: 'google', user: authUser(), persisted, secure: safeStorage.isEncryptionAvailable() });
      } catch (e) {
        send(500, 'Sign-in failed.');
        finish(e);
      }
    });
  });
  result.catch(() => {});
  const opened = await shell.openExternal(authUrl.href).then(() => true).catch(() => false);
  if (!opened && googleFlow) googleFlow.cancel(new Error('Could not open the browser for Google sign-in.'));
  return result;
});
ipcMain.handle('auth-google-cancel', () => {
  if (googleFlow) { googleFlow.cancel(); return true; }
  return false;
});
ipcMain.handle('auth-signout', async () => {
  authPending = null;
  if (googleFlow) googleFlow.cancel();
  clearGithubOauth();
  clearGoogleOauth();
  delete keys.auth_provider;
  await saveKeys();
  return true;
});
ipcMain.handle('auth-verify', async () => {
  const provider = currentProvider();
  if (provider === 'github') return verifyGithub();
  if (provider === 'google') return verifyGoogle();
  return { signedIn: false, provider: null, user: null };
});

ipcMain.handle('list-models', async (_e, { baseUrl, provider }) => {
  const cloud = provider === 'nvidia' || provider === 'custom';
  const res = await net.fetch(resolveUrl(provider, baseUrl) + '/models', { headers: authHeaders(provider), signal: AbortSignal.timeout(cloud ? 12000 : 3000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return (await res.json()).data.map((m) => m.id);
});

ipcMain.handle('abort', (_e, id) => { aborts.get(id)?.abort(); });

// Streams tokens to the window as they arrive, returns the finished message.
ipcMain.handle('chat', async (e, { id, baseUrl, provider, model, messages, tools }) => {
  const ctrl = new AbortController();
  aborts.set(id, ctrl);
  let idle = null, idleHit = false;
  const bump = () => { clearTimeout(idle); idle = setTimeout(() => { idleHit = true; ctrl.abort(); }, 120000); };
  bump();
  try {
    let res;
    for (let attempt = 0; ; attempt++) {
      bump();
      res = await net.fetch(resolveUrl(provider, baseUrl) + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(provider) },
        signal: ctrl.signal,
        body: JSON.stringify({ model, messages, ...(tools && tools.length ? { tools } : {}), stream: true }),
      });
      if (res.status === 429 && attempt < 3) { // cloud rate limit: wait and retry
        const wait = Math.min(Number(res.headers.get('retry-after')) || 2 ** (attempt + 1) * 2, 30);
        await new Promise((ok, no) => { const t = setTimeout(ok, wait * 1000); ctrl.signal.addEventListener('abort', () => { clearTimeout(t); no(new Error('Stopped')); }); });
        continue;
      }
      break;
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      const hint = res.status === 401 || res.status === 403 ? ' Your API key was rejected. Click "API key" to update it.'
        : res.status === 404 ? ' Model not found. Check the model name.'
        : res.status === 429 ? ' Rate limit reached. Wait a minute and try again.' : '';
      throw new Error(`Server returned ${res.status}.${hint} ${body}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const msg = { role: 'assistant', content: '', tool_calls: [] };
    let finish = null, reasoned = false;
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      bump();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j;
        try { j = JSON.parse(data); } catch { continue; }
        if (j.error) throw new Error(typeof j.error === 'string' ? j.error : j.error.message || JSON.stringify(j.error));
        const fr = j.choices?.[0]?.finish_reason; if (fr) finish = fr;
        const d = j.choices?.[0]?.delta;
        if (!d) continue;
        const rs = d.reasoning_content ?? d.reasoning;
        if (rs) { reasoned = true; e.sender.send('chunk', { id, reasoning: true }); }
        if (d.content) { msg.content += d.content; e.sender.send('chunk', { id, text: d.content }); }
        for (const tc of d.tool_calls || []) {
          let k = tc.index;
          if (k == null) {
            if (tc.id) {
              const found = msg.tool_calls.findIndex((x) => x.id === tc.id);
              k = found >= 0 ? found : msg.tool_calls.length;
            } else {
              k = msg.tool_calls.length ? msg.tool_calls.length - 1 : 0;
            }
          }
          const t = (msg.tool_calls[k] ??= { id: tc.id || 'call_' + k, type: 'function', function: { name: '', arguments: '' } });
          if (tc.id && !t.id) t.id = tc.id;
          if (tc.function?.name) t.function.name += tc.function.name;
          const a = tc.function?.arguments;
          if (a) t.function.arguments += typeof a === 'string' ? a : JSON.stringify(a);
        }
      }
    }
    if (!msg.tool_calls.length) delete msg.tool_calls;
    msg._finish = finish; msg._reasoned = reasoned;
    return msg;
  } catch (err) {
    if (idleHit) throw new Error('The model server did not send any data for 2 minutes. Check that it is still running, then try again.');
    throw err;
  } finally {
    clearTimeout(idle);
    aborts.delete(id);
  }
});

app.whenReady().then(async () => {
  await loadKeys();
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(path.join(__dirname, 'build', 'icon.png'));
  const win = new BrowserWindow({
    title: 'Jeilo ARK',
    icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    width: 1440, height: 900, backgroundColor: '#ffffff',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'index.html'));
});
app.on('will-quit', () => {
  stopWatch();
  stopPreview();
  stopMcp();
  for (const p of termProcs.values()) killProc(p);
});
app.on('window-all-closed', () => app.quit());
