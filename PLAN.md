# train-app — Plan de MVP

## 1. Visión

Un asistente de **sobrecarga progresiva para cualquier meta medible en el tiempo, MCP-nativo desde el día uno**: el usuario le pide a su agente de IA (Claude, ChatGPT, Gemini) un plan para lo que sea que quiera mejorar — entrenar, leer más, estudiar, correr, resolver ejercicios de una materia — el agente genera el plan y lo importa directo al backend vía Model Context Protocol, la app trackea el progreso semana a semana, y el agente puede revisar y ajustar el plan cuando el usuario se lo pida. Cero flujo de "generar un prompt, copiar la respuesta, pegarla en la app".

Lo que hace que esto sea un solo producto y no una lista de apps de nicho: entrenar, leer, estudiar y correr se miden con la misma estructura — un valor numérico (repeticiones, páginas, minutos, problemas resueltos) que sube o baja de dificultad/volumen según el desempeño, en sesiones programadas a lo largo de fases, con revisión periódica cuando el usuario la pide. El motor no necesita saber qué es "un press banca" ni "un capítulo" — solo necesita saber qué métrica sigue, cuál es el objetivo actual, y la regla de cuándo avanzar.

### Por qué no usar Hevy/Strong (para el caso de entrenamiento específicamente)
- Hevy tiene API pública y ya existe un conector MCP open source (`hevy-mcp`), pero requiere Hevy Pro y el plan gratis limita a 4 rutinas. Además, por diseño, solo cubre entrenamiento — no lectura, estudio o running.
- Strong no tiene API pública (solo exporta CSV); un cliente no oficial existió pero está abandonado y su uso arriesga el baneo de cuenta.
- Ninguna de las dos modela bien un programa periodizado de 16 semanas con fases, deloads y escaleras de progresión — están pensadas para rutinas planas. Y ninguna, obviamente, sirve para una meta de lectura o estudio.

### Usuario objetivo
Gente con poco tiempo (el caso de uso de referencia es literalmente "padre primerizo con horario caótico" queriendo entrenar en casa) que ya usa un LLM para generar su plan — de entrenamiento o de cualquier otra meta — y necesita estructura externa (recordatorios y seguimiento real de sobrecarga progresiva) para sostener la disciplina, no otra herramienta de personalización manual.

## 2. Por qué MCP resuelve el problema de fiabilidad, no solo el de fricción

Cuando un agente llama a una tool MCP, los argumentos ya vienen validados contra el JSON Schema declarado por esa tool — no es texto libre que un parser debe extraer. Esto elimina el riesgo principal identificado en la revisión de diseño anterior (LLMs que no respetan un formato de salida pedido por prompt). El "formato obligatorio" ya no depende de la buena voluntad del modelo: lo aplica el protocolo.

## 3. Stack

La app siempre fue pensada como app móvil — el stack se elige para empezar desarrollo móvil desde el día uno, no como una fase posterior a un dashboard web.

| Capa | Elección | Por qué |
|---|---|---|
| App móvil (cliente principal) | Expo (React Native) + TypeScript, Expo Router | Un solo código para iOS/Android desde el día uno; Expo Go permite iterar sin compilar binarios nativos, y se pasa a EAS Build recién cuando haga falta un build real (TestFlight/Play) |
| Backend (API REST + servidor MCP) | Next.js (solo API routes, sin páginas) + TypeScript, `@modelcontextprotocol/sdk`, `mcp-handler` | Mismo motivo que antes: SDK oficial de MCP + `mcp-handler` para exponer el endpoint MCP como Streamable HTTP dentro de rutas de API de Next.js. Ya no sirve páginas de dashboard — ese rol lo cumple la app Expo |
| Base de datos + auth | Supabase (Postgres + Auth) | Cuentas de usuario, aislamiento por Row Level Security, y un authorization server OAuth 2.1 para el conector MCP sin construir auth propio |
| Notificaciones | Push nativo con Expo (`expo-notifications` en el cliente, `expo-server-sdk` en el backend) | Reemplaza el email del plan anterior: como el MVP ya es la app móvil, push nativo está disponible desde M1 en vez de ser una mejora futura tipo "cuando exista la app" |
| Hosting (al desplegar) | AWS App Runner para el backend Next.js; Supabase hosted para DB/Auth; EAS Build + EAS Submit para la app móvil | Se descartó Vercel: su billing por uso (bandwidth/invocaciones) no tiene tope duro por defecto y hay casos documentados de facturas sorpresa. App Runner factura por tiempo de cómputo real (no por request/bandwidth), y AWS Budgets permite un tope de gasto con acción automática — control de costo más predecible, y el usuario ya tiene experiencia con AWS |

Decisión explícita de alcance: **una sola app Next.js** (sin páginas) sirve la API REST y el endpoint MCP (transporte HTTP/streamable) para el backend. El dashboard web queda fuera de alcance del MVP — el único cliente end-user es la app Expo. Separar el servidor MCP en su propio servicio queda para cuando el volumen o la necesidad de conexión persistente lo justifique — no antes.

### 3.1 Desarrollo local primero, deploy simple después

Todo el desarrollo se hace en local hasta donde sea posible, y recién se toca Supabase hosted / AWS / EAS cuando hace falta probar algo que el entorno local no puede cubrir (auth OAuth remota real, push a un dispositivo fuera de la red local, o una build para tienda):

- **Backend + base de datos:** Supabase CLI (`supabase start`) levanta Postgres + Auth + Storage local; el backend Next.js corre con `next dev` apuntando a esa instancia local vía variables de entorno (`.env.local`). Las migraciones se escriben y prueban ahí antes de aplicarse a Supabase hosted (`supabase db push`).
- **App móvil:** Expo Go (o un dev client si hace falta un módulo nativo que Expo Go no soporte) corriendo contra el backend local — mismo dispositivo o emulador en la misma red, o un túnel (`expo start --tunnel`) si hace falta probar desde un celular físico sin estar en la misma LAN.
- **MCP:** durante M1/M2 se prueba con Claude Desktop vía transporte stdio contra el backend local, sin necesidad de OAuth ni de desplegar nada (ver sección 4, nota del punto 2/4). El flujo OAuth remoto solo se valida una vez desplegado a AWS + Supabase hosted.
- **Cuándo migrar a hosted:** recién al final de cada milestone, para validar que lo construido en local también funciona contra la infraestructura real — no antes, y no como parte del ciclo de iteración diario.

**Sobre Docker:** AWS App Runner soporta despliegue desde código fuente (build gestionado, detecta Node.js automáticamente, sin Dockerfile) o desde una imagen de contenedor — para el MVP se usa el modo de **código fuente**, manteniendo la misma decisión que con Vercel: nada de Dockerfile propio para desplegar. Supabase hosted tampoco lo necesita, y EAS Build/Submit hace lo mismo para la app móvil. Si más adelante hiciera falta más control sobre el runtime (dependencias del sistema, versión exacta de Node), ahí sí conviene pasar App Runner a modo imagen de contenedor — no antes. La única pieza que sí usa Docker hoy es el stack local de Supabase CLI, y lo hace automáticamente al correr `supabase start`: no hace falta escribir ni mantener ningún Dockerfile propio para eso tampoco.

**Sobre el control de costo (motivo del cambio de Vercel a AWS):** configurar un **AWS Budget** sobre la cuenta con una alerta (SNS) a un umbral bajo (ej. USD 5-10) desde el primer deploy — antes de tener tráfico real, no después. App Runner ya reduce el riesgo de raíz porque cobra por tiempo de cómputo usado, no por bandwidth/requests como Vercel; para un tope realmente automático (no solo una alerta) hace falta un paso extra — una Budget Action no puede pausar App Runner directamente (esa acción nativa solo aplica a EC2/RDS), así que un corte automático real requiere una Lambda simple disparada por la alerta de SNS que llame a `PauseService` sobre el servicio de App Runner. Para M1, con cero usuarios reales, la alerta sola alcanza; la Lambda de auto-pausa queda como mejora antes de invitar usuarios externos, no como bloqueante de M1.

> **Resuelto (revisión post-council, punto 1/4):** la preocupación de que MCP no funcione bien sobre funciones serverless estaba basada en el transporte HTTP+SSE pre-2025. Desde la spec 2025-03-26 (y más aún en 2026-07-28), Streamable HTTP es stateless por defecto — cada llamada es un POST con respuesta JSON directa; el streaming solo se abre si el servidor necesita mandar mensajes no solicitados (progreso, sampling), algo que ninguna de nuestras tools necesita. `mcp-handler` (originalmente el paquete de Vercel para Next.js, `vercel-labs/mcp-for-next.js`) no depende de ningún runtime de Vercel específico — es un handler de Next.js estándar, así que corre igual en App Runner. Decisión: usar `mcp-handler` para el endpoint MCP dentro de la misma app Next.js, en vez de implementar el transporte a mano.

## 4. Modelo de datos

Diseñado para ser agnóstico de dominio: la misma estructura sirve para un programa de entrenamiento, un plan de lectura, un plan de estudio o un plan de running. Nada en el schema asume gimnasio.

### Program
```
Program
├─ id, user_id, name, source_note (texto libre: qué LLM/prompt lo generó, opcional)
├─ phases[]
│   ├─ name, week_start, week_end, goal (texto libre)
│   ├─ deload_weeks[] (números de semana dentro del rango de la fase; opcional, no todo dominio tiene deloads)
│   └─ session_slots[]              # antes "training_days" — un bloque programado dentro de la semana
│       ├─ label                     # texto libre: "Push", "Bloque de estudio", "Día de carrera", "Lectura"
│       ├─ collapse_priority         # entero: qué slots se sacrifican primero si la semana colapsa
│       └─ activities[]              # antes "exercises" — cualquier cosa medible: un ejercicio, una sesión de lectura, un set de problemas
│           ├─ activity_id (estable, generado al importar — NUNCA se re-deriva del texto)
│           ├─ label                  # texto libre: "Press banca", "Lectura", "Ejercicios de vectores", "Carrera continua"
│           ├─ ladder[]               # escalones de dificultad/volumen, ordenados de más fácil a más difícil
│           │   ├─ step_id (estable)
│           │   ├─ label               # texto libre: "Incline push-up", "100 páginas", "Intervalo 5x1min", "4 problemas nivel 2"
│           │   ├─ target_metric      # texto libre elegido por el LLM: "reps", "pages", "minutes", "problems_solved", "distance_km"...
│           │   ├─ target_value / target_range (ej. "8-12", "100", "5")
│           │   └─ progression_rule   # ver sección 5 — el mismo motor sirve para cualquier target_metric
│           └─ current_step_id        # reemplaza "current_ladder_index" — por ID estable, no por posición en el array
└─ collapse_rules
    └─ { min_slots_per_week: 3, min_activities_per_slot: 1 }   # regla declarativa genérica, no hardcodeada en el backend
```

**Por qué `activity_id`/`step_id` y no matchear por nombre:** el riesgo real (marcado independientemente por tres roles en la revisión del council) era que si `log_session` intenta encontrar a qué escalón corresponde una medición comparando *texto* ("Bench Press" vs. "Barbell Bench Press"), el match falla en silencio. La solución no es un catálogo de ejercicios canónicos — sería un supuesto de dominio (gimnasio) que no aplica a leer o estudiar. La solución es que cada escalón tenga un ID estable asignado al importar; `log_session` referencia ese ID directamente, nunca el nombre. El nombre queda como texto libre, solo para mostrar.

### SessionLog / MeasurementLog
```
SessionLog: id, program_id, session_slot_label, date, notes   # "notes": contexto libre que el usuario le da al agente (cómo fue la sesión), útil para la revisión asistida por IA (sección 5.2)
MeasurementLog: session_log_id, activity_id, step_id, metric_type, value, sequence, extra (JSONB opcional)
```
`metric_type` y `value` son libres — `{metric_type: "reps", value: 12, sequence: 1}` para gimnasio (una fila por serie), `{metric_type: "pages", value: 100, sequence: 1}` para lectura, `{metric_type: "minutes", value: 5.2}` para correr. `sequence` reemplaza "set_number" como un número de orden genérico (para gimnasio son series; para otros dominios normalmente es 1). `extra` es un lugar libre para datos auxiliares específicos del dominio que el LLM quiera trackear (RPE en gimnasio, dificultad percibida en estudio, ritmo en running) sin que el schema central los conozca.

### Availability
```
Availability: user_id, day_of_week, start_time, timezone
```

> **Nota de implementación (issue #4, `trAIn-backend`):** la migración inicial (`supabase/migrations/20260914205628_init_schema.sql`) va más allá del texto literal de esta sección en tres puntos, siguiendo el criterio de priorizar buenas prácticas de Supabase/Postgres sobre el texto del plan cuando no coinciden:
> 1. **`user_id` denormalizado en las 8 tablas**, no solo en `programs`/`availability` como sugiere la lista de campos de arriba. Sin esto, las políticas RLS de `phases`/`session_slots`/`activities`/`ladder_steps`/`session_logs`/`measurement_logs` necesitarían un `EXISTS` con hasta 4 joins para llegar al dueño — Supabase recomienda evitar eso denormalizando el `user_id` en cada tabla hija. La cadena de FKs estructurales (`program_id`, `phase_id`, etc.) se mantiene igual para integridad referencial; `user_id` es redundante a propósito, solo para RLS.
> 2. **`updated_at` + trigger en las 8 tablas** (no mencionado arriba, bookkeeping estándar).
> 3. **Policies RLS acotadas a `to authenticated`** explícitamente (si no, aplican también a `anon`).
>
> `activities.current_step_id` (ver más arriba en esta sección) forma una dependencia circular con `ladder_steps.activity_id` — se resuelve en la migración agregando ese FK con `ALTER TABLE` después de crear `ladder_steps`, marcado `DEFERRABLE INITIALLY DEFERRED` para que `import_program` pueda insertar el árbol completo en una sola transacción.

### User
Cuenta de Supabase Auth. Autenticación de las llamadas MCP: **OAuth 2.1** (ver resolución del punto 2 más abajo), no API key.

> **Resuelto (revisión post-council, punto 2/4):** el conector remoto de claude.ai exige explícitamente que el servidor MCP funcione como authorization server OAuth 2.1 (PKCE S256, HTTPS, redirect URI validado) — "autorizar solo con API key" está catalogado como violación de sus requisitos, así que esa opción queda descartada para el flujo principal del producto. Decisión: usar la feature **OAuth 2.1 Server de Supabase Auth** (Authentication → Providers → OAuth Server, con Dynamic Client Registration habilitada) en vez de construir un authorization server propio. Esto además resuelve de raíz el riesgo que marcó Security en la revisión del plan ("`user_id` debe derivarse siempre server-side de la autenticación, nunca del payload"): con OAuth de Supabase, el `user_id` sale directo del token validado, no de un parámetro que la tool recibe.
>
> **Confirmación multi-cliente:** esto no es un requisito específico de Claude. ChatGPT exige lo mismo para sus custom connectors, de forma igual de estricta (rechaza bearer tokens sueltos y grants machine-to-machine; solo acepta flujo de consentimiento de usuario). Gemini Spark (la vía de conectores personalizados para usuarios individuales de Google AI Pro/Ultra, distinta de Gemini Enterprise) exige Streamable HTTP, coherente con el transporte ya elegido. Un solo authorization server OAuth 2.1 estándar sirve para los tres — no hace falta auth distinta por proveedor.
>
> **Disponibilidad real para pruebas (no las tres son gratis):**
> - **Claude Pro** (ya lo tenemos): soporta custom connectors remotos completos, sin costo adicional.
> - **ChatGPT**: Developer Mode/custom connectors requieren mínimo Plus/Pro (de pago) y están en beta; los connectors *completamente* con capacidad de escritura están restringidos a workspaces Business/Enterprise/Edu — con Plus/Pro la escritura (`log_session`, `update_program`) podría estar limitada. Verificar al probar, no asumir paridad con Claude.
> - **Gemini Spark**: requiere Google AI Pro o Ultra (de pago).
> - **Camino gratis para desarrollar sin pagar nada extra:** probar el servidor MCP en local con Claude Desktop vía transporte **stdio** (proceso local, sin red, sin OAuth) durante M1/M2 mientras se construyen las tools; agregar el flujo OAuth remoto recién al desplegar a AWS, y validarlo primero con la cuenta Claude Pro existente antes de pagar por Plus de ChatGPT o Google AI Pro solo para probar.
>
> **Verificado (2026-10-02):** `claude_desktop_config.json` solo acepta servidores por `command`/`args` (stdio) — no una URL HTTP directa; como `mcp-handler` expone el endpoint MCP únicamente como HTTP (`/api/mcp` de `trAIn-backend`), el "camino gratis" de arriba necesita un wrapper stdio↔HTTP: `npx -y mcp-remote http://localhost:3000/api/mcp` como `command`/`args` del servidor en esa config. Con eso, Claude Desktop (reiniciado) listó la tool `ping` y, al invocarla, devolvió `{"message":"pong"}` — transporte local end-to-end confirmado, sin tocar OAuth. Pendiente para las tools reales (`import_program`, etc.): escribir bien `description` e `inputSchema` de cada una — el modelo decide cuándo y cómo usarlas leyendo eso, no alcanza con el nombre (detectado al probar `ping`, cuya descripción actual, "Ping for connection", es mínima a propósito).
>
> **Actualización (2026-10-13): sesión de desarrollo sin tokens pegados a mano.** `MCP_DEV_USER_TOKEN` caducaba (la expiración local de los JWT es de una semana) y Claude Desktop solo veía `[object Object]`. Ahora el servidor inicia sesión solo con `MCP_DEV_EMAIL` + `MCP_DEV_PASSWORD` de `.env.local` (el mismo usuario y contraseña de la app), guarda la sesión en memoria y la renueva al vencer; `MCP_DEV_USER_TOKEN` queda como respaldo y, si venció, el error dice la fecha. Es solo para local: en producción lo reemplaza OAuth. Claude Desktop guarda la lista de tools al arrancar, así que después de cambiar un schema hay que reiniciarlo.

### Autorización a nivel de base de datos (RLS)

> **Resuelto (revisión post-council, punto 3/4):** el riesgo que marcó Security era que, si el backend usa la `service_role` key de Supabase (que **bypasea** Row Level Security) para todas sus consultas, el aislamiento entre usuarios pasa a depender 100% de que cada tool filtre `user_id` a mano — un solo olvido es un IDOR (un usuario lee o escribe datos de otro).
>
> Los tokens que emite el OAuth 2.1 Server de Supabase son JWTs normales de Supabase (incluyen `user_id`, `role`, y además `client_id` del conector OAuth). **Las políticas RLS existentes se aplican automáticamente a esos tokens OAuth, igual que a una sesión normal** — `auth.uid()` funciona sin trabajo extra de nuestra parte.
>
> Decisión: patrón híbrido.
> - Las **tools MCP y las rutas de API que consume la app móvil** crean el cliente de Supabase pasando el token OAuth/sesión del usuario como `Authorization: Bearer <token>` en cada request — RLS queda activa, y Postgres aplica el aislamiento por sí solo, no el código de la tool.
> - **Solo el cron de recordatorios** (que necesita revisar la disponibilidad de todos los usuarios a la vez, una operación legítimamente cruzada entre usuarios) usa la `service_role` key — aislado a un único archivo, no repartido por el resto del código.
> - Regla de política RLS: usar `(select auth.uid()) = user_id`, no `auth.uid() = user_id` (mejor plan de consulta en Postgres).
> - A verificar durante la implementación: revisar guías recientes de seguridad de RLS en Supabase (hay patrones conocidos de mala configuración documentados) antes de escribir las políticas de cada tabla.

## 5. Progresión: determinística vs. asistida por IA

Dos niveles, no uno:

1. **Determinística (la aplica el backend solo, sin IA de por medio).** Cada escalón de `ladder[]` trae un `progression_rule` declarativo y genérico, por ejemplo:
   ```json
   {
     "type": "threshold",
     "metric": "reps",
     "condition": ">=",
     "value": 12,
     "scope": "all_measurements_in_session",
     "on_trigger": { "action": "advance_ladder", "reset_value_to": "range_floor" }
   }
   ```
   El mismo `progression_rule` sirve sin cambios para `metric: "pages"`, `metric: "minutes"` o `metric: "problems_solved"` — no tiene lógica de dominio hardcodeada. Después de cada `log_session`, el backend evalúa la regla de la actividad correspondiente (por `activity_id`/`step_id`, no por nombre) y avanza `current_step_id` automáticamente si se cumple. Toda la inteligencia específica de dominio vino en el JSON que el agente importó.

2. **Asistida por IA (requiere que el usuario se lo pida explícitamente en un chat).** Decisiones cualitativas — transición de fase, ajustar el deload, aplicar un benchmark tipo "si ganás fuerza pero no tamaño, subí el volumen" (o su equivalente en otro dominio: "si leés rápido pero no retenés, agregá resúmenes") — no se automatizan en el backend. El usuario le dice a su agente "revisá mi progreso y ajustá el plan"; el agente lee el historial vía `get_logs`/`get_adherence` (incluyendo las `notes` que el usuario fue dejando), razona con las reglas que el propio documento original ya trae en texto, y escribe los cambios vía `update_program`. El backend no necesita un motor de reglas para esto — es la razón principal por la que el MVP es viable con poco código de dominio.

> **Decisión (2026-10-13): series exactas, nunca supuestas.** El número de series lo fija el agente, no el sistema ni el usuario: `ladder_steps.target_sets` es un entero exacto y `import_program` lo exige para escalones por `reps` (si la fuente dice "2-3 series", el agente elige el número y explica el criterio en `source_note`). La app muestra exactamente esas series; si un plan viejo no lo define, no inventa un número: arranca con una y avisa que hay que pedírselo al agente. Si el usuario hace menos series, se registran tal cual para que el agente lo vea al revisar, y una regla "en todas las series" solo se cumple si se hicieron todas las recomendadas (`progression_rule_met(..., required_count)`). Lo mismo para los umbrales de la regla: `progression_rule.value` y `on_trigger.reset_value_to` son `number` en el schema; ni el backend ni la app interpretan texto libre (`target_value` es solo para mostrar).

## 6. Tools MCP (contrato inicial)

| Tool | Dirección | Annotation MCP | Descripción |
|---|---|---|---|
| `import_program` | escritura | — (crea, no sobrescribe) | Crea un Program completo (fases, slots, actividades, ladders, reglas de progresión, reglas de colapso) — de cualquier dominio |
| `get_program` | lectura | `readOnlyHint: true` | Devuelve el programa activo del usuario, incluyendo en qué escalón está cada actividad |
| `log_session` | escritura | — (agrega, no sobrescribe) | Registra una sesión completa (slot, actividades, mediciones); dispara la evaluación de `progression_rule` |
| `get_logs` | lectura | `readOnlyHint: true` | Historial de sesiones logueadas, con filtro de rango de fechas |
| `get_adherence` | lectura | `readOnlyHint: true` | Resumen de cumplimiento (sesiones planeadas vs. realizadas) para que el agente pueda razonar sobre ajustes |
| `set_availability` | escritura | — | Días/horarios en que el usuario puede hacer sus sesiones; dispara la programación de recordatorios |
| `update_program` | escritura | **`destructiveHint: true`** | Edita un programa existente con operaciones parciales por id (agregar/editar/quitar fases, sesiones, actividades y escalones), sin reenviar el plan completo |

Cada tool define su JSON Schema de entrada con el SDK de MCP — ese schema es, en sí mismo, el "formato obligatorio" que reemplaza al prompt de traducción del diseño original, y es agnóstico de dominio: nada en la forma de las tools asume gimnasio.

> **Resuelto (revisión post-council, punto 4/4):** `update_program` era la tool más peligrosa del contrato — reescribe el programa activo según el razonamiento del agente, sin versionado ni forma de revertir un cambio erróneo. Tres capas de defensa, cada una cubriendo lo que las otras no cubren:
> 1. **Protocolo:** anotar `update_program` con `destructiveHint: true` (tabla de arriba) — los clientes MCP (Claude, ChatGPT, Gemini Spark) usan esta annotation para decidir si piden confirmación al usuario antes de ejecutar la tool. Es gratis y estándar, pero es una señal informativa, no una garantía — no puede ser la única defensa.
> 2. **Base de datos:** activar la extensión `supa_audit` de Supabase sobre `programs` (y `session_logs`/`measurement_logs`, que de paso ayuda con la idempotencia pendiente) — `create extension supa_audit cascade; select audit.enable_tracking('public.programs'::regclass);`. Dos líneas de SQL dan historial completo de cambios (`audit.record_version`) y reconstrucción del estado en cualquier punto anterior, es decir, rollback sin código propio de versionado.
>
>    **Actualización (issue #4):** verificado contra la instancia local de Supabase CLI (Postgres 17.6) — `supa_audit` **no está disponible** ahí (`pg_available_extensions` no lo lista), así que no son "dos líneas" como se asumía. Sí está disponible `pg_tle` (Trusted Language Extensions), que es el mecanismo por el que Supabase lo instala en su plataforma hosteada — instalarlo a mano requeriría traer el SQL fuente de la extensión vía `pgtle.install_extension(...)`. Queda pendiente de investigar cuando se construya `update_program` (todavía no tiene issue); no se activó en la migración inicial de la sección 4 para no bloquearla con algo no resuelto.
> 3. **Aplicación:** una función de validación semántica antes de aplicar `update_program` — el JSON Schema valida forma (que `target_value` sea un número), no sentido (que no sea absurdo, o que la actualización no borre todas las fases). Regla dura mínima para el MVP: rechazar una actualización que deje el programa sin fases o sin ningún slot programado.

> **Decisión (2026-10-13): `update_program` con operaciones parciales.** El agente no reenvía el plan entero: manda una lista de operaciones dirigidas por id (`update_step`, `add_activity`, `remove_phase`…, 13 en total: `add_*`/`update_*`/`remove_*` para fase, sesión, actividad y escalón, más `update_program_info`). Se descartó JSON Patch (RFC 6902) porque sus rutas usan índices de arreglos (`/phases/0/session_slots/2/...`), que se rompen si algo se reordenó entre la lectura y la escritura y son fáciles de errar para un LLM; los ids de la DB son estables.
> - **Atómico:** todas las operaciones corren en una sola transacción de Postgres (`public.update_program`); si una falla o el resultado queda incompleto, no se aplica nada. Las inserciones las comparte con `import_program` (funciones en el esquema `private`, que PostgREST no expone).
> - **Validación semántica (capa 3):** al final se rechaza (`invalid_program`) un programa sin fases, una fase sin sesiones, una sesión sin actividades, fases que mezclan semanas con planes abiertos o que se solapan; no se puede quitar el único escalón de una actividad. Escalones en reps sin `target_sets` no bloquean (el plan real del usuario los tiene) pero vuelven como `warnings`.
> - **Concurrencia:** `programs.revision` sube en cada `update_program`; el agente manda `expected_revision` (viene en `get_program`) y si la app o otra conversación cambiaron el plan entretanto recibe `revision_conflict` en lugar de pisar cambios. Agregar un extra al plan desde `log_session` todavía no sube la revisión (solo agrega, no invalida ids).
> - **El historial nunca se borra al editar:** quitar una fase/sesión/actividad/escalón desengancha sus mediciones (`detached_at`, y `adhoc_label` guarda el nombre con que se registraron); `get_logs` las devuelve con `removed_from_plan=true`. Las FK de `measurement_logs` hacia actividades/escalones dejaron de ser `on delete cascade`: un borrado directo con historial falla en lugar de perderlo. Borrar el programa entero (`replace_program`) sí borra su historial, como se decidió con los slots.
> - **Escala (primera prueba real, 2026-10-13):** completar series y descansos de "Home V-Taper Blueprint" desde Claude Desktop necesitó 231 operaciones de a un id (tope de 100, así que salieron en 3 llamadas no atómicas entre sí) y `get_program` devolvió 122 KB, más de lo que el cliente acepta en una respuesta. Ajustes: `update_steps`/`update_activities` aplican el mismo `set` a una lista de ids (el error sigue indicando qué id falló), el tope sube a 500 operaciones, los avisos se agrupan (`count` + `step_ids`) y `get_program` devuelve por defecto un `outline` (actividades con su escalón actual, ~22 KB para ese plan) y, para leer completo solo lo que hace falta, selectores que combinan como unión y usan los mismos ids que `update_program`: `phase_ids` (~26 KB por fase), `session_slot_ids` (~10 KB), `activity_ids` (~2 KB) y `activity_label` (el mismo ejercicio en todas las fases, ~10 KB); `detail='full'` sin selectores sigue trayendo todo. Una sola tool de lectura con selectores en lugar de varias (`get_phases`, `get_activities`…), porque el modelo elige peor entre tools parecidas. Sin columnas internas (`user_id`, timestamps).
> - **La app se entera de los cambios del agente:** recarga los planes al volver a primer plano y con pull-to-refresh en la lista, el plan y la sesión (antes solo cargaba al iniciar sesión y mostraba datos viejos tras un `update_program`).
> - **Capa 2 (auditoría) sigue pendiente:** no hay rollback de un cambio erróneo más allá de pedirle al agente que lo revierta con otra operación; `supa_audit` sigue sin estar disponible en local.

## 7. Recordatorios (MVP)

- La app Expo pide permiso de notificaciones al usuario y registra el push token del dispositivo contra el backend (extensión de `set_availability` o endpoint propio `register_push_token` — a definir en M1/M3).
- El agente llama `set_availability` con los días/horarios que el usuario le dio en el chat.
- Un cron job (Amazon EventBridge Scheduler invocando el endpoint, o una Supabase Edge Function programada) revisa diariamente: ¿hay un `session_slot` de la fase activa que caiga en un día de disponibilidad y todavía no tenga `SessionLog` para esa fecha? Si sí, y falta poco para el horario declarado, se dispara una notificación push vía Expo Push Notifications (`expo-server-sdk`) al token registrado del usuario.
- Si el usuario no completa un slot planeado y coincide con quedar por debajo de `collapse_rules.min_slots_per_week` restante en la semana, la notificación push siguiente sugiere colapsar a la versión reducida (usando `collapse_priority` para elegir qué slot sacrificar) — lógica simple basada en conteo, no IA.
- Queda pendiente (ya señalado en la revisión del council, sección de riesgos): el cron diario fijo no resuelve bien timezones reales de usuarios en zonas distintas — a revisar en M3, sea con un cron más frecuente filtrando por ventana horaria, o con Supabase Edge Functions programadas por usuario.

## 8. Fuera de alcance del MVP (explícito)

- Dashboard web — el cliente end-user del MVP es exclusivamente la app móvil (Expo); un panel de administración web queda para más adelante si hace falta.
- ~~Multi-programa simultáneo por usuario~~ — reemplazado por el modelo de slots (nota abajo).
- ~~Editor visual de programas en la app~~ — revertido: ver la decisión del flujo inverso abajo.

> **Decisión (2026-10-13): flujo inverso, el usuario también crea y registra.** Además de "el agente crea → la app registra", el usuario puede armar su propio plan en la app, registrar lo que hace (incluso fuera del plan) y pedirle al agente que lo audite o ajuste. Un plan propio ocupa un slot igual que uno del agente.
> - **Editor en la app:** modo simple = plan → sesiones → actividades (métrica, series exactas, meta, descanso), sin semanas (plan abierto: `phases.week_start/week_end` nulos). Opciones avanzadas apagadas por defecto: fases con semanas, descargas (requiere fases), escaleras de variaciones (lista desplegable 0, 1, 2… bajo el ejercicio inicial) y reglas de progresión (las escaleras las activan, porque sin condición no hay avance). Se guarda con la misma `import_program` que usa el agente, con `origin = 'user'`.
> - **Extras en una sesión:** un ejercicio fuera del plan se registra solo por nombre (`measurement_logs.adhoc_label`, sin `activity_id`) o, si el usuario lo pide, se suma a esa sesión del plan en la misma transacción de `log_session`.
> - **Agente:** `get_logs` devuelve las sesiones con cada medición (`in_plan=false` para extras) y `get_program` incluye `origin`; y `update_program` le permite editarlos con operaciones parciales (ver la decisión en la sección 6).
- Motor de recomendación de progresión cualitativo dentro del backend — vive en el agente, no en el código.
- Pagos/monetización — se decide después de validar retención con usuarios reales. (El *modelo* de slots ya existe en la DB; el cobro, no.)

> **Decisión (2026-10-11): slots de programa.** Cada programa ocupa un slot mientras existe; no hay programas archivados ni inactivos — un plan fuera de un slot no existe en la app, porque el valor del slot es la disponibilidad y el seguimiento del plan. La cuenta gratuita tiene 1 slot; se pueden comprar más, de forma permanente (pago único, los slots nunca bajan, así que no hay lógica de downgrade).
> - **DB** (`supabase/migrations/20261011180000_program_slots.sql`): `user_entitlements.program_slots` (sin fila = 1; solo lectura para el usuario, lo escribe el backend con `service_role`, ej. un webhook de pago). Un trigger `before insert` en `programs` rechaza con `slots_full` si no queda slot — la regla vive en Postgres, no en un cliente.
> - **Reemplazo:** `import_program(payload, replace_program_id)` borra el programa elegido (con su historial, por cascada) y crea el nuevo en la misma transacción; solo puede borrar programas del propio usuario (`program_not_found` si no).
> - **MCP:** `import_program` nunca borra; ante `slots_full` devuelve la lista de programas y el agente debe preguntarle al usuario cuál reemplazar. `replace_program` (con `destructiveHint: true`) hace el reemplazo con el id que el usuario eligió. `get_program` acepta `program_id` y devuelve el uso de slots.
> - **App:** muestra todos los programas del usuario (selector en la pantalla Programa) y el uso de slots en Ajustes.
> - De paso: `programs.start_date` (semana 1 del programa) y `position` en `session_slots`/`activities` para conservar el orden en que el LLM escribió el programa.
- UI específica por dominio (gráficos de fuerza vs. gráficos de páginas leídas vs. splits de running) — el MVP usa una vista genérica de "actividad + métrica + valor" para todos los dominios; visualizaciones a medida quedan para después de validar qué dominio(s) engancha(n).

## 9. Roadmap

> **Decisión (2026-10-11): todo local y gratis hasta que haga falta pagar.** El cierre "en la nube" que antes iba al final de M1 se mueve después de M4. Desplegar, validar el conector remoto y cobrar son tres pasos distintos: se despliega cuando alguien que no sea el desarrollador vaya a usar la app, y se cobra recién después de validar retención. Lo único que local no cubre (que claude.ai llegue al MCP por HTTPS) se valida gratis con un túnel antes del deploy, no desplegando antes.

1. **M1 — Esqueleto (hecho, local):** backend Next.js (API + MCP) + Supabase local (schema de la sección 4, RLS, slots de programa) + MCP con `import_program`, `replace_program` y `get_program` funcionando contra Claude Desktop (vía `mcp-remote`) — y la app Expo con login contra Supabase Auth local, vista de solo lectura del programa y temas, corriendo en Expo Go en un teléfono real.
2. **M2 — Logging y progresión determinística (local):** pantalla principal de la app como lista de planes (uno por slot) con invitación a sumar un slot; `log_session`, `get_logs`, motor de evaluación de `progression_rule` (por `activity_id`/`step_id`), historial en la app; editor de planes propios en la app, extras en la sesión y `update_program` adelantado desde M4 para que el agente pueda editar lo que el usuario creó.
3. **M3 — Disponibilidad y recordatorios (local):** `set_availability`, registro de push token desde la app, cron de recordatorios (`pg_cron` en local), lógica de colapso de slots. Las push no funcionan en Expo Go en Android desde SDK 53: se prueba con un development build local (`bunx expo run:android`, gratis).
4. **M4 — Revisión asistida por IA (local):** `get_adherence`, `update_program`, validar el flujo completo "revisa mi progreso y ajusta el plan" con el programa real de `rutina.md` de punta a punta.
5. **Pre-lanzamiento (primer gasto):** el MCP lee el token de cada request y se activa OAuth 2.1 (el servidor OAuth de Supabase CLI permite hacerlo en local; falta decidir dónde vive la pantalla de consentimiento `/oauth/consent`); validar el conector de claude.ai con un túnel HTTPS gratis hacia el stack local; recién entonces Supabase hosted (tiene plan gratuito) + backend en AWS App Runner (primer costo real; AWS Budget con alerta antes del primer deploy) + build de la app apuntando a esa infraestructura.
6. **Cobro de slots:** después de validar retención con usuarios reales. Los slots son un bien digital, así que dentro de la app la compra tiene que pasar por la facturación de cada tienda (Google Play Billing / Apple In-App Purchase), y el backend sube `user_entitlements.program_slots` al confirmar la compra.

## 10. Verificación

- Probar el flujo completo en local (Supabase CLI + Next.js dev + Claude Desktop stdio), importando el programa real de 16 semanas (`rutina.md` traducido al schema de la sección 4) y verificando que `import_program` lo acepta sin pérdida de estructura (fases, deloads, ladders).
- Simular logs de varias sesiones y confirmar que `progression_rule` avanza `current_step_id` correctamente por ID, sin intervención manual.
- Probar `set_availability` + registro de push token desde la app Expo + disparo real de una notificación push en un entorno de staging (Supabase hosted + AWS App Runner desplegado).
- Ejecutar `update_program` desde una conversación real pidiéndole a Claude que reevalúe el progreso, y confirmar que el cambio se refleja en `get_program` (visible también en la app Expo).
- Validar que el schema realmente es agnóstico de dominio: importar un segundo programa de un dominio distinto (ej. un plan de lectura simple armado a mano) y confirmar que `import_program`/`log_session`/`progression_rule` funcionan sin ningún cambio de código — esta prueba es la que confirma o refuta el reframe de la sección 1.
- Solo después de validar todo lo anterior en local, repetir el flujo end-to-end contra Supabase hosted + AWS App Runner + claude.ai Connectors (OAuth remoto) y una build de Expo (Expo Go o dev client) apuntando a esa infraestructura real.
