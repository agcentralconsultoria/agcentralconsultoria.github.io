// Automacao (so o Angelo): fila de pedidos que o "vigia" do MacBook executa.
//
// Fluxo: o CRM (logado como Angelo) cria um pedido em automacaoPedidos (status
// "pendente"). O vigia, rodando no Mac, chama esta funcao com a chave secreta,
// pega o proximo pedido, avisa o andamento e entrega o resultado. Nada de senha
// ou chave fica no site publico; so o vigia conhece AUTOMACAO_KEY.
//
// Aqui so ha controle de fila, andamento e resultado (contagens e um resumo curto).
// Quem le o Treino.io / WhatsApp e quem grava no CRM e o vigia (etapas seguintes).
const { onRequest } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const crypto = require('crypto');

const db = admin.firestore();
const { AUTOMACAO_KEY } = require('./segredos');

const REGION = 'southamerica-east1';
const PEDIDOS = 'automacaoPedidos';
const RESUMO = 'automacaoResumo';
const VIGIA_STATUS = db.doc('automacaoVigia/status');

const STATUS_FINAIS = ['concluido', 'parcial', 'erro'];
// Pedido "executando" parado ha mais que isso e dado como falha (Mac dormiu, app fechou...).
const EXECUCAO_PARADA_MS = 45 * 60 * 1000;
const MAX_LOGS = 200;
const MAX_DETALHES = 100;

function chaveConfere(recebida, esperada) {
  const a = Buffer.from(String(recebida || ''));
  const b = Buffer.from(String(esperada || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function texto(v, max) {
  return String(v === undefined || v === null ? '' : v).slice(0, max);
}
function inteiro(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

exports.automacaoVigia = onRequest({
  region: REGION,
  secrets: [AUTOMACAO_KEY],
  timeoutSeconds: 60,
  memory: '256MiB',
  cors: false,
}, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('use POST');
    return;
  }
  // A chave vai no cabecalho (nunca na URL, pra nao cair em log).
  if (!chaveConfere(String(req.get('x-automacao-key') || '').trim(), String(AUTOMACAO_KEY.value()).trim())) {
    logger.warn('automacaoVigia rejeitado: chave ausente ou incorreta.');
    res.status(403).send('nao autorizado');
    return;
  }

  let body = req.body;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || typeof body.action !== 'string') {
    res.status(400).send('envie JSON com "action"');
    return;
  }

  try {
    const agora = Date.now();
    // todo contato do vigia vale como "estou vivo" (o CRM mostra Mac conectado/desconectado)
    await VIGIA_STATUS.set({ ultimoContato: agora, versao: texto(body.versao, 30) }, { merge: true });

    if (body.action === 'ping') {
      res.status(200).json({ ok: true });
      return;
    }

    if (body.action === 'proximo') {
      const resultado = await db.runTransaction(async (tx) => {
        // 1) pedido que ficou "executando" por tempo demais vira erro (nao trava a fila)
        const parados = await tx.get(db.collection(PEDIDOS).where('status', '==', 'executando').limit(10));
        let jaExecutando = false;
        parados.docs.forEach((d) => {
          const iniciado = Number(d.data().iniciadoEm) || 0;
          if (agora - iniciado > EXECUCAO_PARADA_MS) {
            tx.update(d.ref, {
              status: 'erro',
              finalizadoEm: agora,
              resultado: { analisados: 0, atualizados: 0, pendencias: 0, falhas: 1, resumo: 'Interrompido: o computador parou de responder durante a execução.' },
            });
          } else {
            jaExecutando = true;
          }
        });
        // 2) uma execucao por vez
        if (jaExecutando) return { pedido: null, motivo: 'ja_executando' };
        // sem orderBy no banco (evita indice composto): pega o mais antigo na memoria
        const fila = await tx.get(db.collection(PEDIDOS).where('status', '==', 'pendente').limit(30));
        if (fila.empty) return { pedido: null, motivo: 'fila_vazia' };
        const doc = fila.docs.slice().sort((a, b) => (a.data().criadoEm || 0) - (b.data().criadoEm || 0))[0];
        const d = doc.data();
        tx.update(doc.ref, { status: 'executando', iniciadoEm: agora, etapa: 'Iniciando' });
        return { pedido: { id: doc.id, tipo: d.tipo, modo: d.modo } };
      });
      res.status(200).json(resultado);
      return;
    }

    const id = texto(body.id, 80);
    if (!id) {
      res.status(400).send('falta "id" do pedido');
      return;
    }
    const ref = db.collection(PEDIDOS).doc(id);

    if (body.action === 'atualizar') {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists || snap.data().status !== 'executando') throw new Error('pedido nao esta executando');
        const upd = {};
        if (body.etapa !== undefined) upd.etapa = texto(body.etapa, 120);
        if (body.progresso !== undefined) upd.progresso = Math.min(100, inteiro(body.progresso));
        if (body.log) {
          const logs = (snap.data().logs || []).concat([{ em: agora, msg: texto(body.log, 300) }]);
          upd.logs = logs.slice(-MAX_LOGS);
        }
        tx.update(ref, upd);
      });
      res.status(200).json({ ok: true });
      return;
    }

    if (body.action === 'finalizar') {
      const status = String(body.status || '');
      if (STATUS_FINAIS.indexOf(status) === -1) {
        res.status(400).send('status deve ser concluido, parcial ou erro');
        return;
      }
      const r = body.resultado || {};
      const resultado = {
        analisados: inteiro(r.analisados),
        atualizados: inteiro(r.atualizados),
        pendencias: inteiro(r.pendencias),
        falhas: inteiro(r.falhas),
        resumo: texto(r.resumo, 500),
        detalhes: (Array.isArray(r.detalhes) ? r.detalhes : []).slice(0, MAX_DETALHES).map((x) => texto(x, 200)),
      };
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new Error('pedido nao existe');
        const d = snap.data();
        // reenvio do mesmo "finalizar" (queda de conexao) nao duplica nada
        if (STATUS_FINAIS.indexOf(d.status) !== -1) return;
        if (d.status !== 'executando') throw new Error('pedido nao esta executando');
        tx.update(ref, { status, finalizadoEm: agora, resultado, etapa: status === 'erro' ? 'Falhou' : 'Finalizado', progresso: 100 });
        // "Ultima execucao" de cada card (o CRM le isto direto)
        tx.set(db.collection(RESUMO).doc(d.tipo), {
          tipo: d.tipo, pedidoId: id, status, finalizadoEm: agora, modo: d.modo || 'previa',
          analisados: resultado.analisados, atualizados: resultado.atualizados,
          pendencias: resultado.pendencias, falhas: resultado.falhas, resumo: resultado.resumo,
        });
      });
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).send('action desconhecida');
  } catch (err) {
    logger.error('automacaoVigia erro: ' + (err && err.message));
    res.status(409).send(String((err && err.message) || 'erro'));
  }
});

