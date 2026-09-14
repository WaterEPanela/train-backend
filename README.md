# trAIn-backend

Backend de [`trAIn-app`](https://github.com/WaterEPanela/trAIn-app): API REST + servidor **MCP** (Model Context Protocol) que permite a un agente de IA (Claude, ChatGPT, Gemini) importar y ajustar planes de sobrecarga progresiva directamente, sin flujo manual de copiar/pegar.

La arquitectura completa (modelo de datos, contrato de tools MCP, decisiones de auth/RLS, roadmap) vive en el repo de la app: **[`trAIn-app/PLAN.md`](https://github.com/WaterEPanela/trAIn-app/blob/main/PLAN.md)** — es la fuente de verdad para ambos repos, no se duplica acá.

## Responsabilidad de este repo

- API REST que consume la app mobile (`trAIn-app`)
- Endpoint MCP (`mcp-handler` sobre Next.js API routes) con las tools `import_program`, `get_program`, `log_session`, `get_logs`, `get_adherence`, `set_availability`, `update_program`
- Migraciones SQL de Supabase (schema + políticas RLS)

Sin páginas ni UI — ver sección 3 de `PLAN.md` sobre por qué el dashboard web quedó fuera de alcance.

## Stack

- Next.js (solo API routes) + TypeScript
- `@modelcontextprotocol/sdk` + `mcp-handler`
- Supabase (Postgres + Auth)
- Hosting (al desplegar): AWS App Runner — ver sección 3 de `PLAN.md`

## Estado actual

Todavía no scaffoldeado. Seguimiento de tareas en el [GitHub Project "train-app — Fase 1"](https://github.com/users/WaterEPanela/projects/1) (issues en `trAIn-app`):

- [#3](https://github.com/WaterEPanela/trAIn-app/issues/3) Instalar Supabase CLI y levantar el stack local
- [#4](https://github.com/WaterEPanela/trAIn-app/issues/4) Migración SQL del modelo de datos inicial
- [#5](https://github.com/WaterEPanela/trAIn-app/issues/5) Scaffold del backend Next.js
- [#7](https://github.com/WaterEPanela/trAIn-app/issues/7) Servidor MCP mínimo
- [#9](https://github.com/WaterEPanela/trAIn-app/issues/9) Implementar `import_program` y `get_program` reales

## Desarrollo local

Todo el desarrollo se hace en local antes de tocar Supabase hosted o AWS (ver sección 3.1 de `PLAN.md`):

```bash
supabase start   # Postgres + Auth local (requiere Docker)
npm run dev       # backend Next.js, una vez scaffoldeado
```
