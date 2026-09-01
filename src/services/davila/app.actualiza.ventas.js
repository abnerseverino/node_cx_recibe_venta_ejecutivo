const fs = require("fs");
const path = require("path");
const { pool } = require("../../config/conexion");
const puppeteer = require("puppeteer");
const { convertirFecha } = require("../../helpers/dates");
const querys = require("../../data/querys");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Perfil dedicado con sesión de Google logueada (mismo que usa AndesSalud):
// el reporte de davila también empezó a exigir login, y Chrome bloquea el
// debugging remoto de Puppeteer sobre el perfil de escritorio por defecto,
// así que hay que usar un perfil propio, no el default.
const CHROME_PROFILE_DIR = "/home/ubuntu/.config/chrome-profiles/andessalud";
// Ese perfil lo mantiene el Chrome real de escritorio (v141+), muy por
// delante del Chromium que trae empaquetado el paquete "puppeteer": abrir
// el perfil con una versión tan distinta hace crashear Chrome al instante.
const CHROME_BIN = "/usr/bin/google-chrome";

function limpiarLockPerfilChrome(profileDir) {
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    const p = path.join(profileDir, f);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {}
  }
}

// Permite forzar un mes puntual con --ano=YYYY --mes=M (ej. para correr un
// mes ya cerrado a mano); sin esos argumentos usa el mes actual.
function obtenerAnoMes() {
  const argAno = process.argv.find((a) => a.startsWith("--ano="));
  const argMes = process.argv.find((a) => a.startsWith("--mes="));
  const hoy = new Date();
  const ano = argAno ? parseInt(argAno.split("=")[1], 10) : hoy.getFullYear();
  const mes = argMes ? parseInt(argMes.split("=")[1], 10) : hoy.getMonth() + 1;
  return { ano, mes };
}

const capturaLooker = async () => {
  let browser;
  try {
    const { ano, mes } = obtenerAnoMes();

    const res_fec_mes = await pool.query(querys.obtieneMesID(ano, mes));
    const MesVentaID = res_fec_mes.rows[0].mes_venta_id;

    limpiarLockPerfilChrome(CHROME_PROFILE_DIR);

    browser = await puppeteer.launch({
      headless: "new",
      defaultViewport: null,
      executablePath: CHROME_BIN,
      userDataDir: CHROME_PROFILE_DIR,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
    );

    const lookerURL =
      "https://datastudio.google.com/u/5/reporting/745213f7-e6f9-498c-b6fa-f053a047f18a/page/sAMLE";
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

    while (pageCount <= 3) { 
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
          let estado = row[6];
          const beneficiarios = parseInt(row[7]) || 0;

          if (estado === "Activo") estado = "EXITOSO";

          console.log(
            `📌Fila ${index}: ID: ${id}, Rut: ${rut}, Fecha: ${fecha_contrato}, Estado: ${estado}, Beneficiarios: ${beneficiarios}`
          );

          const query1 = `
            UPDATE genesys_backend.cx_venta_ejecutivo
            SET 
              ven_eje_respuesta_fecha_contratacion = $1,
              ven_eje_respuesta_beneficiarios = $2,
              ven_eje_respuesta_estado = $3
            WHERE
              ven_eje_campana_id IN (29, 37, 45) AND 
              ven_eje_mes_venta_id = $4 AND 
              ven_eje_rut_cliente = $5 AND
              ven_eje_respuesta_estado NOT IN 
              ('DUPLICADO','RECHAZA VENTA','CORTA',
               'RECHAZADA POR COMPRA EN CYBER','EXITOSO',
               'TIMEOUT','RECHAZADA POR CALIDAD');
          `;
          const values1 = [
            fecha_contrato,
            beneficiarios,
            estado,
            MesVentaID,
            rut,
          ];

          const result1 = await pool.query(query1, values1);
          console.log(`✅ Query1: actualizados ${result1.rowCount}`);

          const query2 = `
            UPDATE genesys_backend.cx_venta_ejecutivo
            SET ven_eje_respuesta_beneficiarios = $1
            WHERE
              ven_eje_campana_id IN (29, 37, 45) AND 
              ven_eje_mes_venta_id = $2 AND 
              ven_eje_rut_cliente = $3;
          `;
          const values2 = [beneficiarios, MesVentaID, rut];
          const result2 = await pool.query(query2, values2);
          console.log(`✅ Query2: actualizados ${result2.rowCount}`);

          const existeQuery = `
            SELECT 1 FROM genesys_backend.cx_venta_ejecutivo
            WHERE ven_eje_campana_id IN (29, 37, 45)
              AND SPLIT_PART(ven_eje_rut_cliente, '-', 1) = SPLIT_PART($1, '-', 1)
            LIMIT 1;
          `;
          const existeResult = await pool.query(existeQuery, [rut]);

          if (existeResult.rowCount === 0) {
            console.warn(`❗ Rut no encontrado: ${rut}`);
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
          if (nextButton) nextButton.click();
        });
        await sleep(7000);
        pageCount++;
      } else {
        console.log("🚫 No se detectó botón de 'Siguiente', terminando.");
        break;
      }
    }

    const ajusteQuery = `
      UPDATE genesys_backend.cx_venta_ejecutivo
      SET ven_eje_venta_adicional = GREATEST(
        ven_eje_respuesta_beneficiarios - ven_eje_venta_titular, 0
      )
      WHERE ven_eje_campana_id IN (29, 37, 45) AND 
            ven_eje_mes_venta_id = $1 AND 
            ven_eje_respuesta_beneficiarios > 0;
    `;
    await pool.query(ajusteQuery, [MesVentaID]);
    console.log("✅ Ajuste final aplicado a ven_eje_venta_adicional");
  } catch (error) {
    console.error("❌ Error en la ejecución del script:", error.message);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
    try {
      await pool.end();
    } catch {}
  }
};

capturaLooker();
