const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

// Mientras la sesión siga vencida, los crons (cada 30 min) fallarían igual
// todos los días: se manda un solo correo cada este intervalo, no uno por corrida.
const INTERVALO_MIN_ENTRE_ALERTAS_HORAS = 6;

const DIR_ESTADO =
  process.env.ALERTA_ESTADO_DIR || path.resolve(__dirname, "../../../logs");
const ARCHIVO_ESTADO = path.join(DIR_ESTADO, "alerta_sesion_google.json");

function esPantallaLoginGoogle(url) {
  return ["accounts.google.com", "/ServiceLogin", "/signin"].some((p) => String(url).includes(p));
}

function leeEstado() {
  try {
    return JSON.parse(fs.readFileSync(ARCHIVO_ESTADO, "utf8"));
  } catch {
    return {};
  }
}

function guardaEstado(estado) {
  try {
    fs.mkdirSync(DIR_ESTADO, { recursive: true });
    fs.writeFileSync(ARCHIVO_ESTADO, JSON.stringify(estado));
  } catch (error) {
    console.error("⚠️ No se pudo guardar el estado de la alerta:", error.message);
  }
}

/** Sesión OK: se limpia el estado para que el próximo vencimiento alerte de inmediato. */
function marcaSesionOk() {
  if (fs.existsSync(ARCHIVO_ESTADO)) {
    try {
      fs.unlinkSync(ARCHIVO_ESTADO);
    } catch {}
  }
}

/**
 * Avisa por correo que la sesión de Google del perfil de Chrome venció.
 * Nunca lanza: si el correo falla, solo se loguea (el script ya va a fallar
 * de todas formas por la sesión vencida). `forzar` ignora el anti-spam
 * (sirve para pruebas).
 */
async function notificaSesionVencida({ script, urlFinal, forzar = false }) {
  const destino = process.env.ALERTA_MAIL_TO;
  if (!destino || !process.env.SMTP_HOST) {
    console.warn("⚠️ Sesión de Google vencida, pero no hay ALERTA_MAIL_TO/SMTP_HOST configurados: no se envía correo.");
    return false;
  }

  const estado = leeEstado();
  if (!forzar && estado.ultimoEnvio) {
    const horas = (Date.now() - new Date(estado.ultimoEnvio).getTime()) / 36e5;
    if (horas < INTERVALO_MIN_ENTRE_ALERTAS_HORAS) {
      console.log(`ℹ️ Sesión de Google vencida; ya se avisó hace ${horas.toFixed(1)} h, no se reenvía aún.`);
      return false;
    }
  }

  const cuando = new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" });

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || "false") === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    await transporter.sendMail({
      from: process.env.ALERTA_MAIL_FROM || process.env.SMTP_USER,
      to: destino,
      subject: "Sesión de Google vencida en el perfil de Looker (AndesSalud / Davila)",
      text: [
        `Detectado el ${cuando} (hora Chile) por ${script}.`,
        "",
        "Google está pidiendo volver a iniciar sesión en el perfil chrome-profiles/andessalud,",
        "así que las actualizaciones de AndesSalud y Davila NO se están ejecutando.",
        `Página a la que llegó el script: ${urlFinal}`,
        "",
        "Cómo solucionarlo (por VNC en server-cx, en una terminal):",
        "  /usr/bin/google-chrome --user-data-dir=/home/ubuntu/.config/chrome-profiles/andessalud",
        "1) Iniciar sesión con andres.mura.connectx@externos.queplan.cl (puede pedir verificación).",
        "2) Abrir el reporte para confirmar que carga.",
        "3) Cerrar Chrome COMPLETAMENTE (Ctrl+Q).",
        "",
        `Mientras siga caído se reenvía este aviso cada ${INTERVALO_MIN_ENTRE_ALERTAS_HORAS} h.`,
      ].join("\n"),
    });

    guardaEstado({ ultimoEnvio: new Date().toISOString() });
    console.log(`📧 Alerta de sesión vencida enviada a ${destino}`);
    return true;
  } catch (error) {
    console.error("❌ No se pudo enviar el correo de alerta:", error.message);
    return false;
  }
}

module.exports = { esPantallaLoginGoogle, notificaSesionVencida, marcaSesionOk };
