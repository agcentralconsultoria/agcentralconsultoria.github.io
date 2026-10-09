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

// Lê, de um aluno, os check-ins semanais respondidos a partir de `desdeISO`.
// Devolve [{ data: 'YYYY-MM-DD', observacoes: ['pergunta: resposta', ...] }]
async function lerCheckinsDoAluno(page, aluno, desdeISO) {
  await abrirAluno(page, aluno.id);
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
    const linha = page.locator('table tbody tr', { hasText: r.quando }).first();
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
  return resultado;
}

module.exports = { abrirNavegador, listarAlunosAtivos, lerCheckinsDoAluno, dataBRparaISO };
