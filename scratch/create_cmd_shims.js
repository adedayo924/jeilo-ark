const fs = require('fs');
const path = require('path');
const shims = ['wc', 'head', 'tail', 'grep', 'touch', 'which', 'cat', 'ls', 'pwd', 'clear', 'rm', 'cp', 'mv'];
const dir = path.resolve('shims');
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

for (const s of shims) {
  const content = `@node "%~dp0\\shim.js" ${s} %*\r\n`;
  fs.writeFileSync(path.join(dir, s + '.cmd'), content, 'utf8');
}
console.log('Successfully created shims:', shims.join(', '));

