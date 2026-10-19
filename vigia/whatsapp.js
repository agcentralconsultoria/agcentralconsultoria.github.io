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
  return lerConversaAberta(page, desdeISO, ateISO, hojeISO);
}

// Lê a conversa que já está aberta na tela (mesma leitura de sempre).
async function lerConversaAberta(page, desdeISO, ateISO, hojeISO) {
  // Ao abrir a conversa o WhatsApp marca tudo como lido; o aviso "N mensagens não lidas" fica no
  // painel enquanto a conversa está aberta. Guardamos isso pra devolver "não lida" no fim.
  const verAviso = () => page.evaluate(() => {
    const painel = document.querySelector('[data-testid="conversation-panel-messages"]') || document.querySelector('#main');
    const tem = !!painel && /\b\d+\s+(mensagens?\s+n[aã]o\s+lidas?|unread\s+messages?)/i.test(painel.innerText);
    const tit = document.querySelector('[data-testid="conversation-info-header-chat-title"]');
    return { naoLidas: tem, titulo: tit ? tit.innerText.trim() : '' };
  });
  // olha logo que abre e de novo depois das mensagens carregarem (olhar so no começo perdia o aviso)
  let antes = await verAviso();
  await page.waitForTimeout(3500);
  const depoisAviso = await verAviso();
  antes = { naoLidas: antes.naoLidas || depoisAviso.naoLidas, titulo: depoisAviso.titulo || antes.titulo };

  // carrega mensagens antigas rolando pra cima até passar do início da janela
  const painelSel = '[data-testid="conversation-panel-messages"]';
  // (so conta separador de dia e data da PROPRIA mensagem; a data de uma mensagem citada enganava antes)
  let ultimoTotal = -1;
  let semMudar = 0;
  for (let i = 0; i < 40; i++) {
    const info = await page.evaluate((sel) => {
      const painel = document.querySelector(sel);
      if (!painel) return { total: 0, seps: [], pre: [] };
      let rolavel = painel;
      for (let e = painel; e; e = e.parentElement) { if (e.scrollHeight > e.clientHeight + 20 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)) { rolavel = e; break; } }
      const re = /^(HOJE|ONTEM|\d{1,2}\/\d{2}\/\d{4}|(SEGUNDA|TERÇA|TERCA|QUARTA|QUINTA|SEXTA|SÁBADO|SABADO|DOMINGO)(-FEIRA)?)$/i;
      const seps = [...painel.querySelectorAll('span')].filter((s) => s.children.length === 0 && !s.closest('[data-testid="msg-container"]') && re.test(s.innerText.trim())).map((s) => s.innerText.trim());
      const pre = [...painel.querySelectorAll('[data-pre-plain-text]')].filter((e) => !e.closest('[data-testid="quoted-message"]')).map((e) => (e.getAttribute('data-pre-plain-text').match(/(\d{1,2}\/\d{2}\/\d{4})/) || [])[1]).filter(Boolean);
      rolavel.scrollTop = 0;
      return { total: painel.querySelectorAll('[role="row"]').length, seps, pre };
    }, painelSel);
    const datas = info.seps.map((t) => separadorParaISO(t, hojeISO)).concat(info.pre.map((d) => d.split('/').reverse().join('-'))).filter(Boolean).sort();
    if (datas[0] && datas[0] < desdeISO) break;                    // já carregou até antes da janela
    semMudar = info.total === ultimoTotal ? semMudar + 1 : 0;
    if (semMudar >= 3) break;                                       // não veio mais nada (começo da conversa)
    ultimoTotal = info.total;
    await page.waitForTimeout(1500);
  }

  // O WhatsApp so desenha as mensagens perto da tela (as outras ficam vazias). Entao desce a conversa
  // do topo ate o fim, aos pouquinhos, guardando cada mensagem (pelo id) quando ela aparece desenhada.
  // A ordem e os separadores de dia ("12/10/2026", "sábado"...) ficam sempre na pagina.
  const vistos = {};
  for (let passo = 0; passo < 400; passo++) {
    const r = await page.evaluate((sel) => {
      const painel = document.querySelector(sel);
      if (!painel) return { fim: true, msgs: [] };
      let rolavel = painel;
      for (let e = painel; e; e = e.parentElement) { if (e.scrollHeight > e.clientHeight + 20 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)) { rolavel = e; break; } }
      const pr = painel.getBoundingClientRect();
      const msgs = [];
      painel.querySelectorAll('div[role="row"]').forEach((e) => {
        const idEl = e.querySelector('[data-testid^="conv-msg-"]');
        const cont = e.querySelector('[data-testid="msg-container"]');
        if (!idEl || !cont) return; // ainda nao desenhada
        const id = idEl.getAttribute('data-testid');
        const fora = (x) => !x.closest('[data-testid="quoted-message"]');
        const pre = [...e.querySelectorAll('[data-pre-plain-text]')].filter(fora)[0];
        const preTxt = pre ? pre.getAttribute('data-pre-plain-text') : '';
        const m1 = preTxt.match(/\[(\d{1,2}:\d{2}), (\d{1,2}\/\d{2}\/\d{4})\]/);
        const meta = e.querySelector('[data-testid="msg-meta"]');
        const horasFolha = [...e.querySelectorAll('span')].filter((s) => s.children.length === 0 && /^\d{1,2}:\d{2}$/.test(s.innerText.trim())).map((s) => s.innerText.trim());
        const m2 = (meta ? meta.innerText : '').match(/(\d{1,2}:\d{2})/);
        const cr = cont.getBoundingClientRect();
        const aria = [...e.querySelectorAll('[aria-label]')].filter(fora).map((x) => x.getAttribute('aria-label')).join('|');
        const icones = [...e.querySelectorAll('[data-icon]')].filter(fora).map((x) => x.getAttribute('data-icon')).join('|');
        const txtEl = [...e.querySelectorAll('[data-testid="selectable-text"]')].filter(fora)[0];
        const sistema = !!e.querySelector('[data-testid="msg-notification-container"], [data-testid="system_message"]');
        const durTxt = horasFolha.length > 1 ? horasFolha[0] : null;
        msgs.push({
          id, sistema,
          saida: /tail-out/.test(icones) || (!/tail-in/.test(icones) && (cr.left + cr.right) / 2 > (pr.left + pr.right) / 2),
          data: m1 ? m1[2] : null,
          hora: m1 ? m1[1] : (m2 ? m2[1] : (horasFolha.length ? horasFolha[horasFolha.length - 1] : null)),
          texto: txtEl ? txtEl.innerText.trim() : '',
          audio: /ptt|voz|voice|audio-play|audio-pause/i.test(aria + '|' + icones) || !!e.querySelector('[data-testid="ptt-status"], [data-testid="audio-play"]'),
          midia: /document|image|video|sticker|gif|media/i.test(icones) || !!e.querySelector('[data-testid="video-content"], [data-testid="image-thumb"], [data-testid="sticker-container"], img[src^="blob:"]'),
          duracao: durTxt ? Number(durTxt.split(':')[0]) * 60 + Number(durTxt.split(':')[1]) : null,
        });
      });
      const fim = rolavel.scrollTop + rolavel.clientHeight >= rolavel.scrollHeight - 5;
      if (!fim) rolavel.scrollTop += Math.max(150, Math.round(rolavel.clientHeight * 0.45));
      return { fim, msgs };
    }, painelSel);
    r.msgs.forEach((m) => { vistos[m.id] = m; });
    if (r.fim) break;
    await page.waitForTimeout(500);
  }
  // ordem final (mensagens + separadores de dia), na sequencia da pagina
  const ordem = await page.evaluate((sel) => {
    const painel = document.querySelector(sel);
    if (!painel) return [];
    const dataLeaf = (e) => e.tagName === 'SPAN' && e.children.length === 0 && !e.closest('div[role="row"] [data-testid="msg-container"]') && /^(HOJE|ONTEM|\d{1,2}\/\d{2}\/\d{4}|(SEGUNDA|TERÇA|TERCA|QUARTA|QUINTA|SEXTA|SÁBADO|SABADO|DOMINGO)(-FEIRA)?)$/i.test(e.innerText.trim());
    return [...painel.querySelectorAll('[data-testid^="conv-msg-"], span')].filter((e) => e.tagName !== 'SPAN' || dataLeaf(e)).map((e) => (e.tagName === 'SPAN' ? { k: 'sep', txt: e.innerText.trim() } : { k: 'id', id: e.getAttribute('data-testid') }));
  }, painelSel);
  const itens = [];
  const usados = {};
  ordem.forEach((o) => {
    if (o.k === 'sep') { itens.push(o); return; }
    if (usados[o.id] || !vistos[o.id]) return;
    usados[o.id] = 1;
    itens.push(Object.assign({ k: 'msg' }, vistos[o.id]));
  });

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
  const naPagina = ordem.filter((o) => o.k === 'id').length;
  // REGRA FIXA do Angelo: se a ULTIMA mensagem da conversa e do paciente (ainda sem resposta), a conversa
  // tem que voltar como "nao lida" ao sair, pra ele nunca deixar paciente sem resposta.
  const ultima = itens.filter((it) => it.k === 'msg' && !it.sistema).slice(-1)[0];
  const ultimaDoPaciente = !!(ultima && !ultima.saida);
  return { status: 'ok', mensagens, naoLidas: antes.naoLidas, titulo: antes.titulo, ultimaDoPaciente, lidas: Object.keys(vistos).length, naPagina, seps: ordem.filter((o) => o.k === 'sep').map((o) => o.txt) };
}

// Nomes das conversas que JA estao como "nao lida" na lista (bolinha/contador), vistos antes de abrir
// qualquer uma. So le a tela, nao clica em nada. Devolve [] se nao conseguir ler.
async function listarNaoLidas(page) {
  try {
    await page.goto('https://web.whatsapp.com/');
    await page.waitForSelector('#pane-side', { timeout: 30000 });
    await page.waitForTimeout(2500);
    return await page.evaluate(() => {
      const achados = new Set();
      document.querySelectorAll('#pane-side span[title]').forEach((s) => {
        let linha = s;
        for (let i = 0; i < 8 && linha.parentElement && linha.parentElement.id !== 'pane-side'; i++) {
          linha = linha.parentElement;
          if (/^(row|listitem|gridcell)$/.test(linha.getAttribute('role') || '')) break;
        }
        const rotulos = [...linha.querySelectorAll('[aria-label]')].map((x) => x.getAttribute('aria-label')).join('|');
        if (/n[aã]o lidas?|unread/i.test(rotulos)) achados.add(s.getAttribute('title'));
      });
      return [...achados];
    });
  } catch (e) { return []; }
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

module.exports = { abrirWhatsApp, lerConversa, lerConversaAberta, marcarComoNaoLida, listarNaoLidas };
