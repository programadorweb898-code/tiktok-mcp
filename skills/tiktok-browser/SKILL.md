# SKILL — TikTok Browser Automation

Guía especializada para implementar y modificar automatizaciones de TikTok mediante Playwright en este repositorio.

> Alcance: capa de browser automation únicamente. Las tools MCP concretas pertenecen a la capa MCP (`AGENTS.md` + `SDD.md`). Las reglas de engagement y testing tienen sus propias skills y NO se duplican aquí.

---

## 1. Responsabilidad

Esta skill define cómo usar correctamente, dentro de este proyecto:

Playwright · BrowserContext · sesiones persistentes · páginas · navegación · autenticación QR · hydration · selectores · waits · acciones de usuario · verificación de resultados · errores · timeouts · rate limits · cleanup.

La información debe basarse en la implementación actual del repositorio. Si una capacidad no está implementada, se indica explícitamente.

---

## 2. Arquitectura real

```
MCP Tool (server.ts, addTool + zod)
    ↓
Runtime (local-runtime.ts → LocalTikTokRuntime.start())
    ↓
TikTok Operation (tiktok-operations.ts: postVideo, followUser, likeVideo,
                  deleteVideo, updateProfile, updateAvatar, analyzePosts…)
    ↓
Browser/session helpers
    - social-runtime.ts   → launchLocalContext / openAuthenticatedSession
    - social-selectors.ts → resolveElement / waitForHydrated / axSnapshot
    - social-rate-limit.ts→ checkRateLimit / recordAction
    - media-fetch.ts      → fetchSsrfSafe
    - qr-relay.ts         → QrRelayClient (solo login)
    ↓
Playwright (chromium.launchPersistentContext)
    ↓
TikTok web / TikTok Studio
```

| Capa | Archivo | Funciones clave |
|---|---|---|
| MCP | `src/server.ts` | `addTool` (validación zod + captura de errores), esquemas por tool |
| Runtime | `src/runtime/local-runtime.ts` | `start()` crea job asíncrono; `common()` valida cuenta activa; `runConnect()` para login |
| Operaciones | `src/runtime/tiktok-operations.ts` | Una función exportada por operación; helpers compartidos |
| Sesión | `src/runtime/social-runtime.ts` | `launchLocalContext`, `openAuthenticatedSession`, `lockAccount`, `profileForCountry`, `blockHeavyResources`, `trackPendingRequests` |

---

## 3. Sesiones

- **Creación:** toda operación abre su propia sesión con `openAuthenticatedSession({ accountId, proxySessionId?, cookies, country?, headless?, loadMedia? })`. No hay sesión larga viviente entre operaciones: cada op lanza el navegador, trabaja y cierra.
- **Identificación de cuentas:** `account_id` local validado con `/^[a-zA-Z0-9._-]+$/` (schema zod `ACCOUNT_ID`). El runtime rechaza operar si la cuenta no existe o no está `active` (`common()` en `local-runtime.ts`).
- **Perfiles persistentes:** `chromium.launchPersistentContext(profileDir(accountId))` donde `profileDir = $TIKTOK_MCP_DATA_DIR/profiles/<id saneado>` (default `~/.tiktok-mcp/profiles/<id>`). Cookies y estado de sesión viven dentro del perfil del navegador; el código no las copia ni exporta.
- **Exclusión mutua:** `lockAccount(accountId)` serializa accesos con una cadena de promesas: nunca dos navegadores sobre el mismo perfil simultáneamente. El lock se libera en `close()`.
- **Páginas:** se reutiliza la primera página del contexto (`ctx.pages()[0]`) o se crea una nueva. Sobre esa página se instalan tracking de requests pendientes y bloqueo de recursos.
- **Huella por país:** `profileForCountry(country)` fija locale + timezoneId (19 países mapeados). Alinea la sesión con la región esperada de la cuenta.
- **Headless:** headed por defecto en escritorio; `TIKTOK_HEADLESS=true/false`; en Linux sin DISPLAY se levanta Xvfb automáticamente para permitir navegador headed.
- **Cierre:** siempre `await close()` en un bloque `finally`. `close()` es idempotente (guard `closed`), cierra el contexto, mata el proceso Xvfb si existió y libera el lock de la cuenta.
- **Detección de expiración:** la operación recibe del endpoint interno un mapeo a `SESSION_EXPIRED` (HTTP 401/403 o código interno 8); el runtime marca la cuenta `logged_out` automáticamente.

---

## 4. Autenticación

Mecanismo único implementado: **login por QR** (`tiktok_connect`).

1. `QrRelayClient.create()` obtiene una sesión efímera del relay (`connect_url` público + `writer` privado). HTTPS obligatorio salvo localhost.
2. Se lanza un navegador **headed** hacia `https://www.tiktok.com/login/qrcode`.
3. El QR se extrae del canvas (`[data-e2e="qr-code"] canvas`, fallback: screenshot del elemento) y se retransmite al relay cada vez que cambia (polling cada 2 s hasta el deadline, default 300 s, máx 900 s).
4. El humano escanea desde el link compartido.
5. **Autenticación confirmada únicamente cuando** existe la cookie `sessionid` con valor > 10 caracteres sobre `https://www.tiktok.com`. Nunca por estado visual.
6. También se detecta texto de rechazo en la página ("couldn't log in", "too many attempts", etc.) → fallo inmediato con `LOGIN_FAILED`.
7. Al confirmar: cuenta pasa a `active`, la operación queda `done`, se cierra el navegador.

**Si la sesión expira durante una operación:** la respuesta de TikTok se mapea a `SESSION_EXPIRED`, el runtime marca la cuenta `logged_out` (con el error en `last_error`) y el agente debe relanzar `tiktok_connect`.

No hay logout implementado ni login usuario/contraseña.

---

## 5. Hydration

Problema que resuelve (verificado en comentarios del código): navegar con `domcontentloaded` devuelve el shell antes de que el contenido real exista. Esperar sobre ese shell produce diagnósticos falsos ("selector rotado", "ya siguiendo", "ya borrado") sobre páginas que simplemente no terminaron de renderizar.

API: `waitForHydrated(page, probe, { timeoutMs?, pollMs? })` en `social-selectors.ts`.

- Usa `page.waitForFunction` con el predicado JS del probe; default 20 s de timeout, 250 ms de polling (las operaciones usan 30 s).
- Devuelve el valor resuelto del predicado (puede ser `'rows'` / `'empty'`, no solo boolean) o `null` en timeout. **Nunca lanza** y **nunca traga** el timeout silenciosamente: loguea y devuelve `null`.
- Un `null` significa **NOT_READY**: nada fue observado del objetivo. Es distinto de "observado y ausente" (`NOT_FOUND`). Los callers deben tratarlo así.

Probes existentes (`HYDRATION_PROBES`, no inventar otros):

| Probe | Verdadero cuando | Usado por |
|---|---|---|
| `profileActions` | Existe botón hoja cuyo texto es exactamente `Follow`/`Following`/`Friends`/`Requested` | `followUser` |
| `videoActions` | Existe `[data-e2e="like-icon"]`, `button[aria-label*="ike"]` o `[data-e2e="browse-like-icon"]` | `likeVideo` |
| `studioContent` | Filas reales (`a[href*="/video/"]`) presentes → `'rows'`; o shell del buscador presente sin filas tras dwell de 15 s → `'empty'` | `deleteVideo`, `analyzePosts` |

Regla: el dwell antes de declarar "empty" es deliberadamente generoso. Concluir vacío demasiado pronto registra historia falsa ("cuenta sin videos"). Un `null` jamás debe tratarse como cero posts.

---

## 6. Selectores

Implementación: `resolveElement(page, strategies, opts)` en `social-selectors.ts`.

```ts
interface SelectorStrategy {
  name: string;                 // etiqueta logueada: qué capa ganó
  build: (page: any) => any;    // construye un Locator
}
interface ResolveOptions {
  perStrategyMs?: number;       // budget por estrategia (default 4000)
  firstTimeoutMs?: number;      // budget extra SOLO para la primera (ej. uploads)
  state?: "visible" | "attached";
}
```

Comportamiento:

- **Ordenado, no en carrera:** prueba estrategias en orden de preferencia y devuelve la primera que alcanza `state` dentro de su budget. Una estrategia precisa nunca pierde contra una laxa que matchee el nodo equivocado.
- Devuelve `{ locator, strategy }` o `null`. Con `null`, el caller captura diagnósticos (`captureUiState`).
- Cada estrategia usa `.first()` internamente.
- En fallo total, `axSnapshot(page)` aplana el árbol de accesibilidad a pares `{role, name}` de nodos interactivos para adjuntarlo al error.

Capas reales usadas en el proyecto, en orden típico de prioridad:

1. **`data-e2e`** — primero cuando existe y es válido (`[data-e2e="follow-button"]`, `[data-e2e="upload-editor-caption"]`, `[data-e2e="post_video_button"]`, `[data-e2e="edit-profile-save"]`…). Rápido en el happy path, pero TikTok lo rota sin aviso.
2. **`aria-label`** — `[aria-label*="aption" i]`, `button[aria-label*="ike" i]`.
3. **Rol ARIA + nombre accesible** — `getByRole("button", { name: /^follow$/i })`, `getByRole("option", …)`, `getByRole("menuitem", …)`.
4. **Texto** — `getByText(/^Follow$/)`, `button:has-text("Post")`. Con exclusiones deliberadas: los selectores de Follow excluyen "Following" para nunca convertir follow en unfollow.
5. **Estructurales** — xpath/CSS de contenedores cuando no hay semántica mejor: fila ancestro vía `xpath=ancestor::*[.//button[contains(@class,"TUXButton")]][1]`, `input.TUXTextInputCore-input`, `.tiktok-timepicker-option-list`. Último recurso: son los más frágiles.

Cómo agregar un selector nuevo:

1. Busca primero un `data-e2e` estable en la página viva.
2. Define al menos 3 estrategias: data-e2e → rol/nombre → texto (añade estructural solo si las anteriores pueden fallar legítimamente).
3. Nombra cada estrategia (`name:`) para poder diagnosticar cuál ganó en logs stderr.
4. Si el elemento puede tardar (upload), usa `firstTimeoutMs` alto solo en la primera estrategia.
5. Antes de interactuar con superficies auth-gateadas, agrega un probe de hidratación a `HYDRATION_PROBES` si no existe uno que cubra tu superficie.

Principio: preferir selectores resistentes a cambios visuales (semánticos) sobre CSS frágiles. Nunca hardcodear un selector único sin fallback.

---

## 7. Navegación

Patrón común de todas las operaciones:

- `page.goto(url, { waitUntil: "domcontentloaded", timeout })` — nunca `networkidle` (la SPA de TikTok mantiene conexiones).
- Timeouts de goto observados: 30–60 s según superficie (Studio upload 60 s; Studio content 45 s; perfiles/watch 45 s).
- Después del goto, SIEMPRE un gate de hidratación (sección 5) antes de leer o actuar.
- **Verificación de destino:** comprobar la URL real cuando importa. Ej.: el post exitoso redirige a `tiktokstudio/content` o `/posts`; el código lo verifica con `/tiktokstudio\/(content|posts)/i.test(page.url())` antes de usar esa evidencia.
- **Navegación a perfil propio** (`openEditProfileModal`): resuelve el username leyendo `href` de `a[data-e2e="nav-profile"]` y **polling hasta que el href contenga `/@<username>` real** (el href hidrata después de que el link aparece; navegar antes da 404). Fallback: click en el link de nav y esperar a la SPA.
- **Recuperación ante cargas flaky:** perfiles que renderizan "Something went wrong" → reload-and-retry acotado (ej. 3 intentos con espera) antes de fallar.
- **Redirects de post:** el redirect a Studio content tras publicar es en sí evidencia secundaria de éxito (sección 9).

---

## 8. Interacción

Secuencia obligatoria para cualquier acción: localizar (sección 6) → comprobar disponibilidad (hydration + visibilidad) → ejecutar → verificar (sección 9) → devolver estado claro (`TikTokOpResult`).

Acciones tal como las usa el código:

- **Click:** siempre con `timeout` explícito y `.catch(() => {})` solo cuando hay verificación posterior independiente (el resultado lo decide la verificación, no el click). Antes de clicks críticos, `dismissBlockingModal(page)` limpia overlays TUX/react-joyride que interceptan pointer events. Cuando un overlay real intercepta pero el handler React vive, el código usa click programático `el.click()` dentro de `page.evaluate` (patrón de `dismissBlockingModal` y del radio Schedule).
- **Fill / texto libre:** `locator.fill(value)` para inputs de formulario (nombre/bio del modal de edición). Para la caption del editor rich-text se usa `click()` + `Control+A` + `Delete` + `pressSequentially(text, { delay: 15 })` (simula tipeo; dispara los handlers del editor).
- **Upload de archivos:** `setInputFiles` directamente sobre el `<input type=file>` (visible u oculto) sin clickear el trigger visual — patrón usado tanto para el video como para el avatar.
- **Keyboard:** `Enter` para commit de campos; `Escape` para cerrar calendarios/dropdowns (OJO verificado: Escape revierte el time picker — ahí se hace blur cliqueando una label neutral); `Control+A`+`Delete` para reemplazar contenido.
- **Dropdowns complejos (privacidad, schedule):** abrir trigger → resolver opción con `resolveElement` → clickear → esperar detach de las options → **leer el valor mostrado de vuelta**. Si no coincide con lo pedido, abortar.
- **Scroll infinito:** patrón `loadAllPostRows`: scrollTo bottom → contar filas → parar tras 2 conteos estables consecutivos, con cap de scrolls (40) y flag `truncated` si se alcanza el cap. Parar con una sola ronda plana confunde fetch lento con fin de lista.

Nunca asumir que un click exitoso implica que TikTok procesó la operación.

---

## 9. Verificación

Jerarquía real usada en el proyecto, de más fuerte a más débil:

1. **Respuesta de la API interna** (ver sección 10): `submitAndAwaitTikTokApi` espera la respuesta del endpoint correspondiente y evalúa el envelope (`status_code === 0` = éxito). Es la evidencia primaria de post/follow/like.
2. **Read-back de valores escritos:** schedule (los inputs muestran exactamente la fecha/hora pedida, si no → abort), privacidad (el combobox muestra la audiencia elegida), display name (el título del perfil coincide tras reload), avatar (la URL de la imagen cambió respecto al snapshot previo).
3. **Cambio observable de estado UI específico:** flip del botón Follow a Following/Friends/Requested (fallback cuando no se vio API); desaparición de la fila del post **tras reload completo** (un detach puede venir de un re-sort, por eso delete recarga y re-confirma).
4. **Evidencia de flujo:** redirect verificado a `tiktokstudio/(content|posts)` o toast de éxito con regex acotada — solo como fallback cuando el XHR clásico no aparece.
5. **No-op legítimo:** Save deshabilitado porque los valores ya coinciden = éxito idempotente (documentado así en updateProfile).

Verificaciones débiles prohibidas: "no hubo excepción", "el click no lanzó", "la página cargó".

Regla crítica verificada en código (`findPostedVideo`): solo un match **por caption** prueba que ESE post aterrizó. El fallback "newest post" es una suposición inaceptable como evidencia de un post específico — si solo matchea "newest", el resultado se omite o se reporta como no determinado, nunca como URL del post nuevo.

---

## 10. Network / respuestas internas

- **Interceptor:** `submitAndAwaitTikTokApi(page, trigger, urlPattern, timeoutMs)` en `tiktok-operations.ts`. Registra `page.waitForResponse(pattern)` ANTES de ejecutar el trigger, luego evalúa status HTTP + JSON.
- **Envelope interno:** `status_code === 0` significa éxito; `status_msg`/`message` lleva el error humano. Este envelope no está oficialmente documentado por TikTok: los códigos se mapearon empíricamente (comentario del código: "approximate").
- **Operaciones que lo usan y patrones reales observados en el código:**
  - Post: `/aweme/v\d+/(web/)?aweme/post` (60 s) — también transporta creates programados.
  - Follow: `/aweme/v\d+/(web/)?commit/follow/user` o `/passport/web/user/follow` (20 s).
  - Like: `/commit/item/digg` o `/digg(/|\?|$)` case-insensitive (15 s).
- **Fallback cuando la respuesta no aparece:** cada operación tiene uno explícito (flip de botón, redirect/toast, read-back). Si tampoco hay fallback positivo, el resultado es `UI_TIMEOUT` con diagnósticos — jamás éxito.
- **Diagnóstico de red:** `trackPendingRequests` registra requests en vuelo (cap 300) y `pendingRequests(page)` lista los estancados; se incluyen en los diagnósticos de fallo para identificar qué fetch nunca volvió.
- **No inventar endpoints nuevos** sin observarlos en una sesión real. Los endpoints internos NO son APIs públicas ni estables.

---

## 11. Errores

Enum real (`error_code` en `TikTokOpResult`):

| Código | Significado | Causa probable | Reacción del agente |
|---|---|---|---|
| `SESSION_EXPIRED` | Cookie/sesión inválida (HTTP 401/403 o código interno 8) | Sesión caducada | NO reintentar; relanzar `tiktok_connect` (la cuenta ya quedó `logged_out`) |
| `RATE_LIMITED` | Límite impuesto por TikTok (429, flood interno ≥10000) | Demasiada actividad real detectada | Respetar `retry_after_ms` si viene; espaciar horas, no segundos |
| `RATE_LIMITED_PROTECTIVE` | Cap preventivo LOCAL (pre-navegador) | Se superó el ritmo seguro configurado | Esperar `retry_after_ms`; nunca bypass |
| `NOT_READY` | Página cargó, contenido necesario nunca se hidrató | Red lenta, shell vacío, cambio de UI | Reintentar UNA vez es razonable; si persiste, capturar diagnósticos y reportar. El estado del objetivo es DESCONOCIDO |
| `NOT_FOUND` | Contenido observado y objetivo ausente | Ya eliminado, otra página, target inválido | No reintentar ciegamente; verificar el dato |
| `INVALID_INPUT` | Validación fallida | URL malformada, tamaño, ventana de scheduling | Corregir input; no reintentar igual |
| `UPLOAD_FAILED` | Subida no llegó al editor | Video rechazado, codec, tamaño | Verificar el archivo; revisar `diag_screenshot` |
| `UI_TIMEOUT` | Elemento o confirmación nunca apareció | Selector rotado, flujo cambiado | Inspeccionar `interactive_elements`/`controls` del resultado; ajustar selectores si rotó |
| `LAUNCH_FAILED` | No abrió el navegador | Sin Chromium/browser instalado | Instalar browser (`npx playwright install chromium`) o fijar `TIKTOK_BROWSER_PATH` |
| `CAPTCHA_CHALLENGE` | TikTok exigió verificación (códigos 20000–29999) | Actividad sospechosa | Abortar; requiere intervención humana. NO hay resolución automática |
| `SCHEDULE_FAILED` | Scheduler nativo no aceptó fecha/hora | Widget rotado o calendario distinto | Abortado ANTES de publicar a propósito; revisar diagnósticos del widget |
| `UNKNOWN` | Error no clasificado | Excepción genérica | Leer `error` y diagnósticos; clasificar si es recurrente |

Los diagnósticos (`captureUiState`) llegan en `data`: `diag_screenshot` (ruta en `%TMP%/tiktok-mcp-shots`), `interactive_elements` (AX tree), `controls` (volcado data-e2e/aria/texto) y `pending` (requests estancados).

---

## 12. Timeouts

Valores reales en el código (reutilizar, no reinventar):

| Contexto | Valor |
|---|---|
| `goto` | 30–60 s según superficie (upload 60 s, Studio/perfiles 45 s, content manager delete/analytics 30–45 s) |
| `resolveElement` por estrategia | 4 s default; operaciones usan 5–8 s |
| Primera estrategia (caption editor tras upload) | `firstTimeoutMs: 90_000` |
| `waitForHydrated` | default 20 s; operaciones usan 30 s; polling 250 ms |
| Espera de respuesta API interna | 15 s (like), 20 s (follow), 60 s (post) |
| Login QR | 30–900 s configurable, default 300 s; polling 2 s |
| `dismissBlockingModal` | ventana 6–12 s, con condición de salida "2 checks consecutivos limpios" |
| Confirmaciones puntuales | 3–12 s según evidencia (toast 3 s, flip de botón 4 s, detach de fila 12 s) |

Distinción: **timeout de navegación** (goto — la página llegó o no) vs **timeout de interacción** (elemento/confirmación — la página llegó pero algo no apareció). El segundo casi siempre requiere diagnósticos adjuntos. No existen retries automáticos de operaciones completas: los reintentos decidenlos el agente, con backoff, y nunca para posts ambiguos sin pasar por el oráculo `checkPostedByCaption` (que solo acepta match por caption como prueba).

---

## 13. Rate limiting

- **Dónde:** `social-rate-limit.ts`; se consulta en `gate(accountId, operation)` AL INICIO de cada operación, **antes de lanzar el navegador**.
- **Qué protege:** separación mínima de 30 s entre dos acciones cualesquiera de la misma cuenta; ventanas de volumen: `post` máx 3/día, `follow` máx 20/hora, `like` máx 60/hora.
- **Cuándo se registra:** `recordAction` SOLO después de que la operación confirmó éxito. Una operación fallida no consume cupo.
- **Al alcanzar un límite:** la operación falla con `RATE_LIMITED_PROTECTIVE` + `retry_after_ms`, sin tocar el navegador. Historial podado a 48 h en `state.json`.
- **Cuándo detener una operación:** ante cualquier `RATE_LIMITED` (de TikTok o local) detener la secuencia completa de acciones de esa cuenta; no encadenar más intentos.
- **Reintentos peligrosos prohibidos:** no reintentar un post cuya confirmación fue ambigua (usar `checkPostedByCaption`); no reintentar follows/likes en loop ante `CAPTCHA_CHALLENGE`; no rodear el gate local saltándose `gate()` en operaciones nuevas.

---

## 14. Cleanup

Patrón obligatorio de toda operación (copiarlo tal cual):

```ts
try {
  // … trabajo …
} catch (e) {
  return { success: false, /* … */ };
} finally {
  video?.cleanup();   // borra archivos temporales materializados
  await close();      // cierra ctx, mata Xvfb, libera el lock de cuenta
}
```

- **Pages/context:** `close()` del `LocalContext` es idempotente y siempre cierra el `BrowserContext` persistente. Nunca dejar contextos abiertos: bloquean el perfil vía el lock.
- **Browser instances:** con `launchPersistentContext` el contexto ES el dueño; cerrarlo basta.
- **Listeners/routing:** viven en la página y mueren con el contexto; no instalar listeners globales fuera del ciclo de vida de la sesión.
- **Archivos temporales:** media materializada en `%TMP%/tiktok-mcp-uploads` con `cleanup()` en `finally`; screenshots de diagnóstico en `%TMP%/tiktok-mcp-shots` (best-effort).
- **Procesos huérfanos:** Xvfb se mata en `close()` incluso si el launch falló (verificar el manejo de errores de `launchLocalContext`).

---

## 15. Adding a New Browser Operation

Procedimiento concreto:

1. **Buscar una operación similar existente** en `tiktok-operations.ts` (¿es lectura o acción? ¿página pública o Studio?). Copiar su estructura, no escribir desde cero.
2. **Reutilizar helpers:** `gate()`, `materializeVideo/materializeImage` (si hay archivos), `openAuthenticatedSession`, `waitForHydrated` + probe, `resolveElement`, `dismissBlockingModal`, `submitAndAwaitTikTokApi` (si hay endpoint interno), `captureUiState`, `mapTikTokError`.
3. 3. **Crear la operación en la capa correcta:**
   implementar la operación en la capa de operaciones siguiendo la estructura
   modular existente del repositorio.

   Actualmente las operaciones están implementadas en
   `src/runtime/tiktok-operations.ts`, pero esta skill NO debe asumir que
   todas las futuras operaciones permanecerán necesariamente en ese archivo.

   Respetar la organización modular existente y reutilizar los tipos,
   helpers y patrones establecidos por el proyecto.
4. **Selectores:** definir array ordenado de estrategias ,Usa múltiples estrategias de fallback cuando sea técnicamente justificable. Nada de selectores únicos hardcodeados.
5. **Hydration:** usar un probe existente de `HYDRATION_PROBES` o agregar uno nuevo allí (nunca un `waitForTimeout` suelto como gate de readiness). Tratar `null` como `NOT_READY`.
6. **Ejecutar la acción** con timeouts explícitos y limpieza previa de modales.
7. **Verificar el resultado** con la jerarquía de la sección 9. Definir el fallback ANTES de escribir el happy path.
8. **Manejar errores:** devolver `TikTokOpResult` con `error_code` del enum; adjuntar `captureUiState` en fallos de UI. Nunca lanzar excepciones hacia arriba desde la operación.
9. **Rate limiting:** llamar `gate()` al inicio y `recordAction()` solo tras confirmación. Decidir si la operación necesita ventana de volumen propia.
10. **Limpiar recursos:** `finally` con cleanup de media y `close()`.
11. **Tests unitarios** de lógica pura extraíble (como `loadAllPostRows` se separó de `analyzePosts` para poder testearla) + actualizar el test de conteo de tools si corresponde. La validación final contra TikTok real es manual y se documenta aparte.
12. **Integrar con el runtime:** método en `LocalTikTokRuntime` usando `this.start(...)` (job asíncrono con polling) o método directo si es lectura local pura.
13. **Integrar con MCP:** registrar la tool en `server.ts` con schema zod completo, descripción precisa y cross-validation (`requireOne` cuando aplique).
14. **Actualizar `SDD.md`** (tools, matriz de capacidades, Decision Log si hubo decisión arquitectónica) y `README.md`.

---

## 16. Reglas de seguridad

Nunca:

- guardar credenciales en código;
- imprimir cookies, tokens o valores base64 en logs (el runtime ya redacta `*_base64` al persistir inputs — mantener ese patrón);
- commitear perfiles de navegador, `state.json` o screenshots de diagnóstico;
- exponer datos sensibles de la cuenta en mensajes de error;
- copiar sesiones reales al repositorio;
- ejecutar acciones destructivas (delete, posts reales) sobre cuentas reales durante tests automatizados sin autorización explícita.

El fetch de media externa DEBE pasar por `fetchSsrfSafe` (bloquea private networks, credenciales en URL, redirects ilimitados, oversize).

---

## 17. Principios para el agente

- Inspeccionar primero; reutilizar antes de duplicar.
- Verificar antes de afirmar éxito.
- No inventar selectores ni endpoints: todo selector nuevo sale de observar la página viva.
- No asumir que el DOM de TikTok es estable: rota `data-e2e` y clases sin aviso.
- No asumir que una operación UI siempre funciona: diseñar el camino de fallo junto al feliz.
- Manejar explícitamente estados intermedios: `NOT_READY` ≠ vacío ≠ ausente.
- Mantener cambios pequeños y no romper las operaciones existentes.

---

## 18. Limitaciones

| Ámbito | Limitación real |
|---|---|
| Browser automation | Una sesión por cuenta a la vez; requiere Chrome-family o Chromium; login necesita navegador headed (+Xvfb en VPS Linux); lentitud inherente (navegador por operación) |
| API oficial | Ninguna integrada hoy |
| Endpoints internos | No contractuales, no documentados, pueden rotar; el envelope `status_code` se mapeó empíricamente |
| UI de TikTok | Rotación frecuente de selectores; modales promocionales; captchas posibles sin resolución automática; cooldown de nickname (~1/semana) |
| Sesiones persistentes | Viven en el filesystem local (proteger el data dir); expiración detectable solo al operar |
| Rate limits | Locales conservadores (post 3/día, follow 20/h, like 60/h); los de TikTok son opacos y solo detectables por respuesta |

---

## 19. Relación con otras skills

```
tiktok-engagement ──utiliza──► tiktok-browser ◄──utiliza── tiktok-testing
```

Esta skill es la base. Las reglas específicas de engagement (ritmos, límites por plataforma, buenas prácticas de interacción) viven en `tiktok-engagement`; las estrategias de pruebas (unitarias vs manuales contra TikTok real) viven en `tiktok-testing`. No duplicarlas aquí.
