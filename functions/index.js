const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const { google } = require('googleapis');

admin.initializeApp();
const db = admin.firestore();

const GOOGLE_SERVICE_ACCOUNT_KEY = defineSecret('GOOGLE_SERVICE_ACCOUNT_KEY');
const MANUAL_SYNC_KEY = defineSecret('MANUAL_SYNC_KEY');

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

function getCalendarClient(keyJson) {
  const credentials = JSON.parse(keyJson);
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  });
  return google.calendar({ version: 'v3', auth });
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
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
// varredura completa dos ultimos 2 anos pra frente, o que tambem serve
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
        timeMin.setFullYear(timeMin.getFullYear() - 2);
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

async function runSync() {
  const calendar = getCalendarClient(GOOGLE_SERVICE_ACCOUNT_KEY.value());

  const stateSnap = await SYNC_STATE_DOC.get();
  const prevSyncToken = stateSnap.exists ? stateSnap.data().syncToken : null;

  const configSnap = await CONFIG_DOC.get();
  let testModeEmail = DEFAULT_TEST_MODE_EMAIL;
  if (configSnap.exists) {
    const configured = configSnap.data().testModeEmail;
    testModeEmail = configured ? String(configured).trim().toLowerCase() : null;
  }

  const { events, nextSyncToken, usedFullSync } = await fetchCalendarChanges(calendar, prevSyncToken);
  logger.info(`Eventos recebidos do Google Calendar: ${events.length} (${usedFullSync ? 'sincronizacao completa' : 'incremental'})`);

  const touchedEmails = new Set();
  let batch = db.batch();
  let writesInBatch = 0;

  for (const ev of events) {
    const ref = db.collection(EVENTS_COLLECTION).doc(ev.id);
    const oldSnap = await ref.get();
    if (oldSnap.exists) {
      (oldSnap.data().attendees || []).forEach((e) => touchedEmails.add(e));
    }

    const cancelled = ev.status === 'cancelled';
    const startDate = cancelled ? null : eventStartDate(ev);
    const attendees = cancelled ? [] : eventAttendeeEmails(ev);

    if (cancelled || !startDate || attendees.length === 0) {
      if (oldSnap.exists) {
        batch.delete(ref);
        writesInBatch++;
      }
      continue;
    }

    attendees.forEach((e) => touchedEmails.add(e));
    batch.set(ref, {
      start: startDate,
      attendees,
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
  secrets: [GOOGLE_SERVICE_ACCOUNT_KEY],
}, async () => {
  await runSync();
});

// Disparo manual (pra validar o Arthur antes de liberar geral), via GET
// https://<url-da-funcao>?key=<MANUAL_SYNC_KEY>
exports.syncGoogleCalendarNow = onRequest({
  region: REGION,
  secrets: [GOOGLE_SERVICE_ACCOUNT_KEY, MANUAL_SYNC_KEY],
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
