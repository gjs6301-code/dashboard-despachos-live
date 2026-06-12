# Análisis de flujos WWP — Barrido completo
> Fecha: 2026-06-12 | Autor: Pit | Metodología: Lean/VSM, código-base (sin credenciales prod)
> Fuente: historial.html (20,880 líneas) + proxy.js (8,586 líneas) — análisis estático.
> Flujo empaque→despacho (pack_dispatch) ya documentado en iteraciones previas; no se repite.

---

## Resumen ejecutivo

Se barrieron 6 flujos adicionales (pack_store, free, staffing, devoluciones, reposición, OpsAgent) y 6 secciones del historial (buscar, averías, validación, contenedores, sin adjuntos, dev-cdp). El hallazgo más crítico es la ausencia de integración entre el módulo Averías (sistema propio, /api/averias) y el campo condition: damaged en tareas WWP: un artículo puede ser marcado como averiado en uno de los dos sistemas sin que el otro lo sepa, lo que permite que artículos dañados sean despachados o almacenados sin escalamiento. En segundo lugar, el módulo Devoluciones opera sobre datos hardcoded en el fuente (var DEVOLUCIONES, L12905-12938) sin conexión a Odoo ni a WWP: la gestión de devoluciones que los usuarios ven es una plantilla de demo, no datos operacionales reales. Tercero, isAgentOwnerUser() (L5341-5344) limita OpsAgent a dos emails fijos en código, excluyendo a gerentes legítimos sin intervención del desarrollador. Los cinco tipos de gap (A-E) se confirman en todos los flujos; se añaden Gap-F (válvula de escape sin controles) y Gap-G (silos de integración sin sincronización).

---

## Hallazgos 3 más críticos para decisión inmediata de Gabriel

1. **DEVOLUCIONES son datos demo, no datos reales** (Gap-G + Gap-B): var DEVOLUCIONES en L12905 contiene 9 registros estáticos de enero-abril 2026 escritos a mano en el código fuente. No hay llamada a Odoo ni a ningún endpoint para obtener devoluciones actualizadas. Cada nueva devolución requiere modificar el código HTML y hacer deploy. Riesgo: decisiones de gestión basadas en datos que pueden estar 1-4 meses desactualizados.

2. **Averías y WWP son silos sin puente** (Gap-G): el módulo Averías (/api/averias) y el campo condition en ítems de tarea WWP son dos registros paralelos de daños que nunca se sincronizan. No hay código que cree un registro Averías cuando un auxiliar marca condition: damaged en WWP, ni viceversa. Un artículo puede tener avería en un sistema sin que el otro lo sepa. Riesgo operativo directo: artículos dañados pueden ser almacenados o despachados sin alerta. Evidencia: L17958-17964 (avGetForProduct), L17592-17603 (avLoadList).

3. **OpsAgent bloqueado por emails hardcoded** (Gap-D): isAgentOwnerUser() (L5341-5344) compara el email del usuario contra dos strings literales hardcodeados. No hay opción de configurar esto desde la admin. Para añadir un tercer gerente hay que modificar el código y hacer deploy. Evidencia confirmada: L5342-5343.

---

## Flujo 1: Empaque → Almacenamiento (pack_store)

### VSM resumido
1. Admin/Manager crea tarea via wizard (concepto pack_store) — selecciona empacadores y encargados de almacenamiento.
2. Se crean tareas madre (type: packaging) + subtareas (type: warehouse_move, dependsOnPrev: true, requiresDeliveryPhoto: true).
3. Encargado de empaque empaca artículos: foto por artículo + condición (Almacenado OK / Averia detectada) + confirmación.
4. Empaque se completa → se libera la subtarea de almacenamiento (gate dependsOnPrev).
5. Encargado de almacenamiento mueve físicamente + registra evidencia de ubicación por artículo.
6. Subtarea completada → admin valida.

### Diferencias vs pack_dispatch

| Aspecto | pack_dispatch | pack_store |
|---------|--------------|------------|
| Subtarea tipo | dispatch_order | warehouse_move |
| Etiquetas de UX | Despacho / Despachará | Almacenamiento / Almacenará |
| Evidence label | faltan fotos de empaque | faltan evidencias de ubicacion/almacenamiento |
| Condición buena | Buen estado | Almacenado OK |
| Evidencia extra | Documentos firmados (requiresDeliveryPhoto) | Mismo campo: también requiresDeliveryPhoto: true (L10828) |
| Sección artículos | ARTÍCULOS A EMPACAR | ARTICULOS A ALMACENAR |

### Hallazgos

**H-PS1 (Gap-B)**: requiresDeliveryPhoto: true se asigna a warehouse_move (L10828) igual que a dispatch_order. El drawer muestra DOCUMENTOS DE ENTREGA FIRMADOS en ambos. Para almacenamiento esto es semánticamente incorrecto: no hay documentos firmados en un movimiento interno. El texto Debes subir la foto del documento de entrega firmado por el cliente (L7880) aparece igual para almacenamiento. Inferido: podría ser intencional (foto de hoja de ubicación) pero el texto no lo comunica. Evidencia: L7868-7889, L10828.

**H-PS2 (Gap-C)**: En el wizard paso 2, la nota de almacenamiento es varios posibles (L9694) igual que para empaque. No hay indicación de cómo coordinar la ubicación destino antes de crear la tarea.

**H-PS3 (Gap-E)**: No hay campo de ubicación destino en el wizard al crear pack_store. La ubicación se llena desde el pick después, igual que en empaque. Si el almacén destino difiere del pick de origen, no hay forma de indicarlo al crear la tarea.

**H-PS4 (Gap-A)**: Mismo gap que empaque: empEnrichTaskItems depende de odoo_categ_id en los ítems. Si no está configurado, no se muestran reglas de materiales — aplica igual al flujo de almacenamiento.

### Controles bien implementados
- Herencia de ítems del empaque con evidencias reseteadas (L10835-10836).
- Gate dependsOnPrev: true bloquea almacenamiento hasta empaque completo.
- Condición por artículo (Almacenado OK / Averia detectada) requerida.
- Multi-encargado de almacenamiento soportado.

---

## Flujo 2: Solicitud libre (free / general)

### VSM resumido
1. Cualquier usuario con permiso create_task abre el wizard y selecciona Tarea Libre.
2. Asigna un encargado responsable (single-select, obligatorio).
3. Escribe descripción/instrucciones (opcional) y sube fotos de guía (opcional).
4. No requiere vincular a orden Odoo (aunque se puede buscar una).
5. Encargado ejecuta; debe subir al menos una foto (general o de artículo si hay artículos) para completar.
6. Admin valida.

### Hallazgos

**H-FR1 (Gap-F)**: free es la válvula de escape del sistema: no requiere orden Odoo, tipo de trabajo, artículos, ni especificación de evidencia. El sistema solo requiere 1 foto general sin ninguna especificación de qué mostrar. No hay lista de chequeo, plantilla ni tipo de actividad categorizada. Esto genera heterogeneidad y hace imposible reportar KPIs por tipo de actividad libre. Evidencia: L9713-9718, L7589-7591. Riesgo Lean: sobreprocesamiento y defectos.

**H-FR2 (Gap-E)**: No hay catálogo de actividades para tareas libres. Las actividades más comunes del almacén (limpieza, mantenimiento, recepción parcial, conteo) deberían tener plantillas con campos específicos.

**H-FR3 (Gap-C)**: El label del botón de completar es Terminé mi parte (L7587) cuando free solo admite un encargado. El texto comunica que podría haber más partes, generando confusión.

**H-FR4 (Gap-B)**: Las tareas free mapean al tipo general al guardarse (L10784: type: general). No hay forma de filtrar solo las free vs. general sin leer taskConcept.

### Controles bien implementados
- Fotos de guía opcionales pero funcionales (upload + instrucción por foto).
- Encargado obligatorio (L10659-10661).
- Detección de conflicto de orden con tareas activas.

---

## Flujo 3: Solicitudes de personal (staffing)

### VSM resumido
1. Admin/Manager crea solicitud via wizard (concepto staffing).
2. Indica: solicitante (texto libre), actividad (título), fechas inicio/fin, horario (hora inicio/fin en 12h).
3. Selecciona auxiliares (multi-select, solo rol assistant). Sistema detecta conflictos con tareas activas y permite indicar reemplazo.
4. El wizard PATCH las tareas en conflicto para liberar al auxiliar (L10707): auxiliaryAssignees minus el auxiliar, con nota Auxiliar reasignado a solicitud de personal.
5. Tarea creada como type: staffing. Flujo de estados igual al resto.
6. Paso 3 permite instrucciones + fotos de guía (opcionales). Sin artículos ni fotos obligatorias al completar.

### Hallazgos

**H-ST1 (Gap-B)**: La liberación de auxiliares (L10707-10712) hace PATCH directo a la tarea en conflicto sin notificar al encargado original. Si un auxiliar es sacado de una tarea en progreso, el encargado no recibe ningún aviso. Evidencia confirmada en código L10707.

**H-ST2 (Gap-C)**: En la lista de tareas, una tarea staffing no muestra cuántos auxiliares están asignados ni quiénes (L7119-7122). Para saber los ejecutores hay que abrir el drawer.

**H-ST3 (Gap-E)**: No hay control de capacidad: el sistema detecta conflictos con tareas activas pero no valida si el número de horas pedidas excede la jornada legal ni si el auxiliar tiene múltiples staffings solapados.

**H-ST4 (Gap-D)**: Solo auxiliares con role === assistant aparecen en el selector (L9815). Managers y otros roles no pueden ser asignados a una solicitud de personal.

**H-ST5 (Gap-E)**: No hay campo de lugar en la solicitud de personal. Para actividades en distintas ubicaciones del almacén, esto genera ambigüedad.

### Controles bien implementados
- Detección de conflicto con tareas activas del auxiliar, con selector de reemplazo.
- Cálculo automático de horas totales (L9817, L9878).
- Validación: inicio y horario obligatorios, fin >= inicio (L10650-10651).
- Fotos de guía opcionales para instrucciones de la actividad.

---

## Flujo 4: Devoluciones en WWP

### Contexto
El sistema tiene DOS mecanismos de devolucion con nombres similares pero funciones distintas:
- Devolucion de tarea (boton Devolver en drawer): regresa una tarea de completed a in_progress con motivo. Este si esta integrado (L20862-20873).
- Modulo Devoluciones (seccion historial): gestion de devoluciones comerciales. Este es el que se analiza aqui.

### VSM del modulo Devoluciones
Los datos se cargan desde var DEVOLUCIONES (L12905) — un array JavaScript hardcoded. renderDevoluciones() (L13238) itera sobre este array. No hay fetch a ningun endpoint.

### Hallazgos

**H-DV1 (Gap-G — CRITICO)**: var DEVOLUCIONES (L12905-12938) contiene 9 devoluciones reales de enero-abril 2026 escritas a mano en el codigo fuente. No hay funcion que llame a Odoo ni a ningun endpoint para obtener devoluciones actualizadas. Cada nueva devolucion requiere modificar el codigo HTML y hacer deploy. Evidencia confirmada en codigo L12905, L13238.

**H-DV2 (Gap-B)**: No existe endpoint /api/devoluciones en proxy.js. La unica referencia a devoluciones en proxy.js es el manejo de tipos de transferencia Odoo (RET), no un CRUD de devoluciones comerciales.

**H-DV3 (Gap-C)**: La UI del modulo es completa y convincente (acordeon, KPIs, dias transcurridos SP a Odoo, articulos devueltos) pero opera sobre datos estaticos de hasta 4 meses atras. El usuario cree estar viendo el estado actual.

**H-DV4 (Gap-G)**: No hay conexion entre una devolucion y las tareas WWP relacionadas. El operador debe buscar manualmente en ambos sistemas.

### Controles bien implementados
- UI semanticamente correcta (campos fechaSP, fechaOdoo, estadoOdoo, articulos, motivo).
- Calculo de dias transcurridos funcional (L13048-13059).
- Link de cada orden llama buscarDirecta() para cruzar con datos de Odoo/WWP.

---

## Flujo 5: Reposicion Showroom

### VSM resumido
1. Usuario navega a seccion Reposicion y llama runReposicionAnalysis().
2. Se llama /api/analysis/reposicion?showroom=ALMACEN (L14702) — API real con Odoo.
3. La API devuelve articulos con stock en almacen pero sin existencia en showroom.
4. UI muestra tabla con imagen, referencia, dias sin estar en showroom, stock CDP, familia, almacen/ubicacion.
5. Usuario puede crear solicitud de reposicion (solForItem, L13774) — estado local unicamente.
6. No hay llamada POST al completar la solicitud ni boton para crear tarea WWP.

### Hallazgos

**H-RP1 (Gap-B)**: Las solicitudes de reposicion se guardan solo en estado de cliente. No hay funcion POST /api/wwp/tasks ni POST /api/reposicion/solicitudes disparada al crear/confirmar. La solicitud existe solo mientras la pagina esta abierta. Evidencia: L13774-13803 muestra creacion de objeto sol con source: reposicion sin fetch.

**H-RP2 (Gap-C)**: No hay boton Crear tarea WWP desde la fila de reposicion. El operario debe anotar los articulos y crear la tarea manualmente, introduciendo riesgo de error y desperdicio de tiempo.

**H-RP3 (Gap-A)**: El desglose de origen (embarque, inicial, otro) para articulos nunca en showroom solo es visible para admin (L14772). Los managers que gestionan reposicion no ven esta informacion.

**H-RP4 (Gap-E)**: No hay proceso definido para convertir un candidato de reposicion en una accion: sin dueno, sin prioridad, sin flujo de aprobacion.

### Controles bien implementados
- Integracion real con Odoo via /api/analysis/reposicion (datos live con cache, L14702-14724).
- Indicador de cache con antiguedad en minutos (L14717-14724).
- KPIs: total candidatos, nunca en showroom, con existencia CDP.
- Filtros por familia, almacen, busqueda libre.
- Agrupacion visual de kits por barcode (formato 2D/3D, L14958-14982).

---

## Flujo 6: Mesa de Agentes (OpsAgent)

### VSM resumido
1. Al cargar el dashboard, loadDashboard() llama loadOpsAgent() (L10852-10853).
2. isAgentOwnerUser() verifica el email del usuario (L5341-5344). Si no coincide con los 2 emails hardcoded, el panel se oculta completamente.
3. Si pasa, llama /api/wwp/ops-agent (L10918).
4. API devuelve: summary (activas, vencidas, sin avance, por validar, sin responsable, sin evidencia), decisions (lista priorizada con severidad), workload (carga top 10), nextActions, companyContext.
5. UI: metricas + tarjetas de decisiones con severidad + workload + botones de seguimiento/reasignacion.

### Hallazgos

**H-OA1 (Gap-D — CRITICO)**: isAgentOwnerUser() (L5341-5344) hardcodea dos emails literales: gsanchez@altritempi.com.do y jbencini@altritempi.com.do. No hay permiso configurable ni rol que de acceso. Anadir un tercer gerente requiere modificar el codigo y hacer deploy. Evidencia confirmada L5342-5343.

**H-OA2 (Gap-C)**: La doble restriccion (can(dashboard) + isAgentOwnerUser) hace que managers con wwp.dashboard:true solo vean un panel vacio sin explicacion.

**H-OA3 (Gap-B)**: opsSendFollowUp y opsSendBulkFollowUp (L10949, L10977) aparecen en la UI pero su implementacion completa no fue verificada en este analisis. A verificar en prod.

**H-OA4 (Gap-E)**: No hay refresh automatico del analisis. Para un turno de 8h, el gerente podria estar mirando datos de hace 7h si no presiona Actualizar manualmente.

### Controles bien implementados
- Boton bulk follow-up solo activo si hay decisiones critical/high (L10977).
- companyContext muestra estado de conectividad con Odoo (L10964-10969).
- Workload top 10 con vencidas y sin avance por persona (L10954-10961).
- Boton de reasignacion aparece directamente en la tarjeta de decision si la tarea esta vencida (L10948).

---
## Secciones historial — Analisis

### Seccion Buscar
**Que hace**: busqueda unificada de ordenes (Odoo live + Sheets + WWP tasks + datos mock locales). Consultas en paralelo (L16392-16403). Detecta automaticamente tipo de referencia. Muestra estado global, tareas WWP vinculadas, picks, articulos, historial de movimientos, averias del articulo.

**H-BS1 (Gap-G)**: Los datos GS (Google Sheets mock) y SP (SharePoint mock) permanecen como fallback cuando Odoo falla (L16381). Si Odoo devuelve error, el usuario puede ver informacion de demo en vez de un error claro.

**H-BS2 (Gap-C)**: Los accesos rapidos (L3652-3656: 8949, 9115, 9003, 8946, S09059, 8867) son hardcodeados. No se actualizan con ordenes recientes o mas buscadas.

**Controles**: deteccion automatica de tipo de referencia, consultas paralelas, avSearchBlock integrado al buscar articulo (L16292-16306), boton Nueva Tarea WWP desde busqueda de articulo (L16303).

---

### Seccion Averias
**Que hace**: formulario de registro (barcode lookup Odoo, cantidad, estado inicial, comentario, fotos). Lista filtrable por estado (Recibido/En Taller/Reparado/Descartado). API real: /api/averias y /api/averias/product?ref= (L17596, L17960).

**H-AV1 (Gap-G)**: El modulo Averias y el campo condition en items WWP son sistemas paralelos de danos que nunca se sincronizan. condition: damaged en WWP no crea registro en /api/averias, ni viceversa. Evidencia: ausencia de llamada POST /api/averias en el handler de condition (analisis previo H4 confirmado).

**H-AV2 (Gap-B)**: Al registrar una averia no se puede vincular a la orden de venta ni a la tarea WWP que la origino. Trazabilidad manual unicamente.

**H-AV3 (Gap-E)**: No hay SLA definido para tiempo en cada estado. El modulo calcula duracion (L17607-17641) pero sin meta ni umbral de alerta.

**Controles**: historial de estados con barra visual de duracion, fotos del dano, lookup por barcode contra Odoo, avSearchBlock integrado en Buscar.

---

### Seccion Validacion
**Que hace**: verifica si cantidades en transferencias Odoo (WH/INT/, WH/OUT/) fueron registradas con escaner o teclado.

**H-VL1 (Gap-E)**: No hay meta ni indicador de cumplimiento. No esta claro cuantas deben ser escaneadas. Es una herramienta de auditoria sin proceso definido.

**H-VL2 (Gap-C)**: No hay link directo a la tarea WWP relacionada con la transferencia detectada como problematica.

**Controles**: consulta live a Odoo por transferencia, diferenciacion escaner vs teclado visible.

---

### Seccion Contenedores
**Que hace**: control de contenedores/importaciones. Datos live desde Google Sheets via /api/sheets/contenedores. renderContenedores() (L13475) construye la tabla.

**H-CT1 (Gap-G)**: Los contenedores no estan vinculados a tareas WWP de recepcion. No hay boton Crear tarea de descarga en WWP desde un contenedor.

**H-CT2 (Gap-A)**: Los datos vienen de Google Sheets; si no se actualiza Sheets, los datos aparecen sin indicador de antiguedad.

**Controles**: datos live (no hardcoded), renderizado dinamico.

---

### Seccion Sin Adjuntos (comprobantes)
**Que hace**: lista transferencias OUT de Odoo validadas sin documento adjunto en un rango de fechas. Permite enviar notificacion via Odoo Discuss por usuario (L16817-16818).

**H-SA1 (Gap-E)**: No hay seguimiento: no registra si el comprobante fue recibido despues, ni estado de resolucion.

**H-SA2 (Gap-C)**: No hay auto-envio programado ni recordatorio si el adjunto sigue faltando al dia siguiente. Todo es manual.

**Controles**: consulta live a Odoo, notificacion via Odoo Discuss integrada, filtro por rango de fechas.

---

### Seccion Dev-CDP
**Que hace**: articulos que salieron por OUT desde cualquier tienda y cuya devolucion fue registrada en A-CDP/DEVOLUCION en vez de regresar a su tienda de origen. Datos desde /api/report/dev-cdp (L15015) — integracion real con Odoo.

**H-DC1 (Gap-B)**: La seccion tiene un bulk action panel (devcdp-bulk-bar, L17011) pero no hay codigo visible de la accion que ejecuta el bulk. Podria ser funcionalidad incompleta.

**H-DC2 (Gap-E)**: No hay proceso definido para resolver los articulos mal clasificados. La seccion es un reporte sin flujo de resolucion ni tarea WWP.

**Controles**: datos live de Odoo, KPIs por tienda, filtro por tienda de origen.

---
## Matriz de brechas transversales

| Gap ID | Tipo | Hallazgos | Flujos afectados | Solucion estandarizable | Prioridad |
|--------|------|-----------|-----------------|------------------------|-----------|
| G1 | Gap-G | H-DV1, H-DV2, H-CT1 | Devoluciones, Contenedores, Dev-CDP | S5: endpoint /api/devoluciones desde Odoo; boton Crear tarea WWP en contenedores | ALTA |
| G2 | Gap-G | H-AV1, H-AV2 | Averias, todos los flujos con articulos | S1: notifyDamage() al marcar condition:damaged crea registro en /api/averias con orderId y taskId | ALTA |
| G3 | Gap-D | H-OA1 | OpsAgent, Dashboard | S6: permiso configurable ops_agent en sectionPerms; reemplazar emails hardcoded | ALTA |
| G4 | Gap-F | H-FR1, H-FR2 | free/general | S7: catalogo de tipos de tarea libre con plantillas | MEDIA |
| G5 | Gap-B | H-ST1 | staffing | S1b: notificacion al encargado cuando un auxiliar es liberado de su tarea activa | MEDIA |
| G6 | Gap-C | H-ST2, H-RP2 | staffing, reposicion | S2: boton Crear tarea WWP desde vistas de listado/reporte; badge de ejecutores en tarjeta staffing | MEDIA |
| G7 | Gap-B | H-RP1 | reposicion | S5: endpoint POST para guardar solicitudes de reposicion con persistencia | MEDIA |
| G8 | Gap-E | H-ST3, H-AV3, H-SA1, H-VL1, H-DC2 | staffing, averias, sin-adjuntos, validacion, dev-cdp | SOP + SLA por proceso; meta y umbral de alerta | BAJA |
| G9 | Gap-B | H-PS1 | pack_store | Corregir texto documentos firmados a foto de ubicacion destino para warehouse_move | BAJA |
| G10 | Gap-A | H-PS4, H-RP3 | pack_store, reposicion | Configurar odoo_categ_id en items; desglose de origen visible para managers | BAJA |

---

## Patrones de solucion estandarizables

**S1 — notifyDamage() centralizado**: funcion unica que al detectar condition:damaged en cualquier item de tarea WWP crea automaticamente un registro en /api/averias con orderId, taskId, itemRef, qty y notifica al admin. Aplica a pack_dispatch (H4 previo), pack_store, cualquier tarea con articulos. Codigo: handler de PATCH condition en historial.html + endpoint /api/wwp/tasks/:id/items/:itemId/condition en proxy.js. Riesgo: bajo, es additive.

**S2 — Boton Crear tarea WWP desde reportes**: boton reutilizable que desde reposicion, contenedores, dev-cdp pre-popula el wizard con tipo, referencia y articulos. La funcion abrirNuevaTareaWWP(ref, title, location, type) ya existe (L16303). Solo falta conectarla en las secciones que no la tienen. Riesgo: bajo.

**S3 — Badge bloqueado en subtareas**: ya identificado en analisis previo. Aplica tambien a pack_store al mostrar el gate de almacenamiento bloqueado por empaque.

**S4 — slaColor reutilizable**: ya identificado en analisis previo. Aplica tambien a averias (H-AV3) y dias sin showroom en reposicion.

**S5 — Endpoint real para devoluciones**: /api/devoluciones que consulta Odoo por transferencias tipo RET, igual que /api/report/dev-cdp ya hace. Reemplaza var DEVOLUCIONES hardcoded. Riesgo: medio — requiere definir que transfers de Odoo constituyen una devolucion comercial.

**S6 — Permiso configurable ops_agent**: reemplazar isAgentOwnerUser() por can(ops_agent) o hasSectionPerm(ops_agent), configurable desde el panel de admin. 6 lugares en historial.html (L10909, L11131, L11393, L11440, L11505, L5341). Riesgo: bajo.

**S7 — Catalogo de tipos de tarea libre**: campo activityType opcional en tareas free (Mantenimiento, Limpieza, Conteo, Recepcion parcial) para agrupar y reportar. Solo un select opcional en wizard paso 3. Riesgo: bajo, es additive.

---

## Lo que necesita Ron (consultas pendientes con credenciales)

1. Devoluciones reales: stock.picking filtrado por type_code=incoming y origin like Return para los ultimos 90 dias. Validar si coincide con los registros en var DEVOLUCIONES hardcoded.
2. Estado de averias en prod: GET /api/averias para ver cuantos registros reales hay en la BD vs. los 0 esperados si nadie ha usado el modulo desde que se implemento.
3. Solicitudes de reposicion: verificar si hay tabla de solicitudes en la BD del proxy o si confirma que solo existe en estado local (H-RP1).
4. Transferencias sin adjunto recientes: GET /api/sin-adjuntos para medir el volumen real y evaluar si el proceso de notificacion esta funcionando.
5. Staffing activo: GET /api/wwp/tasks con type=staffing y status in_progress o assigned para ver cuantas solicitudes activas hay y si los auxiliares liberados tienen nota de reasignacion.

---

## Preguntas para Gabriel (decisiones que el debe tomar)

1. Devoluciones (prioridad alta): el modulo actual usa datos demo. Cual es la fuente de verdad para devoluciones comerciales? Solo Odoo (transferencias RET) o tambien SharePoint? Si es ambas, cual tiene prioridad cuando hay conflicto?

2. Averias como silo (prioridad alta): deben el modulo Averias y el campo condition:damaged en WWP ser un solo sistema o dos? Si son uno solo, cual es el flujo: el auxiliar registra en WWP y esto crea el registro de averia, o siempre va al modulo Averias directamente?

3. OpsAgent para mas usuarios: que rol/permiso debe tener acceso al OpsAgent? Solo admins, o tambien managers con seccion wwp.dashboard? Esto define si el fix es un nuevo permiso configurable o ampliar la lista de emails.

4. Solicitudes de reposicion: deben persistir en la base de datos (requiere desarrollo del endpoint) o es suficiente que sean efimeras (la persona toma nota y crea la tarea manual)?

5. Tareas libres sin estandar: hay tipos de actividad recurrentes que se crean como tareas libres hoy que merezcan convertirse en flujos propios? Identificar los 3 mas frecuentes permitiria estandarizarlos sin gran esfuertar.

---

## Decisiones aprobadas — 2026-06-12

| # | Decisión | Estado | Dueño técnico | Notas |
|---|---|---|---|---|
| D1 | Devoluciones → conectar a Odoo (`stock.picking` RET) | ✅ Aprobado | Ron + Mark | Reemplaza `var DEVOLUCIONES` hardcoded L12905 |
| D2 | OpsAgent configurable vía permiso en lugar de emails hardcoded | ⏳ Pendiente | Mark | Gabriel pidió descripción sin tecnicismos antes de decidir |
| D3 | S1 Puente Averías↔WWP: `notifyDamage()` centralizado | ✅ Implementado | Mark | `proxy.js` ~L7757-7800. Deduplicación + trazabilidad |
| D4 | S3 Notificación liberación auxiliar en Staffing | ✅ Implementado | Mark | `proxy.js` ~L5505-5535. Notifica al managerId |
| D5 | Reposición persistente con proceso de aprobación | ✅ Aprobado | Pit (diseño) + Mark (dev) | Diseño operativo documentado en §pit.md §6 |

### Diseño operativo de Reposición (D5)

**Quién solicita**: encargado o manager.

**Datos que captura la solicitud**:
- Artículo o referencia Odoo
- Cantidad necesaria
- Ubicación de destino
- Urgencia: baja / media / alta
- Motivo (texto libre)

**Flujo de estados**:
```
borrador → pendiente_aprobacion → aprobada → en_proceso → completada
                                           → rechazada (con comentario)
```

**Notificaciones**:
- Al crear solicitud → notifica a admin para aprobar
- Al aprobar/rechazar → notifica al solicitante
- Al crear tarea WWP desde la solicitud → notifica al encargado asignado

**Persistencia**: `reposiciones.json` en el proxy. Endpoints mínimos:
- `GET /api/reposicion` — lista por estado/fecha
- `POST /api/reposicion` — nueva solicitud
- `PATCH /api/reposicion/:id` — cambio de estado + comentario aprobador
- `POST /api/reposicion/:id/crear-tarea` — convierte la solicitud aprobada en tarea WWP

**Vínculo con WWP**: botón "Crear tarea" disponible cuando estado = `aprobada`; pre-popula el wizard de nueva tarea con tipo `pack_store` o `free`, artículo y ubicación.

## Protocolo para agregar memoria desde texto

Cuando Gabriel indique **"agrega a memoria de [nombre del agente]"** o una instruccion equivalente y pegue texto, articulo, fragmento de libro, nota, conversacion o documento:

1. Leer el texto completo disponible.
2. No pegar articulos/libros largos completos en el expediente del agente.
3. Convertir la informacion en memoria util: resumen, aprendizajes, reglas practicas, decisiones y forma de aplicarlo.
4. Guardar el aprendizaje en el expediente canonico del agente correspondiente dentro de `agentes-estandar/`.
5. Usar fecha, fuente y alcance: global, proyecto especifico o tema especifico.
6. Si el texto es muy largo, conservar solo citas breves imprescindibles y priorizar resumen accionable.
7. Si la informacion aplica a varios agentes, registrar en cada expediente solo lo que ese agente debe recordar y usar.

Formato recomendado:

```md
### YYYY-MM-DD - [Tema]

Fuente:
- [Articulo, libro, conversacion, documento, enlace o nota]

Resumen:
- [Idea principal]
- [Idea principal]

Aprendizajes para [Agente]:
- [Regla o criterio que debe recordar]
- [Como debe aplicarlo]

Aplicacion:
- [Proyecto, area o alcance]
```

