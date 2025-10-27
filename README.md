# NOTAS

```

    APLICACIONES QUE SE UTILIZAN PARA CARGAR LA ASISTENCIA DIARIA DE LOS EJECUTIVOS Y ADEMAS PARA CARGAR LAS VENTAS A LA BASE Y CRUZAR CON LA RESPUESTA DE RED SALUD

    APLICACIONES 

    Ubicacion : /src/service/redSalud/

    1. app.paso1.carga.ventas.js :  se utiliza para carga la planilla de registro de las ventas de los ejecutivos 

    const ano               = "2024";   -> ano de la carga
    const mes               = "06"      -> mes de la carga
    const filename          = `respuesta_${yearMonth}.xlsx`;        -> nombre del archivo con las repuestas 
    const path              =`./ENTRADA/${yearMonth}/${filename}`;  -> path en donde se encuentra el archivo    
    const clienteID         = "5";      -> id del cliente redSalud
    const campanaID         = "22";     -> id de la campaña redSalud

    
    2. app.paso2.carga.respuesta.redSalud.js : carga las respuesta del clietne de red salud para cada venta informada los parametros de entrada son : 

    const ano               = "2024";   -> ano de la carga
    const mes               = "06"      -> mes de la carga
    const filename          = `${yearMonth}.xlsx`;                  -> nombre del archivo con las ventas 
    const path              =`./ENTRADA/${yearMonth}/${filename}`;  -> path en donde se encuentra el archivo    
    const clienteID         = "5";      -> id del cliente redSalud
    const campanaID         = "22";     -> id de la campaña redSalud


    3.- app.carga.asistencia.diaria.js : carga la asistencia diaria de los ejecutivos configurados en la aplicacion 


    15.08.2024 
        Se actualizan los directorios dejando dentro del directorio /src/services/ el directorio para el cliente desde el cual se reciben las ventas, se deja por ahora la carga desde archivo excel para TMK y C2C de Red Salud


    #ACTUALIZACIONES :

    27.11 se mejora la captura de las ventas exitosas de red salud
    28.11 se implemneta la app app.actualiza.ventas.js para SanaSalud, la cual se trae la iunformacion desde lookers de Google
    28.11 se reordena directorio /src/services/redSalud/ , dejando en old/ las aplicaciones antiguas de captura y actualizacion de ventas, para dejar solo la aplicacion app.actualiza.ventas.js la cual se conecta a googlesheets para actualziar las ventas de Red Salud
    03.12 se mejoran los scripts de sanasalud y davila para que tomen el total de las filas del lookers
```

