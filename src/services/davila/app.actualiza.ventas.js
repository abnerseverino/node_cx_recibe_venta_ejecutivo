const fs = require("fs");
const path = require("path");
const { pool } = require("../../config/conexion");
const puppeteer = require("puppeteer");
const { convertirFecha } = require("../../helpers/dates");
const querys = require("../../data/querys");
const { esPantallaLoginGoogle, notificaSesionVencida, marcaSesionOk } = require("../../helpers/alertaSesionGoogle");

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

const campanaID = 29;

// El reporte trae todo el historial (más nuevo primero). La lógica de
// negocio sobre cx_venta_ejecutivo se aplica solo a las primeras páginas
// (comportamiento histórico); las siguientes se leen solo para guardar el
// snapshot en cx_venta_looker hasta cubrir el mes pedido y el anterior.
const PAGINAS_NEGOCIO = 3;
const MAX_PAGINAS = 15;

// Encabezados reales de la tabla (mismo orden que las columnas capturadas),
// usados solo para armar el snapshot crudo de cx_venta_looker (layout
// verificado el 2026-10-01: 10 columnas).
const VENTAS_HEADERS = [
  "N°", "Certificado", "Rut Titular", "Fecha Contratación", "Plan",
  "Prima Cerrada CLP", "Estado Contratación", "Código Producto", "Canal",
  "Cantidad Benef.",
];

function filaAObjeto(headers, row) {
  const obj = {};
  headers.forEach((h, i) => (obj[h] = row[i] ?? null));
  return obj;
}

/**
 * Guarda (upsert) el snapshot crudo de un certificado tal como vino del
 * Looker. Lo usa node_cx_facturacion (davila/app.cierre.mensual.js) para
 * armar la pre factura del mes. ven_loo_datos es un arreglo (mismo formato
 * que andesSalud) con un solo elemento: la fila del certificado.
 */
async function guardaRawLooker({ certificado, rut, fila, MesVentaID }) {
  try {
    await pool.query(
      `INSERT INTO genesys_backend.cx_venta_looker
         (ven_loo_cliente, ven_loo_tabla_origen, ven_loo_campana_id,
          ven_loo_mes_venta_id, ven_loo_n_certificado, ven_loo_rut_cliente,
          ven_loo_datos, ven_loo_fecha_captura)
       VALUES ('davila', 'Ventas', $1, $2, $3, $4, $5::jsonb, now())
       ON CONFLICT (ven_loo_cliente, ven_loo_tabla_origen, ven_loo_campana_id,
                    ven_loo_mes_venta_id, ven_loo_n_certificado)
       DO UPDATE SET
         ven_loo_rut_cliente = EXCLUDED.ven_loo_rut_cliente,
         ven_loo_datos = EXCLUDED.ven_loo_datos,
         ven_loo_fecha_captura = now();`,
      [campanaID, MesVentaID, certificado, rut, JSON.stringify([filaAObjeto(VENTAS_HEADERS, fila)])]
    );
  } catch (error) {
    console.error(`❌ Error guardando raw Looker (cert ${certificado}):`, error.message);
  }
}

// El snapshot se etiqueta con el mes de la propia fecha de contratación,
// no con el --mes del script (ver la misma nota en andesSalud).
const cacheMesVenta = new Map();
async function mesVentaIdDeFecha(fechaISO) {
  const clave = fechaISO.slice(0, 7);
  if (!cacheMesVenta.has(clave)) {
    const [ano, mes] = clave.split("-").map(Number);
    const res = await pool.query(querys.obtieneMesID(ano, mes));
    cacheMesVenta.set(clave, res.rows?.[0]?.mes_venta_id || null);
  }
  return cacheMesVenta.get(clave);
}

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

    if (esPantallaLoginGoogle(page.url())) {
      await notificaSesionVencida({ script: "davila", urlFinal: page.url() });
      throw new Error("Sesión de Google vencida: la página redirigió a " + page.url());
    }
    await page.waitForSelector(".centerColsContainer");
    marcaSesionOk();

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

    // Se lee hasta pasar el primer día del mes anterior al pedido.
    const corte = new Date(Date.UTC(ano, mes - 2, 1)).toISOString().slice(0, 10);
    let guardadosLooker = 0;

    while (pageCount <= MAX_PAGINAS) {
      const aplicaNegocio = pageCount <= PAGINAS_NEGOCIO;
      let fechaMinPagina = null;
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
          if (row.length < VENTAS_HEADERS.length) {
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
          // Columna "Cantidad Benef." (la última desde que se agregaron
          // "Código Producto" y "Canal"; antes era row[7]).
          const beneficiarios = parseInt(row[9]) || 0;

          if (fecha_contrato && (!fechaMinPagina || fecha_contrato < fechaMinPagina)) {
            fechaMinPagina = fecha_contrato;
          }
          if (fecha_contrato && fecha_contrato >= corte) {
            const mesFila = await mesVentaIdDeFecha(fecha_contrato);
            if (mesFila && certificado) {
              await guardaRawLooker({ certificado, rut, fila: row, MesVentaID: mesFila });
              guardadosLooker++;
            }
          }

          if (!aplicaNegocio) continue;

          if (estado === "Activo") estado = "EXITOSO";
          else if (estado === "Inactivo") estado = "RETRACTO";

          console.log(
            `📌Fila ${index}: ID: ${id}, Rut: ${rut}, Fecha: ${fecha_contrato}, Estado: ${estado}, Beneficiarios: ${beneficiarios}`
          );

          // Si el reporte marca la venta como Inactivo (=> RETRACTO), se
          // fuerza el estado sin importar el estado actual (incluso si ya
          // estaba EXITOSO). Para cualquier otro estado se mantiene la
          // protección de no pisar estados finales ya definidos.
          const forzarRetracto = estado === "RETRACTO";

          const query1 = forzarRetracto
            ? `
            UPDATE genesys_backend.cx_venta_ejecutivo
            SET
              ven_eje_respuesta_fecha_contratacion = $1,
              ven_eje_respuesta_beneficiarios = $2,
              ven_eje_respuesta_estado = $3
            WHERE
              ven_eje_campana_id IN (29, 37, 45) AND
              ven_eje_mes_venta_id = $4 AND
              ven_eje_rut_cliente = $5;
          `
            : `
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

          // Sin la protección de estados finales: certificado y
          // beneficiarios no son un estado de negocio, así que se
          // refrescan siempre, incluso en filas ya EXITOSO donde Query1 no
          // llega a tocarlas.
          const query2 = `
            UPDATE genesys_backend.cx_venta_ejecutivo
            SET
              ven_eje_respuesta_beneficiarios = $1,
              ven_eje_n_certificado = $4
            WHERE
              ven_eje_campana_id IN (29, 37, 45) AND
              ven_eje_mes_venta_id = $2 AND
              ven_eje_rut_cliente = $3;
          `;
          const values2 = [beneficiarios, MesVentaID, rut, certificado];
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

      if (pageCount >= PAGINAS_NEGOCIO && fechaMinPagina && fechaMinPagina < corte) {
        console.log(`✅ Se cubrió desde ${corte} (fecha más antigua de la página: ${fechaMinPagina}).`);
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
    console.log(`💾 Certificados guardados en cx_venta_looker: ${guardadosLooker}`);
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
