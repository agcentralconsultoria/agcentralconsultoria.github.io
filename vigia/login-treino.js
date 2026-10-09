// Abre um navegador PRÓPRIO do vigia no Treino.io para você entrar (uma vez só).
// A senha é digitada por você, nesse navegador, e fica guardada só nele
// (pasta ~/.agcentral/treino-profile). Nada disso vai pro repositório.
const { chromium } = require('playwright');
const os = require('os');
const path = require('path');

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(os.homedir(), '.agcentral', 'treino-profile'), {
    headless: false,
    viewport: { width: 1280, height: 860 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://painel.treino.io/');
  console.log('Navegador aberto. Entre no Treino.io nessa janela. Esperando você entrar...');
  // espera até o painel logado aparecer (ate 10 min)
  await page.waitForURL(/#\/app\//, { timeout: 10 * 60 * 1000 });
  await page.waitForTimeout(3000);
  console.log('Login detectado e salvo. Pode fechar a janela.');
  await ctx.close();
})().catch((e) => { console.error('Erro:', e.message); process.exit(1); });
