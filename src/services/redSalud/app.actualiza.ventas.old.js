const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const csvParser = require("csv-parser");
const moment = require("moment");
const { pool } = require("../../config/conexion");
const querys = require("../../data/querys");

require('dotenv').config({ path: require('find-config')('../../.env') });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const googleCredentials = {
  email: process.env.GOOGLE_EMAIL,
  password: process.env.GOOGLE_PASSWORD,
};

console.log("Credenciales:", googleCredentials.email, googleCredentials.password);

/**
 * Inicia sesión en Google, visita la hoja para obtener las cookies
 * y luego llama a la URL de exportación con page.goto(exportUrl).
 * Dado que la versión de Puppeteer no soporta page.waitForEvent("download"),
 * se ignora el error net::ERR_ABORTED, se espera un tiempo,
 * y se verifica que el CSV aparezca en la carpeta.
 */
async function downloadGoogleSheetAsCSV() {
  // URL de tu Google Sheet
  const sheetUrl =
    "https://docs.google.com/spreadsheets/d/1FvlZU1AUJoKrdLrtNaxo9nGBZvTAhligVbaEhDrp7XU/edit#gid=1765604646";

  // Carpeta donde descargaremos el CSV
  const downloadPath = path.resolve(__dirname, "./downloads");
  if (!fs.existsSync(downloadPath)) {
    fs.mkdirSync(downloadPath);
  }

  // Elimina descargas CSV previas (opcional)
  fs.readdirSync(downloadPath).forEach((file) => {
    if (file.endsWith(".csv")) {
      fs.unlinkSync(path.join(downloadPath, file));
    }
  });

  // Lanza Puppeteer (cámbialo a headless: false para ver la ventana y depurar)
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);

    // 1) Iniciar sesión en Google
    await page.goto("https://accounts.google.com/signin/v2/identifier", {
      waitUntil: "networkidle2",
    });

    // Ingresar email
    await page.waitForSelector("input[type='email']", { visible: true });
    await page.type("input[type='email']", googleCredentials.email, { delay: 80 });
    await page.click("#identifierNext");

    // Esperar navegación para ingresar contraseña
    await page.waitForNavigation({ waitUntil: "networkidle2" });
    await page.type("input[type='password']", googleCredentials.password, { delay: 80 });
    await page.click("#passwordNext");

    // Esperar a que termine la navegación tras login
    await page.waitForNavigation({ waitUntil: "networkidle2" });
    await sleep(3000);

    // 2) Visitar la hoja para adquirir cookies de docs.google.com
    await page.goto(sheetUrl, { waitUntil: "networkidle2" });
    await sleep(3000);

    // 3) Permitir descargas automáticas en downloadPath
    const cdpSession = await page.target().createCDPSession();
    await cdpSession.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadPath,
    });

    // 4) Construir la URL de exportación
    const exportUrl = sheetUrl.split("/edit")[0] + "/export?format=csv";

    // 5) Llamar a page.goto(exportUrl) y capturar net::ERR_ABORTED
    console.log("Descargando CSV con page.goto(exportUrl)...");
    try {
      await page.goto(exportUrl, { waitUntil: "networkidle2" });
    } catch (err) {
      // Si es "net::ERR_ABORTED", lo ignoramos
      if (!err.message.includes("net::ERR_ABORTED")) {
        throw err; // otro error, relanzar
      }
    }

    // 6) Esperar unos segundos para que la descarga finalice
    await sleep(5000);

    // 7) Verificar si apareció un archivo CSV en la carpeta
    const downloadedFiles = fs.readdirSync(downloadPath)
      .filter((f) => f.endsWith(".csv"))
      .map((f) => path.join(downloadPath, f));

    if (downloadedFiles.length === 0) {
      throw new Error("No se descargó ningún CSV en la carpeta " + downloadPath);
    }

    // Tomamos el primer CSV (o el único)
    const csvPath = downloadedFiles[0];
    console.log("Archivo descargado en:", csvPath);
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

    // Lógica de DB
    const clienteID = "5";

    const hoy = new Date();
    const ano = hoy.getFullYear(); // Obtiene el año actual
    const mes = hoy.getMonth() + 1; // 
    
    //const ano ="2025";
    //const mes ="08";

    const filaInicio = 11740;

    const res_fec_mes = await pool.query(
      querys.obtieneMesID(ano,mes)
    );
    const MesVentaID = res_fec_mes.rows[0].mes_venta_id;

    console.log(ano,mes,MesVentaID);


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

        const rawFechaIngreso = row[0]?.toString().trim().replace(/\u200B/g, '');
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
          "DD/MM/YYYY"
        ]).isValid()
          ? moment(rawFechaIngreso, [
              "YYYY-MM-DD HH:mm:ss",
              "D/M/YYYY H:mm:ss",
              "DD/MM/YYYY H:mm:ss",
              "M/D/YYYY H:mm:ss",
              "YYYY-M-D H:mm:ss",
              "YYYY/MM/DD H:mm:ss",
              "DD-MM-YYYY HH:mm:ss",
              "DD/MM/YYYY"
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

        console.log('fecha ingreso : ',fecha_ingreso, fecha_contrato,fecha_fuga);
        
      

        // Mapeo de beneficiarios (ejemplo)
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
            beneficiariosMap[beneficiariosRaw] ||
            parseInt(beneficiariosRaw) ||
            0;
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
          // Declaras las variables arriba para que tengan ámbito en toda la función
          let actual_campana_id = null;
          let actual_telefono   = null;
          let actual_estado     = null;
          
          // 1. Consulta previa para ver qué hay en la BD con estos criterios
          const debugQuery = `
            SELECT 
                  ven_eje_campana_id,
                  ven_eje_telefono,
                  ven_eje_respuesta_estado
            FROM genesys_backend.cx_venta_ejecutivo
            WHERE
               ven_eje_mes_venta_id = $1
              AND ven_eje_rut_cliente = TRIM($2)
          `;
          const debugVals = [
            update.MesVentaID,
            update.rut,
          ];
      
          const existingRows = await pool.query(debugQuery, debugVals);
      
          if (existingRows.rows.length > 0) {
            const firstRow = existingRows.rows[0];
            actual_campana_id = firstRow.ven_eje_campana_id;
            actual_rut  = firstRow.ven_eje_rut_cliente;
            actual_telefono   = firstRow.ven_eje_telefono;
            actual_estado     = firstRow.ven_eje_respuesta_estado;
             
             
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
              const debugVRut = [
                update.MesVentaID,
                update.telefono,
              ];
          
              const existRut = await pool.query(debugQRut, debugVRut);
              const firstRowRut = existRut.rows[0];

              console.log(`NO ENCONTRADO, ${update.rut} , ${update.telefono}, ${update.campanaID}, CAMPANA ACTUAL : ${firstRowRut.ven_eje_campana_id}, ESTADO ACTUAL : ${firstRowRut.ven_eje_respuesta_estado}`);
          }
      
          // 2. Realizas tu UPDATE
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
      
          // 3. Chequeas rowCount
          if (result.rowCount > 0) {
            // Se actualizó
           console.log( update.rut, ': ACTUALIZADO', update.fecha_ingreso);
          } else {
            // rowCount === 0 => no se actualizó nada
            if (actual_estado!=='EXITOSO' && update.estado === "EXITOSO"  && update.contrato === "SI") {

              console.log(
                `NO SE ACTUALIZA,${actual_campana_id},${fecha_ingreso},${actual_rut},${actual_telefono},${actual_estado},` +
                `${update.campanaID},${update.rut},${update.telefono},${update.estado}` )
            }
          }
      
        } catch (error) {
          console.error(`ERROR AL ACTUALIZAR, ${update.rut}`, error.message);
        }
      }
      
      

      // Otros updates masivos según reglas
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
