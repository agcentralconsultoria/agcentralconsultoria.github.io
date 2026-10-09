// Segredos compartilhados entre arquivos de funcoes (declarar o mesmo segredo em dois
// arquivos confunde o deploy; aqui fica num lugar so).
const { defineSecret } = require('firebase-functions/params');
exports.AUTOMACAO_KEY = defineSecret('AUTOMACAO_KEY');
