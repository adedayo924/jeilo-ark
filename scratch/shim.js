const fs = require('fs');
const path = require('path');

const [,, cmd, ...args] = process.argv;

function readInput(files, cb) {
  if (!files || files.length === 0) {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => buf += chunk);
    process.stdin.on('end', () => cb(null, [{ name: '', content: buf }]));
    process.stdin.on('error', err => cb(err));
  } else {
    const list = [];
    for (const f of files) {
      try {
        const full = path.resolve(f);
        const content = fs.readFileSync(full, 'utf8');
        list.push({ name: f, content });
      } catch (err) {
        process.stderr.write(`${cmd}: ${f}: No such file or directory\n`);
      }
    }
    cb(null, list);
  }
}

switch (cmd) {
  case 'wc': {
    let countLines = false, countWords = false, countBytes = false;
    const files = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-l') countLines = true;
      else if (a === '-w') countWords = true;
      else if (a === '-c' || a === '-m') countBytes = true;
      else if (a.startsWith('-') && !a.startsWith('--')) {
        if (a.includes('l')) countLines = true;
        if (a.includes('w')) countWords = true;
        if (a.includes('c') || a.includes('m')) countBytes = true;
      } else if (!a.startsWith('-')) {
        files.push(a);
      }
    }
    if (!countLines && !countWords && !countBytes) {
      countLines = countWords = countBytes = true;
    }

    readInput(files, (err, inputs) => {
      if (err) return;
      let totalL = 0, totalW = 0, totalB = 0;
      for (const item of inputs) {
        const lines = item.content === '' ? 0 : item.content.split(/\r?\n/).length - (item.content.endsWith('\n') ? 1 : 0);
        const words = (item.content.trim().match(/\S+/g) || []).length;
        const bytes = Buffer.byteLength(item.content, 'utf8');
        totalL += lines; totalW += words; totalB += bytes;

        const parts = [];
        if (countLines) parts.push(String(lines).padStart(8));
        if (countWords) parts.push(String(words).padStart(8));
        if (countBytes) parts.push(String(bytes).padStart(8));
        if (item.name) parts.push(' ' + item.name);
        process.stdout.write(parts.join('') + '\n');
      }
      if (inputs.length > 1) {
        const parts = [];
        if (countLines) parts.push(String(totalL).padStart(8));
        if (countWords) parts.push(String(totalW).padStart(8));
        if (countBytes) parts.push(String(totalB).padStart(8));
        parts.push(' total');
        process.stdout.write(parts.join('') + '\n');
      }
    });
    break;
  }

  case 'head': {
    let count = 10;
    const files = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-n' && i + 1 < args.length) {
        count = parseInt(args[++i], 10) || 10;
      } else if (/^-\d+$/.test(a)) {
        count = parseInt(a.slice(1), 10) || 10;
      } else if (!a.startsWith('-')) {
        files.push(a);
      }
    }

    readInput(files, (err, inputs) => {
      if (err) return;
      inputs.forEach((item, idx) => {
        if (inputs.length > 1) process.stdout.write(`==> ${item.name} <==\n`);
        const lines = item.content.split(/\r?\n/);
        process.stdout.write(lines.slice(0, count).join('\n') + '\n');
      });
    });
    break;
  }

  case 'tail': {
    let count = 10;
    const files = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-n' && i + 1 < args.length) {
        count = parseInt(args[++i], 10) || 10;
      } else if (/^-\d+$/.test(a)) {
        count = parseInt(a.slice(1), 10) || 10;
      } else if (!a.startsWith('-')) {
        files.push(a);
      }
    }

    readInput(files, (err, inputs) => {
      if (err) return;
      inputs.forEach((item, idx) => {
        if (inputs.length > 1) process.stdout.write(`==> ${item.name} <==\n`);
        const lines = item.content.split(/\r?\n/);
        const start = Math.max(0, lines.length - count);
        process.stdout.write(lines.slice(start).join('\n') + '\n');
      });
    });
    break;
  }

  case 'touch': {
    for (const f of args) {
      if (f.startsWith('-')) continue;
      try {
        const full = path.resolve(f);
        if (!fs.existsSync(full)) {
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, '');
        } else {
          const now = new Date();
          fs.utimesSync(full, now, now);
        }
      } catch (e) {
        process.stderr.write(`touch: ${f}: ${e.message}\n`);
      }
    }
    break;
  }

  case 'which': {
    const pathext = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';');
    const pathDirs = (process.env.PATH || '').split(path.delimiter);
    for (const target of args) {
      let found = false;
      for (const dir of pathDirs) {
        const base = path.join(dir, target);
        if (fs.existsSync(base) && !fs.statSync(base).isDirectory()) {
          console.log(base); found = true; break;
        }
        for (const ext of pathext) {
          const candidate = base + ext;
          if (fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory()) {
            console.log(candidate); found = true; break;
          }
        }
        if (found) break;
      }
      if (!found) {
        process.stderr.write(`${target} not found\n`);
        process.exitCode = 1;
      }
    }
    break;
  }

  case 'grep': {
    let ignoreCase = false, lineNums = false, invert = false;
    let pattern = null;
    const files = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-i') ignoreCase = true;
      else if (a === '-n') lineNums = true;
      else if (a === '-v') invert = true;
      else if (a.startsWith('-') && !a.startsWith('--')) {
        if (a.includes('i')) ignoreCase = true;
        if (a.includes('n')) lineNums = true;
        if (a.includes('v')) invert = true;
      } else if (pattern === null) {
        pattern = a;
      } else {
        files.push(a);
      }
    }
    if (!pattern) process.exit(0);
    const regex = new RegExp(pattern, ignoreCase ? 'i' : '');
    readInput(files, (err, inputs) => {
      if (err) return;
      for (const item of inputs) {
        const lines = item.content.split(/\r?\n/);
        for (let idx = 0; idx < lines.length; idx++) {
          const l = lines[idx];
          const matched = regex.test(l);
          if ((matched && !invert) || (!matched && invert)) {
            const prefix = (inputs.length > 1 ? item.name + ':' : '') + (lineNums ? (idx + 1) + ':' : '');
            process.stdout.write(prefix + l + '\n');
          }
        }
      }
    });
    break;
  }
}

