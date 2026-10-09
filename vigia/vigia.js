// Vigia do AGCentral (roda no MacBook). Fica olhando a fila de pedidos da aba
// Automação, pega um pedido por vez, avisa o andamento e entrega o resultado.
//
// ETAPA 3 (teste de fila): ainda NÃO lê Treino.io nem WhatsApp e NÃO altera nada
// no CRM. Só simula o andamento pra provar que o caminho
// botão -> fila -> Mac -> resultado funciona. O resultado diz isso com todas as letras.
//
// A chave secreta fica só no Mac (~/.agcentral/vigia.key), nunca neste repositório.
//
// Uso:  node vigia/vigia.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const URL_FUNCAO = 'https://southamerica-east1-agcentralcrm.cloudfunctions.net/automacaoVigia';
const ARQUIVO_CHAVE = path.join(os.homedir(), '.agcentral', 'vigia.key');
const VERSAO = 'etapa3-teste';
const INTERVALO_MS = 5000;

const NOMES = { checkins: 'Check-ins', fotos: 'Fotos e medidas', treinos: 'Treinos e dietas', engajamento: 'Engajamento' };
const ORDEM_TODAS = ['checkins', 'fotos', 'treinos', 'engajamento'];

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

// Simula o trabalho de um tipo, devolvendo o progresso de `de` a `ate` (0-100).
async function simularTipo(id, tipo, de, ate) {
  const passos = ['Abrindo o Chrome', 'Lendo os dados', 'Comparando com o CRM', 'Montando o relatório'];
  for (let i = 0; i < passos.length; i++) {
    const prog = Math.round(de + ((ate - de) * (i + 1)) / passos.length);
    await chamar({ action: 'atualizar', id, etapa: NOMES[tipo] + ': ' + passos[i] + ' (simulado)', progresso: prog, log: NOMES[tipo] + ': ' + passos[i] });
    await dormir(4000);
  }
}

async function executar(pedido) {
  const { id, tipo } = pedido;
  log('Pedido ' + id + ' (' + tipo + ', modo ' + pedido.modo + ') iniciado.');
  try {
    if (tipo === 'todas') {
      const fatia = 100 / ORDEM_TODAS.length;
      for (let i = 0; i < ORDEM_TODAS.length; i++) await simularTipo(id, ORDEM_TODAS[i], i * fatia, (i + 1) * fatia);
    } else {
      await simularTipo(id, tipo, 0, 100);
    }
    await chamar({
      action: 'finalizar', id, status: 'concluido',
      resultado: { analisados: 0, atualizados: 0, pendencias: 0, falhas: 0, resumo: 'Teste do sistema: o caminho botão → fila → Mac → resultado funcionou. Nenhum dado real foi lido nem alterado.' },
    });
    log('Pedido ' + id + ' concluído (teste).');
  } catch (err) {
    log('Falha no pedido ' + id + ': ' + err.message);
    try {
      await chamar({ action: 'finalizar', id, status: 'erro', resultado: { analisados: 0, atualizados: 0, pendencias: 0, falhas: 1, resumo: 'O vigia falhou: ' + String(err.message).slice(0, 200) } });
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
