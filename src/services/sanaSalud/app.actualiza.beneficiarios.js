const { pool } = require("../../config/conexion");
const puppeteer = require("puppeteer");
const { convertirFecha } = require("../../helpers/dates");
const querys = require("../../data/querys");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const capturaBeneficiarios = async () => {
  try {
    const hoy = new Date();
    const ano = hoy.getFullYear();
    const mes = hoy.getMonth() + 1;
    const campanaId = "30";

    const res_fec_mes = await pool.query(querys.obtieneMesID(ano, mes));
    const MesVentaID = res_fec_mes.rows[0].mes_venta_id;

    const browser = await puppeteer.launch({
      headless: "new",
      defaultViewport: null,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");

    const lookerURL = "https://lookerstudio.google.com/u/0/reporting/3a97ace1-9981-4e08-a99b-7e439a960812/page/p_ubm14sy9md";
    await page.goto(lookerURL, { waitUntil: "networkidle2", timeout: 120000 });

    await page.waitForSelector(".centerColsContainer");

    let allRows = [];
    let pageCount = 1;
    let recordsPerPage = 100;

    const totalRecords = await page.evaluate(() => {
      const paginationText = document.querySelector(".pageLabel")?.innerText;
      const match = paginationText ? paginationText.match(/\d+\s*-\s*\d+\s*\/\s*(\d+)/) : null;
      return match ? parseInt(match[1]) : 0;
    });

    while (true) {
      const registrosCapturados = new Set();
      let intentos = 0;

      console.log(`📄 Página ${pageCount}: capturando registros...`);
      await page.evaluate(() => {
        document.querySelector(".centerColsContainer").scrollTop = 0;
      });
      await sleep(2000);

      while (registrosCapturados.size < recordsPerPage && intentos < 20) {
        await page.evaluate(() => {
          const container = document.querySelector(".centerColsContainer");
          if (container) container.scrollTop += 400;
        });
        await sleep(1500);

        const rows = await page.evaluate(() => {
          return Array.from(document.querySelectorAll(".centerColsContainer .row")).map(row =>
            Array.from(row.querySelectorAll(".cell-value")).map(cell => cell.innerText.trim())
          );
        });

        rows.forEach(row => registrosCapturados.add(JSON.stringify(row)));
        intentos++;
      }

      const registrosPagina = Array.from(registrosCapturados).map(JSON.parse);
      allRows.push(...registrosPagina);

      for (const [index, row] of registrosPagina.entries()) {
        try {
          if (row.length < 8) {
            console.warn(`⚠️ Fila ${index} incompleta, omitida.`);
            continue;
          }

          const rut = row[2];
          const beneficiarios = parseInt(row[7]) || 0;

          const updateQuery = `
            UPDATE genesys_backend.cx_venta_ejecutivo
            SET ven_eje_respuesta_beneficiarios = $1
            WHERE ven_eje_campana_id = $2
              AND ven_eje_mes_venta_id = $3
              AND SPLIT_PART(ven_eje_rut_cliente, '-', 1) = SPLIT_PART($4, '-', 1)
          `;
          const updateValues = [beneficiarios, campanaId, MesVentaID, rut];

          const result = await pool.query(updateQuery, updateValues);
          console.log(`✅ Fila ${index}: RUT ${rut} - Beneficiarios actualizados (${beneficiarios}) - Afectadas: ${result.rowCount}`);
        } catch (error) {
          console.error(`❌ Error fila ${index} - RUT ${row[2]}: ${error.message}`);
        }
      }

      if (allRows.length >= totalRecords) {
        console.log("✅ Todos los registros capturados.");
        break;
      }

      const hasNext = await page.evaluate(() => {
        const nextBtn = document.querySelector(".pageForward");
        return nextBtn && !nextBtn.classList.contains("disabled");
      });

      if (!hasNext) {
        console.log("🚫 Fin de paginación.");
        break;
      }

      await page.evaluate(() => document.querySelector(".pageForward").click());
      await sleep(7000);
      pageCount++;
    }

    await browser.close();
    pool.end();
    console.log(`🏁 Script finalizado. Total filas procesadas: ${allRows.length}`);
  } catch (error) {
    console.error("❌ Error en capturaBeneficiarios:", error.message);
  }
};

capturaBeneficiarios();
