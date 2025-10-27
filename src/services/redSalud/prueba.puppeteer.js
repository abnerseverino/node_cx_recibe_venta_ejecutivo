const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");

async function downloadGoogleSheetAsCSV() {
  const browser = await puppeteer.launch({
    headless: false,  // Para ver la ventana mientras debuggeas
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);

    // 1) Ir a login
    await page.goto("https://accounts.google.com/signin/v2/identifier", {
      waitUntil: "networkidle2",
    });

    // Ingresar email
    await page.type("input[type='email']", "amura@connectx.cl", { delay: 80 });
    await page.click("#identifierNext");
    await page.waitForNavigation({ waitUntil: "networkidle2" });

    // Ingresar pass
    await page.type("input[type='password']", "Cif14987.", { delay: 80 });
    await page.click("#passwordNext");
    await page.waitForNavigation({ waitUntil: "networkidle2" });

    // 2) Ir a la hoja
    const sheetUrl = "https://docs.google.com/spreadsheets/d/...";
    await page.goto(sheetUrl, { waitUntil: "networkidle2" });

    // Hacer un screenshot para ver qué hay
    await page.screenshot({ path: "debug_sheet.png", fullPage: true });
    console.log("URL actual tras la navegación:", page.url());

    // Inspeccionar el texto de la página
    const pageText = await page.evaluate(() => document.body.innerText);
    console.log("Texto en la página:\n", pageText);

    // 3) Esperar y hacer click en el menú "Archivo" o "File"
    await page.waitForSelector('[aria-label="Archivo"]', { visible: true });
    await page.click('[aria-label="Archivo"]');

    // ...
  } catch (error) {
    console.error("Error en la descarga con Puppeteer:", error);
  } finally {
    await browser.close();
  }
}

downloadGoogleSheetAsCSV();
