// Leitura do WhatsApp Web (SOMENTE LEITURA: nunca digita nem envia mensagem). Usa o Google
// Chrome do próprio vigia, já logado (login-whatsapp.js, QR code uma vez só).
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

async function abrirWhatsApp() {
  const ctx = await chromium.launchPersistentContext(path.join(os.homedir(), '.agcentral', 'whatsapp-profile'), {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1280, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  page.setDefaultTimeout(30000);
  return { ctx, page };
}

const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const DIAS = { domingo: 0, segunda: 1, terca: 2, terça: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6, sábado: 6 };

// Separador de dia do WhatsApp ("HOJE", "ONTEM", "SEXTA-FEIRA", "21/07/2026") -> 'YYYY-MM-DD'
function separadorParaISO(txt, hoje) {
  const t = txt.trim().toLowerCase();
  let m = t.match(/^(\d{1,2})\/(\d{2})\/(\d{4})$/);
  if (m) return m[3] + '-' + m[2] + '-' + String(m[1]).padStart(2, '0');
  const base = new Date(hoje + 'T00:00:00');
  if (t === 'hoje') return iso(base);
  if (t === 'ontem') { base.setDate(base.getDate() - 1); return iso(base); }
  const nome = t.replace(/-feira$/, '');
  if (nome in DIAS) { // dia da semana dentro dos últimos 7 dias
    for (let i = 2; i <= 7; i++) { const d = new Date(hoje + 'T00:00:00'); d.setDate(d.getDate() - i); if (d.getDay() === DIAS[nome]) return iso(d); }
  }
  return null;
}

// Lê a conversa com um telefone (só dígitos, com 55) e devolve as mensagens de [desdeISO, ateISO].
// { status:'ok'|'sem_conversa', mensagens:[{ data, hora, dir:'paciente'|'coach', tipo:'texto'|'audio'|'midia', texto, seg }] }
async function lerConversa(page, telefone, desdeISO, ateISO, hojeISO) {
  await page.goto('https://web.whatsapp.com/send?phone=' + telefone);
  // espera abrir a conversa OU aparecer aviso de número inválido
  const abriu = await Promise.race([
    page.waitForSelector('#main', { timeout: 45000 }).then(() => 'main').catch(() => null),
    page.waitForSelector('[data-animate-modal-popup="true"], div[role="dialog"]', { timeout: 45000 }).then(() => 'dialogo').catch(() => null),
  ]);
  if (abriu !== 'main') {
    const aviso = await page.evaluate(() => (document.querySelector('[data-animate-modal-popup="true"], div[role="dialog"]') || {}).innerText || '');
    if (/inv[aá]lid|not on whatsapp|n[aã]o est[aá]|invalid/i.test(aviso) || !abriu) return { status: 'sem_conversa', mensagens: [] };
  }
  // Ao abrir a conversa o WhatsApp marca tudo como lido; o aviso "N mensagens não lidas" fica no
  // painel enquanto a conversa está aberta. Guardamos isso pra devolver "não lida" no fim.
  const antes = await page.evaluate(() => {
    const painel = document.querySelector('[data-testid="conversation-panel-messages"]') || document.querySelector('#main');
    const tem = !!painel && /\b\d+\s+(mensagens?\s+n[aã]o\s+lidas?|unread\s+messages?)/i.test(painel.innerText);
    const tit = document.querySelector('[data-testid="conversation-info-header-chat-title"]');
    return { naoLidas: tem, titulo: tit ? tit.innerText.trim() : '' };
  });
  await page.waitForTimeout(3500);

  // carrega mensagens antigas rolando pra cima até passar do início da janela
  const painelSel = '[data-testid="conversation-panel-messages"]';
  let ultimoTotal = -1;
  for (let i = 0; i < 25; i++) {
    const info = await page.evaluate((sel) => {
      const painel = document.querySelector(sel);
      if (!painel) return { total: 0, primeiraData: null };
      let rolavel = painel;
      for (let e = painel; e; e = e.parentElement) { if (e.scrollHeight > e.clientHeight + 20 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)) { rolavel = e; break; } }
      const datas = [...painel.querySelectorAll('span')].filter((s) => s.children.length === 0 && /^\d{2}\/\d{2}\/\d{4}$/.test(s.innerText.trim())).map((s) => s.innerText.trim());
      const pre = [...painel.querySelectorAll('[data-pre-plain-text]')].map((e) => (e.getAttribute('data-pre-plain-text').match(/(\d{2}\/\d{2}\/\d{4})/) || [])[1]).filter(Boolean);
      const todas = datas.concat(pre).map((d) => d.split('/').reverse().join('-')).sort();
      rolavel.scrollTop = 0;
      return { total: painel.querySelectorAll('[role="row"]').length, primeiraData: todas[0] || null };
    }, painelSel);
    if (info.primeiraData && info.primeiraData <= desdeISO) break; // já carregou até antes da janela
    if (info.total === ultimoTotal) break;                         // não veio mais nada (começo da conversa)
    ultimoTotal = info.total;
    await page.waitForTimeout(1500);
  }

  const itens = await page.evaluate((sel) => {
    const painel = document.querySelector(sel);
    if (!painel) return [];
    const pr = painel.getBoundingClientRect();
    const dataLeaf = (e) => e.tagName === 'SPAN' && e.children.length === 0 && /^(HOJE|ONTEM|\d{1,2}\/\d{2}\/\d{4}|(SEGUNDA|TERÇA|TERCA|QUARTA|QUINTA|SEXTA|SÁBADO|SABADO|DOMINGO)(-FEIRA)?)$/i.test(e.innerText.trim());
    const nodes = [...painel.querySelectorAll('div[role="row"], span')].filter((e) => e.getAttribute('role') === 'row' || dataLeaf(e));
    return nodes.map((e) => {
      if (e.getAttribute('role') !== 'row') return { k: 'sep', txt: e.innerText.trim() };
      const pre = e.querySelector('[data-pre-plain-text]');
      const meta = e.querySelector('[data-testid="msg-meta"]');
      const cont = e.querySelector('[data-testid="msg-container"]') || e;
      const cr = cont.getBoundingClientRect();
      const aria = [...e.querySelectorAll('[aria-label]')].map((x) => x.getAttribute('aria-label')).join('|');
      const icones = [...e.querySelectorAll('[data-icon]')].map((x) => x.getAttribute('data-icon')).join('|');
      const txtEl = e.querySelector('[data-testid="selectable-text"]');
      const textoTodo = e.innerText.replace(/\s+/g, ' ').trim();
      const sistema = !!e.querySelector('[data-testid="msg-notification-container"], [data-testid="system_message"]');
      const preTxt = pre ? pre.getAttribute('data-pre-plain-text') : '';
      const m1 = preTxt.match(/\[(\d{1,2}:\d{2}), (\d{2}\/\d{2}\/\d{4})\]/);
      const m2 = (meta ? meta.innerText : '').match(/(\d{1,2}:\d{2})/);
      const dur = textoTodo.match(/\b(\d{1,2}):(\d{2})\b/);
      return {
        k: 'msg', sistema,
        saida: /^\s*Você/i.test(aria) || /^You/i.test(aria) || ((cr.left + cr.right) / 2 > (pr.left + pr.right) / 2),
        data: m1 ? m1[2] : null, hora: m1 ? m1[1] : (m2 ? m2[1] : null),
        texto: txtEl ? txtEl.innerText.trim() : '',
        audio: /voz|[aá]udio|voice|ptt|audio-play|audio-pause/i.test(aria + '|' + icones),
        midia: /document|image|video|sticker|gif|media/i.test(icones) || !!e.querySelector('[data-testid="sticker-container"], img[src^="blob:"]'),
        duracao: dur ? Number(dur[1]) * 60 + Number(dur[2]) : null,
      };
    });
  }, painelSel);

  // monta a linha do tempo com data de cada mensagem (texto traz a data; o resto herda o separador)
  const mensagens = [];
  let diaAtual = null;
  itens.forEach((it) => {
    if (it.k === 'sep') { const d = separadorParaISO(it.txt, hojeISO); if (d) diaAtual = d; return; }
    if (it.sistema) return;
    let dia = it.data ? it.data.split('/').reverse().join('-') : diaAtual;
    if (it.data) diaAtual = dia;
    if (!dia || !it.hora) return;
    if (dia < desdeISO || dia > ateISO) return;
    const tipo = it.audio ? 'audio' : (it.texto ? 'texto' : (it.midia ? 'midia' : 'texto'));
    if (tipo === 'texto' && !it.texto) return;
    mensagens.push({ data: dia, hora: it.hora, dir: it.saida ? 'coach' : 'paciente', tipo, texto: tipo === 'texto' ? it.texto.slice(0, 500) : '', seg: tipo === 'audio' ? it.duracao : null });
  });
  return { status: 'ok', mensagens, naoLidas: antes.naoLidas, titulo: antes.titulo };
}

// Devolve a conversa pra "não lida" (a bolinha verde de notificação do Ângelo). Sai da conversa
// (volta pra lista), acha o contato pelo nome e usa o menu "Marcar como não lida".
async function marcarComoNaoLida(page, titulo) {
  if (!titulo) throw new Error('sem o nome do contato');
  await page.goto('https://web.whatsapp.com/');
  await page.waitForSelector('#pane-side', { timeout: 30000 });
  await page.waitForTimeout(2000);
  const contato = page.locator('#pane-side').getByTitle(titulo, { exact: true }).first();
  if (!(await contato.count())) throw new Error('contato não apareceu na lista de conversas');
  await contato.click({ button: 'right' });
  await page.waitForTimeout(600);
  const item = page.getByText(/^(Marcar como n[aã]o lida|Mark as unread)$/i).first();
  if (!(await item.count())) { await page.keyboard.press('Escape'); throw new Error('opção "Marcar como não lida" não apareceu'); }
  await item.click();
  await page.waitForTimeout(800);
}

module.exports = { abrirWhatsApp, lerConversa, marcarComoNaoLida };
