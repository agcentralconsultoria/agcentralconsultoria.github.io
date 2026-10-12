// Chama o Claude Code (CLI) do próprio Mac, pela assinatura do Ângelo, sem ferramentas
// (só texto entra, só texto sai). Usado SÓ no engajamento.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE = path.join(os.homedir(), '.local', 'bin', 'claude');
const PASTA_VAZIA = path.join(os.homedir(), '.agcentral', 'claude-vazio'); // não carrega o CLAUDE.md do projeto

// Estado do login (o CRM mostra "Claude conectado / desconectado"). Nao gasta token:
// "claude auth status" so le o login salvo no Mac. Como um login VENCIDO ainda aparece como salvo,
// qualquer chamada real que falhe por login marca "desconectado" ate um login novo ou uma chamada que funcione.
const MSG_LOGIN = 'O login do Claude no Mac expirou. Abra o Terminal, rode "claude" e digite /login.';
let falhouLogin = false;
let salvo = null; // true / false / null (ainda nao verificado)
function estado() {
  if (falhouLogin) return 'desconectado';
  if (salvo === null) return 'desconhecido';
  return salvo ? 'conectado' : 'desconectado';
}
function verificar() {
  return new Promise((resolve) => {
    execFile(CLAUDE, ['auth', 'status'], { timeout: 15000, env: Object.assign({}, process.env, { HOME: os.homedir() }) }, (e, out) => {
      try { salvo = !!JSON.parse(out).loggedIn; } catch (x) { salvo = e ? null : false; }
      resolve(estado());
    });
  });
}
// Teste real e minusculo (so antes do engajamento): confirma que o Claude responde de verdade.
async function testar() {
  await perguntar('Responda apenas: ok', { timeoutMs: 60000 });
}
// Login pelo navegador (o proprio Claude abre a pagina; o Angelo so autoriza).
function entrar(timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE, ['auth', 'login', '--claudeai'], { cwd: PASTA_VAZIA, env: Object.assign({}, process.env, { HOME: os.homedir() }) });
    let saida = '';
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('O login não foi concluído a tempo. Clique em Conectar de novo.')); }, timeoutMs);
    proc.stdout.on('data', (d) => { saida += d; });
    proc.stderr.on('data', (d) => { saida += d; });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', async (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('O login não foi concluído. Clique em Conectar de novo.'));
      falhouLogin = false;
      await verificar();
      resolve(estado());
    });
    proc.stdin.end();
  });
}

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
      if (/OAuth session expired|Failed to authenticate|not logged in|\/login/i.test(out + err)) {
        falhouLogin = true;
        return reject(new Error(MSG_LOGIN));
      }
      if (code !== 0) return reject(new Error('Claude saiu com erro ' + code + ': ' + (err || out).slice(0, 200)));
      try {
        const j = JSON.parse(out);
        if (j.is_error) return reject(new Error('Claude: ' + String(j.result).slice(0, 200)));
        falhouLogin = false;
        resolve(String(j.result || ''));
      } catch (e) { reject(new Error('Resposta do Claude ilegível: ' + out.slice(0, 120))); }
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

module.exports = { perguntar, estado, verificar, testar, entrar };
