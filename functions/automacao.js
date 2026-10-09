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
const PATIENTS_DOC = db.doc('crmData/patients');

const STATUS_FINAIS = ['concluido', 'parcial', 'erro', 'cancelado'];
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
        const ordenados = fila.docs.slice().sort((a, b) => (a.data().criadoEm || 0) - (b.data().criadoEm || 0));
        // pedido cancelado antes de comecar nunca vai pro Mac
        const doc = ordenados.find((x) => !x.data().cancelarSolicitado);
        ordenados.filter((x) => x.data().cancelarSolicitado).forEach((x) => tx.update(x.ref, { status: 'cancelado', finalizadoEm: agora }));
        if (!doc) return { pedido: null, motivo: 'fila_vazia' };
        const d = doc.data();
        tx.update(doc.ref, { status: 'executando', iniciadoEm: agora, etapa: 'Iniciando' });
        return { pedido: { id: doc.id, tipo: d.tipo, modo: d.modo } };
      });
      res.status(200).json(resultado);
      return;
    }

    // Fotos e medidas: grava SO as datas (ultimasFotos / ultimasMedidas), e so quando a data do
    // Treino.io e MAIS NOVA que a do CRM (nunca volta no tempo). dryRun = previa (nao grava).
    if (body.action === 'gravarDatas') {
      const entries = Array.isArray(body.entries) ? body.entries.slice(0, 500) : [];
      const dryRun = body.dryRun === true;
      const dataOk = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
      const r = await db.runTransaction(async (tx) => {
        const snap = await tx.get(PATIENTS_DOC);
        const list = snap.exists ? (snap.data().list || []) : [];
        const porEmail = new Map();
        list.forEach((p) => { if (p.email) porEmail.set(String(p.email).trim().toLowerCase(), p); });
        const detalhes = [];
        const pulados = [];
        let atualizados = 0;
        entries.forEach((e) => {
          const email = String((e && e.email) || '').trim().toLowerCase();
          const p = porEmail.get(email);
          if (!p) { pulados.push('e-mail nao encontrado no CRM: ' + email); return; }
          [['ultimasFotos', 'fotos'], ['ultimasMedidas', 'medidas']].forEach(([campo, nome]) => {
            const novo = e[campo];
            if (!dataOk(novo)) return;
            if (p[campo] && String(p[campo]) >= novo) return; // CRM ja tem igual ou mais recente
            detalhes.push(p.nome + ': ' + nome + ' ' + (p[campo] || 'sem registro') + ' -> ' + novo);
            p[campo] = novo;
            atualizados++;
          });
        });
        if (atualizados && !dryRun) tx.set(PATIENTS_DOC, { list }, { merge: true });
        return { atualizados, detalhes, pulados };
      });
      logger.info('gravarDatas: ' + r.atualizados + ' data(s)' + (dryRun ? ' (previa)' : '') + ', ' + r.pulados.length + ' pulado(s).');
      res.status(200).json({ atualizados: r.atualizados, detalhes: r.detalhes, detalhesPulados: r.pulados, dryRun });
      return;
    }

    // Treinos e dietas: se o Treino.io tem ficha MAIS NOVA que a do CRM, cria no CRM uma ficha so
    // com a data (conteudo em branco, sem vencimento) - decisao do Angelo. Nunca mexe em ficha
    // existente. So pra quem tem o servico (Treino / Dieta) no CRM. dryRun = previa.
    if (body.action === 'gravarFichas') {
      const entries = Array.isArray(body.entries) ? body.entries.slice(0, 500) : [];
      const dryRun = body.dryRun === true;
      const dataOk = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
      const r = await db.runTransaction(async (tx) => {
        const snap = await tx.get(PATIENTS_DOC);
        const list = snap.exists ? (snap.data().list || []) : [];
        const porEmail = new Map();
        list.forEach((p) => { if (p.email) porEmail.set(String(p.email).trim().toLowerCase(), p); });
        const detalhes = [];
        const pulados = [];
        let criadas = 0;
        entries.forEach((e) => {
          const email = String((e && e.email) || '').trim().toLowerCase();
          const p = porEmail.get(email);
          if (!p) { pulados.push('e-mail nao encontrado no CRM: ' + email); return; }
          [['treino', 'fichasTreino', 'Treino'], ['dieta', 'fichasDieta', 'Dieta']].forEach(([chave, lista, nome]) => {
            const nova = e[chave];
            if (!dataOk(nova) || !String(p.servico || '').includes(nome)) return;
            const fichas = Array.isArray(p[lista]) ? p[lista] : [];
            const maisRecente = fichas.reduce((m, f) => (f && f.dataPassado && f.dataPassado > m ? f.dataPassado : m), '');
            if (maisRecente && maisRecente >= nova) return; // CRM ja tem ficha dessa data ou mais nova
            const novoId = fichas.reduce((m, f) => Math.max(m, Number(f && f.id) || 0), -1) + 1;
            const ficha = chave === 'treino'
              ? { id: novoId, dataPassado: nova, dataVencimento: '', expectativa: '', volumePorGrupo: {} }
              : { id: novoId, dataPassado: nova, expectativa: '', calorias: '', proteinas: '', carboidratos: '', gorduras: '' };
            p[lista] = fichas.concat([ficha]);
            criadas++;
            detalhes.push(p.nome + ': ficha de ' + nome.toLowerCase() + ' de ' + nova + ' (CRM tinha ' + (maisRecente || 'nenhuma') + ')' + (chave === 'treino' ? ' - defina o vencimento' : ''));
          });
        });
        if (criadas && !dryRun) tx.set(PATIENTS_DOC, { list }, { merge: true });
        return { criadas, detalhes, pulados };
      });
      logger.info('gravarFichas: ' + r.criadas + ' ficha(s)' + (dryRun ? ' (previa)' : '') + ', ' + r.pulados.length + ' pulado(s).');
      res.status(200).json({ criadas: r.criadas, detalhes: r.detalhes, detalhesPulados: r.pulados, dryRun });
      return;
    }

    const id = texto(body.id, 80);
    if (!id) {
      res.status(400).send('falta "id" do pedido');
      return;
    }
    const ref = db.collection(PEDIDOS).doc(id);

    if (body.action === 'atualizar') {
      // devolve cancelar:true se o Angelo pediu pra cancelar (o vigia para na hora)
      const cancelar = await db.runTransaction(async (tx) => {
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
        return !!snap.data().cancelarSolicitado;
      });
      res.status(200).json({ ok: true, cancelar });
      return;
    }

    if (body.action === 'finalizar') {
      const status = String(body.status || '');
      if (STATUS_FINAIS.indexOf(status) === -1) {
        res.status(400).send('status deve ser concluido, parcial, erro ou cancelado');
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
        tx.update(ref, { status, finalizadoEm: agora, resultado, etapa: status === 'erro' ? 'Falhou' : status === 'cancelado' ? 'Cancelado' : 'Finalizado', progresso: 100 });
        // cancelamento nao apaga o resumo da ultima execucao de verdade
        if (status === 'cancelado') return;
        // "Ultima execucao" de cada card (o CRM le isto direto)
        tx.set(db.collection(RESUMO).doc(d.tipo), {
          tipo: d.tipo, pedidoId: id, status, finalizadoEm: agora, modo: d.modo || 'previa',
          avisos: resultado.detalhes.filter((x) => /^(Pulado|Falha):/.test(x)).slice(0, 20),
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

