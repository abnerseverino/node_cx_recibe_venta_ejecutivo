const { pool } = require("../../config/conexion");
const puppeteer = require("puppeteer");
const { convertirFecha } = require("../../helpers/dates");
const querys = require("../../data/querys");

const urlLogin = 'https://ventadigital.alemanaseguros.cl/portalventadigital/accesoauth0';
const rut = '16876474-k';
const password = 'Dol1530*';


const hoy = new Date();
//const ano = hoy.getFullYear(); // Obtiene el año actual                                                                                                                                                                                                  
//const mes = hoy.getMonth() + 1; //                                                                                                                                                                                                                        

const ano = "2025";
const mes = "07";

const campanasIDs = [35, 44]; // campanas vida, macc y renta de alemana

const extraerDatos = async () => {

    let res_fec_mes = await pool.query(querys.obtieneMesID(ano, mes));
    let MesVentaID = res_fec_mes.rows[0].mes_venta_id;
    
    const browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();
    await page.goto(urlLogin, { waitUntil: 'networkidle2' });

    console.log("🔍 Buscando campos de usuario y contraseña...");

    await page.waitForSelector('#username', { visible: true });
    await page.waitForSelector('#password', { visible: true });

    console.log("✅ Campos detectados. Ingresando credenciales...");

    await page.type('#username', rut, { delay: 100 });
    await page.type('#password', password, { delay: 100 });

    await page.evaluate(() => {
        const loginButton = document.querySelector('#btn-login');
        if (loginButton) loginButton.removeAttribute('disabled');
    });

    console.log("🚀 Credenciales ingresadas. Iniciando sesión...");
    await page.click('#btn-login');

    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    if (page.url().includes('portalventadigital')) {
        console.log('✅ Inicio de sesión exitoso.');

        let pageNumber = 1;

        while (true) {
            console.log(`📄 Extrayendo datos de la página ${pageNumber}...`);

            await page.waitForSelector('table.mt-5 tbody tr', { visible: true });

            const rows = await page.$$eval('table.mt-5 tbody tr', rows => {
                return rows.map(row => {
                    const columns = row.querySelectorAll('td');
                    return Array.from(columns, column => column.innerText.trim());
                });
            });

            console.log(`🔍 Se encontraron ${rows.length} registros en la página ${pageNumber}`);

            if (rows.length === 0) {
                console.log("⚠ No se encontraron registros. Es posible que el selector de la tabla haya cambiado.");
                break;
            }

            const estadoMapping = {
                "ASEGURADO": "PENDIENTE",
                "EMITIDA": "EXITOSO",
                "PAGO FLUJO COMPLETADO": "EXITOSO",
                "FORMA DE PAGO": "PENDIENTE",
                "EVALUACIÓN POR FORMA": "PENDIENTE",
                "SOLICITUD DE FIRMA": "PENDIENTE",
                "TITULAR": "PENDIENTE",
                "DESISTIDO POR EJECUTIVO": "RECHAZADA",
                "DESISTIDA POR PLAZO": "RECHAZADA",
                "BENEFICIARIO": "PENDIENTE",
                "ANULADA": "RECHAZADA",
                "ACEPTACIONES": "PENDIENTE"
            };

            for (let row of rows) {
                if (row.length >= 5) {
                    const numero_propuesta = row[0] || "No disponible";
                    const rutCliente = row[1] || "No disponible";
                    const estadoOriginal = row[4] ? row[4].toUpperCase() : "NO DISPONIBLE";
                    const estado = estadoMapping[estadoOriginal] || "NO DEFINIDO";

                    let fecha_contratacion = "0000-00-00";
                    if (row[3]) {
                        const fechaParts = row[3].split("/");
                        if (fechaParts.length === 3) {
                            fecha_contratacion = `${fechaParts[2]}-${fechaParts[0].padStart(2, '0')}-${fechaParts[1].padStart(2, '0')}`;
                        }
                    }
                    

                    // 🚀 Ejecutar la consulta SQL
                    try {
                        const query = `
                        UPDATE 
                            genesys_backend.cx_venta_ejecutivo
                        SET 
                            ven_eje_respuesta_fecha_contratacion = $1,
                            ven_eje_respuesta_estado = $2,
                            ven_eje_n_propuesta = $3
                        WHERE
                            ven_eje_campana_id IN (${campanasIDs.join(',')}) -- Convertir el array en una lista SQL
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
                        rutCliente
                    ];
                    

                    const result = await pool.query(query, values); 
                    console.log(`✅ Actualización exitosa para Propuesta: ${numero_propuesta},  RUT: ${rutCliente} , MesVentaID: ${MesVentaID} , ESTADO: ${estado} , FECHA CONTRATACION: ${fecha_contratacion}`);


                    } catch (error) {
                        console.error(`❌ Error al actualizar RUT: ${rutCliente}`, error);
                    }

                    console.log("-------------------------------------");
                } else {
                    console.log("⚠ Registro con datos incompletos.");
                }
            }

            const nextButton = await page.$('.pagination .page-item.active + .page-item a.page-link');

            if (nextButton) {
                console.log("➡ Avanzando a la siguiente página...");
                await nextButton.click();
                await new Promise(resolve => setTimeout(resolve, 3000));
                pageNumber++;
            } else {
                console.log("✅ No hay más páginas. Finalizando la extracción.");
                break;
            }
        }
    } else {
        console.error('❌ Error en la autenticación. Verifica las credenciales.');
    }

    await browser.close();
};

extraerDatos();
