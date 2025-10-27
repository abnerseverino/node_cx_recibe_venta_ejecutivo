const { pool } = require("../../config/conexion");
const puppeteer = require("puppeteer");
const { convertirFecha } = require("../../helpers/dates");
const querys = require("../../data/querys");
const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const capturaLooker = async () => {
  try {
    const hoy = new Date();
    //const ano = hoy.getFullYear();
    //const mes = hoy.getMonth() + 1;
    const campanaId = "30";

    const ano = "2025";
    const mes = "05";


    let res_fec_mes = await pool.query(querys.obtieneMesID(ano, mes));
    let MesVentaID = res_fec_mes.rows[0].mes_venta_id;

    const browser = await puppeteer.launch({
      headless: "new",
      defaultViewport: null,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
    );

    const lookerURL = "https://lookerstudio.google.com/u/0/reporting/3a97ace1-9981-4e08-a99b-7e439a960812/page/p_ubm14sy9md";
    await page.goto(lookerURL, { waitUntil: 'networkidle2', timeout: 120000 });
    await page.waitForSelector(".centerColsContainer");

    let allRows = [];
    let pageCount = 1;
    const rutsNoEncontrados = [];

    const totalRecords = await page.evaluate(() => {
      const paginationText = document.querySelector(".pageLabel")?.innerText;
      const match = paginationText ? paginationText.match(/\d+\s*-\s*\d+\s*\/\s*(\d+)/) : null;
      return match ? parseInt(match[1]) : 0;
    });

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
          return Array.from(document.querySelectorAll(".centerColsContainer .row")).map(row => {
            return Array.from(row.querySelectorAll(".cell-value")).map(cell => cell.innerText.trim());
          });
        });

        rows.forEach(row => registrosCapturados.add(JSON.stringify(row)));
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

          let [id, certificado, rut, fechaStr, plan, precioStr, estadoRaw, beneficiariosStr] = row;
          let fecha_contrato = await convertirFecha(fechaStr);
          let precio = parseFloat(precioStr.replace(/[^0-9.-]+/g, ""));
          let estado = estadoRaw === "Activo" ? "EXITOSO" : estadoRaw;
          let beneficiarios = parseInt(beneficiariosStr) || 0;

          console.log(`📌 Fila ${index}: ${row.join(' | ')}`);

          const query1 = `
            UPDATE genesys_backend.cx_venta_ejecutivo
            SET 
              ven_eje_respuesta_fecha_contratacion = $1,
              ven_eje_respuesta_beneficiarios = $2,
              ven_eje_respuesta_estado = $3
            WHERE
              ven_eje_campana_id = $4 AND 
              ven_eje_mes_venta_id = $5 AND 
              SPLIT_PART(ven_eje_rut_cliente, '-', 1) = SPLIT_PART($6, '-', 1) AND
              ven_eje_respuesta_estado NOT IN 
              ('DUPLICADO', 'RECHAZA VENTA', 'CORTA', 'RECHAZADA POR COMPRA EN CYBER', 'EXITOSO', 'TIMEOUT', 'RECHAZADA POR CALIDAD')
          `;
          const values1 = [fecha_contrato, beneficiarios, estado, campanaId, MesVentaID, rut];
          const result1 = await pool.query(query1, values1);
          console.log(`🟢 UPDATE1 - ID: ${id}, Afectadas: ${result1.rowCount}`);


          const query2 = `
            UPDATE genesys_backend.cx_venta_ejecutivo
            SET ven_eje_respuesta_beneficiarios = $1
            WHERE
              ven_eje_campana_id = $2 AND 
              ven_eje_mes_venta_id = $3 AND 
              SPLIT_PART(ven_eje_rut_cliente, '-', 1) = SPLIT_PART($4, '-', 1)
          `;
          const values2 = [beneficiarios, campanaId, MesVentaID, rut];
          const result2 = await pool.query(query2, values2);
          console.log(`🟡 UPDATE2 - ID: ${id}, Afectadas: ${result2.rowCount}`);


          const existeQuery = `
              SELECT 1 FROM genesys_backend.cx_venta_ejecutivo
              WHERE ven_eje_campana_id = $1
                AND SPLIT_PART(ven_eje_rut_cliente, '-', 1) = SPLIT_PART($3, '-', 1)
              LIMIT 1;
            `;
            const existeResult = await pool.query(existeQuery, [campanaId, MesVentaID, rut]);

            if (existeResult.rowCount === 0) {
              rutsNoEncontrados.push(rut);
            }

            
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
          nextButton?.click();
        });
        await sleep(7000);
        pageCount++;
      } else {
        console.log("🚫 No se detectó botón de 'Siguiente' o está deshabilitado, terminando.");
        break;
      }
    }

    console.log(`✅ Total de registros capturados: ${allRows.length}`);

    // ✅ Nuevo UPDATE agregado al final del proceso
    const adicionalUpdateQuery = `
      UPDATE genesys_backend.cx_venta_ejecutivo
      SET ven_eje_venta_adicional = GREATEST(
        ven_eje_respuesta_beneficiarios - ven_eje_venta_titular,
        0
      )
      WHERE
        ven_eje_campana_id = $1 AND
        ven_eje_mes_venta_id = $2 AND
        ven_eje_respuesta_beneficiarios > 0;
    `;
    const adicionalUpdateResult = await pool.query(adicionalUpdateQuery, [campanaId, MesVentaID]);
    console.log(`📦 UPDATE adicional completado. Filas afectadas: ${adicionalUpdateResult.rowCount}`);

    // ✅ Guardar los RUTs no encontrados en archivo
    const logDir = "/home/ubuntu/node_procesos/logs";
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const filename = "ruts_no_encontrados_sanasalud.txt";
    const outputPath = path.join(logDir, filename);
    fs.writeFileSync(outputPath, rutsNoEncontrados.join("\n"), "utf-8");
    console.log(`📁 Log actualizado: ${outputPath}`);

    await browser.close();
    pool.end();
  } catch (error) {
    console.error("❌ Error en la ejecución del script:", error.message);
  }
};

capturaLooker();
