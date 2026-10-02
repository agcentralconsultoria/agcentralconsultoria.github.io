// Equipe (funcionarios, grupos de permissao e logs de auditoria).
//
// Como o bloqueio funciona (sem jeito de burlar pelo navegador):
// - Os dados de verdade continuam onde sempre estiveram (crmData/*). So o Angelo
//   (ADMIN_UID) le e grava ali direto - as regras do Firestore barram o resto.
// - Cada funcionario so le a propria "visao" (equipeVisao/{uid}/dados/*), que
//   este servidor monta ja filtrada: so os pacientes liberados pra ele e so as
//   partes (treino, dieta, check-ins, jornada...) que o grupo dele pode ver.
// - Pra gravar, o funcionario chama equipeSalvar. O servidor confere a
//   permissao de novo, aplica so o que mudou no documento de verdade e grava o
//   log de auditoria. O que ele nao pode editar e recusado aqui, nao so na tela.
// Nada aqui mexe na sincronizacao de check-ins nem na do Google Calendar.
const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

const db = admin.firestore();
const REGION = 'southamerica-east1';
const ADMIN_UID = 'uLicObTjbnZS5D3uIRKHLFlxhcO2';

const AREAS = ['dashboard', 'pacientes', 'treino', 'dieta', 'checkins', 'jornada',
  'cap-visao', 'cap-leads', 'cap-parcerias', 'cap-indica', 'cap-comunidade', 'cap-instagram', 'financeiro'];
const AREAS_PACIENTE = ['dashboard', 'pacientes', 'treino', 'dieta', 'checkins', 'jornada'];
// Campos do paciente que pertencem a cada parte. O resto e o cadastro ("base").
const PARTES = { treino: ['fichasTreino'], dieta: ['fichasDieta'], checkins: ['meses'], jornada: ['jornada'] };
const AREA_DA_PARTE = { base: 'pacientes', treino: 'treino', dieta: 'dieta', checkins: 'checkins', jornada: 'jornada' };
// Cada lista da Captacao pertence a uma sub-aba.
const CAPTACAO_AREA = {
  leads: 'cap-leads', etiquetas: 'cap-leads',
  parcerias: 'cap-parcerias', parceriaTipos: 'cap-parcerias',
  indicacoes: 'cap-indica', conquistas: 'cap-indica', marcos: 'cap-indica',
  comunidade: 'cap-comunidade', instagram: 'cap-instagram',
};
const DOCS_ESPELHADOS = ['patients', 'captacao', 'captacaoTemplates', 'financeiro', 'jornadaTemplates', 'grupoMuscularList'];
const TABELA_NOME = {
  base: 'Paciente · cadastro', treino: 'Paciente · ficha de treino', dieta: 'Paciente · ficha de dieta',
  checkins: 'Paciente · check-ins', jornada: 'Paciente · jornada',
  captacao: 'Captação', financeiro: 'Financeiro', jornadaTemplates: 'Modelos de jornada',
  captacaoTemplates: 'Modelos de captação', grupoMuscularList: 'Grupos musculares',
};

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function podeVer(perms, area) { return perms[area] === 'ver' || perms[area] === 'editar'; }
function podeEditar(perms, area) { return perms[area] === 'editar'; }
function vePaciente(perms) { return AREAS_PACIENTE.some((a) => podeVer(perms, a)); }

function campoDaParte(campo) {
  for (const parte of Object.keys(PARTES)) if (PARTES[parte].indexOf(campo) !== -1) return parte;
  return 'base';
}
function separarPaciente(p) {
  const partes = { base: {} };
  Object.keys(PARTES).forEach((k) => { partes[k] = {}; });
  Object.keys(p || {}).forEach((campo) => { partes[campoDaParte(campo)][campo] = p[campo]; });
  return partes;
}
function liberado(membro, id) {
  return !Array.isArray(membro.pacientes) || membro.pacientes.indexOf(String(id)) !== -1;
}
function iguais(a, b) { return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); }

// So os campos que mudaram, pro log ficar legivel.
function diffCampos(antes, depois) {
  const a = antes || {}, d = depois || {};
  const out = { antes: {}, depois: {} };
  const chaves = new Set(Object.keys(a).concat(Object.keys(d)));
  const vazio = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
  chaves.forEach((k) => {
    if (iguais(a[k], d[k]) || (vazio(a[k]) && vazio(d[k]))) return;
    if (a[k] !== undefined) out.antes[k] = a[k];
    if (d[k] !== undefined) out.depois[k] = d[k];
  });
  return out;
}
// Firestore guarda no maximo ~1MB por documento - se o antes/depois for enorme,
// guarda um resumo em texto pra nunca perder o log inteiro.
function limitarTamanho(obj) {
  const txt = JSON.stringify(obj || {});
  if (txt.length <= 300000) return obj || {};
  return { resumo: txt.slice(0, 300000) + ' …(cortado)' };
}
function entradaLog(quem, tabela, acao, registroId, registroNome, antes, depois) {
  return {
    em: Date.now(),
    uid: quem.uid,
    usuario: quem.nome || quem.email || '',
    funcionario: true,
    tabela, acao,
    registroId: registroId === undefined || registroId === null ? '' : String(registroId),
    registroNome: registroNome || '',
    antes: limitarTamanho(antes),
    depois: limitarTamanho(depois),
  };
}

async function lerContexto(uid) {
  const mSnap = await db.doc('equipe/' + uid).get();
  if (!mSnap.exists) return null;
  const membro = mSnap.data();
  if (membro.ativo !== true) return null;
  const gSnap = membro.grupoId ? await db.doc('equipeGrupos/' + membro.grupoId).get() : null;
  const grupo = gSnap && gSnap.exists ? gSnap.data() : null;
  const perms = {};
  AREAS.forEach((a) => { perms[a] = grupo && grupo.ativo === true && grupo.perms ? (grupo.perms[a] || 'nenhum') : 'nenhum'; });
  return { uid, membro, grupo, perms };
}

function visaoRef(uid, nome) { return db.doc('equipeVisao/' + uid + '/dados/' + nome); }

function filtrarDoc(nome, dados, ctx) {
  const perms = ctx.perms;
  if (nome === 'patients') {
    if (!vePaciente(perms)) return { list: [] };
    const list = (dados.list || []).filter((p) => liberado(ctx.membro, p.id)).map((p) => {
      const copia = Object.assign({}, p);
      Object.keys(PARTES).forEach((parte) => {
        if (!podeVer(perms, parte)) PARTES[parte].forEach((campo) => { delete copia[campo]; });
      });
      return copia;
    });
    return { list };
  }
  if (nome === 'captacao') {
    const tudo = podeVer(perms, 'cap-visao');
    const data = {};
    Object.keys(dados.data || {}).forEach((k) => {
      const area = CAPTACAO_AREA[k];
      if (tudo || (area && podeVer(perms, area))) data[k] = dados.data[k];
    });
    return { data };
  }
  if (nome === 'captacaoTemplates') {
    return ['cap-visao', 'cap-leads', 'cap-parcerias'].some((a) => podeVer(perms, a)) ? dados : null;
  }
  if (nome === 'financeiro') return podeVer(perms, 'financeiro') ? dados : null;
  if (nome === 'jornadaTemplates') return (podeVer(perms, 'jornada') || podeVer(perms, 'pacientes')) ? dados : null;
  if (nome === 'grupoMuscularList') return podeVer(perms, 'treino') ? dados : null;
  return null;
}

// Monta (ou apaga) a visao filtrada de um funcionario.
async function gerarVisao(uid, nomes) {
  const ctx = await lerContexto(uid);
  const lista = nomes || DOCS_ESPELHADOS;
  const batch = db.batch();
  if (!ctx) {
    DOCS_ESPELHADOS.concat(['perfil']).forEach((n) => batch.delete(visaoRef(uid, n)));
    await batch.commit();
    return;
  }
  if (!nomes) {
    batch.set(visaoRef(uid, 'perfil'), {
      nome: ctx.membro.nome || '', email: ctx.membro.email || '',
      grupoNome: ctx.grupo ? (ctx.grupo.nome || '') : '',
      perms: ctx.perms,
      pacientes: Array.isArray(ctx.membro.pacientes) ? ctx.membro.pacientes : null,
      atualizadoEm: Date.now(),
    });
  }
  for (const nome of lista) {
    const snap = await db.doc('crmData/' + nome).get();
    const filtrado = snap.exists ? filtrarDoc(nome, snap.data(), ctx) : null;
    if (filtrado) batch.set(visaoRef(uid, nome), filtrado);
    else batch.delete(visaoRef(uid, nome));
  }
  await batch.commit();
}

async function membrosAtivos() {
  const snap = await db.collection('equipe').where('ativo', '==', true).get();
  return snap.docs.map((d) => d.id);
}

exports.equipeVisaoDados = onDocumentWritten({
  document: 'crmData/{docId}', region: REGION, timeoutSeconds: 120, memory: '512MiB',
}, async (event) => {
  const nome = event.params.docId;
  if (DOCS_ESPELHADOS.indexOf(nome) === -1) return;
  const uids = await membrosAtivos();
  for (const uid of uids) await gerarVisao(uid, [nome]);
});

exports.equipeVisaoMembro = onDocumentWritten({
  document: 'equipe/{uid}', region: REGION, timeoutSeconds: 120, memory: '512MiB',
}, async (event) => {
  await gerarVisao(event.params.uid, null);
});

exports.equipeVisaoGrupo = onDocumentWritten({
  document: 'equipeGrupos/{gid}', region: REGION, timeoutSeconds: 120, memory: '512MiB',
}, async (event) => {
  const snap = await db.collection('equipe').where('grupoId', '==', event.params.gid).get();
  for (const d of snap.docs) await gerarVisao(d.id, null);
});

async function autenticar(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return null; }
  if (req.method !== 'POST') { res.status(405).send('use POST'); return null; }
  const authHeader = req.get('Authorization') || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) { res.status(401).json({ erro: 'Sessão expirada. Entre de novo.' }); return null; }
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken, true);
  } catch (err) {
    res.status(401).json({ erro: 'Sessão expirada. Entre de novo.' });
    return null;
  }
  // Google Authenticator obrigatorio: sem ter entrado com o codigo, nada passa.
  if (!decoded.firebase || decoded.firebase.sign_in_second_factor !== 'totp') {
    res.status(403).json({ erro: 'Entre com o código do Google Authenticator.' });
    return null;
  }
  return decoded;
}

class Recusa extends Error {}

// Aplica as mudancas de pacientes de um funcionario, conferindo permissao de cada uma.
function aplicarPacientes(list, ops, ctx, logs) {
  const quem = { uid: ctx.uid, nome: ctx.membro.nome, email: ctx.membro.email };
  ops.forEach((op) => {
    const id = op.id;
    const idx = list.findIndex((p) => String(p.id) === String(id));
    if (op.tipo === 'criar') {
      if (!podeEditar(ctx.perms, 'pacientes') || Array.isArray(ctx.membro.pacientes)) throw new Recusa('Você não tem permissão para cadastrar pacientes.');
      if (idx !== -1) throw new Recusa('Esse paciente já existe.');
      const novo = Object.assign({}, op.paciente || {});
      Object.keys(PARTES).forEach((parte) => {
        if (!podeEditar(ctx.perms, parte) && !(parte === 'jornada' && podeEditar(ctx.perms, 'pacientes'))) {
          PARTES[parte].forEach((campo) => { delete novo[campo]; });
        }
      });
      novo.id = id;
      list.push(novo);
      logs.push(entradaLog(quem, TABELA_NOME.base, 'criacao', id, novo.nome, {}, novo));
      return;
    }
    if (idx === -1) throw new Recusa('Paciente não encontrado (pode ter sido excluído).');
    if (!liberado(ctx.membro, id)) throw new Recusa('Você não tem acesso a esse paciente.');
    const atual = list[idx];
    if (op.tipo === 'excluir') {
      if (!podeEditar(ctx.perms, 'pacientes')) throw new Recusa('Você não tem permissão para excluir pacientes.');
      list.splice(idx, 1);
      logs.push(entradaLog(quem, TABELA_NOME.base, 'exclusao', id, atual.nome, atual, {}));
      return;
    }
    if (op.tipo === 'parte') {
      const parte = op.parte;
      if (!AREA_DA_PARTE[parte]) throw new Recusa('Pedido inválido.');
      const ok = podeEditar(ctx.perms, AREA_DA_PARTE[parte]) || (parte === 'jornada' && podeEditar(ctx.perms, 'pacientes'));
      if (!ok) throw new Recusa('Você não tem permissão para editar isso.');
      const separado = separarPaciente(atual);
      const valor = op.valor || {};
      let novo;
      if (parte === 'base') {
        novo = {};
        Object.keys(PARTES).forEach((k) => Object.assign(novo, separado[k]));
        Object.keys(valor).forEach((campo) => { if (campoDaParte(campo) === 'base') novo[campo] = valor[campo]; });
        novo.id = atual.id;
      } else {
        novo = Object.assign({}, atual);
        PARTES[parte].forEach((campo) => {
          if (valor[campo] === undefined) delete novo[campo]; else novo[campo] = valor[campo];
        });
      }
      const d = diffCampos(separado[parte], separarPaciente(novo)[parte]);
      list[idx] = novo;
      if (Object.keys(d.antes).length || Object.keys(d.depois).length) {
        logs.push(entradaLog(quem, TABELA_NOME[parte], 'atualizacao', id, novo.nome, d.antes, d.depois));
      }
      return;
    }
    throw new Recusa('Pedido inválido.');
  });
}

const PERM_DOC_SIMPLES = {
  financeiro: (p) => podeEditar(p, 'financeiro'),
  jornadaTemplates: (p) => podeEditar(p, 'jornada'),
  captacaoTemplates: (p) => podeEditar(p, 'cap-leads') || podeEditar(p, 'cap-parcerias'),
  grupoMuscularList: (p) => podeEditar(p, 'treino'),
};

// POST { alvo: 'patients', ops: [...] }
//      { alvo: 'captacao', chaves: { leads: [...], ... } }
//      { alvo: 'financeiro' | 'jornadaTemplates' | 'captacaoTemplates', chaves: {...} }  (campos de dentro de "data")
//      { alvo: 'grupoMuscularList', list: [...] }
exports.equipeSalvar = onRequest({ region: REGION, timeoutSeconds: 60, memory: '512MiB' }, async (req, res) => {
  const decoded = await autenticar(req, res);
  if (!decoded) return;
  try {
    const ctx = await lerContexto(decoded.uid);
    if (!ctx) { res.status(403).json({ erro: 'Seu acesso está desativado.' }); return; }
    const body = req.body || {};
    const alvo = body.alvo;
    const quem = { uid: ctx.uid, nome: ctx.membro.nome, email: ctx.membro.email };
    const ref = db.doc('crmData/' + alvo);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const atual = snap.exists ? snap.data() : {};
      const logs = [];
      if (alvo === 'patients') {
        const list = Array.isArray(atual.list) ? atual.list.slice() : [];
        aplicarPacientes(list, Array.isArray(body.ops) ? body.ops : [], ctx, logs);
        tx.set(ref, { list }, { merge: true });
      } else if (alvo === 'captacao' || PERM_DOC_SIMPLES[alvo] && alvo !== 'grupoMuscularList') {
        const data = Object.assign({}, atual.data || {});
        const chaves = body.chaves || {};
        Object.keys(chaves).forEach((k) => {
          const ok = alvo === 'captacao' ? (CAPTACAO_AREA[k] && podeEditar(ctx.perms, CAPTACAO_AREA[k])) : PERM_DOC_SIMPLES[alvo](ctx.perms);
          if (!ok) throw new Recusa('Você não tem permissão para editar isso.');
          const antes = data[k];
          if (chaves[k] === null) delete data[k]; else data[k] = chaves[k];
          logs.push(entradaLog(quem, TABELA_NOME[alvo] + ' · ' + k, 'atualizacao', k, '', { [k]: antes }, { [k]: chaves[k] }));
        });
        tx.set(ref, { data }, { merge: true });
      } else if (alvo === 'grupoMuscularList') {
        if (!PERM_DOC_SIMPLES.grupoMuscularList(ctx.perms)) throw new Recusa('Você não tem permissão para editar isso.');
        if (!Array.isArray(body.list)) throw new Recusa('Pedido inválido.');
        logs.push(entradaLog(quem, TABELA_NOME.grupoMuscularList, 'atualizacao', 'list', '', { list: atual.list }, { list: body.list }));
        tx.set(ref, { list: body.list }, { merge: true });
      } else {
        throw new Recusa('Pedido inválido.');
      }
      logs.forEach((l) => tx.create(db.collection('auditoria').doc(), l));
    });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof Recusa) { res.status(403).json({ erro: err.message }); return; }
    logger.error('equipeSalvar falhou', err);
    res.status(500).json({ erro: 'Não foi possível salvar agora. Tente de novo.' });
  }
});

// So o Angelo: criar funcionario, trocar senha, ativar/desativar.
// POST { acao: 'salvar', uid?, nome, email, senha?, grupoId, ativo, pacientes: null | ['id', ...] }
exports.equipeAdmin = onRequest({ region: REGION, timeoutSeconds: 60, memory: '256MiB' }, async (req, res) => {
  const decoded = await autenticar(req, res);
  if (!decoded) return;
  if (decoded.uid !== ADMIN_UID) { res.status(403).json({ erro: 'Só o administrador pode fazer isso.' }); return; }
  try {
    const b = req.body || {};
    if (b.acao !== 'salvar') { res.status(400).json({ erro: 'Pedido inválido.' }); return; }
    const nome = String(b.nome || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const senha = b.senha ? String(b.senha) : '';
    const ativo = b.ativo === true;
    const pacientes = Array.isArray(b.pacientes) && b.pacientes.length ? b.pacientes.map(String) : null;
    if (!nome || !email) { res.status(400).json({ erro: 'Preencha nome e e-mail.' }); return; }
    if (!b.grupoId) { res.status(400).json({ erro: 'Escolha o grupo de permissões.' }); return; }
    if (senha && senha.length < 6) { res.status(400).json({ erro: 'A senha precisa ter pelo menos 6 caracteres.' }); return; }
    let uid = b.uid || null;
    let antes = {};
    if (uid === ADMIN_UID) { res.status(400).json({ erro: 'Essa conta é a do administrador.' }); return; }
    if (uid) {
      const s = await db.doc('equipe/' + uid).get();
      if (!s.exists) { res.status(404).json({ erro: 'Funcionário não encontrado.' }); return; }
      antes = s.data();
      const upd = { email, displayName: nome, disabled: !ativo };
      if (senha) upd.password = senha;
      await admin.auth().updateUser(uid, upd);
      // desativou ou trocou a senha: derruba as sessoes abertas dele na hora
      if (!ativo || senha) await admin.auth().revokeRefreshTokens(uid);
    } else {
      if (!senha) { res.status(400).json({ erro: 'Defina uma senha para o funcionário.' }); return; }
      try {
        const user = await admin.auth().createUser({ email, password: senha, displayName: nome, disabled: !ativo });
        uid = user.uid;
      } catch (err) {
        if (!err || err.code !== 'auth/email-already-exists') throw err;
        // a conta ja existe (ex: um cadastro que falhou no meio): reaproveita,
        // desde que nao seja o administrador nem um funcionario ja cadastrado
        const existente = await admin.auth().getUserByEmail(email);
        const jaNaEquipe = await db.doc('equipe/' + existente.uid).get();
        if (existente.uid === ADMIN_UID || jaNaEquipe.exists) throw err;
        uid = existente.uid;
        await admin.auth().updateUser(uid, { password: senha, displayName: nome, disabled: !ativo });
        await admin.auth().revokeRefreshTokens(uid);
      }
    }
    const dados = { nome, email, grupoId: String(b.grupoId), ativo, pacientes, atualizadoEm: Date.now() };
    if (!b.uid) dados.criadoEm = Date.now();
    await db.doc('equipe/' + uid).set(dados, { merge: true });
    const semSenha = Object.assign({}, dados);
    const d = diffCampos(antes, Object.assign({}, antes, semSenha));
    if (senha) d.depois.senha = '(alterada)';
    await db.collection('auditoria').add({
      em: Date.now(), uid: decoded.uid, usuario: 'Angelo Garcia', funcionario: false,
      tabela: 'Equipe · funcionário', acao: b.uid ? 'atualizacao' : 'criacao',
      registroId: uid, registroNome: nome, antes: d.antes, depois: d.depois,
    });
    res.json({ ok: true, uid });
  } catch (err) {
    const code = err && err.code ? String(err.code) : '';
    if (code === 'auth/email-already-exists') { res.status(400).json({ erro: 'Esse e-mail já está em uso por outra conta.' }); return; }
    if (code === 'auth/invalid-email') { res.status(400).json({ erro: 'E-mail inválido.' }); return; }
    if (code === 'auth/invalid-password') { res.status(400).json({ erro: 'A senha precisa ter pelo menos 6 caracteres.' }); return; }
    logger.error('equipeAdmin falhou', err);
    res.status(500).json({ erro: 'Não foi possível salvar agora. Tente de novo.' });
  }
});
