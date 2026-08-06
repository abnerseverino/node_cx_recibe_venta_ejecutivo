#!/usr/bin/env node

const { S3Client, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream");
const { promisify } = require("util");
const xlsx = require("xlsx");

require("dotenv").config({ path: require("find-config")("../../.env") });

const { pool } = require("../../config/conexion");
const querys = require("../../data/querys");

const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
const bucketName = process.env.AWS_S3_BUCKET || "bucket-cx-sftp";
const prefix = "colmena/in/reportes/";
const localDir = path.resolve(__dirname, "../../../ENTRADA/Colmena");

const campanaID = 43;

/** true si `fecha` cae el mismo día calendario que `hoy` o que `ayer` */
function esDeHoyOAyer(fecha) {
  const hoy = new Date();
  const ayer = new Date(Date.now() - 86400000);
  const mismoDia = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  return mismoDia(fecha, hoy) || mismoDia(fecha, ayer);
}

/** Descarga los excel de reportes de hoy/ayer desde S3 (por fecha de modificación en S3) */
async function descargarArchivos() {
  const lista = await s3.send(
    new ListObjectsV2Command({ Bucket: bucketName, Prefix: prefix })
  );

  const archivos = (lista.Contents || []).filter(
    (o) => /\.xlsx?$/i.test(o.Key) && o.LastModified && esDeHoyOAyer(new Date(o.LastModified))
  );

  if (!archivos.length) {
    console.log("⚠️ No hay archivos excel de hoy/ayer en S3 bajo", prefix);
    return [];
  }

  if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });

  const descargados = [];
  for (const obj of archivos) {
    const nombre = path.basename(obj.Key);
    const destino = path.join(localDir, nombre);

    if (!fs.existsSync(destino)) {
      console.log(`⬇️  Descargando ${obj.Key} → ${destino}`);
      const dataGet = await s3.send(
        new GetObjectCommand({ Bucket: bucketName, Key: obj.Key })
      );
      await promisify(pipeline)(dataGet.Body, fs.createWriteStream(destino));
    } else {
      console.log(`⏩ Ya existe localmente: ${nombre}`);
    }

    descargados.push(destino);
  }

  console.log("✅ Descargas completadas.");
  return descargados;
}

function normalizaTexto(s) {
  return String(s || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Convierte una celda de fecha (Date de excel o texto dd/mm/yyyy) a 'YYYY-MM-DD' */
function normalizaFecha(valor) {
  if (valor instanceof Date && !isNaN(valor)) {
    const yyyy = valor.getFullYear();
    const mm = String(valor.getMonth() + 1).padStart(2, "0");
    const dd = String(valor.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  const texto = String(valor || "").trim();
  const match = texto.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (match) {
    const [, dd, mm, yyyy] = match;
    return `${yyyy}-${mm}-${dd}`;
  }

  return null;
}

/**
 * Lee el excel ubicando las columnas por su encabezado
 * (Nombre, Apellido, Rut, Tipo, N° Póliza, Fecha Emisión), no por posición fija.
 */
function extraerRegistros(ruta) {
  const wb = xlsx.readFile(ruta, { cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const filas = xlsx.utils.sheet_to_json(ws, { header: 1, defval: "" });

  const encabezados = (filas[0] || []).map(normalizaTexto);
  const idx = (nombre) => encabezados.indexOf(normalizaTexto(nombre));

  const colRut = idx("Rut");
  const colPoliza = idx("N° Póliza");
  const colFecha = idx("Fecha Emisión");

  if (colRut === -1 || colPoliza === -1 || colFecha === -1) {
    throw new Error(
      `No se encontraron las columnas esperadas (Rut/N° Póliza/Fecha Emisión). Encabezados leídos: ${JSON.stringify(
        filas[0]
      )}`
    );
  }

  return filas.slice(1).map((fila, i) => ({
    linea: i + 2,
    rut: String(fila[colRut] || "").trim(),
    poliza: String(fila[colPoliza] || "").trim(),
    fechaEmision: normalizaFecha(fila[colFecha]),
  }));
}

async function actualizaRegistro({ rut, poliza, fechaEmision, MesVentaID }) {
  const query = `
    UPDATE genesys_backend.cx_venta_ejecutivo
    SET
      ven_eje_n_poliza = $1,
      ven_eje_respuesta_fecha_contratacion = $2,
      ven_eje_respuesta_estado = 'EXITOSO'
    WHERE
      ven_eje_rut_cliente = TRIM($3)
      AND ven_eje_campana_id = $4
      AND ven_eje_mes_venta_id = $5
      AND COALESCE(ven_eje_respuesta_estado, '') NOT IN
        ('DUPLICADO','RECHAZA VENTA','RECHAZADA POR CALIDAD','RETRACTO','EXITOSO')
  `;

  const values = [poliza, fechaEmision, rut, campanaID, MesVentaID];

  return pool.query(query, values);
}

(async () => {
  try {
    const hoy = new Date();
    const ano = hoy.getFullYear();
    const mes = hoy.getMonth() + 1;

    const resMes = await pool.query(querys.obtieneMesID(ano, mes));
    const MesVentaID = resMes.rows?.[0]?.mes_venta_id;

    if (!MesVentaID) {
      throw new Error(`No se pudo obtener MesVentaID para ${ano}-${mes}`);
    }

    console.log(`📅 Campaña ${campanaID}, MesVentaID ${MesVentaID} (${ano}-${mes})`);

    const excels = await descargarArchivos();
    if (!excels.length) return;

    console.log("\n🔍 Procesando y actualizando pólizas en BD:");
    for (const archivo of excels) {
      console.log(`\n── ${path.basename(archivo)} ──`);
      const registros = extraerRegistros(archivo);

      for (const { linea, rut, poliza, fechaEmision } of registros) {
        if (!rut || !poliza || !fechaEmision) {
          console.log(
            ` ⚠️ Línea ${linea}: datos incompletos (rut="${rut}", poliza="${poliza}", fecha="${fechaEmision}"), omito.`
          );
          continue;
        }

        try {
          const result = await actualizaRegistro({ rut, poliza, fechaEmision, MesVentaID });
          if (result.rowCount > 0) {
            console.log(
              ` ✅ Línea ${linea}: actualizado rut=${rut}, poliza=${poliza}, fecha=${fechaEmision}`
            );
          } else {
            console.warn(` ⚠️ Línea ${linea}: no encontró coincidencia para rut=${rut}`);
          }
        } catch (error) {
          console.error(` ❌ Línea ${linea}: error al actualizar rut=${rut}:`, error.message);
        }
      }
    }
  } catch (error) {
    console.error("❌ Error fatal:", error.message);
  } finally {
    await pool.end();
  }
})();
