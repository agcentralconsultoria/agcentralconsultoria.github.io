const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const { google } = require('googleapis');

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

// Enquanto o documento crmData/googleCalendarConfig nao existir no Firestore,
// so o paciente de teste (Arthur) recebe a data automatica - por seguranca,
// pra nao aplicar em producao antes da validacao. Depois de validar, crie o
// documento crmData/googleCalendarConfig com { testModeEmail: null } pra
// liberar a sincronizacao geral.
const DEFAULT_TEST_MODE_EMAIL = 'arthur.garcia10@hotmail.com';

const SYNC_STATE_DOC = db.doc('calendarSync/state');
const CONFIG_DOC = db.doc('crmData/googleCalendarConfig');
const PATIENTS_DOC = db.doc('crmData/patients');

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
// só quando: (a) um paciente novo com e-mail e criado, ou (b) um paciente
// existente deixa de estar "Vencido" por causa de mudanca no vencimento
// (reativacao). So assim da pra achar uma consulta que ja existia no
// Calendar antes do cadastro, ou que rolou enquanto ele estava inativo.
// Edicao de qualquer outro campo (nome, telefone, e-mail, plano etc.) nao
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
  });

  if (reasons.length === 0) return;
  logger.info('Gatilho de sincronizacao completa (cadastro/reativacao):\n' + reasons.join('\n'));
  await runSync({ forceFullSync: true });
});

// Endpoint pra automacao externa (Treino.io) lancar check-in + peso em jejum.
// So mexe nesses dois campos, paciente a paciente, pelo e-mail - nao toca em
// mais nada do cadastro. Autenticacao por chave propria (TREINO_SYNC_KEY),
// separada da chave de sincronizacao do Calendar.
//
// POST https://<url-da-funcao>?key=<TREINO_SYNC_KEY>
// Body JSON: { "entries": [
//   { "email": "paciente@x.com", "date": "2026-09-20", "enviou": true, "peso": 78.4 },
//   ...
// ] }
// "peso" e opcional (omitir ou null se so o check-in foi enviado sem peso).
exports.syncCheckins = onRequest({
  region: REGION,
  secrets: [TREINO_SYNC_KEY],
  timeoutSeconds: 120,
  memory: '256MiB',
}, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('use POST');
    return;
  }
  if (req.query.key !== TREINO_SYNC_KEY.value()) {
    res.status(403).send('nao autorizado');
    return;
  }
  const entries = req.body && Array.isArray(req.body.entries) ? req.body.entries : null;
  if (!entries) {
    res.status(400).send('body precisa ser { "entries": [ {email, date, enviou, peso}, ... ] }');
    return;
  }

  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(PATIENTS_DOC);
      if (!snap.exists) return { applied: [], skipped: ['crmData/patients nao existe'] };
      const list = snap.data().list || [];
      const byEmail = new Map();
      list.forEach((p) => {
        if (p.email) byEmail.set(String(p.email).trim().toLowerCase(), p);
      });

      const applied = [];
      const skipped = [];

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
        while (mes.checkin.length < wk) mes.checkin.push(null);
        while (mes.peso.length < wk) mes.peso.push(null);
        while (mes.pesoData.length < wk) mes.pesoData.push(null);

        if (typeof entry.enviou === 'boolean') mes.checkin[weekIndex] = entry.enviou;
        if (entry.peso !== undefined && entry.peso !== null && entry.peso !== '') {
          mes.peso[weekIndex] = Number(entry.peso);
          mes.pesoData[weekIndex] = date;
        }
        applied.push(`${p.nome}: ${monthKey} semana ${weekIndex + 1} -> enviou=${entry.enviou}, peso=${entry.peso === undefined ? '(nao enviado)' : entry.peso}`);
      });

      if (applied.length) tx.set(PATIENTS_DOC, { list }, { merge: true });
      return { applied, skipped };
    });

    if (result.applied.length) logger.info('Check-ins do Treino.io aplicados:\n' + result.applied.join('\n'));
    if (result.skipped.length) logger.info('Check-ins do Treino.io pulados:\n' + result.skipped.join('\n'));

    res.status(200).json({ aplicados: result.applied.length, pulados: result.skipped.length, detalhesPulados: result.skipped });
  } catch (err) {
    logger.error(err);
    res.status(500).send('Erro: ' + err.message);
  }
});
