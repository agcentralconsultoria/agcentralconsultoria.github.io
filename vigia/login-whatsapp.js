// Abre o WhatsApp Web no navegador PRÓPRIO do vigia (Google Chrome, perfil separado) pra você
// escanear o QR code UMA vez só (WhatsApp > Aparelhos conectados > Conectar aparelho).
// Nada de senha: o login fica guardado só nesse perfil (~/.agcentral/whatsapp-profile).
const { chromium } = require('playwright');
const os = require('os');
const path = require('path');

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(os.homedir(), '.agcentral', 'whatsapp-profile'), {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1280, height: 860 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://web.whatsapp.com/');
  console.log('Janela do WhatsApp Web aberta. Escaneie o QR code com o celular. Esperando...');
  // lista de conversas aparece depois de logado
  await page.waitForSelector('#pane-side', { timeout: 10 * 60 * 1000 });
  await page.waitForTimeout(8000); // deixa sincronizar e salvar a sessão
  console.log('WhatsApp Web conectado e salvo. Pode fechar a janela.');
  await ctx.close();
})().catch((e) => { console.error('Erro:', e.message); process.exit(1); });
