// Leitura do Treino.io (SOMENTE LEITURA). Usa o navegador próprio do vigia, que já
// está logado (login feito uma vez por login-treino.js). Nada aqui clica em botão que
// altere dado: só abre páginas, troca de aba e abre a janela "Ver" das respostas.
//
// Não usa IA: é leitura de tabelas e datas, então gasta zero token.
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const PERFIL_REAL = path.join(os.homedir(), '.agcentral', 'treino-profile');
const BASE = 'https://painel.treino.io/#/app/';

async function abrirNavegador() {
  const ctx = await chromium.launchPersistentContext(PERFIL_REAL, {
    headless: true,
    viewport: { width: 1400, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  page.setDefaultTimeout(20000);
  return { ctx, page };
}

// "02/10/2026 08:10" -> "2026-10-02"
function dataBRparaISO(txt) {
  const m = String(txt || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? m[3] + '-' + m[2] + '-' + m[1] : null;
}

// Lista de alunos ATIVOS (a lista do Treino.io mostra os ativos por padrão).
async function listarAlunosAtivos(page) {
  await page.goto(BASE + 'lista-alunos');
  await page.waitForSelector('table tbody tr td');
  await page.waitForTimeout(1500);
  const alunos = [];
  for (let pagina = 1; pagina <= 20; pagina++) {
    const linhas = await page.evaluate(() => [...document.querySelectorAll('table tbody tr')].map((tr) => {
      const td = [...tr.querySelectorAll('td')].map((c) => c.innerText.replace(/\s+/g, ' ').trim());
      const a = tr.querySelector('a');
      return { id: td[0], nome: (td[1] || '').replace(/^[A-ZÀ-Ú]\s/, ''), email: (td[2] || '').toLowerCase(), status: td[4], href: a ? a.getAttribute('href') : '' };
    }).filter((x) => x.id && x.href));
    linhas.forEach((l) => { if (!alunos.some((a) => a.id === l.id)) alunos.push(l); });
    // botão "próxima página" (paginação do painel)
    const prox = page.locator('li[title="Próxima Página"], li.ant-pagination-next, [aria-label*="róxima"]').first();
    if (!(await prox.count())) break;
    const desativado = await prox.evaluate((el) => el.classList.contains('ant-pagination-disabled') || el.getAttribute('aria-disabled') === 'true');
    if (desativado) break;
    await prox.click();
    await page.waitForTimeout(1200);
  }
  return alunos.filter((a) => /ativo/i.test(a.status));
}

async function abrirAluno(page, id) {
  await page.goto(BASE + 'detalhes-aluno/' + id);
  await page.waitForSelector('text=Informações do aluno', { timeout: 30000 });
}

function isoDe(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function somarDias(iso, n) { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return isoDe(d); }
// Sexta-feira da semana (segunda a domingo) em que a data cai. É a "casinha" da semana no CRM.
function sextaDaSemana(iso) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 4);
  return isoDe(d);
}

// Aba Atualizações > Histórico: datas agendadas de check-in do aluno e se foram respondidas.
// Devolve [{ data:'YYYY-MM-DD', status:'Respondida'|'Pendente'|'Cancelada' }]
async function lerAgendadas(page) {
  await page.getByRole('tab', { name: /Atualizações/ }).click();
  await page.waitForTimeout(1200);
  await page.getByRole('tab', { name: /Hist/ }).click();
  await page.waitForTimeout(1500);
  const linhas = await page.evaluate(() => {
    const t = [...document.querySelectorAll('table')].find((x) => /Data agendada/.test(x.innerText));
    if (!t) return [];
    return [...t.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((c) => c.innerText.replace(/\s+/g, ' ').trim()));
  });
  return linhas
    .filter((c) => c.length >= 2 && /^\d{2}\/\d{2}\/\d{4}$/.test(c[0]))
    .map((c) => ({ data: dataBRparaISO(c[0]), status: c[1] }));
}

// Lê, de um aluno, os check-ins semanais respondidos a partir de `desdeISO`.
// Devolve [{ data: 'YYYY-MM-DD', observacoes: ['pergunta: resposta', ...] }]
async function lerCheckinsDoAluno(page, aluno, desdeISO) {
  await abrirAluno(page, aluno.id);
  const agendadas = await lerAgendadas(page);
  await page.getByRole('tab', { name: /Questionários/ }).click();
  await page.waitForSelector('text=Respostas aos questionários');
  await page.waitForTimeout(1200);

  // linhas da tabela "Respostas aos questionários": questionário + data de resposta
  const linhas = await page.evaluate(() => {
    const t = [...document.querySelectorAll('table')].find((x) => /Data de resposta/.test(x.innerText));
    if (!t) return [];
    return [...t.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((c) => c.innerText.replace(/\s+/g, ' ').trim())).filter((c) => c.length >= 2 && /Check-in semanal/i.test(c[0]));
  });
  const recentes = linhas
    .map((c) => ({ quando: c[1], data: dataBRparaISO(c[1]) }))
    .filter((x) => x.data && x.data >= desdeISO);

  const resultado = [];
  for (const r of recentes) {
    // só a tabela de respostas (a do histórico de agendamentos também tem a mesma data)
    const linha = page.locator('table', { hasText: 'Data de resposta' }).locator('tbody tr', { hasText: r.quando }).first();
    await linha.getByText('Ver').click();
    await page.waitForSelector('text=Detalhes da resposta');
    await page.waitForTimeout(1200);
    const respostas = await page.evaluate(() => {
      const dlg = [...document.querySelectorAll('.ant-modal-content, [role=dialog]')].find((e) => /Detalhes da resposta/.test(e.innerText));
      if (!dlg) return [];
      const cands = [...dlg.querySelectorAll('div')].filter((d) => (d.innerText.match(/Resposta atual/g) || []).length === 1 && d.innerText.length < 2500);
      const blocos = [];
      cands.forEach((d) => {
        const i = blocos.findIndex((u) => u.contains(d) || d.contains(u));
        if (i === -1) blocos.push(d); else if (d.contains(blocos[i])) blocos[i] = d;
      });
      return blocos.map((d) => {
        const t = d.innerText.replace(/\s+/g, ' ').trim();
        const titulo = t.split('Obrigatório')[0].split('Resposta atual')[0].trim();
        const m = t.match(/Resposta atual \(\d\d\/\d\d\/\d{4}\):\s*(.*?)\s*(Resposta anterior|Exportar imagem|Observação para o aluno|$)/);
        return { titulo, resposta: m ? m[1].trim() : '' };
      });
    });
    // fecha a janela
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    const obs = [];
    respostas.forEach((p) => {
      if (!p.titulo.includes('💬')) return;           // só as perguntas marcadas com o balão
      const resp = p.resposta;
      if (!resp || /^n[ãa]o respondido$/i.test(resp)) return;
      const limpa = p.titulo.replace('💬', '').trim().replace(/\s+/g, ' ');
      const pergunta = limpa.length > 60 ? limpa.slice(0, 60).trim() + '…' : limpa;
      obs.push(pergunta + ' → ' + resp);
    });
    resultado.push({ data: r.data, observacoes: obs });
  }
  return { respondidos: resultado, agendadas };
}

// Fotos e medidas de um aluno (só datas). Fotos: "Última atualização de fotos" no perfil.
// Medidas: seção "Medidas corporais" da aba Progresso (maior data do Histórico). Sem registro => null.
async function lerFotosMedidas(page, aluno) {
  await abrirAluno(page, aluno.id);
  await page.waitForTimeout(1200);
  const fotos = await page.evaluate(() => {
    const t = document.querySelector('main').innerText;
    const m = t.match(/Última atualização de fotos\s*\n?\s*(\d{2}\/\d{2}\/\d{4})/);
    return m ? m[1] : null;
  });
  await page.getByRole('tab', { name: /Progresso/ }).click();
  await page.waitForTimeout(1500);
  const medidas = await page.evaluate(() => {
    const h = [...document.querySelectorAll('main h1,main h2,main h3,main h4,main h5')].find((e) => /Medidas corporais/.test(e.innerText));
    if (!h) return null;
    let box = h;
    for (let i = 0; i < 4 && box.parentElement; i++) { box = box.parentElement; if (box.querySelector('table')) break; }
    const datas = [];
    box.querySelectorAll('table tbody tr').forEach((tr) => {
      const c = tr.querySelector('td');
      const m = c && c.innerText.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      if (m) datas.push(m[3] + '-' + m[2] + '-' + m[1]);
    });
    if (!datas.length) {
      // sem tabela: usa as datas "em dd/mm/aaaa" dos resumos
      (box.innerText.match(/\d{2}\/\d{2}\/\d{4}/g) || []).forEach((d) => datas.push(d.split('/').reverse().join('-')));
    }
    return datas.length ? datas.sort().pop() : null;
  });
  return { fotos: dataBRparaISO(fotos), medidas };
}

// Fichas ativas do aluno (Visão geral > Fichas): data de "Atualizada em" do treino e da dieta.
async function lerFichas(page, aluno) {
  await abrirAluno(page, aluno.id);
  await page.waitForTimeout(1500);
  const txt = await page.evaluate(() => {
    const h = [...document.querySelectorAll('main h1,main h2,main h3,main h4,main h5')].find((e) => /^Fichas$/.test(e.innerText.trim()));
    if (!h) return '';
    let box = h;
    for (let i = 0; i < 4 && box.parentElement; i++) { box = box.parentElement; if (box.innerText.length > 120) break; }
    return box.innerText.replace(/\s+/g, ' ');
  });
  const iT = txt.search(/Treino\s+PDF/);
  const iD = txt.search(/Dieta\s+PDF/);
  const trecho = (a, b) => (a === -1 ? '' : txt.slice(a, b === -1 || b < a ? undefined : b));
  const data = (t) => { const m = t.match(/Atualizada em (\d{2}\/\d{2}\/\d{4})/); return m ? dataBRparaISO(m[1]) : null; };
  return { treino: data(trecho(iT, iD)), dieta: data(trecho(iD, -1)) };
}

module.exports = { lerFichas, lerFotosMedidas, abrirNavegador, listarAlunosAtivos, lerCheckinsDoAluno, dataBRparaISO, sextaDaSemana, somarDias, isoDe };
