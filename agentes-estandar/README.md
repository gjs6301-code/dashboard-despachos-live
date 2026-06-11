# Agentes Estándar — librería portátil de "empleados" virtuales

Carpeta **reutilizable entre proyectos**. Cada agente (un "empleado" virtual con estándares
ya establecidos) tiene **un expediente** aquí: identidad, estándares, patrones, decisiones y
lo que ha aprendido en los chats. La idea es llevarte el mismo equipo a otros desarrollos sin
re-explicar nada.

## Estructura

```
agentes-estandar/
  README.md                ← este archivo
  _PLANTILLA-EXPEDIENTE.md ← molde en blanco para crear un agente nuevo
  mark.md                  ← expediente del agente (uno por agente)
  ...
```

Cada expediente separa dos capas:
- **🌐 Universal (portable)** — principios que aplican a CUALQUIER proyecto. Esto viaja contigo.
- **📍 Capa de proyecto** — tokens, rutas, convenciones y decisiones del proyecto actual.
  Al copiar el agente a otro repo, **conservas lo universal y reemplazas la capa de proyecto.**

## Cómo instalar un agente en un repo nuevo (2 pasos)

1. **Copia** la carpeta `agentes-estandar/` (o solo el expediente que quieras) al repo nuevo.
2. **Crea el subagente de Claude Code**: copia `agentes-estandar/<nombre>.subagente.md` (la
   definición canónica, versionada aquí) a `.claude/agents/<nombre>.md` del repo nuevo. Conserva
   la línea que le dice _"lee tu expediente en `agentes-estandar/<nombre>.md` antes de actuar"_.
   Vacía la sección **📍 Capa de proyecto** del expediente y rellénala con los datos del repo
   nuevo. (`.claude/` suele estar en `.gitignore`; por eso la copia canónica vive aquí.)

A partir de ahí el agente arranca ya estandarizado y va registrando sus decisiones nuevas en su
propio expediente.

## Cómo crear un agente nuevo

1. Duplica `_PLANTILLA-EXPEDIENTE.md` → `agentes-estandar/<nombre>.md` y rellénalo.
2. Crea su definición ejecutable en `.claude/agents/<nombre>.md` (frontmatter `name`,
   `description`, `tools`) apuntando a su expediente.

## Disciplina de mantenimiento

- **Antes de actuar**, el agente lee su expediente.
- **Al terminar** un cambio relevante, agrega una línea a **Decisiones** (fecha · qué · por qué)
  y, si descubrió algo reutilizable, a **Patrones** o **Aprendizajes del chat**.
- Una decisión que contradiga un estándar previo se documenta y se actualiza el estándar — no se
  deja la contradicción silenciosa.
