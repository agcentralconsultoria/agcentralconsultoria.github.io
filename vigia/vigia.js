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
    await chamar({ action: 'atualizar', id, etapa: 'Check-ins: lendo a lista de alunos', progresso: Math.round(de + (ate - de) * 0.02) });
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
      await chamar({ action: 'atualizar', id, etapa: 'Check-ins: ' + (i + 1) + ' de ' + alunos.length + ' alunos', progresso: prog });
    }
  } finally {
    await ctx.close();
  }
  await chamar({ action: 'atualizar', id, etapa: previa ? 'Check-ins: calculando a prévia' : 'Check-ins: gravando no CRM', progresso: Math.round(de + (ate - de) * 0.95) });
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
    } else if (tipo === 'todas') {
      resultado = await executarCheckins(pedido, [0, 25]);
      resultado.resumo += ' As outras 3 automações (fotos e medidas, treinos e dietas, engajamento) ainda não foram construídas.';
      status = 'parcial';
    } else {
      status = 'erro';
      resultado = { analisados: 0, atualizados: 0, pendencias: 0, falhas: 0, resumo: NAO_CONSTRUIDA, detalhes: [] };
    }
    await chamar({ action: 'finalizar', id, status, resultado });
    log('Pedido ' + id + ' finalizado (' + status + '): ' + resultado.resumo);
  } catch (err) {
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
