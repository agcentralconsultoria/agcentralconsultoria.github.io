// Vigia do AGCentral (roda no MacBook). Fica olhando a fila de pedidos da aba
// Automação, pega um pedido por vez, avisa o andamento e entrega o resultado.
//
// ETAPA 4 (check-ins reais): lê o Treino.io (somente leitura, sem IA, zero token) e envia
// os check-ins pro CRM pelo receptor syncCheckins. Em modo PRÉVIA só calcula o que
// mudaria; em modo DIRETO grava. As outras automações ainda não foram construídas e
// dizem isso com todas as letras (nada de resultado de mentira).
//
// A chave secreta fica só no Mac (~/.agcentral/vigia.key), nunca neste repositório.
//
// Uso:  node vigia/vigia.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const URL_FUNCAO = 'https://southamerica-east1-agcentralcrm.cloudfunctions.net/automacaoVigia';
const ARQUIVO_CHAVE = path.join(os.homedir(), '.agcentral', 'vigia.key');
const VERSAO = 'etapa4-checkins';
const URL_SYNC = 'https://southamerica-east1-agcentralcrm.cloudfunctions.net/syncCheckins';
const JANELA_DIAS = 10; // olha check-ins respondidos nos últimos N dias (reenvio é seguro: o CRM não duplica)
const treino = require('./treino');
const whatsapp = require('./whatsapp');
const claude = require('./claude');
const URL_ENGAJ = 'https://southamerica-east1-agcentralcrm.cloudfunctions.net/engajamento';
const INTERVALO_MS = 5000;


const CHAVE = fs.readFileSync(ARQUIVO_CHAVE, 'utf8').trim();
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const agora = () => new Date().toLocaleTimeString('pt-BR');
const log = (m) => console.log('[' + agora() + '] ' + m);

async function chamar(corpo) {
  const resp = await fetch(URL_FUNCAO, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-automacao-key': CHAVE },
    body: JSON.stringify(Object.assign({ versao: VERSAO }, corpo)),
  });
  const texto = await resp.text();
  if (!resp.ok) throw new Error(resp.status + ' ' + texto.slice(0, 200));
  try { return JSON.parse(texto); } catch (e) { return {}; }
}

// Avisa o andamento. Se o Angelo clicou em Cancelar, o servidor responde cancelar:true e o
// vigia para na hora (nada foi gravado ainda: a gravação no CRM só acontece no fim).
async function atualizarPedido(corpo) {
  const r = await chamar(corpo);
  if (r && r.cancelar) throw new Error('CANCELADO');
  return r;
}

function hojeMenos(dias) {
  const d = new Date(); d.setDate(d.getDate() - dias);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function enviarParaCrm(pedido, entries) {
  const resp = await fetch(URL_SYNC, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-automacao-key': CHAVE },
    body: JSON.stringify({ batchId: pedido.modo === 'direto' ? 'vigia-' + pedido.id : undefined, dryRun: pedido.modo !== 'direto', entries }),
  });
  const texto = await resp.text();
  if (!resp.ok) throw new Error('syncCheckins ' + resp.status + ' ' + texto.slice(0, 200));
  return JSON.parse(texto);
}

// Check-ins: lê cada aluno ativo do Treino.io e manda os check-ins respondidos ao CRM.
// `faixa` = [de, ate] em % do progresso total do pedido (pra "todas" dividir o gráfico).
async function executarCheckins(pedido, faixa) {
  const id = pedido.id;
  const [de, ate] = faixa;
  const previa = pedido.modo !== 'direto';
  const { ctx, page } = await treino.abrirNavegador();
  const entries = [];
  const falhas = [];
  let semResposta = 0;
  let analisados = 0;
  try {
    await atualizarPedido({ action: 'atualizar', id, etapa: 'Check-ins: lendo a lista de alunos', progresso: Math.round(de + (ate - de) * 0.02) });
    const alunos = await treino.listarAlunosAtivos(page);
    const hoje = hojeMenos(0);
    const desde = hojeMenos(JANELA_DIAS);
    if (!alunos.length) throw new Error('A lista de alunos veio vazia (login do Treino.io pode ter expirado).');
    for (let i = 0; i < alunos.length; i++) {
      const al = alunos[i];
      try {
        const lido = await treino.lerCheckinsDoAluno(page, al, desde);
        analisados++;
        const checkins = lido.respondidos;
        if (!checkins.length) semResposta++;
        checkins.forEach((c) => entries.push({ email: al.email, date: c.data, enviou: true, observacoes: c.observacoes }));
        // "Não enviou": prazo agendado do paciente + 1 dia de folga já passou e não foi respondido
        const limite = treino.somarDias(hoje, -2);
        const semanasComResposta = new Set();
        checkins.forEach((c) => semanasComResposta.add(treino.sextaDaSemana(c.data)));
        lido.agendadas.filter((a) => a.status === 'Respondida').forEach((a) => semanasComResposta.add(treino.sextaDaSemana(a.data)));
        const jaMarcadas = new Set();
        lido.agendadas.forEach((a) => {
          if (a.status === 'Respondida' || a.data < desde || a.data > limite) return;
          const sexta = treino.sextaDaSemana(a.data);
          if (semanasComResposta.has(sexta) || jaMarcadas.has(sexta)) return;
          jaMarcadas.add(sexta);
          entries.push({ email: al.email, date: sexta, enviou: false, soSeVazio: true, motivo: 'agendado para ' + a.data.split('-').reverse().join('/') + ' (' + a.status + ' no Treino.io)' });
        });
      } catch (e) {
        falhas.push(al.nome + ': ' + String(e.message).split('\n')[0].slice(0, 100));
      }
      const prog = Math.round(de + (ate - de) * (0.05 + 0.85 * ((i + 1) / alunos.length)));
      await atualizarPedido({ action: 'atualizar', id, etapa: 'Check-ins: ' + (i + 1) + ' de ' + alunos.length + ' alunos', progresso: prog });
    }
  } finally {
    await ctx.close();
  }
  await atualizarPedido({ action: 'atualizar', id, etapa: previa ? 'Check-ins: calculando a prévia' : 'Check-ins: gravando no CRM', progresso: Math.round(de + (ate - de) * 0.95) });
  let r = { checkinsAplicados: 0, observacoesAplicadas: 0, ausentesMarcados: 0, pulados: 0, detalhesPulados: [], detalhes: [] };
  if (entries.length) r = await enviarParaCrm(pedido, entries);
  const pendencias = semResposta + r.pulados;
  const detalhes = []
    .concat((r.detalhes || []).map((x) => (previa ? 'Entraria: ' : 'Gravado: ') + x))
    .concat((r.detalhesPulados || []).map((x) => 'Pulado: ' + x))
    .concat(falhas.map((x) => 'Falha: ' + x));
  const resumo = (previa ? 'PRÉVIA (nada foi gravado). ' : '') +
    r.checkinsAplicados + ' check-in(s) ' + (previa ? 'entrariam' : 'gravados') + ', ' + r.observacoesAplicadas + ' observação(ões), ' +
    r.ausentesMarcados + ' ' + (previa ? 'seriam marcados' : 'marcados') + ' como NÃO enviou (prazo do paciente + 1 dia já passou). ' +
    semResposta + ' aluno(s) sem check-in nos últimos ' + JANELA_DIAS + ' dias' +
    (r.pulados ? ', ' + r.pulados + ' pulado(s) (e-mail/semana não encontrados no CRM)' : '') +
    (falhas.length ? ', ' + falhas.length + ' falha(s) de leitura' : '') + '.';
  return { analisados, atualizados: r.checkinsAplicados + r.ausentesMarcados, pendencias, falhas: falhas.length, resumo, detalhes };
}

const DIAS_FOTOS_MEDIDAS = 30; // mesma regra do Atenção de hoje: a cada 30 dias

function diasDesde(iso) {
  return Math.round((new Date(hojeMenos(0) + 'T00:00:00') - new Date(iso + 'T00:00:00')) / 86400000);
}

// Fotos e medidas: lê as datas no Treino.io (sem IA) e atualiza as datas do CRM (só se for mais nova).
async function executarFotosMedidas(pedido, faixa) {
  const id = pedido.id;
  const [de, ate] = faixa;
  const previa = pedido.modo !== 'direto';
  const { ctx, page } = await treino.abrirNavegador();
  const entries = [];
  const falhas = [];
  const atrasados = [];
  let analisados = 0;
  try {
    await atualizarPedido({ action: 'atualizar', id, etapa: 'Fotos e medidas: lendo a lista de alunos', progresso: Math.round(de + (ate - de) * 0.02) });
    const alunos = await treino.listarAlunosAtivos(page);
    if (!alunos.length) throw new Error('A lista de alunos veio vazia (login do Treino.io pode ter expirado).');
    for (let i = 0; i < alunos.length; i++) {
      const al = alunos[i];
      try {
        const d = await treino.lerFotosMedidas(page, al);
        analisados++;
        entries.push({ email: al.email, ultimasFotos: d.fotos || undefined, ultimasMedidas: d.medidas || undefined });
        const partes = [];
        if (!d.fotos) partes.push('fotos: nunca enviou');
        else if (diasDesde(d.fotos) >= DIAS_FOTOS_MEDIDAS) partes.push('fotos há ' + diasDesde(d.fotos) + ' dias');
        if (!d.medidas) partes.push('medidas: nunca enviou');
        else if (diasDesde(d.medidas) >= DIAS_FOTOS_MEDIDAS) partes.push('medidas há ' + diasDesde(d.medidas) + ' dias');
        if (partes.length) atrasados.push('Pendência: ' + al.nome + ' — ' + partes.join(', '));
      } catch (e) {
        falhas.push(al.nome + ': ' + String(e.message).split('\n')[0].slice(0, 100));
      }
      const prog = Math.round(de + (ate - de) * (0.05 + 0.85 * ((i + 1) / alunos.length)));
      await atualizarPedido({ action: 'atualizar', id, etapa: 'Fotos e medidas: ' + (i + 1) + ' de ' + alunos.length + ' alunos', progresso: prog });
    }
  } finally {
    await ctx.close();
  }
  await atualizarPedido({ action: 'atualizar', id, etapa: previa ? 'Fotos e medidas: calculando a prévia' : 'Fotos e medidas: gravando no CRM', progresso: Math.round(de + (ate - de) * 0.95) });
  let r = { atualizados: 0, detalhes: [], detalhesPulados: [] };
  if (entries.length) {
    const resp = await chamar({ action: 'gravarDatas', dryRun: previa, entries });
    r = resp;
  }
  const detalhes = []
    .concat((r.detalhes || []).map((x) => (previa ? 'Entraria: ' : 'Gravado: ') + x))
    .concat((r.detalhesPulados || []).map((x) => 'Pulado: ' + x))
    .concat(falhas.map((x) => 'Falha: ' + x))
    .concat(atrasados);
  const resumo = (previa ? 'PRÉVIA (nada foi gravado). ' : '') + r.atualizados + ' data(s) de fotos/medidas ' + (previa ? 'entrariam' : 'gravadas') + '. ' +
    atrasados.length + ' aluno(s) com fotos ou medidas há ' + DIAS_FOTOS_MEDIDAS + ' dias ou mais' +
    ((r.detalhesPulados || []).length ? ', ' + r.detalhesPulados.length + ' pulado(s) (e-mail não está no CRM)' : '') +
    (falhas.length ? ', ' + falhas.length + ' falha(s) de leitura' : '') + '.';
  return { analisados, atualizados: r.atualizados, pendencias: atrasados.length + (r.detalhesPulados || []).length, falhas: falhas.length, resumo, detalhes };
}

// Treinos e dietas: compara as fichas do Treino.io com as do CRM; ficha mais nova no Treino.io vira
// ficha nova no CRM só com a data (sem conteúdo nem vencimento). Sem IA, zero token.
async function executarTreinosDietas(pedido, faixa) {
  const id = pedido.id;
  const [de, ate] = faixa;
  const previa = pedido.modo !== 'direto';
  const { ctx, page } = await treino.abrirNavegador();
  const entries = [];
  const falhas = [];
  let analisados = 0;
  try {
    await atualizarPedido({ action: 'atualizar', id, etapa: 'Treinos e dietas: lendo a lista de alunos', progresso: Math.round(de + (ate - de) * 0.02) });
    const alunos = await treino.listarAlunosAtivos(page);
    if (!alunos.length) throw new Error('A lista de alunos veio vazia (login do Treino.io pode ter expirado).');
    for (let i = 0; i < alunos.length; i++) {
      const al = alunos[i];
      try {
        const f = await treino.lerFichas(page, al);
        analisados++;
        if (f.treino || f.dieta) entries.push({ email: al.email, treino: f.treino || undefined, dieta: f.dieta || undefined });
      } catch (e) {
        falhas.push(al.nome + ': ' + String(e.message).split('\n')[0].slice(0, 100));
      }
      const prog = Math.round(de + (ate - de) * (0.05 + 0.85 * ((i + 1) / alunos.length)));
      await atualizarPedido({ action: 'atualizar', id, etapa: 'Treinos e dietas: ' + (i + 1) + ' de ' + alunos.length + ' alunos', progresso: prog });
    }
  } finally {
    await ctx.close();
  }
  await atualizarPedido({ action: 'atualizar', id, etapa: previa ? 'Treinos e dietas: calculando a prévia' : 'Treinos e dietas: gravando no CRM', progresso: Math.round(de + (ate - de) * 0.95) });
  let r = { criadas: 0, detalhes: [], detalhesPulados: [] };
  if (entries.length) r = await chamar({ action: 'gravarFichas', dryRun: previa, entries });
  const semVenc = (r.detalhes || []).filter((x) => /defina o vencimento/.test(x)).length;
  const detalhes = []
    .concat((r.detalhes || []).map((x) => (previa ? 'Entraria: ' : 'Criada: ') + x))
    .concat((r.detalhesPulados || []).map((x) => 'Pulado: ' + x))
    .concat(falhas.map((x) => 'Falha: ' + x));
  const resumo = (previa ? 'PRÉVIA (nada foi gravado). ' : '') + r.criadas + ' ficha(s) ' + (previa ? 'seriam criadas' : 'criadas') + ' no CRM (só com a data)' +
    (semVenc ? ', ' + semVenc + ' de treino sem vencimento (você precisa definir)' : '') +
    ((r.detalhesPulados || []).length ? ', ' + r.detalhesPulados.length + ' pulado(s) (e-mail não está no CRM)' : '') +
    (falhas.length ? ', ' + falhas.length + ' falha(s) de leitura' : '') + '.';
  return { analisados, atualizados: r.criadas, pendencias: semVenc + (r.detalhesPulados || []).length, falhas: falhas.length, resumo, detalhes };
}

// ---------------- Engajamento (WhatsApp Web + Claude) ----------------
// Escala 0-10 definida pelo Ângelo (texto dele, sem mudar nada). O Claude só vê datas, horários,
// quem falou e o texto das mensagens; áudio entra só como "existiu, durou X s".
const ESCALA_ENGAJAMENTO = `0 = silêncio total do paciente durante a semana, sem mensagens recebidas.
1–2 = respondeu apenas depois de cobrança ou com muito atraso, e de forma seca, sem continuidade.
3–4 = apresentou um ponto fraco: resposta lenta (2 dias ou mais) OU resposta rápida, porém seca e sem troca real.
5–6 = respondeu em 1–2 dias e houve conteúdo ou troca mínima real.
7–8 = respondeu no mesmo dia ou no dia seguinte E manteve uma troca real de mensagens. Áudio com conteúdo razoável conta; áudio curtíssimo, como "ok", não.
9–10 = cumpriu os critérios de 7–8 E iniciou conversa por conta própria em algum momento da semana, antes de o coach falar com ele.
Escolha a nota específica dentro da faixa de acordo com a evidência observada. Se não conseguir avaliar um áudio com segurança, registre exceção em vez de presumir seu conteúdo.`;

function dataCurta(iso) { return iso.slice(8, 10) + '/' + iso.slice(5, 7); }
const DIAS_PT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

function montarPrompt(nome, semana, mensagens) {
  const linhas = mensagens.slice(-150).map((m) => {
    const dia = DIAS_PT[new Date(m.data + 'T00:00:00').getDay()];
    const quando = dia + ' ' + dataCurta(m.data) + ' ' + m.hora;
    const fora = m.data < semana.segunda ? ' [antes da semana avaliada, só contexto]' : '';
    const quem = m.dir === 'paciente' ? 'PACIENTE' : 'COACH';
    const conteudo = m.tipo === 'audio' ? '[ÁUDIO' + (m.seg ? ' de ' + m.seg + ' s' : '') + ' — conteúdo desconhecido]' : (m.tipo === 'midia' ? '[foto/arquivo/figurinha]' : '"' + m.texto.replace(/\s+/g, ' ').slice(0, 300) + '"');
    return quando + ' · ' + quem + ' · ' + conteudo + fora;
  });
  return 'Você avalia o ENGAJAMENTO SEMANAL de um paciente de acompanhamento de treino/dieta pelo WhatsApp, usando EXATAMENTE a escala abaixo. Não crie outra metodologia.\n\n' +
    'ESCALA (0 a 10):\n' + ESCALA_ENGAJAMENTO + '\n\n' +
    'SEMANA AVALIADA: segunda ' + dataCurta(semana.segunda) + ' a domingo ' + dataCurta(semana.domingo) + '. Avalie só o que aconteceu nessa semana (mensagens marcadas "antes da semana" servem de contexto, por exemplo para saber se o coach falou primeiro).\n' +
    'PACIENTE: ' + nome + '.\n\n' +
    'REGRAS:\n- PACIENTE = a pessoa acompanhada. COACH = o profissional.\n' +
    '- Áudio conta como mensagem recebida do paciente. Você NÃO sabe o que ele disse, só a duração. Se a nota depender do conteúdo do áudio e a duração não bastar para decidir com segurança, responda excecao=true em vez de presumir.\n' +
    '- Separe FATOS (o que está na conversa) da sua INTERPRETAÇÃO.\n\n' +
    'CONVERSA (ordem cronológica):\n' + linhas.join('\n') + '\n\n' +
    'Responda SOMENTE com um JSON, sem texto antes ou depois, neste formato:\n' +
    '{"nota": <inteiro de 0 a 10, ou null se excecao>, "excecao": <true ou false>, "motivo_excecao": "<curto ou vazio>", "fatos": "<fatos observados, até 110 caracteres>", "interpretacao": "<seu julgamento, até 110 caracteres>"}';
}

async function chamarEngaj(corpo) {
  const resp = await fetch(URL_ENGAJ, { method: 'POST', headers: { 'content-type': 'application/json', 'x-automacao-key': CHAVE }, body: JSON.stringify(corpo) });
  const texto = await resp.text();
  if (!resp.ok) throw new Error('engajamento ' + resp.status + ' ' + texto.slice(0, 160));
  return JSON.parse(texto);
}

function extrairJson(txt) {
  const m = String(txt).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Claude não devolveu JSON');
  return JSON.parse(m[0]);
}

async function executarEngajamento(pedido, faixa) {
  const id = pedido.id;
  const [de, ate] = faixa;
  const previa = pedido.modo !== 'direto';
  const hoje = hojeMenos(0);
  await atualizarPedido({ action: 'atualizar', id, etapa: 'Engajamento: vendo quem precisa de nota', progresso: Math.round(de + (ate - de) * 0.02) });
  const pend = await chamarEngaj({ acao: 'pendentes' });
  const pacientes = pend.pacientes || [];
  const entries = [];
  const detalhes = [];
  const falhas = [];
  let analisados = 0; let excecoes = 0; let naoLidasDevolvidas = 0; let pulados = (pend.semTelefone || []).length;
  (pend.semTelefone || []).forEach((n) => detalhes.push('Pulado: ' + n + ' — sem telefone no CRM'));
  if (!pacientes.length) {
    return { analisados: 0, atualizados: 0, pendencias: pulados, falhas: 0, resumo: (previa ? 'PRÉVIA (nada foi gravado). ' : '') + 'Nenhuma semana encerrada sem nota de engajamento.' + (pulados ? ' ' + pulados + ' sem telefone.' : ''), detalhes };
  }
  const { ctx, page } = await whatsapp.abrirWhatsApp();
  try {
    await page.goto('https://web.whatsapp.com/');
    const logado = await page.waitForSelector('#pane-side', { timeout: 45000 }).then(() => true).catch(() => false);
    if (!logado) throw new Error('WhatsApp Web deslogado: rode "node vigia/login-whatsapp.js" e escaneie o QR code de novo.');
    for (let i = 0; i < pacientes.length; i++) {
      const p = pacientes[i];
      try {
        const desde = treino.somarDias(p.semanas.map((x) => x.segunda).sort()[0], -3);
        const ateD = p.semanas.map((x) => x.domingo).sort().slice(-1)[0];
        const conv = await whatsapp.lerConversa(page, p.telefone, desde, ateD, hoje);
        if (conv.status === 'sem_conversa') { pulados++; detalhes.push('Pulado: ' + p.nome + ' — número sem conversa no WhatsApp'); continue; }
        analisados++;
        // Se tinha mensagem não lida, devolve a conversa pra "não lida" (notificação do Ângelo)
        if (conv.naoLidas) {
          try { await whatsapp.marcarComoNaoLida(page, conv.titulo); naoLidasDevolvidas++; }
          catch (e) { falhas.push('Não consegui deixar "não lida": ' + p.nome.slice(0, 24) + ' — ' + String(e.message).slice(0, 60)); }
        }
        for (const sem of p.semanas) {
          const naJanela = conv.mensagens.filter((m) => m.data >= sem.segunda && m.data <= sem.domingo);
          const recebidas = naJanela.filter((m) => m.dir === 'paciente');
          const audios = recebidas.filter((m) => m.tipo === 'audio').length;
          const periodo = dataCurta(sem.segunda) + '–' + dataCurta(sem.domingo);
          const rotulo = p.nome.slice(0, 26) + ' (' + periodo + ')';
          if (!recebidas.length) {
            entries.push({ email: p.email, monthKey: sem.monthKey, weekIndex: sem.weekIndex, nota: 0 });
            detalhes.push(rotulo + ' → nota 0 | Fato: nenhuma mensagem do paciente na semana | Sem IA (regra da escala)');
            continue;
          }
          const contexto = conv.mensagens.filter((m) => m.data <= sem.domingo);
          let r;
          try {
            const bruto = await claude.perguntar(montarPrompt(p.nome, sem, contexto), { modelo: 'sonnet', esforco: 'medium' });
            r = extrairJson(bruto);
          } catch (e) { falhas.push(rotulo + ': ' + String(e.message).slice(0, 90)); continue; }
          const fatoBase = recebidas.length + ' msg do paciente' + (audios ? ' (' + audios + ' áudio)' : '');
          if (r.excecao || r.nota === null || r.nota === undefined || !Number.isInteger(Number(r.nota)) || r.nota < 0 || r.nota > 10) {
            excecoes++;
            detalhes.push('Exceção: ' + rotulo + ' — ' + String(r.motivo_excecao || 'IA não conseguiu avaliar com segurança').slice(0, 90) + ' | ' + fatoBase);
            continue;
          }
          entries.push({ email: p.email, monthKey: sem.monthKey, weekIndex: sem.weekIndex, nota: Number(r.nota) });
          detalhes.push(rotulo + ' → nota ' + r.nota + ' | Fato: ' + String(r.fatos || fatoBase).slice(0, 55) + ' | IA: ' + String(r.interpretacao || '').slice(0, 45));
        }
      } catch (e) {
        falhas.push(p.nome + ': ' + String(e.message).split('\n')[0].slice(0, 100));
      }
      await atualizarPedido({ action: 'atualizar', id, etapa: 'Engajamento: ' + (i + 1) + ' de ' + pacientes.length + ' pacientes', progresso: Math.round(de + (ate - de) * (0.05 + 0.85 * ((i + 1) / pacientes.length))) });
      await dormir(2000 + Math.floor(Math.random() * 2500)); // ritmo calmo, como uma pessoa
    }
  } finally {
    await ctx.close();
  }
  await atualizarPedido({ action: 'atualizar', id, etapa: previa ? 'Engajamento: calculando a prévia' : 'Engajamento: gravando no CRM', progresso: Math.round(de + (ate - de) * 0.95) });
  let r = { gravadas: 0, detalhes: [], detalhesPulados: [] };
  if (entries.length) r = await chamarEngaj({ acao: 'gravar', dryRun: previa, entries });
  const todos = detalhes.concat((r.detalhesPulados || []).map((x) => 'Pulado: ' + x)).concat(falhas.map((x) => 'Falha: ' + x));
  const resumo = (previa ? 'PRÉVIA (nada foi gravado). ' : '') + r.gravadas + ' nota(s) ' + (previa ? 'entrariam' : 'gravadas') + ' (só em semana encerrada e campo vazio)' +
    (excecoes ? ', ' + excecoes + ' exceção(ões) sem nota (você decide)' : '') + (pulados ? ', ' + pulados + ' pulado(s)' : '') + (naoLidasDevolvidas ? ', ' + naoLidasDevolvidas + ' conversa(s) devolvida(s) para "não lida"' : '') + (falhas.length ? ', ' + falhas.length + ' falha(s)' : '') + '.';
  return { analisados, atualizados: r.gravadas, pendencias: excecoes + pulados + (r.detalhesPulados || []).length, falhas: falhas.length, resumo, detalhes: todos };
}

const NAO_CONSTRUIDA = 'Esta automação ainda não foi construída. Nada foi lido nem alterado.';

async function executar(pedido) {
  const { id, tipo } = pedido;
  log('Pedido ' + id + ' (' + tipo + ', modo ' + pedido.modo + ') iniciado.');
  try {
    let status = 'concluido';
    let resultado;
    if (tipo === 'checkins') {
      resultado = await executarCheckins(pedido, [0, 100]);
      if (resultado.falhas) status = 'parcial';
    } else if (tipo === 'fotos') {
      resultado = await executarFotosMedidas(pedido, [0, 100]);
      if (resultado.falhas) status = 'parcial';
    } else if (tipo === 'treinos') {
      resultado = await executarTreinosDietas(pedido, [0, 100]);
      if (resultado.falhas) status = 'parcial';
    } else if (tipo === 'engajamento') {
      resultado = await executarEngajamento(pedido, [0, 100]);
      if (resultado.falhas) status = 'parcial';
    } else if (tipo === 'todas') {
      const a = await executarCheckins(pedido, [0, 25]);
      const b = await executarFotosMedidas(pedido, [25, 50]);
      const c = await executarTreinosDietas(pedido, [50, 75]);
      const e = await executarEngajamento(pedido, [75, 100]);
      resultado = {
        analisados: Math.max(a.analisados, b.analisados, c.analisados, e.analisados), atualizados: a.atualizados + b.atualizados + c.atualizados + e.atualizados,
        pendencias: a.pendencias + b.pendencias + c.pendencias + e.pendencias, falhas: a.falhas + b.falhas + c.falhas + e.falhas,
        resumo: 'CHECK-INS: ' + a.resumo + ' FOTOS E MEDIDAS: ' + b.resumo + ' TREINOS E DIETAS: ' + c.resumo + ' ENGAJAMENTO: ' + e.resumo,
        detalhes: a.detalhes.map((x) => '[Check-ins] ' + x).concat(b.detalhes.map((x) => '[Fotos/medidas] ' + x), c.detalhes.map((x) => '[Treinos/dietas] ' + x), e.detalhes.map((x) => '[Engajamento] ' + x)).slice(0, 100),
      };
      status = 'parcial';
    } else {
      status = 'erro';
      resultado = { analisados: 0, atualizados: 0, pendencias: 0, falhas: 0, resumo: NAO_CONSTRUIDA, detalhes: [] };
    }
    await chamar({ action: 'finalizar', id, status, resultado });
    log('Pedido ' + id + ' finalizado (' + status + '): ' + resultado.resumo);
  } catch (err) {
    if (err.message === 'CANCELADO') {
      log('Pedido ' + id + ' cancelado pelo Angelo.');
      try {
        await chamar({ action: 'finalizar', id, status: 'cancelado', resultado: { analisados: 0, atualizados: 0, pendencias: 0, falhas: 0, resumo: 'Cancelado por você antes de terminar. Nada foi gravado no CRM.' } });
      } catch (e3) { log('Não consegui registrar o cancelamento: ' + e3.message); }
      return;
    }
    log('Falha no pedido ' + id + ': ' + err.message);
    try {
      await chamar({ action: 'finalizar', id, status: 'erro', resultado: { analisados: 0, atualizados: 0, pendencias: 0, falhas: 1, resumo: 'O vigia falhou: ' + String(err.message).slice(0, 300) } });
    } catch (e2) { log('Não consegui nem registrar o erro: ' + e2.message); }
  }
}

async function main() {
  log('Vigia ligado (' + VERSAO + '). Olhando a fila a cada ' + INTERVALO_MS / 1000 + ' s. Ctrl+C para parar.');
  for (;;) {
    try {
      const r = await chamar({ action: 'proximo' });
      if (r.pedido) { await executar(r.pedido); continue; }
    } catch (err) {
      log('Sem contato com o servidor: ' + err.message);
    }
    await dormir(INTERVALO_MS);
  }
}

main();
