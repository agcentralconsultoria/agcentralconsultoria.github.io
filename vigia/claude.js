// Chama o Claude Code (CLI) do próprio Mac, pela assinatura do Ângelo, sem ferramentas
// (só texto entra, só texto sai). Usado SÓ no engajamento.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE = path.join(os.homedir(), '.local', 'bin', 'claude');
const PASTA_VAZIA = path.join(os.homedir(), '.agcentral', 'claude-vazio'); // não carrega o CLAUDE.md do projeto

function perguntar(prompt, { modelo = 'sonnet', esforco = 'medium', timeoutMs = 180000 } = {}) {
  fs.mkdirSync(PASTA_VAZIA, { recursive: true });
  return new Promise((resolve, reject) => {
    const args = ['-p', '--model', modelo, '--effort', esforco, '--output-format', 'json', '--max-turns', '1',
      '--tools', '', '--no-session-persistence', '--disable-slash-commands'];
    const proc = spawn(CLAUDE, args, { cwd: PASTA_VAZIA, env: Object.assign({}, process.env, { HOME: os.homedir() }) });
    let out = ''; let err = '';
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('Claude demorou demais')); }, timeoutMs);
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('Claude saiu com erro ' + code + ': ' + (err || out).slice(0, 200)));
      try {
        const j = JSON.parse(out);
        if (j.is_error) return reject(new Error('Claude: ' + String(j.result).slice(0, 200)));
        resolve(String(j.result || ''));
      } catch (e) { reject(new Error('Resposta do Claude ilegível: ' + out.slice(0, 120))); }
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

module.exports = { perguntar };
