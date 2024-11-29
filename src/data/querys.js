module.exports = {
    
    obtieneMesID : (ano,mes) => `
                            select 
                                cmv.mes_ven_id as mes_venta_id
                            from 
                                genesys_backend.cx_mes_venta cmv 
                            where 
                                cmv.mes_ven_ano  =  '${ano}' and
                                cmv.mes_ven_mes  =  '${mes}' `,

 
    obtieneEjecutivoID : (Ejecutivo) =>`
                                    select 
                                        usu_id as ejecutivo_id
                                    from 
                                        genesys_backend.usu_usuario
                                    where
                                    UPPER(usu_nombre_completo) = '${Ejecutivo}'`,

    obtieneRecuperadorID : (Ejecutivo) =>`
                                    select 
                                        usu_id as ejecutivo_id
                                    from 
                                        genesys_backend.usu_usuario
                                    where
                                        usu_nombre_completo = '${Ejecutivo}'`,                                    

    vaciaTabla : (MesVentaID) =>`delete 
                                from
                                    genesys_backend.cx_venta_ejecutivo
                                where 
                                    ven_eje_mes_venta_id  =  '${MesVentaID}'`,        
    
    existeVenta: (telefono,rut) => `
                                    select 
                                        ven_eje_id::integer as id
                                    from 
                                        genesys_backend.cx_venta_ejecutivo cve 
                                    where
                                        cve.ven_eje_telefono ='${telefono}' and 
                                        cve.ven_eje_rut_cliente ='${rut}'`,
                                        
    obtieneCampanaID : (clienteId)=>`
                                    select 
                                        cam_id
                                    from 
                                        genesys_backend.cam_campana cc 
                                    where 
                                        cc.cam_cliente_id ='${clienteId}'and 
		                                cc.cam_estado_id ='1'`                                       

}
