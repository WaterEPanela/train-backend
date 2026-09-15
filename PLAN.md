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
| App móvil (cliente principal) | Expo (React Native) + TypeScript, Expo Router, `@tanstack/react-query` + `ky` (cliente REST) | Un solo código para iOS/Android desde el día uno; Expo Go permite iterar sin compilar binarios nativos, y se pasa a EAS Build recién cuando haga falta un build real (TestFlight/Play). `ky` es un wrapper liviano sobre `fetch` (maneja JSON, errores HTTP y reintentos sin el boilerplate de `fetch` crudo); React Query se encarga de cache/revalidación de las respuestas REST en el cliente |
| Backend (API REST + servidor MCP) | Next.js (solo API routes, sin páginas) + TypeScript, `@modelcontextprotocol/sdk`, `mcp-handler` | SDK oficial de MCP + `mcp-handler` para exponer el endpoint MCP como Streamable HTTP dentro de rutas de API de Next.js. La API que consume la app usa Route Handlers nativos de Next.js (`app/api/.../route.ts`) con verbos HTTP estándar (GET para lectura, POST para creación, PATCH para actualización parcial — ver sección 6.1). Ya no sirve páginas de dashboard — ese rol lo cumple la app Expo |
| Base de datos + auth | Supabase (Postgres + Auth) | Cuentas de usuario, aislamiento por Row Level Security, y un authorization server OAuth 2.1 para el conector MCP sin construir auth propio |
| Notificaciones | Push nativo con Expo (`expo-notifications` en el cliente, `expo-server-sdk` en el backend) | Reemplaza el email del plan anterior: como el MVP ya es la app móvil, push nativo está disponible desde M1 en vez de ser una mejora futura tipo "cuando exista la app" |
| Hosting (al desplegar) | Vercel (free tier) para el backend Next.js; Supabase hosted para DB/Auth; EAS Build + EAS Submit para la app móvil | Todo plataformas gestionadas — ver nota sobre Docker abajo |

Decisión explícita de alcance: **una sola app Next.js** (sin páginas) sirve la API REST y el endpoint MCP (transporte HTTP/streamable) para el backend. El dashboard web queda fuera de alcance del MVP — el único cliente end-user es la app Expo. Separar el servidor MCP en su propio servicio queda para cuando el volumen o la necesidad de conexión persistente lo justifique — no antes.

**Por qué REST (y no GraphQL) para la API que consume la app:** el modelo de datos (sección 4) es anidado, pero en la práctica cada usuario tiene **un solo** programa activo a la vez (ver sección 8, "fuera de alcance") — no hay un grafo grande de relaciones que recorrer, así que el argumento clásico a favor de GraphQL (elegir campos anidados a medida para evitar over-fetching) pesa poco acá: `GET /api/programs/active` devuelve el árbol completo de una sola vez y ninguna pantalla necesita menos que eso. A cambio, REST evita sumar una capa entera (GraphQL Yoga + Pothos + `urql` + generación de tipos) para un backend que va a mantener una sola persona — menos piezas moviéndose es más valioso acá que la flexibilidad de queries que GraphQL ofrece y que este proyecto no llega a necesitar. **Novedad respecto del plan anterior:** para las actualizaciones parciales (registrar el push token del dispositivo, y a futuro cualquier edición de un campo suelto del perfil) se usa el verbo **PATCH** en vez de forzar al cliente a reenviar el recurso completo con PUT — ver sección 6.1.

### 3.1 Desarrollo local primero, deploy simple después

Todo el desarrollo se hace en local hasta donde sea posible, y recién se toca Supabase hosted / Vercel / EAS cuando hace falta probar algo que el entorno local no puede cubrir (auth OAuth remota real, push a un dispositivo fuera de la red local, o una build para tienda):

- **Backend + base de datos:** Supabase CLI (`supabase start`) levanta Postgres + Auth + Storage local; el backend Next.js corre con `next dev` apuntando a esa instancia local vía variables de entorno (`.env.local`). Las migraciones se escriben y prueban ahí antes de aplicarse a Supabase hosted (`supabase db push`).
- **App móvil:** Expo Go (o un dev client si hace falta un módulo nativo que Expo Go no soporte) corriendo contra el backend local — mismo dispositivo o emulador en la misma red, o un túnel (`expo start --tunnel`) si hace falta probar desde un celular físico sin estar en la misma LAN.
- **MCP:** durante M1/M2 se prueba con Claude Desktop vía transporte stdio contra el backend local, sin necesidad de OAuth ni de desplegar nada (ver sección 4, nota del punto 2/4). El flujo OAuth remoto solo se valida una vez desplegado a Vercel + Supabase hosted.
- **Cuándo migrar a hosted:** recién al final de cada milestone, para validar que lo construido en local también funciona contra la infraestructura real — no antes, y no como parte del ciclo de iteración diario.

**Sobre Docker:** se evaluó explícitamente y no se adopta para el despliegue. Vercel y Supabase hosted son plataformas gestionadas — reciben el código directamente (`git push` / `vercel deploy`, `supabase db push`) sin necesitar una imagen propia, y EAS Build/Submit hace lo mismo para la app móvil. Agregar un Dockerfile ahí sumaría una capa de mantenimiento (mantener la imagen, el build, el registry) sin ningún beneficio real en este stack — nadie más va a correr este backend fuera de Vercel. La única pieza que sí usa Docker es el stack local de Supabase CLI, y lo hace automáticamente al correr `supabase start`: no hace falta escribir ni mantener ningún Dockerfile propio para eso tampoco.

> **Resuelto (revisión post-council, punto 1/4):** la preocupación de que MCP no funcione bien sobre funciones serverless de Vercel estaba basada en el transporte HTTP+SSE pre-2025. Desde la spec 2025-03-26 (y más aún en 2026-07-28), Streamable HTTP es stateless por defecto — cada llamada es un POST con respuesta JSON directa; el streaming solo se abre si el servidor necesita mandar mensajes no solicitados (progreso, sampling), algo que ninguna de nuestras tools necesita. Vercel mantiene oficialmente el paquete `mcp-handler` (ex `vercel-labs/mcp-for-next.js`), ya actualizado a la spec 2026-07-28, sin dependencia de Redis ni almacenamiento de sesión. Decisión: usar `mcp-handler` para el endpoint MCP dentro de la misma app Next.js, en vez de implementar el transporte a mano. Alternativa de respaldo si el free tier de Vercel se queda corto más adelante: Cloudflare Workers + `createMcpHandler` (Cloudflare hizo el mismo movimiento a stateless, deprecando su `McpAgent` basado en Durable Objects).

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
> - **Camino gratis para desarrollar sin pagar nada extra:** probar el servidor MCP en local con Claude Desktop vía transporte **stdio** (proceso local, sin red, sin OAuth) durante M1/M2 mientras se construyen las tools; agregar el flujo OAuth remoto recién al desplegar a Vercel, y validarlo primero con la cuenta Claude Pro existente antes de pagar por Plus de ChatGPT o Google AI Pro solo para probar.

### Autorización a nivel de base de datos (RLS)

> **Resuelto (revisión post-council, punto 3/4):** el riesgo que marcó Security era que, si el backend usa la `service_role` key de Supabase (que **bypasea** Row Level Security) para todas sus consultas, el aislamiento entre usuarios pasa a depender 100% de que cada tool filtre `user_id` a mano — un solo olvido es un IDOR (un usuario lee o escribe datos de otro).
>
> Los tokens que emite el OAuth 2.1 Server de Supabase son JWTs normales de Supabase (incluyen `user_id`, `role`, y además `client_id` del conector OAuth). **Las políticas RLS existentes se aplican automáticamente a esos tokens OAuth, igual que a una sesión normal** — `auth.uid()` funciona sin trabajo extra de nuestra parte.
>
> Decisión: patrón híbrido.
> - Las **tools MCP y las rutas de API (Route Handlers) que consume la app móvil** crean el cliente de Supabase pasando el token OAuth/sesión del usuario como `Authorization: Bearer <token>` en cada request — RLS queda activa, y Postgres aplica el aislamiento por sí solo, no el código de la tool.
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

## 6. Tools MCP (contrato inicial)

| Tool | Dirección | Annotation MCP | Descripción |
|---|---|---|---|
| `import_program` | escritura | — (crea, no sobrescribe) | Crea un Program completo (fases, slots, actividades, ladders, reglas de progresión, reglas de colapso) — de cualquier dominio |
| `get_program` | lectura | `readOnlyHint: true` | Devuelve el programa activo del usuario, incluyendo en qué escalón está cada actividad |
| `log_session` | escritura | — (agrega, no sobrescribe) | Registra una sesión completa (slot, actividades, mediciones); dispara la evaluación de `progression_rule` |
| `get_logs` | lectura | `readOnlyHint: true` | Historial de sesiones logueadas, con filtro de rango de fechas |
| `get_adherence` | lectura | `readOnlyHint: true` | Resumen de cumplimiento (sesiones planeadas vs. realizadas) para que el agente pueda razonar sobre ajustes |
| `set_availability` | escritura | — | Días/horarios en que el usuario puede hacer sus sesiones; dispara la programación de recordatorios |
| `update_program` | escritura | **`destructiveHint: true`** | Modifica fases/reglas/volumen de un programa existente (usado en revisiones cualitativas guiadas por IA) |

Cada tool define su JSON Schema de entrada con el SDK de MCP — ese schema es, en sí mismo, el "formato obligatorio" que reemplaza al prompt de traducción del diseño original, y es agnóstico de dominio: nada en la forma de las tools asume gimnasio.

> **Resuelto (revisión post-council, punto 4/4):** `update_program` era la tool más peligrosa del contrato — reescribe el programa activo según el razonamiento del agente, sin versionado ni forma de revertir un cambio erróneo. Tres capas de defensa, cada una cubriendo lo que las otras no cubren:
> 1. **Protocolo:** anotar `update_program` con `destructiveHint: true` (tabla de arriba) — los clientes MCP (Claude, ChatGPT, Gemini Spark) usan esta annotation para decidir si piden confirmación al usuario antes de ejecutar la tool. Es gratis y estándar, pero es una señal informativa, no una garantía — no puede ser la única defensa.
> 2. **Base de datos:** activar la extensión `supa_audit` de Supabase sobre `programs` (y `session_logs`/`measurement_logs`, que de paso ayuda con la idempotencia pendiente) — `create extension supa_audit cascade; select audit.enable_tracking('public.programs'::regclass);`. Dos líneas de SQL dan historial completo de cambios (`audit.record_version`) y reconstrucción del estado en cualquier punto anterior, es decir, rollback sin código propio de versionado.
> 3. **Aplicación:** una función de validación semántica antes de aplicar `update_program` — el JSON Schema valida forma (que `target_value` sea un número), no sentido (que no sea absurdo, o que la actualización no borre todas las fases). Regla dura mínima para el MVP: rechazar una actualización que deje el programa sin fases o sin ningún slot programado.

## 6.1 API REST para la app móvil (ejemplos de uso)

Importante: esto es **distinto** de las tools MCP de la tabla de arriba. Las tools MCP las llama el agente de IA (Claude/ChatGPT/Gemini) vía protocolo MCP/JSON-RPC; los endpoints REST de acá abajo los consume directamente la app Expo (pantallas de solo lectura/logging manual, sección 8) contra el mismo backend Next.js. Ambas capas leen y escriben las mismas tablas de Supabase, cada una con su propio mecanismo de auth (OAuth 2.1 del conector MCP vs. sesión de Supabase Auth de la app).

**Endpoints (Route Handlers de Next.js):**

| Método | Ruta | Uso |
|---|---|---|
| `GET` | `/api/programs/active` | Árbol completo del programa activo (fases, slots, actividades, ladders) — equivalente de solo-lectura a `get_program` |
| `GET` | `/api/logs?from=&to=` | Historial de sesiones logueadas, filtrado por rango de fechas — equivalente a `get_logs` |
| `GET` | `/api/adherence?weeks=4` | Resumen de cumplimiento — equivalente a `get_adherence` |
| `POST` | `/api/logs` | Registra una sesión completa (crea un recurso nuevo) — equivalente de escritura a `log_session` |
| `PATCH` | `/api/me` | Actualiza parcialmente el perfil del usuario (hoy: `pushToken`) sin reenviar el resto de los campos |

**Sobre PATCH — por qué se usa acá y no antes:** `/api/me` es un recurso con varios campos (nombre, preferencias, token de push, etc.). Con `PUT` el cliente tendría que reenviar el objeto entero en cada actualización (arriesgando pisar campos que no tocó si el payload viene incompleto); con `PATCH` manda solo el campo que cambió. El contrato es **JSON Merge Patch** ([RFC 7396](https://www.rfc-editor.org/rfc/rfc7396)) — el body es un objeto parcial que se mergea sobre el recurso existente, con `Content-Type: application/merge-patch+json` — más simple que JSON Patch (RFC 6902, que usa una lista de operaciones tipo `[{ "op": "replace", "path": "/pushToken", "value": "..." }]`) y suficiente para este caso, donde no hace falta borrar campos ni reordenar arrays, solo reemplazar valores sueltos. Si en el futuro se habilita edición parcial de disponibilidad desde la app (hoy `set_availability` es solo vía MCP, sección 8), seguiría el mismo patrón: `PATCH /api/me/availability`.

**Ejemplo — pantalla "programa activo":**

```http
GET /api/programs/active
Authorization: Bearer <token>
```

```json
{
  "id": "prog_123",
  "name": "Fuerza 16 semanas",
  "phases": [
    {
      "name": "Base",
      "weekStart": 1,
      "weekEnd": 4,
      "sessionSlots": [
        {
          "label": "Push",
          "activities": [
            {
              "label": "Press banca",
              "currentStepId": "step_incline_pushup",
              "ladder": [
                { "stepId": "step_incline_pushup", "label": "Flexión inclinada", "targetMetric": "reps", "targetValue": "12" }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

Como cada usuario tiene un solo programa activo (sección 8), este único `GET` ya trae todo lo que la pantalla necesita — no hace falta un endpoint separado por nivel de anidación.

**Ejemplo — logging manual desde la app (equivalente de escritura a `log_session`):**

```http
POST /api/logs
Authorization: Bearer <token>
Content-Type: application/json

{
  "sessionSlotLabel": "Push",
  "date": "2026-09-14",
  "notes": "Se sintió pesado el último set",
  "measurements": [
    { "activityId": "act_bench_press", "stepId": "step_incline_pushup", "metricType": "reps", "value": 12, "sequence": 1 }
  ]
}
```

**Ejemplo — registrar el push token con PATCH:**

```http
PATCH /api/me
Authorization: Bearer <token>
Content-Type: application/merge-patch+json

{
  "pushToken": "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]"
}
```

El resto del perfil del usuario (nombre, preferencias) no se toca — el handler en el backend solo aplica los campos presentes en el body sobre la fila existente en Supabase.

**Ejemplo — uso desde la app Expo con `ky` + React Query:**

```tsx
// lib/api.ts
import ky from 'ky';
import { supabase } from './supabase';

export const api = ky.create({
  prefixUrl: process.env.EXPO_PUBLIC_API_URL,
  hooks: {
    beforeRequest: [
      async (request) => {
        const { data } = await supabase.auth.getSession();
        request.headers.set('Authorization', `Bearer ${data.session?.access_token}`);
      },
    ],
  },
});
```

```tsx
// hooks/useActiveProgram.ts
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Program } from '../types';

export function useActiveProgram() {
  return useQuery({
    queryKey: ['programs', 'active'],
    queryFn: () => api.get('api/programs/active').json<Program>(),
  });
}
```

```tsx
// hooks/useRegisterPushToken.ts
import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';

export function useRegisterPushToken() {
  return useMutation({
    mutationFn: (pushToken: string) =>
      api.patch('api/me', {
        json: { pushToken },
        headers: { 'Content-Type': 'application/merge-patch+json' },
      }),
  });
}
```

El cliente manda el token de sesión de Supabase Auth como header `Authorization: Bearer <token>` en cada request (configurado una sola vez en el `beforeRequest` hook de `ky`), el mismo patrón de la sección de RLS — no hace falta pasar `user_id` a mano en ningún endpoint.

**Del lado del backend — el Route Handler que resuelve el `PATCH`:**

```ts
// app/api/me/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr'; // o el helper equivalente ya usado en el resto de las rutas

// Whitelist explícita: un merge patch nunca debe poder tocar columnas fuera de esta lista
// (evita que un body con { "id": "...", "role": "admin" } pise algo que no debería).
const PATCHABLE_FIELDS = ['pushToken', 'name', 'preferences'] as const;
type PatchableField = (typeof PATCHABLE_FIELDS)[number];

export async function PATCH(request: NextRequest) {
  const contentType = request.headers.get('content-type');
  if (contentType !== 'application/merge-patch+json') {
    return NextResponse.json(
      { error: 'Content-Type debe ser application/merge-patch+json' },
      { status: 415 }, // Unsupported Media Type
    );
  }

  // El cliente de Supabase pasa el Bearer token del header, no la service_role key —
  // RLS aplica sola (ver sección "Autorización a nivel de base de datos").
  const authHeader = request.headers.get('authorization');
  const supabase = createServerClient(/* ...config, con el token del header pasado en global headers... */);

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }

  const patch = await request.json();

  // RFC 7396: solo se aplican los campos presentes en el body; un valor `null`
  // explícito borra ese campo (lo pasa a NULL) en vez de dejarlo como está.
  const updates: Partial<Record<PatchableField, unknown>> = {};
  for (const field of PATCHABLE_FIELDS) {
    if (field in patch) {
      updates[field] = patch[field] === null ? null : patch[field];
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Ningún campo válido en el patch' }, { status: 400 });
  }

  const { data: updatedProfile, error: updateError } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', user.id) // redundante con RLS, pero explícito — no confiar solo en la policy
    .select()
    .single();

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json(updatedProfile, { status: 200 });
}
```

Puntos a resaltar del handler:
- **Valida el `Content-Type`** antes de tocar nada — si alguien manda `application/json` a secas, se rechaza con `415` en vez de asumir semántica de merge patch por defecto.
- **Whitelist de campos** (`PATCHABLE_FIELDS`) en vez de aplicar el body entero a la fila — un merge patch mal armado (o malicioso) no puede tocar columnas como `id` o `role` aunque estén en el JSON.
- **`.eq('id', user.id)` explícito** aunque RLS ya lo garantice — defensa en profundidad, no depender de una sola capa.
- El mismo esqueleto (auth por Bearer token, `supabase.from(...)`) se reusa para los Route Handlers de `GET /api/programs/active`, `GET /api/logs`, `GET /api/adherence` y `POST /api/logs` — cambia el verbo, el nombre de tabla y la query, no el patrón de auth.

## 7. Recordatorios (MVP)

- La app Expo pide permiso de notificaciones al usuario y registra el push token del dispositivo contra el backend (`PATCH /api/me`, ver sección 6.1).
- El agente llama `set_availability` con los días/horarios que el usuario le dio en el chat.
- Un cron job (Vercel Cron o Supabase Edge Function programada) revisa diariamente: ¿hay un `session_slot` de la fase activa que caiga en un día de disponibilidad y todavía no tenga `SessionLog` para esa fecha? Si sí, y falta poco para el horario declarado, se dispara una notificación push vía Expo Push Notifications (`expo-server-sdk`) al token registrado del usuario.
- Si el usuario no completa un slot planeado y coincide con quedar por debajo de `collapse_rules.min_slots_per_week` restante en la semana, la notificación push siguiente sugiere colapsar a la versión reducida (usando `collapse_priority` para elegir qué slot sacrificar) — lógica simple basada en conteo, no IA.
- Queda pendiente (ya señalado en la revisión del council, sección de riesgos): el cron diario fijo no resuelve bien timezones reales de usuarios en zonas distintas — a revisar en M3, sea con un cron más frecuente filtrando por ventana horaria, o con Supabase Edge Functions programadas por usuario.

## 8. Fuera de alcance del MVP (explícito)

- Dashboard web — el cliente end-user del MVP es exclusivamente la app móvil (Expo); un panel de administración web queda para más adelante si hace falta.
- Multi-programa simultáneo por usuario (un programa activo a la vez — podría ser de cualquier dominio, pero uno solo).
- Editor visual de programas en la app — el único camino de creación/edición en el MVP es vía MCP (el agente); la app móvil es de solo lectura/logging manual como fallback.
- Motor de recomendación de progresión cualitativo dentro del backend — vive en el agente, no en el código.
- Pagos/monetización — se decide después de validar retención con usuarios reales.
- UI específica por dominio (gráficos de fuerza vs. gráficos de páginas leídas vs. splits de running) — el MVP usa una vista genérica de "actividad + métrica + valor" para todos los dominios; visualizaciones a medida quedan para después de validar qué dominio(s) engancha(n).

## 9. Roadmap

1. **M1 — Esqueleto:** backend Next.js (API + MCP) + Supabase local (schema de datos de la sección 4) + servidor MCP con `import_program` y `get_program` funcionando end-to-end contra Claude Desktop (stdio, todo local) — y en paralelo, esqueleto de la app Expo (navegación básica, login contra Supabase Auth local) corriendo con Expo Go. Migración a claude.ai Connectors (remoto, OAuth) y a Supabase hosted/Vercel recién al cierre del milestone.
2. **M2 — Logging y progresión determinística:** `log_session`, `get_logs`, motor de evaluación de `progression_rule` (por `activity_id`/`step_id`), vista en la app Expo de solo lectura del programa activo y del historial.
3. **M3 — Disponibilidad y recordatorios:** `set_availability`, registro de push token desde la app, cron de recordatorios por push (Expo), lógica de colapso de slots.
4. **M4 — Revisión asistida por IA:** `get_adherence`, `update_program`, validar el flujo completo "revisá mi progreso y ajustá el plan" con un programa real (el de `rutina.md`, dominio de entrenamiento) de punta a punta.

## 10. Verificación

- Probar el flujo completo en local (Supabase CLI + Next.js dev + Claude Desktop stdio), importando el programa real de 16 semanas (`rutina.md` traducido al schema de la sección 4) y verificando que `import_program` lo acepta sin pérdida de estructura (fases, deloads, ladders).
- Simular logs de varias sesiones y confirmar que `progression_rule` avanza `current_step_id` correctamente por ID, sin intervención manual.
- Probar `set_availability` + registro de push token desde la app Expo + disparo real de una notificación push en un entorno de staging (Supabase hosted + Vercel desplegado).
- Ejecutar `update_program` desde una conversación real pidiéndole a Claude que reevalúe el progreso, y confirmar que el cambio se refleja en `get_program` (visible también en la app Expo).
- Validar que el schema realmente es agnóstico de dominio: importar un segundo programa de un dominio distinto (ej. un plan de lectura simple armado a mano) y confirmar que `import_program`/`log_session`/`progression_rule` funcionan sin ningún cambio de código — esta prueba es la que confirma o refuta el reframe de la sección 1.
- Solo después de validar todo lo anterior en local, repetir el flujo end-to-end contra Supabase hosted + Vercel + claude.ai Connectors (OAuth remoto) y una build de Expo (Expo Go o dev client) apuntando a esa infraestructura real.
