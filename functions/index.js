const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const { google } = require('googleapis');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();

// Autenticacao OAuth como o proprio dono do calendario (nao service account):
// so assim a API do Google devolve a lista de convidados dos eventos. Uma
// service account, mesmo com o calendario compartilhado, so ve o organizador.
const GOOGLE_OAUTH_CLIENT_ID = defineSecret('GOOGLE_OAUTH_CLIENT_ID');
const GOOGLE_OAUTH_CLIENT_SECRET = defineSecret('GOOGLE_OAUTH_CLIENT_SECRET');
const GOOGLE_OAUTH_REFRESH_TOKEN = defineSecret('GOOGLE_OAUTH_REFRESH_TOKEN');
const MANUAL_SYNC_KEY = defineSecret('MANUAL_SYNC_KEY');
const TREINO_SYNC_KEY = defineSecret('TREINO_SYNC_KEY');

const OAUTH_SECRETS = [GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN];

const REGION = 'southamerica-east1';
const CALENDAR_ID = 'primary';
const EVENTS_COLLECTION = 'calendarEvents';

// Modo teste validado e aprovado (19/09/2026) - sincronizacao liberada pra
// todos os pacientes por padrao. O documento crmData/googleCalendarConfig
// ainda pode restringir a um email especifico se definir testModeEmail.
const DEFAULT_TEST_MODE_EMAIL = null;

const SYNC_STATE_DOC = db.doc('calendarSync/state');
const CONFIG_DOC = db.doc('crmData/googleCalendarConfig');
const PATIENTS_DOC = db.doc('crmData/patients');

// Unico usuario autorizado a gerar codigo de sincronizacao (Angelo). Mesma
// pessoa que ja e a unica com permissao de trocar senha no CRM
// (SENHA_EMAIL_PERMITIDO em index.html) - confirmado via UID real do
// Firebase Auth, nao da pra falsificar.
const ALLOWED_MINT_UID = 'uLicObTjbnZS5D3uIRKHLFlxhcO2';
const SYNC_TOKENS_COLLECTION = 'syncTokens';
const SYNC_BATCHES_COLLECTION = 'syncBatches';
const SYNC_TOKEN_TTL_MS = 10 * 60 * 1000;

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function getCalendarClient() {
  const auth = new google.auth.OAuth2(
    GOOGLE_OAUTH_CLIENT_ID.value(),
    GOOGLE_OAUTH_CLIENT_SECRET.value(),
  );
  auth.setCredentials({ refresh_token: GOOGLE_OAUTH_REFRESH_TOKEN.value() });
  return google.calendar({ version: 'v3', auth });
}

// Data de hoje no fuso do Brasil (nao UTC - toISOString() erraria o dia
// entre 21h e meia-noite no horario de Brasilia).
function todayIso() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// Mesma regra de "Vencido" usada no CRM (renovacaoStatus em index.html):
// vencimento antes de hoje = vencido. So olha a data, nao outros campos.
function isVencido(p, todayStr) {
  if (!p || !p.vencimento) return false;
  return p.vencimento < todayStr;
}

// ---- Mesma logica de semanas/check-in do index.html (copiada, nao reinventada) ----
function monthKeyOf(y, m0) {
  return y + '-' + String(m0 + 1).padStart(2, '0');
}
function parseMonthKey(key) {
  const parts = key.split('-');
  return { year: parseInt(parts[0], 10), month: parseInt(parts[1], 10) - 1 };
}
function getFridaysInMonth(year, monthIndex0) {
  let count = 0;
  const d = new Date(year, monthIndex0, 1);
  while (d.getMonth() === monthIndex0) {
    if (d.getDay() === 5) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}
function weeksInMonth(key) {
  const p = parseMonthKey(key);
  return getFridaysInMonth(p.year, p.month);
}
function isoDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function addDaysIso(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return isoDate(d);
}
function nthFridayDate(monthKey, weekIndex) {
  const parsed = parseMonthKey(monthKey);
  const d = new Date(parsed.year, parsed.month, 1);
  const fridays = [];
  while (d.getMonth() === parsed.month) {
    if (d.getDay() === 5) fridays.push(isoDate(d));
    d.setDate(d.getDate() + 1);
  }
  return fridays[weekIndex] || null;
}
// Janela do check-in: sexta (dia oficial) ate segunda (sexta+3 dias) - mesma
// regra do CRM pra casar uma data de checkin com a semana correta.
function weekIndexForDate(monthKey, dateStr) {
  if (!dateStr) return -1;
  const wk = weeksInMonth(monthKey);
  for (let i = 0; i < wk; i++) {
    const friday = nthFridayDate(monthKey, i);
    if (!friday) continue;
    if (dateStr >= friday && dateStr <= addDaysIso(friday, 3)) return i;
  }
  return -1;
}
function isTreinoQuinzenal(p) {
  return !!p && p.servico === 'Treino';
}
function isEssencialMensal(p) {
  return !!p && (p.plano === 'Essencial Trimestral' || p.plano === 'Essencial Semestral');
}
// Acha em qual mes/semana uma data de check-in cai. Tenta o mes da propria
// data e o mes anterior (a janela sexta-a-segunda pode virar o mes, ex:
// sexta 30/08 com check-in na segunda 01/09).
function resolveMonthAndWeek(p, dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const prevMonth = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const candidates = [
    monthKeyOf(d.getFullYear(), d.getMonth()),
    monthKeyOf(prevMonth.getFullYear(), prevMonth.getMonth()),
  ];
  for (const monthKey of candidates) {
    const rawIndex = weekIndexForDate(monthKey, dateStr);
    if (rawIndex === -1) continue;
    let weekIndex = rawIndex;
    if (isEssencialMensal(p)) weekIndex = 0;
    else if (isTreinoQuinzenal(p)) weekIndex = rawIndex < 2 ? 0 : 2;
    return { monthKey, weekIndex };
  }
  return null;
}

function eventStartDate(ev) {
  if (!ev.start) return null;
  if (ev.start.date) return ev.start.date;
  if (ev.start.dateTime) return ev.start.dateTime.slice(0, 10);
  return null;
}

function eventAttendeeEmails(ev) {
  if (!ev.attendees) return [];
  return ev.attendees
    .map((a) => (a.email || '').trim().toLowerCase())
    .filter(Boolean);
}

// Busca eventos novos/alterados/cancelados desde a ultima sincronizacao.
// Sem syncToken guardado (primeira vez, ou token expirado), faz uma
// varredura completa dos ultimos 6 meses pra frente, o que tambem serve
// como backfill dos pacientes com data desatualizada.
async function fetchCalendarChanges(calendar, syncToken) {
  let events = [];
  let pageToken;
  let nextSyncToken = null;
  const usedFullSync = !syncToken;
  try {
    do {
      const params = {
        calendarId: CALENDAR_ID,
        singleEvents: true,
        showDeleted: true,
        maxResults: 250,
        pageToken,
      };
      if (syncToken) {
        params.syncToken = syncToken;
      } else {
        const timeMin = new Date();
        timeMin.setMonth(timeMin.getMonth() - 6);
        params.timeMin = timeMin.toISOString();
      }
      const resp = await calendar.events.list(params);
      events = events.concat(resp.data.items || []);
      pageToken = resp.data.nextPageToken;
      if (resp.data.nextSyncToken) nextSyncToken = resp.data.nextSyncToken;
    } while (pageToken);
  } catch (err) {
    if (err.code === 410) {
      logger.warn('syncToken expirado ou invalido, refazendo sincronizacao completa.');
      return fetchCalendarChanges(calendar, null);
    }
    throw err;
  }
  return { events, nextSyncToken, usedFullSync };
}

// Recalcula a "Data da Consulta" dos pacientes cujo e-mail apareceu em algum
// evento tocado nesta rodada. Regra: consulta futura mais proxima; se nao
// houver nenhuma futura, a mais recente ja realizada; se nao houver nenhum
// evento vinculado, nao mexe no campo.
async function recomputePatients(emails, testModeEmail) {
  const today = todayIso();
  const computedByEmail = {};

  for (const email of emails) {
    const snap = await db.collection(EVENTS_COLLECTION).where('attendees', 'array-contains', email).get();
    if (snap.empty) continue;
    const future = [];
    const past = [];
    snap.forEach((doc) => {
      const start = doc.data().start;
      if (!start) return;
      if (start >= today) future.push(start);
      else past.push(start);
    });
    future.sort();
    past.sort();
    if (future.length > 0) computedByEmail[email] = future[0];
    else if (past.length > 0) computedByEmail[email] = past[past.length - 1];
  }

  if (Object.keys(computedByEmail).length === 0) return;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(PATIENTS_DOC);
    if (!snap.exists) return;
    const list = snap.data().list || [];
    let changed = false;
    const appliedLog = [];
    const skippedLog = [];

    list.forEach((p) => {
      if (!p.email) return;
      if (isVencido(p, today)) return;
      const email = String(p.email).trim().toLowerCase();
      const newDate = computedByEmail[email];
      if (!newDate || p.consulta === newDate) return;

      if (testModeEmail && email !== testModeEmail) {
        skippedLog.push(`${p.nome} (${email}): ${p.consulta || '(vazio)'} -> ${newDate} [modo teste, NAO aplicado]`);
        return;
      }
      appliedLog.push(`${p.nome} (${email}): ${p.consulta || '(vazio)'} -> ${newDate}`);
      p.consulta = newDate;
      changed = true;
    });

    if (appliedLog.length) logger.info('Datas de consulta atualizadas:\n' + appliedLog.join('\n'));
    if (skippedLog.length) logger.info('Modo teste ativo (crmData/googleCalendarConfig.testModeEmail) - nao aplicado:\n' + skippedLog.join('\n'));
    if (changed) tx.set(PATIENTS_DOC, { list }, { merge: true });
  });
}

async function runSync({ forceFullSync = false } = {}) {
  const calendar = getCalendarClient();

  const stateSnap = await SYNC_STATE_DOC.get();
  const prevSyncToken = forceFullSync ? null : (stateSnap.exists ? stateSnap.data().syncToken : null);

  const configSnap = await CONFIG_DOC.get();
  let testModeEmail = DEFAULT_TEST_MODE_EMAIL;
  if (configSnap.exists) {
    const configured = configSnap.data().testModeEmail;
    testModeEmail = configured ? String(configured).trim().toLowerCase() : null;
  }

  // So sincroniza paciente ativo (nao "Vencido"). Um inativo so volta a
  // ser sincronizado quando reativar (o gatilho onPatientsChange forca
  // uma varredura completa nesse momento, ja com ele ativo de novo).
  const today = todayIso();
  const patientsSnap = await PATIENTS_DOC.get();
  const patientEmails = new Set(
    (patientsSnap.exists ? patientsSnap.data().list || [] : [])
      .filter((p) => !isVencido(p, today))
      .map((p) => (p.email ? String(p.email).trim().toLowerCase() : null))
      .filter(Boolean)
  );

  const { events, nextSyncToken, usedFullSync } = await fetchCalendarChanges(calendar, prevSyncToken);
  logger.info(`Eventos recebidos do Google Calendar: ${events.length} (${usedFullSync ? 'sincronizacao completa' : 'incremental'})`);

  const touchedEmails = new Set();
  let batch = db.batch();
  let writesInBatch = 0;

  for (const ev of events) {
    const ref = db.collection(EVENTS_COLLECTION).doc(ev.id);
    const cancelled = ev.status === 'cancelled';
    const startDate = cancelled ? null : eventStartDate(ev);
    const attendees = cancelled ? [] : eventAttendeeEmails(ev);

    // So le o doc anterior fora da sincronizacao completa: numa varredura
    // total nao existe historico previo relevante (evento cancelado nem
    // aparece sem syncToken), e isso evita 1 leitura por evento quando sao
    // milhares (o que estourava o tempo limite da funcao).
    let oldSnap = null;
    if (!usedFullSync) {
      oldSnap = await ref.get();
      if (oldSnap.exists) {
        (oldSnap.data().attendees || []).forEach((e) => touchedEmails.add(e));
      }
    }

    const relevantAttendees = attendees.filter((e) => patientEmails.has(e));

    if (cancelled || !startDate || relevantAttendees.length === 0) {
      if (oldSnap && oldSnap.exists) {
        batch.delete(ref);
        writesInBatch++;
      }
      continue;
    }

    relevantAttendees.forEach((e) => touchedEmails.add(e));
    batch.set(ref, {
      start: startDate,
      attendees: relevantAttendees,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    writesInBatch++;

    if (writesInBatch >= 400) {
      await batch.commit();
      batch = db.batch();
      writesInBatch = 0;
    }
  }
  if (writesInBatch > 0) await batch.commit();

  logger.info(`E-mails a recalcular: ${touchedEmails.size}`);
  if (touchedEmails.size > 0) {
    await recomputePatients(Array.from(touchedEmails), testModeEmail);
  }

  await SYNC_STATE_DOC.set({
    syncToken: nextSyncToken || prevSyncToken || null,
    lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

// Roda sozinha a cada 15 minutos.
exports.syncGoogleCalendar = onSchedule({
  schedule: 'every 15 minutes',
  timeZone: 'America/Sao_Paulo',
  region: REGION,
  secrets: OAUTH_SECRETS,
  timeoutSeconds: 300,
  memory: '512MiB',
}, async () => {
  await runSync();
});

// Disparo manual (pra validar o Arthur antes de liberar geral), via GET
// https://<url-da-funcao>?key=<MANUAL_SYNC_KEY>
exports.syncGoogleCalendarNow = onRequest({
  region: REGION,
  secrets: [...OAUTH_SECRETS, MANUAL_SYNC_KEY],
  timeoutSeconds: 300,
  memory: '512MiB',
}, async (req, res) => {
  if (req.query.key !== MANUAL_SYNC_KEY.value()) {
    res.status(403).send('nao autorizado');
    return;
  }
  try {
    await runSync();
    res.status(200).send('Sincronizacao concluida. Veja o resultado nos logs da funcao (Firebase Console > Functions > Logs).');
  } catch (err) {
    logger.error(err);
    res.status(500).send('Erro: ' + err.message);
  }
});

// Dispara uma sincronizacao COMPLETA (nao a incremental de 15 em 15 min)
// só quando: (a) um paciente novo com e-mail e criado, (b) um paciente
// existente deixa de estar "Vencido" por causa de mudanca no vencimento
// (reativacao), ou (c) o e-mail de um paciente existente muda (ex: corrigir
// e-mail digitado errado) - a vinculacao com o Calendar e por e-mail, entao
// um e-mail corrigido so passa a achar os eventos dele numa varredura
// completa, ja que a incremental so revisita evento que foi tocado no
// Calendar. Edicao de qualquer outro campo (nome, telefone, plano etc.) nao
// dispara nada.
exports.onPatientsChange = onDocumentWritten({
  document: 'crmData/patients',
  region: REGION,
  secrets: OAUTH_SECRETS,
  timeoutSeconds: 300,
  memory: '512MiB',
}, async (event) => {
  if (!event.data || !event.data.after.exists) return;
  const beforeList = event.data.before && event.data.before.exists ? (event.data.before.data().list || []) : [];
  const afterList = event.data.after.data().list || [];
  const beforeById = new Map(beforeList.map((p) => [p.id, p]));
  const today = todayIso();

  const reasons = [];
  afterList.forEach((p) => {
    const prev = beforeById.get(p.id);
    if (!prev) {
      if (p.email) reasons.push(`paciente novo: ${p.nome}`);
      return;
    }
    if (isVencido(prev, today) && !isVencido(p, today)) {
      reasons.push(`reativado (vencimento): ${p.nome}`);
    }
    const prevEmail = prev.email ? String(prev.email).trim().toLowerCase() : '';
    const newEmail = p.email ? String(p.email).trim().toLowerCase() : '';
    if (newEmail && prevEmail !== newEmail) {
      reasons.push(`e-mail alterado: ${p.nome}`);
    }
  });

  if (reasons.length === 0) return;
  logger.info('Gatilho de sincronizacao completa (cadastro/reativacao):\n' + reasons.join('\n'));
  await runSync({ forceFullSync: true });
});

// Endpoint pra automacao externa (Treino.io) lancar check-in, peso em jejum
// e as respostas das perguntas com emoji 💬. So mexe em checkin/peso/pesoData/
// obsCheckin, paciente a paciente, pelo e-mail - nao toca em mais nada do
// cadastro. Autenticacao por chave propria (TREINO_SYNC_KEY), separada da
// chave de sincronizacao do Calendar.
//
// POST https://<url-da-funcao>?key=<TREINO_SYNC_KEY>
// Body JSON: { "entries": [
//   { "email": "paciente@x.com", "date": "2026-09-20", "enviou": true,
//     "peso": 78.4, "observacoes": ["texto da resposta 1", "texto 2"] },
//   ...
// ] }
// "peso" e "observacoes" sao opcionais.
//
// Idempotencia (reenvio seguro):
// - peso: se ja existir peso gravado pra mesma data, so reaplica se for
//   igual (nao duplica); se for diferente, NAO sobrescreve - fica como
//   divergencia na resposta. Data diferente da ja gravada no slot da
//   semana = atualizacao normal (checkin mais recente daquela semana).
// - observacoes: cada resposta vira uma linha entre aspas no campo de
//   observacoes do check-in daquela semana; reenviar a mesma linha nao
//   duplica. Texto que ja estava la (nao entre aspas, digitado a mao) nunca
//   e apagado nem sobrescrito, so preservado.
function appendObservacoes(existente, novasRespostas) {
  const linhas = existente ? existente.split('\n') : [];
  let adicionadas = 0;
  novasRespostas.forEach((texto) => {
    if (typeof texto !== 'string') return;
    const limpo = texto.trim();
    if (!limpo) return;
    const lower = limpo.toLowerCase();
    if (lower === 'não respondido' || lower === 'nao respondido') return;
    const linha = '"' + limpo + '"';
    if (linhas.indexOf(linha) !== -1) return;
    linhas.push(linha);
    adicionadas++;
  });
  return { texto: linhas.join('\n'), adicionadas };
}

// Gera um codigo de sincronizacao temporario (10 min, uso unico), pra quem
// nao tem a chave permanente (ex: um agente de IA) conseguir mandar UM lote
// pro syncCheckins sem nunca ter acesso a chave de verdade. So funciona pra
// quem esta logado no CRM como o Angelo (verificado pelo token do Firebase
// Auth, nao da pra chamar isso sem estar logado).
//
// POST https://<url-da-funcao>?  (sem parametro nenhum)
// Header: Authorization: Bearer <idToken do Firebase Auth>
exports.mintSyncCheckinsToken = onRequest({
  region: REGION,
  timeoutSeconds: 30,
  memory: '256MiB',
}, async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).send('use POST');
    return;
  }

  const authHeader = req.get('Authorization') || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) {
    res.status(401).send('faltou header Authorization: Bearer <idToken>');
    return;
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (err) {
    res.status(401).send('token invalido ou expirado');
    return;
  }
  if (decoded.uid !== ALLOWED_MINT_UID) {
    res.status(403).send('usuario nao autorizado a gerar codigo de sincronizacao');
    return;
  }

  // limite de geracao: no maximo 20 codigos por hora, pra essa mesma pessoa.
  // Filtro so por igualdade (mintedByUid) + contagem na memoria, de proposito
  // - assim nao depende de criar indice composto no Firestore.
  const umaHoraAtrasMs = Date.now() - 60 * 60 * 1000;
  const recentesSnap = await db.collection(SYNC_TOKENS_COLLECTION)
    .where('mintedByUid', '==', decoded.uid)
    .limit(200)
    .get();
  const geradosNaUltimaHora = recentesSnap.docs.filter((d) => d.data().createdAt.toMillis() > umaHoraAtrasMs).length;
  if (geradosNaUltimaHora >= 20) {
    res.status(429).send('limite de codigos gerados por hora atingido, tente novamente mais tarde');
    return;
  }

  const token = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  const expiresAt = now + SYNC_TOKEN_TTL_MS;
  await db.collection(SYNC_TOKENS_COLLECTION).doc(token).set({
    createdAt: admin.firestore.Timestamp.fromMillis(now),
    expiresAt: admin.firestore.Timestamp.fromMillis(expiresAt),
    used: false,
    mintedByUid: decoded.uid,
  });

  logger.info(`Codigo de sincronizacao gerado (expira em 10 min).`);
  res.status(200).json({ token, expiresAt });
});

// POST /syncCheckins - agora aceita DOIS jeitos de autenticar:
// 1) ?key=<TREINO_SYNC_KEY> - a chave permanente de sempre, sem mudancas.
// 2) ?token=<codigo> - um codigo de uso unico gerado por mintSyncCheckinsToken.
//    E consumido (marcado como usado) na hora, antes de processar - uma
//    segunda tentativa com o mesmo codigo e recusada.
//
// batchId (opcional, no corpo): identifica um lote. Se o mesmo batchId for
// reenviado (ex: o chamador nao recebeu a resposta por queda de conexao),
// o endpoint NAO reprocessa - devolve as mesmas contagens ja aplicadas da
// primeira vez, sem duplicar nada. So fica salvo metadado minimo do lote
// (id, hora, status, contagens) - nunca nome, e-mail, peso ou observacao.
exports.syncCheckins = onRequest({
  region: REGION,
  secrets: [TREINO_SYNC_KEY],
  timeoutSeconds: 120,
  memory: '256MiB',
}, async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).send('use POST');
    return;
  }

  const providedKey = req.query.key;
  const providedToken = req.query.token;
  let authOk = false;

  if (providedKey && providedKey === TREINO_SYNC_KEY.value()) {
    authOk = true;
  } else if (providedToken) {
    const tokenRef = db.collection(SYNC_TOKENS_COLLECTION).doc(String(providedToken));
    authOk = await db.runTransaction(async (tx) => {
      const snap = await tx.get(tokenRef);
      if (!snap.exists) return false;
      const data = snap.data();
      if (data.used) return false;
      if (data.expiresAt.toMillis() < Date.now()) return false;
      tx.update(tokenRef, { used: true, usedAt: admin.firestore.FieldValue.serverTimestamp() });
      return true;
    });
  }

  if (!authOk) {
    res.status(403).send('nao autorizado');
    return;
  }

  const entries = req.body && Array.isArray(req.body.entries) ? req.body.entries : null;
  if (!entries) {
    res.status(400).send('body precisa ser { "entries": [ {email, date, enviou, peso, observacoes}, ... ], "batchId": "opcional" }');
    return;
  }
  const batchId = req.body && req.body.batchId ? String(req.body.batchId).slice(0, 100) : null;

  try {
    if (batchId) {
      const batchSnap = await db.collection(SYNC_BATCHES_COLLECTION).doc(batchId).get();
      if (batchSnap.exists && batchSnap.data().status === 'completed') {
        res.status(200).json(Object.assign({ reenvio: true }, batchSnap.data().counts));
        return;
      }
    }

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(PATIENTS_DOC);
      if (!snap.exists) {
        return { logLines: [], skipped: ['crmData/patients nao existe'], divergenciasPeso: [], checkins: 0, pesos: 0, observacoes: 0 };
      }
      const list = snap.data().list || [];
      const byEmail = new Map();
      list.forEach((p) => {
        if (p.email) byEmail.set(String(p.email).trim().toLowerCase(), p);
      });

      const logLines = [];
      const skipped = [];
      const divergenciasPeso = [];
      let checkinsAplicados = 0;
      let pesosAplicados = 0;
      let observacoesAplicadas = 0;
      let algumaMudanca = false;

      entries.forEach((entry) => {
        const email = entry && entry.email ? String(entry.email).trim().toLowerCase() : null;
        const date = entry && entry.date ? String(entry.date).slice(0, 10) : null;
        if (!email || !date) {
          skipped.push(`entrada invalida (faltou email ou date): ${JSON.stringify(entry)}`);
          return;
        }
        const p = byEmail.get(email);
        if (!p) {
          skipped.push(`e-mail nao encontrado no CRM: ${email}`);
          return;
        }

        const resolved = resolveMonthAndWeek(p, date);
        if (!resolved) {
          skipped.push(`${p.nome}: data ${date} nao caiu em nenhuma semana de check-in valida`);
          return;
        }
        const { monthKey, weekIndex } = resolved;
        const wk = weeksInMonth(monthKey);

        if (!p.meses) p.meses = {};
        if (!p.meses[monthKey]) p.meses[monthKey] = {};
        const mes = p.meses[monthKey];
        if (!Array.isArray(mes.checkin)) mes.checkin = [];
        if (!Array.isArray(mes.peso)) mes.peso = [];
        if (!Array.isArray(mes.pesoData)) mes.pesoData = [];
        if (!Array.isArray(mes.obsCheckin)) mes.obsCheckin = [];
        while (mes.checkin.length < wk) mes.checkin.push(null);
        while (mes.peso.length < wk) mes.peso.push(null);
        while (mes.pesoData.length < wk) mes.pesoData.push(null);
        while (mes.obsCheckin.length < wk) mes.obsCheckin.push('');

        const partesLog = [`${p.nome}: ${monthKey} semana ${weekIndex + 1}`];

        if (typeof entry.enviou === 'boolean') {
          mes.checkin[weekIndex] = entry.enviou;
          checkinsAplicados++;
          algumaMudanca = true;
          partesLog.push(`enviou=${entry.enviou}`);
        }

        if (entry.peso !== undefined && entry.peso !== null && entry.peso !== '') {
          const novoPeso = Number(entry.peso);
          const pesoAtual = mes.peso[weekIndex];
          const dataAtual = mes.pesoData[weekIndex];
          if (pesoAtual === null || pesoAtual === undefined) {
            mes.peso[weekIndex] = novoPeso;
            mes.pesoData[weekIndex] = date;
            pesosAplicados++;
            algumaMudanca = true;
            partesLog.push(`peso=${novoPeso}`);
          } else if (dataAtual === date) {
            if (Number(pesoAtual) === novoPeso) {
              partesLog.push(`peso=${novoPeso} (ja gravado, reenvio ignorado)`);
            } else {
              divergenciasPeso.push(`${p.nome} (${email}) em ${date}: ja gravado ${pesoAtual}kg, recebido ${novoPeso}kg - NAO sobrescrito`);
            }
          } else {
            mes.peso[weekIndex] = novoPeso;
            mes.pesoData[weekIndex] = date;
            pesosAplicados++;
            algumaMudanca = true;
            partesLog.push(`peso=${novoPeso} (atualizado, data anterior ${dataAtual})`);
          }
        }

        if (Array.isArray(entry.observacoes) && entry.observacoes.length) {
          const resultado = appendObservacoes(mes.obsCheckin[weekIndex] || '', entry.observacoes);
          if (resultado.adicionadas > 0) {
            mes.obsCheckin[weekIndex] = resultado.texto;
            observacoesAplicadas += resultado.adicionadas;
            algumaMudanca = true;
            partesLog.push(`+${resultado.adicionadas} observacao(oes)`);
          }
        }

        if (partesLog.length > 1) logLines.push(partesLog.join(' -> '));
      });

      if (algumaMudanca) tx.set(PATIENTS_DOC, { list }, { merge: true });
      return { logLines, skipped, divergenciasPeso, checkins: checkinsAplicados, pesos: pesosAplicados, observacoes: observacoesAplicadas };
    });

    // Log so com CONTAGENS - nunca nome, e-mail, peso ou texto de observacao.
    // O detalhe (com identificacao do paciente) vai so na resposta HTTP,
    // direto pra quem chamou autenticado - nunca fica gravado em log.
    logger.info(`syncCheckins: ${result.checkins} check-in(s), ${result.pesos} peso(s), ${result.observacoes} observacao(oes) aplicados; ${result.skipped.length} pulado(s); ${result.divergenciasPeso.length} divergencia(s) de peso.`);

    const respostaCounts = {
      checkinsAplicados: result.checkins,
      pesosAplicados: result.pesos,
      observacoesAplicadas: result.observacoes,
      pulados: result.skipped.length,
      detalhesPulados: result.skipped,
      divergenciasPeso: result.divergenciasPeso,
    };

    if (batchId) {
      // Metadado MINIMO do lote - so pra permitir confirmar depois se um
      // reenvio ja tinha sido aplicado, sem guardar nenhum dado de paciente.
      await db.collection(SYNC_BATCHES_COLLECTION).doc(batchId).set({
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'completed',
        counts: {
          checkinsAplicados: result.checkins,
          pesosAplicados: result.pesos,
          observacoesAplicadas: result.observacoes,
          pulados: result.skipped.length,
          divergenciasPeso: result.divergenciasPeso.length,
        },
      });
    }

    res.status(200).json(respostaCounts);
  } catch (err) {
    logger.error('Erro em syncCheckins: ' + err.message);
    res.status(500).send('Erro: ' + err.message);
  }
});
