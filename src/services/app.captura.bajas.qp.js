#!/usr/bin/env node
const { pool } = require("../config/conexion");
const puppeteer = require("puppeteer");
const { convertirFecha } = require("../helpers/dates");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const capturaLooker = async () => {
  const startTime = new Date();
  console.log(`⏱️ Proceso iniciado: ${startTime.toLocaleString("es-CL")}\n`);

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
      "https://lookerstudio.google.com/u/0/reporting/3a97ace1-9981-4e08-a99b-7e439a960812/page/p_vsizma8fud";
    await page.goto(lookerURL, {
      waitUntil: "networkidle2",
      timeout: 120000,
    });
    await page.waitForSelector(".centerColsContainer");

    // 1) Contamos páginas
    let totalPages = 1;
    while (true) {
      const hasNext = await page.evaluate(() => {
        const btn = document.querySelector(".pageForward");
        return btn && !btn.classList.contains("disabled");
      });
      if (!hasNext) break;
      await page.evaluate(() => document.querySelector(".pageForward").click());
      await sleep(3000);
      totalPages++;
    }
    console.log(`🔢 Total de páginas detectadas: ${totalPages}`);

    // 2) Volver al inicio
    for (let i = 0; i < totalPages - 1; i++) {
      await page.evaluate(() => document.querySelector(".pageBack")?.click());
      await sleep(3000);
    }

    // 3) Avanzar hasta la (n-3)+1
    const pagesToSkip = Math.max(0, totalPages - 3);
    for (let i = 0; i < pagesToSkip; i++) {
      await page.evaluate(() => document.querySelector(".pageForward")?.click());
      await sleep(3000);
    }
    const pagesToProcess = Math.min(3, totalPages);

    // 4) Procesar esas 3
    let insertedCount = 0;
    for (let p = 0; p < pagesToProcess; p++) {
      const pageNum = pagesToSkip + 1 + p;
      console.log(`\n📄 Página ${pageNum} de ${totalPages}`);

      // Scroll & extracción
      await page.evaluate(() => (document.querySelector(".centerColsContainer").scrollTop = 0));
      await sleep(2000);
      const seen = new Set();
      let attempts = 0;
      while (seen.size < 100 && attempts < 20) {
        await page.evaluate(() => {
          const c = document.querySelector(".centerColsContainer");
          if (c) c.scrollTop += 400;
        });
        await sleep(1500);
        const rows = await page.evaluate(() =>
          Array.from(document.querySelectorAll(".centerColsContainer .row")).map((r) =>
            Array.from(r.querySelectorAll(".cell-value")).map((c) => c.innerText.trim())
          )
        );
        rows.forEach((r) => seen.add(JSON.stringify(r)));
        attempts++;
      }
      const registros = Array.from(seen).map(JSON.parse);
      console.log(`✅ Capturadas ${registros.length} filas`);

      for (const [idx, row] of registros.entries()) {
        // Sólo filas de al menos 9 columnas
        if (row.length < 9) {
          console.warn(`⚠️ Fila ${idx} (length=${row.length}) ignorada por tener <9 columnas`);
          continue;
        }

        // Desestructuramos lo que necesitamos
        const [
          _id,
          certificado,
          rut,
          fechaContrRaw,
          fechaBajaRaw,
          plan,
          codigo_producto,
          canal,
          organizacion,
          beneficiariosRaw = "0",
        ] = row;

        

        // Conversión
        let fecha_contrato, fecha_baja;
        try {
          fecha_contrato = await convertirFecha(fechaContrRaw);
          fecha_baja = await convertirFecha(fechaBajaRaw);
        } catch (e) {
          console.warn(`⚠️ Fila ${idx} omitida: error convirtiendo fecha - ${e.message}`);
          continue;
        }
        const beneficiarios = parseInt(beneficiariosRaw) || 0;
        const informador = "QUEPLAN";

        // 5) Check duplicado
        const dup = await pool.query(
          `SELECT 1 FROM genesys_backend.cx_venta_ejecutivo_baja
             WHERE ven_eje_baj_rut=$1 AND ven_eje_baj_organizacion=$2
             LIMIT 1`,
          [rut, organizacion]
        );
        if (dup.rowCount > 0) {
          continue;
        }

        // 6) Insert
        try {
          const res = await pool.query(
            `INSERT INTO genesys_backend.cx_venta_ejecutivo_baja (
               ven_eje_baj_certificado,
               ven_eje_baj_rut,
               ven_eje_baj_fecha_contratacion,
               ven_eje_baj_fecha_baja,
               ven_eje_baj_plan,
               ven_eje_baj_codigo_producto,
               ven_eje_baj_canal,
               ven_eje_baj_organizacion,
               ven_eje_baj_beneficiarios,
               ven_eje_baj_informador
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              certificado,
              rut,
              fecha_contrato,
              fecha_baja,
              plan,
              codigo_producto,
              canal,
              organizacion,
              beneficiarios,
              informador,
            ]
          );
          insertedCount += res.rowCount;
          console.log(`✅ Fila ${idx} insertado Registro RUT=${rut}, Org=${organizacion} `);
        } catch (e) {
          console.error(`❌ Error insert fila ${idx}: ${e.message}`);
        }
      }

      // Avanzar a la siguiente página a procesar
      if (p < pagesToProcess - 1) {
        await page.evaluate(() => document.querySelector(".pageForward")?.click());
        await sleep(3000);
      }
    }

    await browser.close();
    console.log(`\n🏁 Total filas insertadas: ${insertedCount}`);
  } catch (e) {
    console.error("❌ Error general:", e.message);
  } finally {
    const endTime = new Date();
    console.log(`⏱️ Proceso terminado: ${endTime.toLocaleString("es-CL")}`);
    await pool.end();
  }
};

capturaLooker();