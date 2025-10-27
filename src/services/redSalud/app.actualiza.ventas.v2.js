const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const csvParser = require("csv-parser");
const moment = require("moment");
const { pool } = require("../../config/conexion");
const querys = require("../../data/querys");

require("dotenv").config({ path: require("find-config")("../../.env") });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// === NUEVO: perfil persistente y binario opcional ===
const CHROME_PROFILE_DIR = process.env.CHROME_PROFILE_DIR || ""; // p.ej. /home/ubuntu/.config/chrome-profiles/docs2
const CHROME_BIN = process.env.CHROME_BIN || null;               // p.ej. /usr/bin/google-chrome

function looksLikeGoogleLogin(url) {
  const pats = ["accounts.google.com", "/ServiceLogin", "/signin", "identifier?"];
  return pats.some((p) => url.includes(p));
}

/**
 * Usa un perfil persistente (CHROME_PROFILE_DIR) que ya debe tener sesión iniciada en Google.
 * Visita la hoja y luego la URL de exportación. Descarga el CSV en ./downloads.
 */
async function downloadGoogleSheetAsCSV() {
  // URL de tu Google Sheet (edit)
  const sheetUrl =
    "https://docs.google.com/spreadsheets/d/1FvlZU1AUJoKrdLrtNaxo9nGBZvTAhligVbaEhDrp7XU/edit#gid=1765604646";

  // Carpeta de descarga
  const downloadPath = path.resolve(__dirname, "./downloads");
  if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath, { recursive: true });

  // Limpia CSV previos
  for (const f of fs.readdirSync(downloadPath)) {
    if (f.endsWith(".csv")) {
      try { fs.unlinkSync(path.join(downloadPath, f)); } catch {}
    }
  }

  // Lanza Puppeteer con perfil persistente
  const launchOpts = {
    headless: true, // si quieres depurar, cambia a false
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--password-store=basic",
      "--use-mock-keychain",
    ],
  };
  if (CHROME_BIN) {
    launchOpts.executablePath = CHROME_BIN;
  }
  if (CHROME_PROFILE_DIR) {
    launchOpts.userDataDir = CHROME_PROFILE_DIR;
    console.log("🗂  Usando perfil persistente:", CHROME_PROFILE_DIR);
  } else {
    console.log("🗂  Perfil temporal (sin CHROME_PROFILE_DIR).");
  }

  const browser = await puppeteer.launch(launchOpts);

  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(90000);
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
    );

    // 1) Visitar la hoja (debería abrir sin pedir login si el perfil tiene sesión)
    console.log("➡️ Abriendo hoja (edit) para validar sesión/cookies…");
    await page.goto(sheetUrl, { waitUntil: "networkidle2", timeout: 90000 });
    await sleep(2000);

    const urlNow = page.url();
    if (looksLikeGoogleLogin(urlNow)) {
      throw new Error(
        "El perfil no tiene sesión válida (redirige a login). Abre el navegador con ese userDataDir por VNC, inicia sesión y vuelve a correr."
      );
    }

    // 2) Permitir descargas en `downloadPath` vía CDP (método legacy)
    const cdp = await page.target().createCDPSession();
    await cdp.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath,
    });

    // 3) Armar URL de exportación CSV
    //    Si tu sheet requiere un gid específico, agrega &gid=<gid>
    const base = sheetUrl.split("/edit")[0];
    const exportUrl = `${base}/export?format=csv&gid=1765604646`;

    // 4) Disparar descarga
    console.log("⬇️ Descargando CSV con page.goto(exportUrl)…");
    try {
      await page.goto(exportUrl, { waitUntil: "networkidle2", timeout: 90000 });
    } catch (err) {
      if (!String(err.message).includes("net::ERR_ABORTED")) throw err;
    }

    // 5) Esperar a que el archivo aparezca
    const waitEnd = Date.now() + 15000; // hasta 15s
    let csvPath = null;
    while (Date.now() < waitEnd) {
      const files = fs
        .readdirSync(downloadPath)
        .filter((f) => f.endsWith(".csv"))
        .map((f) => path.join(downloadPath, f));
      if (files.length > 0) {
        csvPath = files[0];
        break;
      }
      await sleep(500);
    }

    if (!csvPath) {
      throw new Error("No se descargó ningún CSV en la carpeta " + downloadPath);
    }

    console.log("📂 Archivo descargado en:", csvPath);
    return csvPath;
  } finally {
    await browser.close();
  }
}

/**
 * Procesa el CSV descargado para actualizar la base de datos
 */
async function leeGoogleSheet() {
  try {
    console.clear();
    console.log("Iniciando proceso de descarga...");
    const csvPath = await downloadGoogleSheetAsCSV();

    console.log("Procesando archivo CSV...");
    const rows = [];

    await new Promise((resolve, reject) => {
      fs.createReadStream(csvPath)
        .pipe(csvParser({ headers: false }))
        .on("data", (row) => {
          const rowArray = Object.values(row);
          const maxColumns = 13; // Ajusta según columnas esperadas
          const filledRow = [...rowArray, ...Array(maxColumns - rowArray.length).fill(null)];
          rows.push(filledRow);
        })
        .on("end", resolve)
        .on("error", reject);
    });

    const clienteID = "5";

    const hoy = new Date();
    const ano = hoy.getFullYear();
    const mes = hoy.getMonth() + 1;

    const filaInicio = 11740;

    const res_fec_mes = await pool.query(querys.obtieneMesID(ano, mes));
    const MesVentaID = res_fec_mes.rows[0].mes_venta_id;

    console.log(ano, mes, MesVentaID);

    const data = await pool.query(querys.obtieneCampanaID(clienteID));

    for (const campana of data.rows) {
      const campanaID = campana.cam_id;
      console.log(`Procesando campaña ID: ${campanaID}...`);

      const updates = [];
      for (let rowIndex = filaInicio; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex];
        if (!row || !Array.isArray(row)) continue;

        const rut = row[1]?.trim();
        const telefono = row[4]?.trim();
        const contrato = row[7]?.toString().trim();
        const estado = row[11]?.toString().toUpperCase();

        const rawFechaIngreso = row[0]?.toString().trim().replace(/\u200B/g, "");
        const rawFechaContrato = row[8]?.toString().trim();
        const rawFechaFuga = row[10]?.toString().trim();

        const fecha_ingreso = moment(rawFechaIngreso, [
          "YYYY-MM-DD HH:mm:ss",
          "D/M/YYYY H:mm:ss",
          "DD/MM/YYYY H:mm:ss",
          "M/D/YYYY H:mm:ss",
          "YYYY-M-D H:mm:ss",
          "YYYY/MM/DD H:mm:ss",
          "DD-MM-YYYY HH:mm:ss",
          "DD/MM/YYYY",
        ]).isValid()
          ? moment(rawFechaIngreso, [
              "YYYY-MM-DD HH:mm:ss",
              "D/M/YYYY H:mm:ss",
              "DD/MM/YYYY H:mm:ss",
              "M/D/YYYY H:mm:ss",
              "YYYY-M-D H:mm:ss",
              "YYYY/MM/DD H:mm:ss",
              "DD-MM-YYYY HH:mm:ss",
              "DD/MM/YYYY",
            ]).format("YYYY-MM-DD HH:mm:ss")
          : null;

        if (!fecha_ingreso) {
          console.warn(`⚠️ Fecha inválida en fila ${rowIndex + 1}, RUT: ${rut}`);
          continue;
        }

        const fecha_contrato = rawFechaContrato
          ? moment(rawFechaContrato, ["D/M/YYYY", "DD/MM/YYYY", "M/D/YYYY"]).isValid()
            ? moment(rawFechaContrato, ["D/M/YYYY", "DD/MM/YYYY", "M/D/YYYY"]).format("YYYY-MM-DD")
            : null
          : null;

        const fecha_fuga = rawFechaFuga
          ? moment(rawFechaFuga, ["D/M/YYYY", "DD/MM/YYYY", "M/D/YYYY"]).isValid()
            ? moment(rawFechaFuga, ["D/M/YYYY", "DD/MM/YYYY", "M/D/YYYY"]).format("YYYY-MM-DD")
            : null
          : null;

        console.log("fecha ingreso : ", fecha_ingreso, fecha_contrato, fecha_fuga);

        let beneficiarios = 0;
        const beneficiariosRaw = row[9]?.trim();
        if (beneficiariosRaw) {
          const beneficiariosMap = {
            "2.99999999999999": 3,
            "0.799999999999999": 1,
            "0.8": 1,
            "1.6": 2,
            "3.2": 4,
            "4.99999999999999": 5,
            "5.9999999999999": 6,
            "5.99999999999999": 6,
            "6.99999999999999": 7,
          };
          beneficiarios =
            beneficiariosMap[beneficiariosRaw] || parseInt(beneficiariosRaw) || 0;
        }

        if (contrato !== "DUPLICADO") {
          updates.push({
            fecha_ingreso,
            contrato,
            fecha_contrato,
            beneficiarios,
            fecha_fuga,
            estado,
            clienteID,
            campanaID,
            telefono,
            MesVentaID,
            rut,
          });
        }
      }

      // Hacer updates en DB
      for (const update of updates) {
        try {
          let actual_campana_id = null;
          let actual_telefono = null;
          let actual_estado = null;

          const debugQuery = `
            SELECT 
                  ven_eje_campana_id,
                  ven_eje_telefono,
                  ven_eje_respuesta_estado,
                  ven_eje_rut_cliente
            FROM genesys_backend.cx_venta_ejecutivo
            WHERE
               ven_eje_mes_venta_id = $1
              AND ven_eje_rut_cliente = TRIM($2)
          `;
          const debugVals = [update.MesVentaID, update.rut];
          const existingRows = await pool.query(debugQuery, debugVals);

          if (existingRows.rows.length > 0) {
            const firstRow = existingRows.rows[0];
            actual_campana_id = firstRow.ven_eje_campana_id;
            actual_telefono = firstRow.ven_eje_telefono;
            actual_estado = firstRow.ven_eje_respuesta_estado;
          } else {
            const debugQRut = `
              SELECT 
                    ven_eje_campana_id,
                    ven_eje_respuesta_estado
              FROM genesys_backend.cx_venta_ejecutivo
              WHERE
                ven_eje_mes_venta_id = $1
                AND ven_eje_telefono = $2
            `;
            const debugVRut = [update.MesVentaID, update.telefono];
            const existRut = await pool.query(debugQRut, debugVRut);
            const firstRowRut = existRut.rows[0];
            if (firstRowRut) {
              console.log(
                `NO ENCONTRADO POR RUT, ${update.rut} , ${update.telefono}, ${update.campanaID}, CAMPANA ACTUAL : ${firstRowRut.ven_eje_campana_id}, ESTADO ACTUAL : ${firstRowRut.ven_eje_respuesta_estado}`
              );
            } else {
              console.log(`NO ENCONTRADO, ${update.rut} , ${update.telefono}, ${update.campanaID}`);
            }
          }

          const query = `
            UPDATE genesys_backend.cx_venta_ejecutivo
            SET
              ven_eje_respuesta_fecha_ingreso = $1,
              ven_eje_respuesta_contrato = $2,
              ven_eje_respuesta_fecha_contratacion = $3,
              ven_eje_respuesta_beneficiarios = $4,
              ven_eje_respuesta_fecha_fuga = $5,
              ven_eje_respuesta_estado = $6
            WHERE
              ven_eje_cliente_id = $7
              AND ven_eje_campana_id = $8
              AND ven_eje_telefono = TRIM($9)
              AND ven_eje_mes_venta_id = $10
              AND ven_eje_rut_cliente = TRIM($11)
              AND ven_eje_respuesta_estado NOT IN (
                'DUPLICADO','RECHAZA VENTA','CORTA','RECHAZADA POR COMPRA EN CYBER',
                'EXITOSO','TIMEOUT','RECHAZADA POR CALIDAD','RETRACTO'
              )
          `;
          const values = [
            update.fecha_ingreso,
            update.contrato,
            update.fecha_contrato,
            update.beneficiarios,
            update.fecha_fuga,
            update.estado,
            update.clienteID,
            update.campanaID,
            update.telefono,
            update.MesVentaID,
            update.rut,
          ];

          const result = await pool.query(query, values);

          if (result.rowCount > 0) {
            console.log(update.rut, ": ACTUALIZADO", update.fecha_ingreso);
          } else {
            if (actual_estado !== "EXITOSO" && update.estado === "EXITOSO" && update.contrato === "SI") {
              console.log(
                `NO SE ACTUALIZA,${actual_campana_id},${update.fecha_ingreso},${update.rut},${update.telefono},${actual_estado},` +
                  `${update.campanaID},${update.rut},${update.telefono},${update.estado}`
              );
            }
          }
        } catch (error) {
          console.error(`ERROR AL ACTUALIZAR, ${update.rut}`, error.message);
        }
      }

      // Updates masivos según reglas
      let queryU1 = `
        UPDATE genesys_backend.cx_venta_ejecutivo
        SET ven_eje_respuesta_estado = 'PENDIENTE POR RED SALUD'
        WHERE
          ven_eje_cliente_id = '${clienteID}'
          AND ven_eje_campana_id = '${campanaID}'
          AND ven_eje_respuesta_contrato='NO'
          AND ven_eje_respuesta_estado = 'EXITOSO'
          AND ven_eje_mes_venta_id='${MesVentaID}'
      `;
      await pool.query(queryU1);

      let queryU2 = `
        UPDATE genesys_backend.cx_venta_ejecutivo
        SET ven_eje_respuesta_estado = 'PENDIENTE POR RED SALUD'
        WHERE
          ven_eje_cliente_id = '${clienteID}'
          AND ven_eje_campana_id = '${campanaID}'
          AND ven_eje_mes_venta_id='${MesVentaID}'
          AND (
            ven_eje_respuesta_estado in ('','PENDIENTE')
            OR ven_eje_respuesta_estado is null
          )
      `;
      await pool.query(queryU2);

      let queryU3 = `
        UPDATE genesys_backend.cx_venta_ejecutivo
        SET ven_eje_respuesta_estado = 'RECUPERADA Y PENDIENTE POR RED SALUD'
        WHERE
          ven_eje_cliente_id = '${clienteID}'
          AND ven_eje_campana_id = '${campanaID}'
          AND ven_eje_respuesta_estado in ('NO INGRESA','FALLIDO')
          AND ven_eje_recuperado_por > 0
          AND ven_eje_mes_venta_id='${MesVentaID}'
      `;
      await pool.query(queryU3);

      let queryU4 = `
        UPDATE genesys_backend.cx_venta_ejecutivo
        SET ven_eje_respuesta_estado = 'RETRACTO'
        WHERE
          ven_eje_cliente_id = '${clienteID}'
          AND ven_eje_campana_id = '${campanaID}'
          AND ven_eje_respuesta_contrato='RETRACTO'
          AND ven_eje_mes_venta_id='${MesVentaID}'
      `;
      await pool.query(queryU4);
    }
  } catch (error) {
    console.error("Error en leeGoogleSheet:", error.message, error.stack);
  }
}

(async () => {
  try {
    await leeGoogleSheet();
    console.log("Proceso finalizado correctamente.");
  } catch (error) {
    console.error("Error en el proceso completo:", error.message);
  }
})();