const { spawn } = require('child_process');

const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
  stdio: ['pipe', 'pipe', 'pipe']
});

let out = '';
ps.stdout.on('data', d => out += d);
ps.stderr.on('data', d => console.error('stderr:', d.toString()));
ps.on('close', code => {
  console.log('Exited code:', code);
  console.log('Captured output:\n' + out);
});

ps.stdin.write(`
function head { param([Parameter(ValueFromPipeline=$true)]$In) process { $In | Select-Object -First 2 } }
"a\`nb\`nc\`nd" | head
`);
ps.stdin.end();

