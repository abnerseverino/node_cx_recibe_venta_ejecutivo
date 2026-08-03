/**
 * app.extrae.estado.alemana.js
 * - Login portal Alemana Seguros
 * - Lee tabla paginada
 * - Mapea estado (EMITIDA => EXITOSO, etc.)
 * - Actualiza cx_venta_ejecutivo por rut + mes + campañas
 * - Avanza página de forma robusta (espera a que cambie el contenido)
 */

const { pool } = require("../../config/conexion");
const puppeteer = require("puppeteer");
const querys = require("../../data/querys");
require("dotenv").config();

const urlLogin =
  "https://ventadigital.alemanaseguros.cl/portalventadigital/accesoauth0";

// ✅ Recomendado: variables de entorno (ALEMANA_RUT / ALEMANA_PASS)
const rutLogin = process.env.ALEMANA_RUT || "16876474-k";
const passLogin = process.env.ALEMANA_PASS || "Dol1530*";

// Campañas vida, macc y renta alemana
const campanasIDs = [34, 35, 44, 65, 50];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizaEstado(txt) {
  return (txt ?? "")
    .toString()
    .normalize("NFKC")
    .replace(/\u00A0/g, " ") // NBSP
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function mapearEstado(estadoRaw) {
  const key = normalizaEstado(estadoRaw);

  const exact = {
    ASEGURADO: "PENDIENTE",
    EMITIDA: "EXITOSO",
    "PAGO FLUJO COMPLETADO": "EXITOSO",
    "FORMA DE PAGO": "PENDIENTE",
    "EVALUACIÓN POR FORMA": "PENDIENTE",
    "SOLICITUD DE FIRMA": "PENDIENTE",
    TITULAR: "PENDIENTE",
    "DESISTIDO POR EJECUTIVO": "RECHAZADA",
    "DESISTIDA POR PLAZO": "RECHAZADA",
    BENEFICIARIO: "PENDIENTE",
    ANULADA: "RECHAZADA",
    ACEPTACIONES: "PENDIENTE",
  };

  if (exact[key]) return { estado: exact[key], key };

  // tolerancia por patrones
  if (key.startsWith("EMITIDA")) return { estado: "EXITOSO", key };
  if (key.includes("PAGO FLUJO COMPLETADO")) return { estado: "EXITOSO", key };

  if (key.includes("DESISTID")) return { estado: "RECHAZADA", key };
  if (key.includes("ANULAD")) return { estado: "RECHAZADA", key };

  if (key.includes("FORMA DE PAGO")) return { estado: "PENDIENTE", key };
  if (key.includes("SOLICITUD DE FIRMA")) return { estado: "PENDIENTE", key };
  if (key.includes("EVALUACIÓN")) return { estado: "PENDIENTE", key };
  if (key.includes("ACEPTACIONES")) return { estado: "PENDIENTE", key };
  if (key.includes("TITULAR")) return { estado: "PENDIENTE", key };
  if (key.includes("BENEFICIARIO")) return { estado: "PENDIENTE", key };
  if (key.includes("ASEGURADO")) return { estado: "PENDIENTE", key };

  return { estado: "NO DEFINIDO", key };
}

// Portal: en tu screenshot la FECHA viene como M/D/YYYY (ej: 1/21/2026)
function parseFechaContratacion(fechaTxt) {
  if (!fechaTxt) return "0000-00-00";
  const t = fechaTxt.trim();
  const parts = t.split("/");
  if (parts.length !== 3) return "0000-00-00";

  const mm = parts[0]?.padStart(2, "0");
  const dd = parts[1]?.padStart(2, "0");
  const yyyy = parts[2];

  if (!/^\d{4}$/.test(yyyy)) return "0000-00-00";
  return `${yyyy}-${mm}-${dd}`;
}

// Lee tabla (tbody) como matriz de strings
async function leerTabla(page) {
  await page.waitForSelector("table.mt-5 tbody tr", { visible: true });

  const rows = await page.$$eval("table.mt-5 tbody tr", (trs) =>
    trs.map((tr) =>
      Array.from(tr.querySelectorAll("td")).map((td) =>
        (td.innerText || "").trim()
      )
    )
  );

  return rows;
}

// Espera “cambio” de página comparando primera celda (o el HTML completo)
async function esperarCambioTabla(page, primeraCeldaAntes) {
  // intenta varias veces por si el portal carga lento
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const primeraCeldaAhora = await page.evaluate(() => {
      const td = document.querySelector("table.mt-5 tbody tr td");
      return td ? td.innerText.trim() : "";
    });

    if (primeraCeldaAhora && primeraCeldaAhora !== primeraCeldaAntes) return true;
  }
  return false;
}

const extraerDatos = async () => {
  const hoy = new Date();
  const ano = hoy.getFullYear();
  const mes = hoy.getMonth() + 1;

  let browser;

  try {
    const res_fec_mes = await pool.query(querys.obtieneMesID(ano, mes));
    const MesVentaID = res_fec_mes.rows?.[0]?.mes_venta_id;

    if (!MesVentaID) {
      throw new Error(`No se pudo obtener MesVentaID para ${ano}-${mes}`);
    }

    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(60000);

    await page.goto(urlLogin, { waitUntil: "networkidle2", timeout: 120000 });

    console.log("🔍 Buscando campos de usuario y contraseña...");
    await page.waitForSelector("#username", { visible: true });
    await page.waitForSelector("#password", { visible: true });

    console.log("✅ Campos detectados. Ingresando credenciales...");
    await page.type("#username", rutLogin, { delay: 50 });
    await page.type("#password", passLogin, { delay: 50 });

    await page.evaluate(() => {
      const loginButton = document.querySelector("#btn-login");
      if (loginButton) loginButton.removeAttribute("disabled");
    });

    console.log("🚀 Iniciando sesión...");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 120000 }),
      page.click("#btn-login"),
    ]);

    if (!page.url().includes("portalventadigital")) {
      throw new Error("❌ Error en autenticación (no aterrizó en portalventadigital).");
    }

    console.log("✅ Inicio de sesión exitoso.");

    // El portal lista las propuestas de más reciente a más antigua, así
    // que basta con recorrer las primeras N páginas: seguir paginando hacia
    // atrás solo procesa ventas de meses ya cerrados que jamás van a hacer
    // match con el ven_eje_mes_venta_id del mes actual.
    const MAX_PAGINAS = 100;
    let pageNumber = 1;

    while (true) {
      console.log(`\n📄 Extrayendo datos de la página ${pageNumber}...`);

      const rows = await leerTabla(page);

      console.log(`🔍 Se encontraron ${rows.length} registros en la página ${pageNumber}`);
      if (rows.length === 0) break;

      // ✅ IMPORTANTE: según tu tabla:
      // 0 Propuesta | 1 Rut | 2 Nombre | 3 Fecha | 4 UF | 5 Estado | 6 Fecha envío
      for (const [idx, row] of rows.entries()) {
        if (row.length < 6) {
          console.log(`⚠ Registro incompleto idx=${idx}:`, row);
          continue;
        }

        const numero_propuesta = row[0] || "";
        const rutCliente = row[1] || "";
        const fecha_contratacion = parseFechaContratacion(row[3]);
        const estadoRaw = row[5]; // ✅ Estado está en índice 5 (no 4)

        const { estado, key: estadoKey } = mapearEstado(estadoRaw);

        if (estado === "NO DEFINIDO") {
          console.log("❗Estado NO DEFINIDO detectado:", {
            propuesta: numero_propuesta,
            rutCliente,
            estadoRaw,
            estadoKey,
            ufLeida: row[4], // para que veas que row[4] es UF
            chars: [...(estadoRaw ?? "")].map((c) => c.charCodeAt(0)),
          });
        }

        try {
          const query = `
            UPDATE genesys_backend.cx_venta_ejecutivo
            SET 
              ven_eje_respuesta_fecha_contratacion = $1,
              ven_eje_respuesta_estado = $2,
              ven_eje_n_propuesta = $3
            WHERE
              ven_eje_campana_id IN (${campanasIDs.join(",")})
              AND ven_eje_mes_venta_id = $4
              AND SPLIT_PART(ven_eje_rut_cliente, '-', 1) = SPLIT_PART($5, '-', 1)
              AND ven_eje_respuesta_estado NOT IN
                ('DUPLICADO','RECHAZA VENTA','EXITOSO','RECHAZADA POR CALIDAD')
          `;

          const values = [
            fecha_contratacion,
            estado,
            numero_propuesta,
            MesVentaID,
            rutCliente,
          ];

          const result = await pool.query(query, values);

          console.log(
            `✅ Update ok [${result.rowCount}] Propuesta=${numero_propuesta} Rut=${rutCliente} EstadoRaw="${estadoRaw}" EstadoKey="${estadoKey}" EstadoFinal=${estado} Fecha=${fecha_contratacion}`
          );
        } catch (error) {
          console.error(
            `❌ Error update Rut=${rutCliente} Propuesta=${numero_propuesta}:`,
            error.message
          );
        }
      }

      if (pageNumber >= MAX_PAGINAS) {
        console.log(`✅ Se alcanzó el límite de ${MAX_PAGINAS} páginas. Finalizando.`);
        break;
      }

      // ---- Paginar ----
      // Guardamos “marca” antes de click para saber si cambió
      const firstCellBefore = rows?.[0]?.[0] || "";

      // Selector de "siguiente"
      const nextSelector =
        ".pagination .page-item.active + .page-item a.page-link";

      const nextExists = await page.$(nextSelector);

      if (!nextExists) {
        console.log("✅ No hay más páginas. Finalizando.");
        break;
      }

      // Verificar si está deshabilitado
      const isDisabled = await page.evaluate((sel) => {
        const a = document.querySelector(sel);
        if (!a) return true;
        const li = a.closest(".page-item");
        return li?.classList.contains("disabled") || a.getAttribute("aria-disabled") === "true";
      }, nextSelector);

      if (isDisabled) {
        console.log("✅ Botón siguiente deshabilitado. Finalizando.");
        break;
      }

      console.log("➡ Avanzando a la siguiente página...");

      // Click + esperar cambio real de tabla
      await page.click(nextSelector);

      const changed = await esperarCambioTabla(page, firstCellBefore);
      if (!changed) {
        console.log("⚠ No detecté cambio de página (tabla no cambió). Corto para evitar loop infinito.");
        break;
      }

      pageNumber++;
    }
  } catch (error) {
    console.error("❌ Error general:", error.message);
  } finally {
    try {
      if (browser) await browser.close();
    } catch {}
    try {
      await pool.end();
    } catch {}
  }
};

extraerDatos();