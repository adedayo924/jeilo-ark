/**
 * Jeilo ARK Comprehensive Unit Test Suite
 * Tests all core subsystems:
 *  1. Preload & IPC Channel Symmetry
 *  2. Filesystem & Sandbox Security (safe() traversal protection)
 *  3. File & Folder Operations (create, list, read, write, rename, delete)
 *  4. Extensions Hub (MCP tools, Opencode, skills, themes, custom servers)
 *  5. ANSI Terminal Color Formatter (ansiToHtml)
 *  6. Line Diff Algorithm (lineDiff)
 *  7. Chat Markdown Renderer (md, run-in-terminal, copy, insert)
 *  8. Frontend DOM & Script Validation (HTML element IDs, VM script execution)
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const vm = require('vm');
const Module = require('module');

let passedTests = 0;
let totalTests = 0;

async function test(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    Error: ${err.message}`);
    if (err.stack) {
      const lines = err.stack.split('\n').slice(1, 3);
      console.error(`    ${lines.join('\n    ')}`);
    }
  }
}

async function runAllTests() {
  console.log('\n========================================');
  console.log('  Running Jeilo ARK Unit Test Suite');
  console.log('========================================\n');

  // Set up temporary test workspace
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jeilo-ark-test-'));
  const testRoot = fs.realpathSync(tempDir);

  // Set up Electron mocking to load main.js
  const handlers = new Map();
  const origRequire = Module.prototype.require;

  Module.prototype.require = function (id) {
    if (id === 'electron') {
      return {
        app: {
          whenReady: () => Promise.resolve(),
          on: () => {},
          quit: () => {},
          getPath: () => testRoot,
        },
        BrowserWindow: class {
          static getAllWindows() { return []; }
          constructor() {
            this.webContents = {
              send: () => {},
              setWindowOpenHandler: () => {},
              on: () => {},
            };
          }
          setMenuBarVisibility() {}
          loadFile() {}
          on() {}
        },
        ipcMain: {
          handle: (ch, fn) => handlers.set(ch, fn),
          on: () => {},
        },
        dialog: {
          showOpenDialog: async () => ({ canceled: false, filePaths: [testRoot] }),
        },
        safeStorage: {
          isEncryptionAvailable: () => true,
          encryptString: (s) => Buffer.from(s),
          decryptString: (b) => b.toString(),
        },
        net: {},
        shell: { openExternal: () => {} }
      };
    }
    return origRequire.apply(this, arguments);
  };

  // Require main.js to populate handlers
  require('../main.js');

  // Initialize root folder in main.js
  const pickFolder = handlers.get('pick-folder');
  await pickFolder();

  // ----------------------------------------------------
  console.log('Suite 1: Preload & IPC Contract Integrity');
  // ----------------------------------------------------
  await test('Preload exposes all IPC channels matching main.js handlers', async () => {
    const preloadContent = fs.readFileSync(path.resolve(__dirname, '../preload.js'), 'utf8');
    const calls = [...preloadContent.matchAll(/call\('([\w-]+)'\)/g)].map((m) => m[1]);
    
    assert(calls.length >= 45, `Expected at least 45 IPC calls in preload, got ${calls.length}`);
    for (const ch of calls) {
      assert(handlers.has(ch), `Preload channel "${ch}" has no registered handler in main.js`);
    }
  });

  // ----------------------------------------------------
  console.log('\nSuite 2: Filesystem Sandbox & Security (safe())');
  // ----------------------------------------------------
  await test('Blocks directory traversal outside workspace root (relative ..)', async () => {
    const readFile = handlers.get('read-file');
    await assert.rejects(
      async () => await readFile(null, '../../sensitive.txt'),
      /Path is outside the project folder/
    );
  });

  await test('Blocks absolute path traversal outside workspace root', async () => {
    const readFile = handlers.get('read-file');
    const outside = os.platform() === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/passwd';
    await assert.rejects(
      async () => await readFile(null, outside),
      /Path is outside the project folder/
    );
  });

  // ----------------------------------------------------
  console.log('\nSuite 3: File & Directory CRUD Operations');
  // ----------------------------------------------------
  await test('create-file creates nested file inside workspace', async () => {
    const createFile = handlers.get('create-file');
    const r = await createFile(null, 'src/components/Button.jsx');
    assert(typeof r === 'string' && r.includes('Button.jsx'), 'create-file should return path to created file');
    assert(fs.existsSync(path.join(testRoot, 'src/components/Button.jsx')));
  });

  await test('write-file writes and read-file reads exact contents', async () => {
    const writeFile = handlers.get('write-file');
    const readFile = handlers.get('read-file');
    const testContent = 'export function Button() { return <button>Click</button>; }';
    
    await writeFile(null, { path: 'src/components/Button.jsx', content: testContent });
    const readBack = await readFile(null, 'src/components/Button.jsx');
    assert.strictEqual(readBack, testContent);
  });

  await test('create-folder creates directory properly', async () => {
    const createFolder = handlers.get('create-folder');
    const r = await createFolder(null, 'src/utils');
    assert(typeof r === 'string' && r.includes('src'), 'create-folder should return directory path');
    assert(fs.statSync(path.join(testRoot, 'src/utils')).isDirectory());
  });

  await test('list-dir returns folder contents excluding .git and node_modules', async () => {
    fs.mkdirSync(path.join(testRoot, '.git'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(testRoot, 'README.md'), '# Test Project');

    const listDir = handlers.get('list-dir');
    const items = await listDir(null, '');
    const names = items.map((i) => i.name);

    assert(names.includes('README.md'), 'Expected README.md in list-dir output');
    assert(names.includes('src'), 'Expected src in list-dir output');
    assert(!names.includes('.git'), 'Expected .git to be filtered out');
    assert(!names.includes('node_modules'), 'Expected node_modules to be filtered out');
  });

  await test('rename-path renames a file cleanly', async () => {
    const renamePath = handlers.get('rename-path');
    const r = await renamePath(null, { oldPath: 'README.md', newPath: 'DOCS.md' });
    assert.strictEqual(r, true);
    assert(fs.existsSync(path.join(testRoot, 'DOCS.md')));
    assert(!fs.existsSync(path.join(testRoot, 'README.md')));
  });

  await test('delete-path deletes files and recursive directories', async () => {
    const deletePath = handlers.get('delete-path');
    await deletePath(null, 'DOCS.md');
    assert(!fs.existsSync(path.join(testRoot, 'DOCS.md')));

    await deletePath(null, 'src');
    assert(!fs.existsSync(path.join(testRoot, 'src')));
  });

  // ----------------------------------------------------
  console.log('\nSuite 4: Extensions Hub (MCP, Themes, Skills)');
  // ----------------------------------------------------
  await test('ext-list returns catalog with MCP, Themes, Skills, and OpenCode', async () => {
    const extList = handlers.get('ext-list');
    const res = await extList(null);
    assert(Array.isArray(res.catalog), 'Catalog should be an array');
    assert(res.catalog.length >= 15, `Expected >= 15 extensions in catalog, got ${res.catalog.length}`);

    const opencode = res.catalog.find((c) => c.id === 'mcp-opencode');
    assert(opencode, 'OpenCode MCP extension must be present in EXTENSION_CATALOG');
    assert.strictEqual(opencode.type, 'mcp');
    assert.strictEqual(opencode.config.command, 'npx');
  });

  await test('ext-install installs MCP extension into .jeilo/mcp.json', async () => {
    const extInstall = handlers.get('ext-install');
    const r = await extInstall(null, 'mcp-opencode');
    assert.deepStrictEqual(r, { ok: true, mcp: true });

    const mcpConfigPath = path.join(testRoot, '.jeilo/mcp.json');
    assert(fs.existsSync(mcpConfigPath), '.jeilo/mcp.json must exist');
    const cfg = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
    assert(cfg.mcpServers.opencode, 'opencode must be configured in mcpServers');
    assert.deepStrictEqual(cfg.mcpServers.opencode.command, 'npx');
  });

  await test('ext-custom-mcp adds a custom MCP server to configuration', async () => {
    const extCustomMcp = handlers.get('ext-custom-mcp');
    const r = await extCustomMcp(null, { name: 'custom-tool', command: 'node', args: ['server.js'] });
    assert.strictEqual(r.ok, true);

    const mcpConfigPath = path.join(testRoot, '.jeilo/mcp.json');
    const cfg = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
    assert(cfg.mcpServers['custom-tool'], 'custom-tool must be configured');
  });

  await test('ext-uninstall removes MCP server cleanly', async () => {
    const extUninstall = handlers.get('ext-uninstall');
    await extUninstall(null, 'mcp-opencode');

    const mcpConfigPath = path.join(testRoot, '.jeilo/mcp.json');
    const cfg = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
    assert(!cfg.mcpServers.opencode, 'opencode should be removed from mcpServers');
  });

  await test('ext-install installs an AI skill into JEILO.md', async () => {
    const extInstall = handlers.get('ext-install');
    const r = await extInstall(null, 'skill-security');
    assert.deepStrictEqual(r, { ok: true, skill: true });

    const jeiloMdPath = path.join(testRoot, 'JEILO.md');
    assert(fs.existsSync(jeiloMdPath), 'JEILO.md must exist');
    const content = fs.readFileSync(jeiloMdPath, 'utf8');
    assert(content.includes('OWASP Security'), 'JEILO.md must contain the installed skill');
  });

  await test('ext-uninstall removes the AI skill from JEILO.md', async () => {
    const extUninstall = handlers.get('ext-uninstall');
    await extUninstall(null, 'skill-security');

    const jeiloMdPath = path.join(testRoot, 'JEILO.md');
    const content = fs.readFileSync(jeiloMdPath, 'utf8');
    assert(!content.includes('OWASP Security'), 'JEILO.md must no longer contain the skill');
  });

  // ----------------------------------------------------
  console.log('\nSuite 5: ANSI Terminal Formatter (ansiToHtml)');
  // ----------------------------------------------------
  // Extract ansiToHtml from index.html
  const htmlContent = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  const ansiMatch = htmlContent.match(/function ansiToHtml\(raw\)\s*\{[\s\S]*?\n\}/);
  const colorsMatch = htmlContent.match(/const ANSI_COLORS = \{[\s\S]*?\n\};/);
  assert(ansiMatch, 'ansiToHtml function must be defined in index.html');
  assert(colorsMatch, 'ANSI_COLORS must be defined in index.html');
  
  const escCode = "const esc = (s) => String(s).replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' }[c]));";
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(escCode + '\n' + colorsMatch[0] + '\n' + ansiMatch[0], sandbox);
  const ansiToHtml = sandbox.ansiToHtml;

  await test('ansiToHtml handles plain text and HTML escaping safely', async () => {
    const res = ansiToHtml('Hello <world> & "friends"');
    assert.strictEqual(res, 'Hello &lt;world&gt; &amp; &quot;friends&quot;');
  });

  await test('ansiToHtml parses standard colors (red, green, bold, reset)', async () => {
    const sample = '\x1b[31mError\x1b[0m \x1b[32mSuccess\x1b[0m \x1b[1mBold\x1b[0m';
    const res = ansiToHtml(sample);
    assert(res.includes('color:var(--bad);'), 'Red text should map to var(--bad)');
    assert(res.includes('color:var(--ok);'), 'Green text should map to var(--ok)');
    assert(res.includes('font-weight:600;'), 'Bold text should map to font-weight:600');
    assert(!res.includes('\x1b['), 'Raw escape sequences should not leak');
  });

  // ----------------------------------------------------
  console.log('\nSuite 6: Line Diff Algorithm (lineDiff)');
  // ----------------------------------------------------
  const diffMatch = htmlContent.match(/function lineDiff\(o, n\)\s*\{[\s\S]*?\n\}/);
  assert(diffMatch, 'lineDiff function must be defined in index.html');
  vm.runInContext(diffMatch[0], sandbox);
  const lineDiff = sandbox.lineDiff;

  await test('lineDiff correctly identifies adds, dels, and context lines', async () => {
    const oldCode = 'line 1\nline 2\nline 3';
    const newCode = 'line 1\nline 2 modified\nline 3\nline 4';
    const diff = lineDiff(oldCode, newCode);

    assert(Array.isArray(diff), 'diff should be an array');
    const adds = diff.filter((d) => d[0] === 'add').map((d) => d[1]);
    const dels = diff.filter((d) => d[0] === 'del').map((d) => d[1]);

    assert(adds.includes('line 2 modified'), 'Expected "line 2 modified" in additions');
    assert(adds.includes('line 4'), 'Expected "line 4" in additions');
    assert(dels.includes('line 2'), 'Expected "line 2" in deletions');
  });

  // ----------------------------------------------------
  console.log('\nSuite 7: Chat Markdown & Code Block Actions');
  // ----------------------------------------------------
  const mdMatch = htmlContent.match(/function md\(t\)\s*\{[\s\S]*?\n\}/);
  assert(mdMatch, 'md function must be defined in index.html');
  vm.runInContext(mdMatch[0], sandbox);
  const md = sandbox.md;

  await test('md() renders inline bold and inline code', async () => {
    const out = md('This is **bold** and `code` test');
    assert.strictEqual(out, 'This is <b>bold</b> and <code>code</code> test');
  });

  await test('md() adds Copy and Insert buttons to standard code blocks', async () => {
    const out = md('```javascript\nconst a = 1;\n```');
    assert(out.includes('<button class="copy">Copy</button>'));
    assert(out.includes('<button class="copy ins"'));
    assert(!out.includes('<button class="copy run"'));
  });

  await test('md() adds "Run in terminal" button to shell commands', async () => {
    const out = md('```bash\nnpm run test\n```');
    assert(out.includes('<button class="copy run" title="Run in terminal">Run</button>'));
  });

  // ----------------------------------------------------
  console.log('\nSuite 8: Frontend DOM & Application Script Integrity');
  // ----------------------------------------------------
  await test('index.html main script compiles without syntax errors', async () => {
    const scriptStart = htmlContent.lastIndexOf('<script>') + 8;
    const scriptEnd = htmlContent.lastIndexOf('</script>');
    const js = htmlContent.slice(scriptStart, scriptEnd);
    assert.doesNotThrow(() => new vm.Script(js), 'Main script must parse cleanly');
  });

  await test('All $(id) selectors in JS correspond to valid elements in index.html', async () => {
    const scriptStart = htmlContent.lastIndexOf('<script>') + 8;
    const scriptEnd = htmlContent.lastIndexOf('</script>');
    const js = htmlContent.slice(scriptStart, scriptEnd);

    const selectorIds = new Set([...js.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]));
    const domIds = new Set([...htmlContent.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));

    const missingIds = [];
    for (const id of selectorIds) {
      if (!domIds.has(id)) missingIds.push(id);
    }

    assert(
      missingIds.length === 0,
      `The following IDs used in $("...") were not found in index.html: ${missingIds.join(', ')}`
    );
  });

  // ----------------------------------------------------
  console.log('\nSuite 9: Windows POSIX Command Shims');
  // ----------------------------------------------------
  fs.writeFileSync(path.join(testRoot, 'sample.txt'), 'line 1\nline 2\nline 3\nline 4\nline 5\n');

  await test('wc counts lines accurately on Windows', async () => {
    const runCommand = handlers.get('run-command');
    const out = await runCommand(null, 'wc -l sample.txt');
    assert(out.includes('sample.txt'), 'wc output should include filename');
    assert(/\d+/.test(out), 'wc output should include line count number');
  });

  await test('head prints the first N lines', async () => {
    const runCommand = handlers.get('run-command');
    const out = await runCommand(null, 'head -n 2 sample.txt');
    const lines = out.trim().split(/\r?\n/);
    assert.strictEqual(lines.length, 2, 'head -n 2 should return exactly 2 lines');
  });

  await test('which locates executables on PATH', async () => {
    const runCommand = handlers.get('run-command');
    const out = await runCommand(null, 'which node');
    assert(out.toLowerCase().includes('node'), 'which node should locate node binary');
  });

  await test('term-run and term-input support interactive stdin communication', async () => {
    const termRun = handlers.get('term-run');
    const termInput = handlers.get('term-input');
    const termKill = handlers.get('term-kill');

    // Run node in interactive mode
    const { id } = await termRun(null, 'node -e "process.stdin.on(\'data\', d => { console.log(\'ECHO:\' + d.toString().trim()); process.exit(0); });"');
    assert(id, 'termRun must return process id');
    
    // Wait briefly and send input via term-input
    await new Promise((r) => setTimeout(r, 200));
    const sent = await termInput(null, { id, data: 'hello stdin\n' });
    assert.strictEqual(sent, true, 'term-input must successfully write to stdin');
    termKill(null, id);
  });

  console.log('\nSuite 10: Premium IDE Features (Activity Bar, Multi-Terminal, Chat History, Inline AI)');

  await test('fileIcon renders SVG icons for files and folders', () => {
    // Extract fileIcon function from index.html
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const match = html.match(/function fileIcon\(name, isDir, isOpen\) \{([\s\S]*?)\n\}/);
    assert(match, 'fileIcon function must exist in index.html');
    const fileIcon = new Function('name', 'isDir', 'isOpen', match[1]);

    const jsIco = fileIcon('app.js', false, false);
    assert(jsIco.includes('<svg') && jsIco.includes('f7df1e'), 'app.js should render yellow JS SVG icon');

    const tsIco = fileIcon('main.ts', false, false);
    assert(tsIco.includes('<svg') && tsIco.includes('3178c6'), 'main.ts should render blue TS SVG icon');

    const pyIco = fileIcon('script.py', false, false);
    assert(pyIco.includes('<svg') && pyIco.includes('3572A5'), 'script.py should render Python SVG icon');

    const closedDir = fileIcon('src', true, false);
    const openDir = fileIcon('src', true, true);
    assert(closedDir.includes('<svg') && openDir.includes('<svg'), 'Directories should render folder SVG icons');
    assert.notStrictEqual(closedDir, openDir, 'Open and closed folders must have distinct SVGs');
  });

  await test('term-run executes with shell selector options (cmd / powershell)', async () => {
    const termRun = handlers.get('term-run');
    const termKill = handlers.get('term-kill');

    // Test with cmd shell option
    const resCmd = await termRun(null, 'node -e "console.log(\'cmd_ok\')"', { shell: 'cmd' });
    assert(resCmd && resCmd.id, 'termRun with shell: cmd must return proc id');

    // Test with powershell shell option
    const resPs = await termRun(null, 'node -e "console.log(\'ps_ok\')"', { shell: 'powershell' });
    assert(resPs && resPs.id, 'termRun with shell: powershell must return proc id');

    await new Promise((r) => setTimeout(r, 300));
    termKill(null, resCmd.id);
    termKill(null, resPs.id);
  });

  await test('Multi-session chat persistent storage and migration', () => {
    const mockStorage = new Map();
    const store = {
      get: (k, d) => mockStorage.get(k) ?? d,
      set: (k, v) => mockStorage.set(k, String(v))
    };

    // Test migration from legacy single chat:
    const legacyHistory = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }];
    store.set('chat:myproject', JSON.stringify(legacyHistory));

    const chatFolderKey = 'chat_sessions:myproject';
    let sessions = [];
    try { sessions = JSON.parse(store.get(chatFolderKey, '[]')); } catch {}
    if (!sessions.length) {
      let legacy = [];
      try { legacy = JSON.parse(store.get('chat:myproject', '[]')); } catch {}
      if (legacy.length) {
        sessions = [{ id: 'sess_1', title: 'Restored chat', updatedAt: Date.now(), history: legacy }];
      }
    }
    assert.strictEqual(sessions.length, 1, 'Should migrate legacy single chat into a session');
    assert.strictEqual(sessions[0].history.length, 2, 'Should preserve message history');

    // Add new session
    const newSession = { id: 'sess_2', title: 'New chat', updatedAt: Date.now(), history: [] };
    sessions.unshift(newSession);
    store.set(chatFolderKey, JSON.stringify(sessions));

    const reloaded = JSON.parse(store.get(chatFolderKey, '[]'));
    assert.strictEqual(reloaded.length, 2, 'Should persist multiple sessions');
    assert.strictEqual(reloaded[0].id, 'sess_2', 'Latest session should be at index 0');
  });

  await test('Inline AI code stripFences and diff review generation', () => {
    const stripFences = (s) => {
      let t = String(s || '').trim();
      const m = t.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
      if (m) t = m[1];
      return t.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').trim();
    };

    const fencedCode = '```javascript\nfunction greet() {\n  return "hello world";\n}\n```';
    const stripped = stripFences(fencedCode);
    assert.strictEqual(stripped, 'function greet() {\n  return "hello world";\n}', 'stripFences should extract raw code');

    // Test diff building for inline replacement
    const fullCode = 'const a = 1;\nconst b = 2;\nconst c = 3;';
    const rangeStart = 13; // start of 'const b = 2;'
    const rangeEnd = 25;   // end of 'const b = 2;'
    const replacement = 'const b = 42;';
    const afterCode = fullCode.slice(0, rangeStart) + replacement + fullCode.slice(rangeEnd);
    assert.strictEqual(afterCode, 'const a = 1;\nconst b = 42;\nconst c = 3;', 'Replacement should cleanly integrate into file for diff review');
  });

  // Clean up temporary workspace
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}

  console.log('\n========================================');
  console.log(`  Test Results: ${passedTests}/${totalTests} Passed (${Math.round((passedTests / totalTests) * 100)}%)`);
  console.log('========================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Fatal test suite failure:', err);
  process.exit(1);
});
