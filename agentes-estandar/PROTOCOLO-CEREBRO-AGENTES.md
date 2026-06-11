# Protocolo Cerebro De Agentes

Fecha: 2026-06-11

Este protocolo es permanente y portable. Aplica a cualquier proyecto, documento o carpeta donde Gabriel invoque agentes como Mark, Pit, Ron u otros agentes estandarizados.

## Regla principal

Cuando un agente sea invocado, su informacion persistente no debe quedar solo en el chat. Debe alimentarse el cerebro del agente en su documento correspondiente dentro de esta carpeta:

`C:\Users\Gabriel Ramirez\OneDrive\Documentos\Claude\Artifacts\dashboard-despachos-live\agentes-estandar`

## Documento correspondiente

- Mark: `mark.md`
- Pit: `pit.md`
- Ron: `ron.md`
- Nuevo agente: `<nombre-del-agente>.md`, creado desde `_PLANTILLA-EXPEDIENTE.md`

## Antes de actuar

1. Identificar que agente fue invocado.
2. Leer su expediente correspondiente en `agentes-estandar/<agente>.md`.
3. Aplicar sus estandares universales y, si existe, la capa del proyecto actual.
4. Si el proyecto actual no tiene capa registrada, crear o actualizar la seccion de proyecto en el expediente del agente.

## Despues de actuar

Al terminar un analisis, cambio, prueba o decision relevante, el agente debe actualizar su expediente:

- En `Decisiones`: decisiones concretas con formato `AAAA-MM-DD · que · por que`.
- En `Patrones reutilizables`: soluciones que pueden repetirse en otros proyectos.
- En `Aprendizajes del chat`: preferencias de Gabriel, correcciones, reglas de estilo o instrucciones permanentes.
- En `Capa de proyecto`: rutas, comandos, restricciones, datos de entorno y convenciones del proyecto trabajado.

## Criterio de persistencia

Guardar en el cerebro del agente todo lo que cumpla al menos una de estas condiciones:

- Gabriel dijo que quiere que se recuerde.
- Afecta como debe actuar el agente en futuras invocaciones.
- Es una decision tecnica u operativa del proyecto.
- Es una ruta, comando, flujo o restriccion que se volvera a necesitar.
- Es una correccion sobre como Gabriel espera que el agente trabaje.

No guardar ruido temporal, errores descartados, datos sensibles innecesarios ni conclusiones sin verificar.

## Regla para Codex/Claude

Si Gabriel pide "invoca a Mark", "que Pit revise", "consulta con Ron" o equivalente, el asistente debe tratar esta carpeta como memoria canónica de agentes. Si descubre informacion durable, debe escribirla en el expediente del agente correspondiente, no solo responder en el chat.
