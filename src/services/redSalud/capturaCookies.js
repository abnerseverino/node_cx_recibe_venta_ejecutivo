require('dotenv').config({ path: require('find-config')('../../.env') });

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const cookiesDir = path.resolve(__dirname, 'cookies');
const cookiesPath = path.join(cookiesDir, 'google.cookies.json');
const userDataDir = path.resolve(__dirname, 'chrome-profile');

if (!fs.existsSync(cookiesDir)) fs.mkdirSync(cookiesDir);

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const [page] = await browser.pages(); // usar la pestaña abierta por defecto

  try {
    console.log('🌐 Abriendo login de Google...');
    await page.goto('https://accounts.google.com/', {
      waitUntil: 'networkidle2',
    });

    console.log('📝 Por favor, completa el login manualmente...');
    console.log('⌛ Esperando 60 segundos para que completes el login...');

    await new Promise(resolve => setTimeout(resolve, 60000));

    // ✅ Verificar que la página aún esté abierta
    if (!page.isClosed()) {
      const cookies = await page.cookies();
      fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));
      console.log(`✅ Cookies guardadas en: ${cookiesPath}`);
    } else {
      console.warn('⚠️ La pestaña fue cerrada antes de guardar cookies.');
    }
  } catch (err) {
    console.error('❌ Error durante el proceso:', err.message);
  } finally {
    await browser.close();
    console.log('👋 Proceso finalizado.');
  }
})();
