// Ponte direta com a extensão "Meu WaSpeed": a extensão lê o resumo dos pacientes e
// manda edições (vencimento, nascimento, consulta, telefone) sem precisar do CRM aberto.
const { onRequest } = require('firebase-functions/v2/https');
const crypto = require('crypto');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

// Só a impressão digital (SHA-256) da chave fica aqui; a chave em si fica só na extensão.
const KEY_SHA256 = '5018259ed4f52ca04bf233ff054f51eb177a09bfc2367069e7aa8a5732dcf73e';
const REGION = 'southamerica-east1';

function resumo(p) {
  const meses = typeof p.meses === 'object' ? '' : (p.meses || '');
  return { id: p.id || '', nome: p.nome || '', telefone: p.telefone || '', vencimento: p.vencimento || '',
    nascimento: p.nascimento || '', inicioPlano: p.inicioPlano || '', meses, plano: p.plano || '', consulta: p.consulta || '', email: p.email || '' };
}

exports.extPonte = onRequest({ region: REGION, cors: false }, async (req, res) => {
  if (crypto.createHash('sha256').update(String(req.get('x-key') || '')).digest('hex') !== KEY_SHA256) { res.status(403).json({ erro: 'nao autorizado' }); return; }
  const db = admin.firestore();
  const DOC = db.doc('crmData/patients');
  try {
    const body = req.body || {};
    if (req.method === 'GET' || body.acao === 'ler') {
      const snap = await DOC.get();
      const list = snap.exists ? (snap.data().list || []) : [];
      res.status(200).json({ at: Date.now(), patients: list.map(resumo) });
      return;
    }
    if (body.acao === 'editar') {
      const ch = body.changes || {};
      const dataOk = (v) => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(String(v));
      const campos = ['vencimento', 'nascimento', 'consulta', 'telefone', 'email'].filter((k) => k in ch);
      if (!campos.length) { res.status(200).json({ ok: false, erro: 'Nada para alterar' }); return; }
      for (const k of ['vencimento', 'nascimento', 'consulta']) if (k in ch && !dataOk(ch[k])) { res.status(200).json({ ok: false, erro: 'Data inválida (' + k + ')' }); return; }
      if ('telefone' in ch && String(ch.telefone).replace(/\D/g, '').length < 10) { res.status(200).json({ ok: false, erro: 'Telefone inválido' }); return; }
      if ('email' in ch && ch.email !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(ch.email))) { res.status(200).json({ ok: false, erro: 'E-mail inválido' }); return; }
      const r = await db.runTransaction(async (tx) => {
        const snap = await tx.get(DOC);
        const list = snap.exists ? (snap.data().list || []) : [];
        const p = list.find((x) => String(x.id) === String(body.pid));
        if (!p) return { ok: false, erro: 'Paciente não encontrado no CRM' };
        campos.forEach((k) => { p[k] = k === 'telefone' ? String(ch[k]) : k === 'email' ? String(ch[k]).trim().toLowerCase() : ch[k]; });
        tx.update(DOC, { list });
        return { ok: true, patient: resumo(p) };
      });
      res.status(200).json(r);
      return;
    }
    res.status(400).json({ erro: 'acao invalida' });
  } catch (err) {
    logger.error(err);
    res.status(500).json({ erro: err.message });
  }
});
