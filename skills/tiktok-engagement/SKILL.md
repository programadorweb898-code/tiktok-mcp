# SKILL — TikTok Engagement

Guía especializada para implementar, modificar, verificar y extender operaciones de **engagement** de TikTok en este repositorio: interacción con otros usuarios y con contenido ajeno o propio.

> Alcance: define **QUÉ** operación de engagement realizar, su semántica, estados e invariantes.
> El **CÓMO** del navegador (Playwright, hydration, selectores, sesiones, cleanup) pertenece a `skills/tiktok-browser/SKILL.md`. No duplicar aquí esos detalles.
>
> Este documento refleja exclusivamente el estado REAL del código. Estados usados: `IMPLEMENTED` · `PARTIAL` · `PLANNED` · `RESEARCH` · `BLOCKED` · `NOT_SUPPORTED`. Nunca documentar como implementada una capacidad que no exista en el código.

---

## 1. Responsabilidad

Cubre las operaciones de interacción:

like · unlike · follow · unfollow · comentarios (leer/publicar/responder/eliminar) · share · save/favorite · messaging · eliminación de contenido propio (adyacente).

Cada una está clasificada según lo que el código realmente hace hoy (sección 20). Si una operación no existe, esta skill indica qué haría falta para implementarla, pero **no autoriza a implementarla sin seguir el procedimiento de la sección 16**.

---

## 2. Capacidades actuales verificadas

Verificado contra `src/runtime/tiktok-operations.ts`, `src/runtime/local-runtime.ts`, `src/server.ts` y `src/runtime/social-rate-limit.ts`.

### 2.1 LIKE — `IMPLEMENTED`

| Aspecto | Valor real |
|---|---|
| Función | `likeVideo(req)` (`tiktok-operations.ts`) |
| Tool MCP | `tiktok_like` (`server.ts`) |
| Runtime | `LocalTikTokRuntime.like()` → job asíncrono vía `start("like", …)` |
| Parámetros | `account_id`, `video_url` |
| Validación de entrada | Regex estricta: `^https://(www\.)?tiktok\.com/@[handle]/video/\d+` — solo permalinks; si falla → `INVALID_INPUT` sin abrir navegador |
| Página | Página pública watch (`video_url`), `goto` con `domcontentloaded`, timeout 45 s |
| Hydration | `HYDRATION_PROBES.videoActions` (30 s). `null` → `NOT_READY` con diagnósticos |
| Modales | `dismissBlockingModal(page, 6000)` antes de interactuar |
| Selector | `resolveElement`: `[data-e2e="like-icon"]` → `button[aria-label*="ike" i]` → `getByRole("button", { name: /like/i })`; 6 s por estrategia |
| Interacción | Click con timeout 10 s |
| Endpoint interno observado | `/commit/item/digg` o `/digg(/|\?|$)` (case-insensitive), espera 15 s vía `submitAndAwaitTikTokApi` |
| Verificación | 1º respuesta API (`status_code === 0`); si no hay respuesta → fallo `UI_TIMEOUT` ("No like API call observed"), NUNCA éxito |
| Éxito | `{ success: true, data: { liked: true } }` + `recordAction(account_id, "tiktok", "like")` |
| Errores | `INVALID_INPUT`, `LAUNCH_FAILED`, `NOT_READY`, `UI_TIMEOUT`, `RATE_LIMITED`, `SESSION_EXPIRED`, `CAPTCHA_CHALLENGE`, `UNKNOWN` (vía `mapTikTokError`) |
| Rate limit | Gate previo: espaciado 30 s + ventana `like` máx **60/hora** → `RATE_LIMITED_PROTECTIVE` |

**LIMITACIÓN CRÍTICA documentada:** `likeVideo` NO comprueba el estado actual del like antes de clickear. Si el video YA tiene like del perfil conectado, el click sobre `like-icon` ejecuta un **unlike**, y el endpoint digg responderá éxito igualmente. No existe detección de "already liked". Ver sección 11 (Idempotencia).

### 2.2 FOLLOW — `IMPLEMENTED`

| Aspecto | Valor real |
|---|---|
| Función | `followUser(req)` (`tiktok-operations.ts`) |
| Tool MCP | `tiktok_follow` (`server.ts`) |
| Runtime | `LocalTikTokRuntime.follow()` → job asíncrono vía `start("follow", …)` |
| Parámetros | `account_id`, `target_user` (con o sin `@`) |
| Identificación del usuario | Handle validado con `/^[A-Za-z0-9._]{2,24}$/`; inválido → `INVALID_INPUT` sin navegador |
| Navegación | `https://www.tiktok.com/@<handle>` (perfil público), 45 s |
| Hydration | `HYDRATION_PROBES.profileActions` (30 s): botón hoja con texto exacto `Follow/Following/Friends/Requested` en cualquier estado. `null` → `NOT_READY` |
| Modales | `dismissBlockingModal(page, 6000)` |
| Selector | `resolveElement` con estrategias que **excluyen deliberadamente "Following"**: `[data-e2e="follow-button"]:has-text("Follow"):not(:has-text("Following"))` → `getByRole("button", { name: /^follow$/i })` → `getByText(/^Follow$/)` → botones de texto excluyendo Following. 8 s por estrategia |
| Endpoint interno observado | `/aweme/v\d+/(web/)?commit/follow/user` o `/passport/web/user/follow`, espera 20 s |
| Verificación primaria | Respuesta API (`status_code === 0`) |
| Verificación fallback | Flip del botón a `Following/Friends/Requested` (`[data-e2e="follow-button"]`, 4 s). Confirmado → éxito + `recordAction` |
| Idempotencia | SI: si no hay control "Follow" actionable, se lee la página buscando botón hoja `Following/Friends/Requested` → éxito `{ followed: true }` ("already following — treating as satisfied"). Es un resultado soportado, no un error |
| Fallo sin relación previa | Botones renderizados y ningún control ni estado de relación → `NOT_FOUND` (perfil privado, restringido, inexistente o selector rotado) con diagnósticos |
| Sin confirmación alguna | `UI_TIMEOUT` ("no API, button didn't flip") con `captureUiState` |
| Rate limit | Espaciado 30 s + ventana `follow` máx **20/hora** |

**REGLAS DE ESTADO (inviolables):**

- Los estados `Following`, `Friends` y `Requested` significan que la relación **ya existe** (o está pendiente). Jamás interpretarlos como "necesita follow".
- Ningún selector de follow puede matchear el estado "Following": eso convertiría FOLLOW en UNFOLLOW. Las exclusiones `:not(:has-text("Following"))` y `/^follow$/i` existen exactamente por eso y deben conservarse.
- `Requested` (cuenta privada) cuenta como follow satisfecho: la solicitud quedó registrada.

### 2.3 DELETE (contenido propio) — adyacente a engagement

`deleteVideo` / tool `tiktok_delete` existe y es `IMPLEMENTED`, pero pertenece al dominio de gestión de publicaciones (Studio content manager), no al engagement con terceros. Documentado en `tiktok-browser/SKILL.md` y `SDD.md`. No duplicarlo aquí.

### 2.4 Operaciones NO presentes en el código (verificado)

Búsquedas sobre el repositorio confirman que **no existe** ninguna función, tool MCP ni runtime method para: `unlike`, `unfollow`, comentarios (lectura, publicación, respuesta, eliminación), share, save/favorite, mensajería. Cualquier afirmación contraria es inventada. Estado detallado por capacidad en las secciones 6–10 y matriz de la sección 20.

---

## 3. Arquitectura

Flujo real de una operación de engagement:

```
MCP Tool (server.ts: addTool, validación zod, ACCOUNT_ID)
    ↓
LocalTikTokRuntime (local-runtime.ts)
    - common(): exige cuenta existente y status "active"
    - start(name, …): crea job asíncrono pending→running→done/failed,
      devuelve { operation_id, poll_with: "tiktok_operation_status" }
    ↓
TikTok Operation (tiktok-operations.ts: likeVideo, followUser, …)
    ↓
Rate Limit Gate (gate() → checkRateLimit en social-rate-limit.ts)
    - ANTES de abrir el navegador; si bloquea → RATE_LIMITED_PROTECTIVE
    ↓
Browser Session (openAuthenticatedSession → launchPersistentContext,
    lockAccount: una sola sesión por cuenta)
    ↓
Hydration (waitForHydrated + HYDRATION_PROBES; null = NOT_READY)
    ↓
Selector Resolution (resolveElement: capas ordenadas data-e2e → aria → rol → texto)
    ↓
TikTok Action (click con dismissBlockingModal previo)
    ↓
Verification (submitAndAwaitTikTokApi → fallback UI explícito)
    ↓
Result (TikTokOpResult tipado con error_code)
    ↓
recordAction (social-rate-limit.ts → store.appendAction)
    - SOLO tras confirmación de éxito; los cupos no se gastan en fallos
```

Responsabilidades por capa:

- **Tool MCP:** validación de parámetros, descripción precisa, errores estructurados. No conoce TikTok.
- **Runtime:** ciclo de vida del job, marca `logged_out` ante `SESSION_EXPIRED`, polling. No conoce selectores.
- **Operación:** semántica de la acción, estados, verificación. Es donde vive toda decisión de engagement.
- **Gate/recordAction:** protección de volumen local, registro histórico (48 h).
- **Sesión/selectores/hydration:** infraestructura de browser — propiedad de `tiktok-browser/SKILL.md`.

---

## 4. LIKE — flujo exacto (implementado)

1. **Recepción del video:** `video_url` permalink completo; validación regex antes de tocar nada.
2. **Target:** la propia URL identifica el video; no se resuelve id aparte.
3. **Navegación:** `goto(video_url, domcontentloaded, 45 s)`.
4. **Hydration:** probe `videoActions` (30 s). El rail de engagement hidrata DESPUÉS del shell del video; operar antes produce falsos "selector rotado".
5. **Localización del botón:** estrategias ordenadas (data-e2e → aria-label → rol), 6 s c/u, con diagnóstico AX si todas fallan.
6. **Endpoint observado:** `commit/item/digg` (interceptado ANTES del click).
7. **Éxito:** respuesta con envelope OK → `recordAction` → `{ liked: true }`.
8. **Fallback:** NO HAY fallback positivo. Sin respuesta del endpoint → `UI_TIMEOUT` con captura de UI. Esta op exige la API interna como única prueba.
9. **Errores:** mapeados por `mapTikTokError` (401/403/código 8 → `SESSION_EXPIRED`; 429 y ≥10000 → `RATE_LIMITED`; 20000–29999 → `CAPTCHA_CHALLENGE`; etc.).
10. **Rate limit:** 30 s de espaciado global + máx 60 likes/hora.

**Lo que NO soporta hoy:** unlike, detección de estado previo del like, likes sobre comentarios, likes en LIVE. No asumir simetría LIKE/UNLIKE: el mismo botón sirve para ambos y el código no distingue — por eso un like repetido es peligroso (ver §11).

---

## 5. FOLLOW — flujo exacto (implementado)

Documentado en §2.2. Resumen de invariantes:

- Identificación: handle sanitizado (`@` opcional), validado localmente.
- Navegación directa al perfil público; nunca vía búsqueda.
- Hydration obligatoria del row de acciones (auth-gated, hidrata último).
- Selector multi-capa con exclusión explícita de "Following".
- Estados reconocidos: `Follow` (sin relación) / `Following` (relación mutua activa) / `Friends` (mutuo) / `Requested` (privada, pendiente).
- Endpoint: `commit/follow/user` o `passport/web/user/follow`.
- Verificación: API → flip de botón → (si ya había relación) lectura de página como éxito idempotente.
- Errores: `NOT_READY` ≠ `NOT_FOUND` ≠ `UI_TIMEOUT`, cada uno con decisión de agente distinta (ver §15).
- Rate limit: máx 20 follows/hora + espaciado 30 s.

---

## 6. UNFOLLOW — `NOT_IMPLEMENTED` (estado SDD: RESEARCH)

No existe en el repositorio. Ninguna función, tool o runtime method lo implementa. El único mecanismo indirecto sería clickear un botón en estado `Following` — exactamente lo que los selectores actuales están diseñados a **evitar**.

Componentes necesarios para implementarlo (guía, no autorización automática):

1. Probe de hydration reutilizable: `profileActions` ya cubre estados `Following/Friends/Requested` — reutilizar, no crear otro.
2. Estrategias de selector que matcheen EXCLUSIVAMENTE estados de relación activa (`Following`, `Friends`; decidir tratamiento de `Requested` — cancelar solicitud vs. abortar).
3. Endpoint interno a observar: debe descubrirse empíricamente en una sesión real (el commit de unfollow probablemente reutilice el endpoint de follow, pero NO está confirmado — prohibido inventarlo).
4. Idempotencia: si el botón muestra `Follow` puro, la relación ya no existe → éxito no-op sin clickear.
5. Ventana propia de rate limit en `WINDOWS` (propuesta pendiente de decisión; no asumir que hereda la de `follow`).
6. Tool MCP `tiktok_unfollow` + runtime method + tests + actualización de SDD (secciones 4, 5, roadmap fase 2).

Riesgo principal: un error de selección convierte unfollow en follow o viceversa. La verificación debe leer el estado FINAL del botón, no confiar en el click.

---

## 7. COMENTARIOS — matriz de estado real

Verificado: no existe ninguna implementación de comentarios en el repositorio. SDD Fase 2 los planifica.

| Capacidad | Estado | Implementación | Limitaciones |
|---|---|---|---|
| Leer comentarios de un video | PLANNED (Fase 2) | Ninguna | Requiere definir superficie (watch page vs. endpoint interno); volumen de scroll/paginación por definir |
| Publicar comentario | PLANNED (Fase 2) | Ninguna | Editor de comentarios no explorado; filtros anti-spam de TikTok sin evaluar |
| Responder comentario | PLANNED (Fase 2) | Ninguna | Depende de hilo/reply UI sin investigar |
| Eliminar comentario propio | PLANNED (Fase 2) | Ninguna | Menú de contexto de comentario sin investigar |
| Likes sobre comentarios | Fuera de roadmap | Ninguna | — |

Notas transversales: los probes de hydration existentes NO cubren la superficie de comentarios (habría que agregar uno nuevo a `HYDRATION_PROBES`). El rate limiting actual no tiene ventana para comentarios (agregarla sería una propuesta nueva, no una implementación existente).

---

## 8. SHARE — `RESEARCH`

No existe implementación. Además, "share" no es una operación única. Distinguir conceptualmente antes de investigar:

1. **Obtener URL del video** — trivialmente derivable del permalink; no requiere acción en TikTok.
2. **Copiar enlace** — acción de UI del menú Share (portapapeles); verificación difícil desde Playwright.
3. **Abrir el menú Share** — paso intermedio, no una capacidad final.
4. **Compartir vía UI a otro canal integrado** — superficies externas (WhatsApp, etc.), fuera del alcance actual.
5. **Republish/reenvío** (repost nativo de TikTok) — operación DISTINTA con estado propio en la cuenta; sin investigación.

Estado: RESEARCH para todas. No fusionarlas en una sola tool futura sin decisión explícita.

---

## 9. SAVE / FAVORITE — `RESEARCH`

No existe soporte real. Conceptos distintos que no deben mezclarse:

- **Guardar video (Favorite)** — estado en la cuenta del perfil conectado; análogo directo de like con botón propio en el rail (`videoActions` cubre parcialmente esa zona, pero no hay estrategia para el botón de save).
- **Colección** — guardar dentro de una colección nombrada; UI adicional sin investigar.
- **Descargar** — descarga del archivo; interseca políticas de derechos y la configuración de descargas del autor; además el runtime bloquea media pesada salvo `loadMedia`.

Todo: RESEARCH.

---

## 10. MESSAGING — `RESEARCH` (superficie sensible)

No existe soporte. DMs en TikTok web tienen restricciones fuertes (disponibilidad limitada por región/edad/mutual-follow) y son superficie de alto riesgo de abuso y de challenge/captcha. Antes de cualquier evaluación: análisis de riesgo explícito (SDD ya lo señala). Sin endpoints inventados; cualquier endpoint de mensajera deberá observarse empíricamente. Estado: RESEARCH/BLOCKED hasta esa evaluación.

---

## 11. IDEMPOTENCIA

Una operación de engagement es **idempotente** cuando ejecutarla sobre un sistema que YA está en el estado objetivo produce éxito sin cambiar nada (o reportando el estado alcanzado), en lugar de invertir el estado o fallar.

| Operación | Estado inicial posible | Acción | Estado esperado | Comportamiento correcto si ya está en el objetivo |
|---|---|---|---|---|
| FOLLOW | Botón `Follow` | Click + verificar | `Following/Friends/Requested` | Ya cubierto: sin control "Follow" y presente `Following/Friends/Requested` → éxito `{ followed: true }` sin click |
| FOLLOW | Ya `Following` | — | `Following` | Éxito inmediato (implementado) |
| UNLIKE (futuro) | Sin like | Click | Like removido | Si no hay like → éxito no-op. NO implementado hoy |
| LIKE (hoy) | **Con like previo** | Click | ⚠️ **El código NO lo detecta: el click ejecuta UNLIKE** | El agente NO debe llamar `tiktok_like` dos veces sobre el mismo video asumiendo idempotencia. Tratar like como NO idempotente hasta que exista lectura de estado previo |
| UNFOLLOW (futuro) | Sin relación | — | Sin relación | Debe ser éxito no-op sin click (requisito de diseño, §6) |
| COMMENT (futuro) | — | Publicar | Comentario visible | Duplicados: evitar republicar el mismo texto; definir dedup antes de implementar |

Regla general: antes de actuar, leer el estado cuando sea observable; después de actuar, verificar el estado final. Nunca "reintentar hasta que cambie".

---

## 12. VERIFICACIÓN

Jerarquía (misma de `tiktok-browser/SKILL.md` §9; aquí solo la aplicación a engagement):

1. **Respuesta de API interna observada** (`submitAndAwaitTikTokApi`, envelope `status_code === 0`): evidencia primaria de like (digg) y follow (commit/follow).
2. **Cambio de estado específico:** flip del botón Follow a `Following/Friends/Requested` — fallback legítimo definido en código.
3. **Read-back del estado final:** para operaciones futuras (unlike/unfollow/comentarios) debería leerse el estado resultante, no solo aceptar el click.
4. **Evidencia de UI acotada** (redirect/toast): último recurso, con patrones verificados.
5. **Prohibido:** "no hubo excepción", "el click no lanzó", "la página cargó".

En fallo: adjuntar siempre `captureUiState` (screenshot, AX tree, controles, requests pendientes) — mecanismo existente, no reimplementar.

---

## 13. RATE LIMITING (estado real)

Implementación: `src/runtime/social-rate-limit.ts`. Consultada por `gate()` al inicio de CADA operación, antes de abrir el navegador. Registro vía `recordAction` SOLO tras confirmación de éxito (los fallos no consumen cupo). Historial podado a 48 h en `state.json`.

Límites vigentes (NO crear límites nuevos arbitrarios):

- **Separación mínima:** 30.000 ms entre dos acciones cualesquiera de la misma cuenta → `retry_after_ms` calculado.
- **Ventanas por operación** (`WINDOWS`):
  - `post`: máx 3 / 24 h
  - `follow`: máx 20 / hora
  - `like`: máx 60 / hora
- `delete`, `profile`, `avatar`, `analytics`: pasan SOLO por el espaciado mínimo, sin ventana de volumen.

Comportamiento:

- **`RATE_LIMITED_PROTECTIVE`** (cap local): la operación falla ANTES de lanzar el navegador, con `reason` y `retry_after_ms`. El agente debe esperar ese tiempo; jamás bypass (p. ej., saltarse `gate()` en una op nueva rompe toda la protección).
- **`RATE_LIMITED`** (impuesto por TikTok: HTTP 429, códigos internos ≥10000, cooldown de nickname): viene de respuestas reales mapeadas por `mapTikTokError`. Detener la secuencia completa de acciones de esa cuenta; espaciar en horas, no segundos.

Propuestas pendientes (NO son implementación): ventanas para comentarios, unfollow/unlike, shares. Cualquiera requiere editar `WINDOWS` como parte de la implementación de la capacidad, no antes.

---

## 14. SEGURIDAD Y COMPORTAMIENTO RESPONSABLE

Las operaciones de engagement deben:

- pasar siempre por `gate()`; nunca registrar acciones fallidas;
- detenerse ante `CAPTCHA_CHALLENGE` (no hay resolución automática; requiere humano);
- detener la secuencia ante `RATE_LIMITED` / `RATE_LIMITED_PROTECTIVE`;
- NO evadir mecanismos de protección de TikTok (captchas, fingerprints, límites);
- NO ejecutar volúmenes masivos: los caps locales (20 follows/h, 60 likes/h) son el techo, no el objetivo;
- NO reintentar indefinidamente resultados ambiguos: un engagement ambiguo (click sin confirmación) se diagnostica, no se repite a ciegas;
- respetar el lock por cuenta: una sola acción en vuelo por perfil.

Si una tarea del agente implica muchas acciones (seguir 50 cuentas), eso NO se resuelve iterando la tool individual: ver §17.

---

## 15. ERRORES (códigos reales y reacción en engagement)

Enum real de `TikTokOpResult.error_code`. No crear códigos nuevos salvo necesidad justificada y registrada como propuesta en SDD.

| Código | En contexto engagement | Reacción del agente |
|---|---|---|
| `SESSION_EXPIRED` | Sesión muerta al operar | NO reintentar; relanzar `tiktok_connect` (la cuenta ya quedó `logged_out` automáticamente) |
| `RATE_LIMITED` | TikTok frenó la actividad | Parar toda secuencia; esperar horas; revisar volumen |
| `RATE_LIMITED_PROTECTIVE` | Cap local preventivo (pre-navegador) | Esperar `retry_after_ms`; no bypass |
| `CAPTCHA_CHALLENGE` | Challenge de seguridad | Abortar; intervención humana; jamás reintentar en loop |
| `NOT_READY` | Página cargó, controles nunca hidrataron — NADA fue observado | Reintento ÚNICO razonable tras espera; persiste → reportar con diagnósticos. El estado del target es DESCONOCIDO (≠ "ya siguiendo"/"sin like") |
| `NOT_FOUND` | Contenido renderizado y objetivo ausente (perfil privado/inexistente, control no expuesto) | No reintentar ciegamente; verificar el dato del target |
| `UI_TIMEOUT` | Elemento o confirmación nunca apareció (posible rotación de selector o flujo cambiado) | Inspeccionar `interactive_elements`/`controls`/`pending` en `data`; ajustar selectores si rotaron |
| `INVALID_INPUT` | URL/perfil malformado | Corregir input; no reintentar igual |
| `LAUNCH_FAILED` | Navegador no abrió | Instalar browser o fijar `TIKTOK_BROWSER_PATH` |
| `UNKNOWN` | Excepción genérica | Leer `error` + diagnósticos; clasificar si recurre |

---

## 16. IMPLEMENTAR UNA NUEVA OPERACIÓN DE ENGAGEMENT (procedimiento)

1. **Verificar que no exista:** buscar en `tiktok-operations.ts`, `local-runtime.ts`, `server.ts` y esta skill. Consultar la matriz (§20) y `SDD.md` §5.
2. **Buscar operación similar:** like/follow son las plantillas de acción con API interna; delete lo es de flujo con menú+confirmación. Copiar estructura, no escribir desde cero.
3. **Leer `tiktok-browser/SKILL.md`** completo (sesiones, hydration, selectores, timeouts, cleanup).
4. **Definir estado inicial observable:** ¿qué señal de página distingue "ya está en el objetivo"? Agregar probe a `HYDRATION_PROBES` si ninguna cubre la superficie.
5. **Definir la acción** (click, texto, menú) con modales limpiados antes.
6. **Definir el estado esperado** post-acción, incluyendo los estados intermedios válidos (p. ej. `Requested`).
7. **Definir cómo se verifica éxito:** endpoint interno (observarlo en una sesión REAL antes de codificar el patrón — prohibido inventarlo) + fallback UI explícito. Diseñar el camino de fallo junto al feliz.
8. **Definir comportamiento idempotente** según §11: qué pasa si ya está en el objetivo (debe ser éxito no-op, nunca inversión del estado).
9. **Aplicar rate limiting:** `gate()` al inicio, `recordAction()` tras confirmación; proponer ventana en `WINDOWS` si el volumen importa.
10. **Implementar la operación** con `TikTokOpResult` tipado, `captureUiState` en fallos de UI y `finally { cleanup; close(); }`.
11. **Integrar en `LocalTikTokRuntime`:** método con `this.start(...)` (job asíncrono + `tiktok_operation_status`).
12. **Crear la tool MCP** en `server.ts`: schema zod completo, `ACCOUNT_ID`, descripción precisa, cross-validation si aplica.
13. **Agregar tests** unitarios de lógica pura extraída + actualizar el test de conteo de tools (hoy afirma 16).
14. **Probar manualmente contra TikTok real** con cuentas de prueba; documentar resultado y efectos secundarios.
15. **Actualizar `SDD.md`** (§3, §4, §5, Decision Log si hubo decisión) — obligatorio para capacidades significativas.
16. **Actualizar esta skill** (matriz §20 y secciones afectadas) si la arquitectura o el catálogo cambian.

---

## 17. OPERACIONES MASIVAS

**Regla:** el agente NO convierte una operación individual en masiva agregando un loop sobre `tiktok_like`/`tiktok_follow`. Cada llamada abre y cierra un navegador, consume cupo del gate, y un loop sin control viola directamente los caps protectores y expone la cuenta.

Antes de permitir acciones sobre múltiples targets deben estar definidos:

- límites totales y por ventana (por encima de los caps individuales, coherentes con ellos);
- delays entre acciones (respetando los ≥30 s del gate y sumando jitter razonable);
- manejo de errores por ítem (continuar, abortar, marcar);
- cancelación explícita;
- comportamiento ante CAPTCHA (abortar TODO, no saltar el item);
- comportamiento ante rate limits (abortar la tanda completa, no el item);
- dedup de targets (no relikear/refollowar lo ya procesado — ver §11: un like repetido ES un unlike).

Las operaciones masivas, si algún día se construyen, deben ser una **capacidad explícita y separada** (nueva operación con su propia lógica de volumen, su tool y su entrada en SDD). Hoy: NO_IMPLEMENTED, y ningún patrón del repo la soporta.

---

## 18. TESTING

Reglas generales de testing: pertenecen a `tiktok-testing/SKILL.md` (cuando exista) y a `AGENTS.md`/`SDD.md` §13. Aplicación específica a engagement:

- **Unit tests:** lógica pura extraíble (validaciones, parseos, decisiones de estado). Framework `node:test`. Ejemplo a imitar: `loadAllPostRows` se separó de `analyzePosts` para poder testearse.
- **Integration tests locales:** contrato de tools vía `InMemoryTransport` (como `local.test.ts` afirma las 16 tools); actualizar el conteo al agregar tools.
- **Browser tests:** NO automatizados contra TikTok real hoy (decisión vigente del SDD).
- **Pruebas manuales:** obligatorias antes de considerar funcional una operación nueva de engagement. Usar cuentas de prueba; minimizar acciones; verificar cada resultado; documentar efectos secundarios (likes/follows quedan en la cuenta — elegir targets desechables).
- Prohibido: acciones destructivas o masivas sobre cuentas reales en tests automáticos.

---

## 19. RELACIÓN CON OTRAS SKILLS

```
              ┌── tiktok-engagement   (QUÉ: semántica, estados, límites de engagement)
              │
              ↓
        tiktok-browser            (CÓMO: Playwright, hydration, selectores, sesiones)
              ↓
           Playwright
              ↓
            TikTok

tiktok-testing ──verifica──► tiktok-engagement + tiktok-browser
```

Esta skill NO duplica: detalles de Playwright, estrategias de selector completas, probes de hydration, BrowserContext, cleanup, manejo general del navegador → `tiktok-browser/SKILL.md`.

---

## 20. MATRIZ DE CAPACIDADES (estado real del repositorio)

| Operación | Estado | Tool MCP | Runtime | Browser | Verificación | Rate Limit |
|---|---|---|---|---|---|---|
| like | IMPLEMENTED | `tiktok_like` | `like()` → `likeVideo` | Watch page + rail hydratado + `like-icon` | API `commit/item/digg` (obligatoria; sin fallback positivo) | 30 s espaciado + 60/h |
| follow | IMPLEMENTED | `tiktok_follow` | `follow()` → `followUser` | Perfil público + actions hydratadas + follow-button | API `commit/follow/user` \| flip a Following/Friends/Requested \| ya-relacionado = éxito | 30 s espaciado + 20/h |
| unlike | RESEARCH / NOT_IMPLEMENTED | — | — | — | — | — |
| unfollow | RESEARCH / NOT_IMPLEMENTED | — | — | — | — | — |
| leer comentarios | PLANNED (Fase 2) | — | — | — | — | — |
| publicar comentario | PLANNED (Fase 2) | — | — | — | — | — |
| responder comentario | PLANNED (Fase 2) | — | — | — | — | — |
| eliminar comentario | PLANNED (Fase 2) | — | — | — | — | — |
| share (cualquier variante, §8) | RESEARCH | — | — | — | — | — |
| save/favorite | RESEARCH | — | — | — | — | — |
| colección | RESEARCH | — | — | — | — | — |
| descargar video | RESEARCH | — | — | — | — | — |
| messaging / DM | RESEARCH (superficie sensible; riesgo sin evaluar) | — | — | — | — | — |
| likes sobre comentarios | Fuera de roadmap | — | — | — | — | — |
| operaciones masivas de engagement | NOT_IMPLEMENTED (prohibidas como loops ad-hoc, §17) | — | — | — | — | — |

Adyacentes fuera de esta skill (documentadas en `tiktok-browser/SKILL.md` y `SDD.md`): delete de video propio, update profile/avatar, post/schedule, analytics.

---

## 21. LIMITACIONES ACTUALES

**De TikTok:**
- Rotación sin aviso de `data-e2e`, clases y flujos (los selectores multi-capa lo mitigan, no lo eliminan).
- Captchas/challenges posibles sin resolución automática.
- Límites reales opacos: solo visibles por respuesta (`RATE_LIMITED`, códigos internos).
- Perfiles privados/restringidos pueden no exponer control de follow (`NOT_FOUND`).
- Cooldowns propios (ej. nickname ~1/semana) aplican a otras ops, evidencian que existen límites silenciosos también para interacciones.

**Del navegador:**
- Una sesión por cuenta a la vez (lock); navegador por operación (lento).
- Media bloqueada por defecto (irrelevante para like/follow, relevante si se investiga download).

**Del repositorio:**
- LIKE no lee estado previo: repetir un like ejecuta un unlike (§11). Es LA limitación más importante de engagement hoy.
- No hay lectura del estado de relación salvo en el flujo de follow (idempotencia embebida ahí).
- Endpoints internos interceptados no contractuales; el envelope `status_code` se mapeó empíricamente.
- Sin ventana de rate limit para capacidades aún inexistentes (comentarios, unfollow…).

**No implementadas (ver §20):** unlike, unfollow, todo el dominio de comentarios, share, save, messaging, bulk.

**Requieren investigación previa:** endpoints reales de unfollow/unlike/digg-inverso; superficie y paginación de comentarios; disponibilidad regional de DM; semántica de repost.

---

## 22. REGLAS PARA EL AGENTE

El agente que use esta skill debe:

- inspeccionar el código antes de modificar o afirmar capacidades;
- reutilizar operaciones, helpers y patrones existentes (`gate`, `resolveElement`, `waitForHydrated`, `submitAndAwaitTikTokApi`, `captureUiState`, `recordAction`);
- no duplicar lógica de la capa browser (esa es `tiktok-browser`);
- no inventar endpoints, selectores ni comportamientos de TikTok;
- no asumir que una acción tuvo éxito porque el click ocurrió: verificar siempre según §12;
- respetar rate limits locales y de TikTok; detenerse ante CAPTCHA y RATE_LIMITED;
- no realizar acciones masivas sin una capacidad explícita (§17);
- no convertir operaciones idempotentes en acciones repetitivas — y tratar LIKE como NO idempotente hasta que exista lectura de estado previo;
- distinguir siempre `NOT_READY` (nada observado) de `NOT_FOUND` (observado y ausente);
- actualizar `SDD.md` y esta skill al agregar una capacidad significativa.
