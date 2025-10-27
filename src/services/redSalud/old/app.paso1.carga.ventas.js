const {pool} = require("../../../config/conexion");
const {mostrarMenu}    = require("../../../helpers/mensajes");

const moment = require('moment');



const funciones= require("../../../helpers/funciones");
const querys = require("../../../data/querys");
const ExcelJS = require('exceljs');
const dates = require("../../../helpers/dates");



const main = async()=>{

    
        
        try{

            let respuesta =  await mostrarMenu();
            

            console.log(respuesta[0]);

            //  Parametros de previos a la ejecucion 

            const clienteID         = "5";
            const ano               =  respuesta[0];
            const mes               =  respuesta[1];
            const campanaID         =  respuesta[2];
            let   filename          = "";
            let   flujo_venta       = "";

            if(campanaID =="22"){

                filename          = `${ano}${mes}_TMK.xlsx`; // nombre de archivo contactos
                flujo_venta       = "TMK";

            }else if(campanaID =="23"){

                filename          = `${ano}${mes}_C2C.xlsx`; // nombre de archivo contactos
                flujo_venta       = "C2C";

            }else if(campanaID =="26"){

                filename          = `${ano}${mes}_TTE.xlsx`; // nombre de archivo contactos
                flujo_venta       = "TTE";

            }else if(campanaID =="27"){

                filename          = `${ano}${mes}_DDE.xlsx`; // nombre de archivo contactos
                flujo_venta       = "DDE";
            }
            
            const path              =`../../../ENTRADA/${ano}${mes}/${filename}`;
            
            
            

            // inicia ejecucion del programa
       
            let res_fec_mes       = await pool.query(querys.obtieneMesID(ano,mes));
            let MesVentaID        = res_fec_mes.rows[0].mes_venta_id;
                
            // elimina registros del mes 
            


            const workbook = new ExcelJS.Workbook();

            await workbook.xlsx.readFile(path);

            let sheet = workbook.getWorksheet();
            
            //let ultimoRegistro = sheet.actualRowCount +1
            
            console.log(`total de registros ${ sheet.actualRowCount}`)

            for (let i = 3; i <=  sheet.actualRowCount; i++) {

                const res   = await pool.query(querys.existeVenta(sheet.getRow(i).getCell(8).toString(),sheet.getRow(i).getCell(5).toString()));

                if(res.rows.length == 0)
                {


                    let incentivo5000 = 0;

                    if(sheet.getRow(i).getCell(1).toString()>0){

                         incentivo5000   = sheet.getRow(i).getCell(1).toString();
                    }
                    
                    let incentivo10000 = 0;

                    if(sheet.getRow(i).getCell(2).toString()>0){

                        incentivo10000 = sheet.getRow(i).getCell(2).toString();
                    }


                    let incentivo15000  = 0;
                    let incentivo20000  = 0;

                    
                                        
                    let res             = await pool.query(querys.obtieneEjecutivoID(sheet.getRow(i).getCell(3).toString()));
                    let ejecutivo_id    = res.rows[0].ejecutivo_id;
                    
                        
                    let nombre_cliente  = sheet.getRow(i).getCell(4).toString();
                    let rut             = sheet.getRow(i).getCell(5).toString();
                    let digito          = sheet.getRow(i).getCell(6).toString();

                    const fecha_compromiso = moment(sheet.getRow(i).getCell(7).toString()).add(4, 'hours').format('YYYY-MM-DD');

                    let telefono        = sheet.getRow(i).getCell(8).toString();
                    let enlace          = sheet.getRow(i).getCell(9).toString();
                    let venta_titular   = sheet.getRow(i).getCell(10).toString();
                    let venta_adicional = 0;

                    if(sheet.getRow(i).getCell(11).toString()>0){

                        venta_adicional = sheet.getRow(i).getCell(11).toString();
                    }
                    
                  

                    console.log(filename,fecha_compromiso,rut,telefono,nombre_cliente,venta_titular,venta_adicional,incentivo5000,incentivo10000);

          

                    let metadata ={

                        cliente_id:clienteID,
                        campana_id:campanaID,
                        usuario_id:ejecutivo_id,
                        mes_venta_id:MesVentaID,
                        rut_cliente:rut,
                        digito_cliente:digito,
                        nombre_cliente:nombre_cliente,
                        fecha_compromiso:fecha_compromiso,
                        telefono:telefono,
                        enlace:enlace,
                        venta_titular:venta_titular,
                        venta_adicional:venta_adicional,
                        incentivo_5000:incentivo5000,
                        incentivo_10000:incentivo10000,
                        incentivo_15000:incentivo15000,
                        incentivo_20000:incentivo20000,
                        flujo_venta:flujo_venta
                    };


                    const query = `INSERT INTO genesys_backend.cx_venta_ejecutivo (
                                        ven_eje_fecha,
                                        ven_eje_cliente_id,
                                        ven_eje_campana_id,
                                        ven_eje_usuario_id,
                                        ven_eje_mes_venta_id,
                                        ven_eje_rut_cliente,
                                        ven_eje_digito_cliente,
                                        ven_eje_nombre_cliente,
                                        ven_eje_fecha_compromiso,
                                        ven_eje_telefono,
                                        ven_eje_enlace,
                                        ven_eje_venta_titular,
                                        ven_eje_venta_adicional,
                                        ven_eje_incentivo_5000,
                                        ven_eje_incentivo_10000,
                                        ven_eje_incentivo_15000,
                                        ven_eje_incentivo_20000,
                                        ven_eje_json,
                                        ven_eje_flujo_venta)
                            VALUES(NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`;
                        const values = [
                                       clienteID,
                                       campanaID,
                                       ejecutivo_id,
                                       MesVentaID,
                                       rut,
                                       digito,
                                       nombre_cliente,
                                       fecha_compromiso,
                                       telefono,
                                       enlace,
                                       venta_titular,
                                       venta_adicional,
                                       incentivo5000,
                                       incentivo10000,
                                       incentivo15000,
                                       incentivo20000,
                                       metadata,
                                       flujo_venta
                                    ];
                        
                                    await  pool.query(query, values);

                    }else{

                        console.log(`VENTA YA EXISTE ${sheet.getRow(i).getCell(8).toString()}`)
                    }
                }
                    
        

        

        }catch(error){
            
            throw error;

        }

    }


   

    main();
    