require('colors');

const mostrarMenu = async()=>
{
    return new Promise(resolve => {

        console.clear(); 
        console.log("################################".green);
        console.log("   APP Carga Ventas Ejecutivo  ".green);
        console.log("################################\n".green);


        const readline = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout
        });

        
        readline.question('Ingrese Año del proceso (YYYY) : ',(param1) =>{
            readline.question('Ingrese Mes del proceso (MM) : ',(param2) =>{
                readline.question('Ingrese CAMPAÑA ID: ',(param3) =>{
                    resolve([param1,param2,param3]); 
                    readline.close();
                });    
                
            });    
            });
        
        });
    

}


const mostrarMenuAsistencia = async()=>
    {
        return new Promise(resolve => {
    
            console.clear(); 
            console.log("################################".green);
            console.log("   APP Carga Asistencia Ejecutivo  ".green);
            console.log("################################\n".green);
    
    
            const readline = require('readline').createInterface({
                input: process.stdin,
                output: process.stdout
            });
    
            
            readline.question('Ingrese Año del proceso (YYYY) : ',(param1) =>{
                readline.question('Ingrese Mes del proceso (MM) : ',(param2) =>{
                       resolve([param1,param2]); 
                        readline.close();
                    });    
                });
            
            });
        
    
    }



    const mostrarMenuRecuperacion = async()=>
        {
            return new Promise(resolve => {

                console.clear(); 
                console.log("################################".green);
                console.log("   APP Carga Recuperaciones  ".green);
                console.log("################################\n".green);
        
        
                const readline = require('readline').createInterface({
                    input: process.stdin,
                    output: process.stdout
                });
        
                
                readline.question('Ingrese Año del proceso (YYYY) : ',(param1) =>{
                    readline.question('Ingrese Mes del proceso (MM) : ',(param2) =>{
                        readline.question('Ingrese CAMPAÑA ID: ',(param3) =>{
                            resolve([param1,param2,param3]); 
                            readline.close();
                        });    
                        
                    });    
                    });
                
                });
            
            
        
        }


        const mostarMenuActualizaEstado = async()=>
            {
                return new Promise(resolve => {
    
                    console.clear(); 
                    console.log("################################".green);
                    console.log("   APP Actualiza Estado Ventas ".green);
                    console.log("################################\n".green);
            
            
                    const readline = require('readline').createInterface({
                        input: process.stdin,
                        output: process.stdout
                    });
            
                    
                    readline.question('Ingrese Año del proceso (YYYY) : ',(param1) =>{
                        readline.question('Ingrese Mes del proceso (MM) : ',(param2) =>{                            
                                resolve([param1,param2]); 
                                readline.close();
                            });    
                        });
                    
                    });
                
                
            
            }

module.exports = {
    
    mostrarMenu,    
    mostrarMenuAsistencia,
    mostrarMenuRecuperacion,
    mostarMenuActualizaEstado

}