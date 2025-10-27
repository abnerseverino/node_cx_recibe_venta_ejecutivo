const puppeteer = require("puppeteer");
const { convertirFecha } = require("../../helpers/dates");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const capturaLooker = async () => {
  try {
    const browser = await puppeteer.launch({
      headless: "new",
      defaultViewport: null,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
    );

    const lookerURL =
      "https://lookerstudio.google.com/u/0/reporting/3a97ace1-9981-4e08-a99b-7e439a960812/page/sAMLE";
    await page.goto(lookerURL, {
      waitUntil: "networkidle2",
      timeout: 120000,
    });

    await page.waitForSelector(".centerColsContainer");

    let allRows = [];
    let pageCount = 1;

    let totalRecords = await page.evaluate(() => {
      const paginationText = document.querySelector(".pageLabel")?.innerText;
      const match = paginationText
        ? paginationText.match(/\d+\s*-\s*\d+\s*\/\s*(\d+)/)
        : null;
      return match ? parseInt(match[1]) : 0;
    });

    console.log(`🔍 Total de registros detectados: ${totalRecords}`);

    while (true) {
      let registrosCapturados = new Set();
      let intentos = 0;

      console.log(`📄 Capturando datos de la Página ${pageCount}...`);

      await page.evaluate(() => {
        document.querySelector(".centerColsContainer").scrollTop = 0;
      });
      await sleep(2000);

      while (registrosCapturados.size < 100 && intentos < 20) {
        await page.evaluate(() => {
          const container = document.querySelector(".centerColsContainer");
          if (container) container.scrollTop += 400;
        });

        await sleep(1500);

        const rows = await page.evaluate(() => {
          return Array.from(
            document.querySelectorAll(".centerColsContainer .row")
          ).map((row) =>
            Array.from(row.querySelectorAll(".cell-value")).map((cell) =>
              cell.innerText.trim()
            )
          );
        });

        rows.forEach((row) => registrosCapturados.add(JSON.stringify(row)));
        intentos++;
      }

      const registrosPagina = Array.from(registrosCapturados).map(JSON.parse);
      allRows.push(...registrosPagina);
      console.log(`✅ Página ${pageCount} - Registros capturados: ${registrosPagina.length}`);

      for (const [index, row] of registrosPagina.entries()) {
        try {
          if (row.length < 8) {
            console.warn(`⚠️ Fila ${index} no contiene suficientes columnas, se omitirá.`);
            continue;
          }

          const id = row[0];
          const certificado = row[1];
          const rut = row[2];
          const fecha_contrato = await convertirFecha(row[3]);
          const plan = row[4];
          const precio = parseFloat(row[5].replace(/[^0-9.-]+/g, ""));
          const estado = row[6];
          const beneficiarios = parseInt(row[7]) || 0;

          console.log(
            `📌 Fila ${index}: ID: ${id}, Certificado: ${certificado}, Rut: ${rut}, Fecha: ${fecha_contrato}, Plan: ${plan}, Precio: ${precio}, Estado: ${estado}, Beneficiarios: ${beneficiarios}`
          );
        } catch (error) {
          console.error(`❌ Error procesando fila ${index}: ${error.message}`);
        }
      }

      if (allRows.length >= totalRecords) {
        console.log("✅ Se alcanzó el total de registros.");
        break;
      }

      const hasNextPage = await page.evaluate(() => {
        const nextButton = document.querySelector(".pageForward");
        return nextButton && !nextButton.classList.contains("disabled");
      });

      if (hasNextPage) {
        console.log("➡️ Pasando a la siguiente página...");
        await page.evaluate(() => {
          const nextButton = document.querySelector(".pageForward");
          if (nextButton) nextButton.click();
        });
        await sleep(7000);
        pageCount++;
      } else {
        console.log("🚫 No se detectó botón de 'Siguiente', terminando.");
        break;
      }
    }

    await browser.close();
  } catch (error) {
    console.error("❌ Error en la ejecución del script:", error.message);
  }
};

capturaLooker();
