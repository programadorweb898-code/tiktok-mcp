# SDD.md — Especificación de diseño y arquitectura

Este documento es la especificación técnica y arquitectónica viva del proyecto TikTok MCP. Representa el estado **REAL** del sistema verificado contra el código fuente. Nunca documentar como implementada una capacidad que solamente esté planificada.

- Las reglas globales de desarrollo viven en [`AGENTS.md`](./AGENTS.md).
- El conocimiento especializado de operación vive en [`SKILL.md`](./SKILL.md).
- Este documento contiene la arquitectura, las decisiones y el mapa de capacidades.

---

## 1. Objetivo del proyecto

MCP local y self-hosted para automatizar TikTok mediante un agente. El objetivo es maximizar las capacidades que el agente puede realizar sobre una cuenta de TikTok, aproximándose lo máximo posible a las acciones de un usuario real.

El sistema combina: MCP (stdio), Playwright con perfiles de navegador persistentes, sesiones locales, operaciones verificadas mediante intercepción de las APIs internas de TikTok, y análisis calculados localmente. Evita depender innecesariamente de servicios SaaS externos.

### Dependencias externas actuales

| Dependencia | Tipo | Rol |
|---|---|---|
| `@modelcontextprotocol/sdk` ^1.29 | npm | Servidor MCP sobre stdio |
| `playwright` ^1.59 | npm | Automatización del navegador |
| `ffmpeg-static` (agregada) | npm | Binario estático de ffmpeg (6.1.1) para fusión local de media (`tiktok_mix_media`); no requiere instalación externa |
| `zod` ^3.25 | npm | Validación de parámetros de tools |
| Relay QR (`tiktok.palmyr.ai`, configurable vía `TIKTOK_CONNECT_RELAY_URL`) | servicio externo efímero | Único servicio externo: entrega del QR al humano durante el login. No almacena credenciales; solo retransmite la imagen del QR. HTTPS obligatorio salvo localhost |

**No se usa ninguna API oficial de TikTok en el código actual.** Todas las capacidades implementadas son browser automation.

---

## 2. Principios arquitectónicos

1. API oficial antes que browser automation cuando la API oficial proporcione correctamente la capacidad necesaria (hoy: ninguna capacidad usa API oficial).
2. Browser automation cuando la API oficial no exponga la capacidad requerida.
3. Self-hosted como prioridad: perfiles, sesiones, media y analíticas permanecen en el dispositivo.
4. Modularidad y separación de responsabilidades.
5. Reutilización de la arquitectura existente; no crear una segunda arquitectura paralela.
6. Verificación de cada operación: nunca asumir éxito porque Playwright ejecutó un click.
7. Manejo explícito de errores con códigos tipados.
8. Rate limiting protector antes de abrir el navegador.
9. Seguridad de sesiones y credenciales.
10. No duplicar lógica ni introducir dependencias innecesarias.
11. Toda capacidad nueva debe poder exponerse como tool MCP clara y estructurada.
12. Distinguir siempre "no observado" ("NOT_READY") de "observado y ausente" ("NOT_FOUND").

---

## 3. Arquitectura real

```
Agente MCP (Claude Code, Codex, Hermes, …)
        ↓  stdio (JSON-RPC)
src/server.ts            — definición y validación de las 35 tools MCP
        ↓
LocalTikTokRuntime       — src/runtime/local-runtime.ts
        ↓                (operaciones asíncronas + registro de jobs)
TikTok Operations        — src/runtime/tiktok-operations.ts
        ↓                (postVideo, followUser, likeVideo, deleteVideo,
                          updateProfile, updateAvatar, analyzePosts…)
Browser / APIs internas  — social-runtime.ts (Playwright),
                          social-selectors.ts, media-fetch.ts,
                          social-rate-limit.ts, qr-relay.ts,
                          op-validators.ts (validación de input y mapeo de errores)
        ↓
TikTok (web + TikTok Studio)
```

### Componentes por archivo

| Archivo | Responsabilidad |
|---|---|
| `src/index.ts` | Entrypoint binario (`tiktok-mcp`). Flags: `--data-dir`, `--browser-path`, `--headless`. Transporte stdio. |
| `src/server.ts` | Registro de las 35 tools con esquemas zod, wrapper `addTool` con captura de errores y devolución estructurada (`structuredContent` + texto JSON). |
| `src/runtime/local-runtime.ts` | Orquestador. Crea operaciones asíncronas (`pending → running → done/failed/cancelled`), gestiona el flujo de conexión QR, delega en las operaciones. |
| `src/runtime/tiktok-operations.ts` | Implementación real de cada operación contra TikTok: subida de video, follow, like, delete, perfil, avatar, scraping de analíticas. Incluye helpers de diagnóstico, modales, privacidad, scheduling nativo e interceptor de respuestas API. |
| `src/runtime/media-mix.ts` | Fusión local de media con `ffmpeg-static` (binario incluido): reemplaza o superpone una pista de audio sobre un video y produce un MP4 listo para `tiktok_post`. |
| `src/runtime/media-quiz.ts` | Generación local de videos de trivia: quema una pregunta y sus opciones como overlays de texto (`drawtext`) sobre un video, en un workdir dedicado para evitar el conflicto de rutas Windows (`:`) con el filtergraph. Produce un MP4 listo para `tiktok_post`. |
| `src/runtime/media-duet.ts` | Composición local de duet/stitch: arma un video de pantalla dividida (duet) o un clip inicial del video ajeno seguido del propio (stitch) con ffmpeg. Detecta si cada clip tiene audio y lo mezcla/concatena (o usa silencio). Produce un MP4 listo para `tiktok_post`. |
| `src/runtime/social-runtime.ts` | Lanzamiento de Chromium (`launchPersistentContext`) por cuenta, perfiles de país (locale + timezone, 19 países), lock por cuenta, detección de navegador instalado, Xvfb en Linux sin DISPLAY, bloqueo de telemetría/media pesada, tracking de requests pendientes. |
| `src/runtime/social-selectors.ts` | Resolución resiliente de elementos (`resolveElement`), probes de hidratación (`waitForHydrated`, `HYDRATION_PROBES`), snapshot de accesibilidad (`axSnapshot`). |
| `src/runtime/op-validators.ts` | Validadores puros y sin efectos (normalización/validación de handles y video permaLinks, mapeo de códigos de error de TikTok al enum `OpErrorCode`). Separados de las operaciones para poder testearlos sin Chromium. |
| `src/runtime/social-rate-limit.ts` | Rate limiting protector local. |
| `src/runtime/store.ts` | Persistencia local atómica en `~/.tiktok-mcp/state.json`: cuentas, operaciones, métricas, acciones. Perfiles de navegador en `profiles/<account_id>`. |
| `src/runtime/qr-relay.ts` | Cliente del relay QR efímero para el login remoto. |
| `src/runtime/schedule-time.ts` | Matemática pura de zonas horarias para el scheduler nativo. |
| `src/runtime/media-fetch.ts` | Fetch de media con protección SSRF y límites de tamaño. |
| `src/runtime/tiktok-metrics.ts` | Almacenamiento y cálculo de métricas locales (series, crecimiento, fecha de publicación desde el id Snowflake). |
| `src/runtime/tiktok-hooks.ts` | Análisis heurístico local de hooks de captions. |
| `src/runtime/tiktok-niches.ts` | Lista estática de 24 nichos para el análisis de hooks. |
| `src/runtime/tiktok-accounts.ts` | Helper de listado de cuentas por owner/tag (hoy delega en `store.listAccounts`). |
| `src/tests/local.test.ts` | Tests con `node:test`. |
| `src/tests/op-validators.test.ts` | Tests unitarios de los validadores puros (`normalizeHandle`, `isValidHandle`, `isValidVideoPermalink`, `mapTikTokError`). Sin navegador. |
| `src/tests/social-selectors.test.ts` | Tests unitarios de la capa de estabilización (`resolveElement`, `waitForHydrated`, `axSnapshot`) con page mock, sin Chromium. |

### Modelo de ejecución

Las tools de acción (`post`, `follow`, `like`, `comment`, `delete`, `profile`, `avatar`, `analytics`, `cancel_scheduled`) son **asíncronas**: devuelven inmediatamente `{ operation_id, status: "pending", poll_with: "tiktok_operation_status" }` y el agente consulta el resultado con `tiktok_operation_status`. Las tools de lectura (`accounts`, `series`, `hooks`, `niches`, `scheduled`, `connect_status`, `comments`) son síncronas: `comments` abre el navegador autenticado, scrapea y devuelve los datos directo (no pasa por un job). `tiktok_mix_media` es síncrona y de procesamiento local (no abre navegador): devuelve el MP4 fusionado.

Solo puede haber **una sesión de navegador abierta por cuenta a la vez**: `lockAccount()` serializa los accesos al perfil persistente.

---

## 4. Capacidades actuales (tools MCP)

Verificado contra `src/server.ts`. El servidor expone exactamente 35 tools (el test lo afirma).

| Tool | Propósito | Parámetros principales | Implementación | Browser/API | Estado | Limitaciones conocidas |
|---|---|---|---|---|---|---|
| `tiktok_connect` | Login por QR compartible | `account_id`, `country?`, `tag?`, `browser_path?`, `timeout_seconds?` | Relay QR + Chromium headed a `/login/qrcode`; autenticación detectada por cookie `sessionid` | Browser | IMPLEMENTADO | Puede ser rechazado si el exit IP del navegador y el teléfono están lejos geográficamente; requiere humano que escanee |
| `tiktok_connect_status` | Estado del login | `token` | Lectura del registro de operaciones | — | IMPLEMENTADO | Solo refleja lo registrado localmente |
| `tiktok_accounts` | Listar cuentas locales y su estado | `tag?` | Lectura de `state.json` | — | IMPLEMENTADO | El estado depende de detección local (puede quedar desactualizado respecto a TikTok) |
| `tiktok_post` | Publicar o programar video | `account_id`, `caption` (1–2200 en schema; 1–4000 en la op), `video_path/video_url/video_base64` (exactamente uno), `privacy?`, `allow_comments/duet/stitch?`, `schedule_at?` | Subida en TikTok Studio; intercepta `/aweme/v*/(web/)?aweme/post`; confirmación alternativa por redirect/toast; verificación de privacidad y fecha programada con read-back | Browser + intercepción API interna | IMPLEMENTADO | Máx ~100 MB; solo MP4; `schedule_at` entre ~15 min y ~10 días; sin confirmación de API cae en heurísticas de redirect/toast |
| `tiktok_mix_media` | Fusionar un video con una pista de audio separada | `video_path/video_url/video_base64` (exactamente uno), `audio_path/audio_url/audio_base64` (exactamente uno), `mix?` | `media-mix.ts` con `ffmpeg-static`: reemplazo (default) o superposición (`mix:true`) de audio; produce un MP4 | Local (ffmpeg) | IMPLEMENTADO | No toca TikTok ni el navegador; devuelve `output_path` para alimentar `tiktok_post`; video ≤100 MB, audio ≤50 MB |
| `tiktok_make_quiz` | Generar un video de trivia/quiz | `video_path/video_url/video_base64` (exactamente uno), `question` (1-140), `options` (2-4, ≤60 c/u), `font?` | `media-quiz.ts` con `drawtext`: quema pregunta + opciones (A/B/C/D) sobre el video; workdir dedicado para rutas relativas | Local (ffmpeg) | IMPLEMENTADO | Quiz visual no interactivo (los creadores usan este formato; el quiz interactivo nativo solo existe en la app móvil); requiere fuente TTF; devuelve `output_path` |
| `tiktok_make_duet` | Componer un video duet o stitch | `base_video_*` (exactamente uno), `your_video_*` (exactamente uno), `mode?` (`duet`/`stitch`), `stitch_seconds?` | `media-duet.ts` con ffmpeg: duet = pantalla dividida side-by-side; stitch = `stitch_seconds`s del video ajeno seguidos del propio; detecta audio por clip y mezcla/concatena o usa silencio | Local (ffmpeg) | IMPLEMENTADO | El editor nativo de Duet/Stitch es solo app móvil; acá se compone el MP4 equivalente que suben los creadores de PC; devuelve `output_path` |
| `tiktok_operation_status` | Consultar job asíncrono | `operation_id` | Lectura del registro de operaciones | — | IMPLEMENTADO | Los registros se podan a 2.000 operaciones |
| `tiktok_follow` | Seguir usuario | `account_id`, `target_user` | Perfil público; probe de hidratación de acciones; intercepta `commit/follow/user` o `passport/web/user/follow`; fallback: flip del botón; "ya siguiendo" es éxito legítimo | Browser + intercepción API interna | IMPLEMENTADO | Perfiles privados/restringidos pueden no exponer control |
| `tiktok_unfollow` | Dejar de seguir usuario | `account_id`, `target_user` | Perfil público; probe de hidratación de acciones; resuelve el botón SOLO en estado Following/Friends/Requested (invierte la exclusión de follow para nunca click-to-follow); confirma el diálogo "Unfollow?" si aparece; intercepta `commit/follow/user` o `passport/web/user/follow`; verifica por read-back el flip del botón de vuelta a Follow; "ya no siguiendo" es no-op exitoso | Browser + intercepción API interna + read-back | IMPLEMENTADO (v1; requiere validación manual) | Perfiles privados/restringidos pueden no exponer control; el DOM del perfil no se pudo inspeccionar en desarrollo → selectores resilientes + validación manual |
| `tiktok_like` | Dar like a un video | `account_id`, `video_url` | Página watch; probe de hidratación del rail; lee `aria-pressed` (si ya está likeado → no-op, nunca togglea al revés); intercepta `commit/item/digg`; verifica por read-back que `aria-pressed` quedó en true | Browser + intercepción API interna + read-back | IMPLEMENTADO | Requiere permalink `/video/<id>`; idempotente desde DEC-017 |
| `tiktok_unlike` | Quitar like de un video | `account_id`, `video_url` | Página watch; probe de hidratación del rail; lee `aria-pressed` del botón de like (si no está likeado → no-op); intercepta `commit/item/digg`; verifica por read-back que `aria-pressed` quedó en false | Browser + intercepción API interna + read-back | IMPLEMENTADO (v1; requiere validación manual) | Requiere permalink `/video/<id>`; el estado se lee del `aria-pressed` del botón (si TikTok rota ese atributo hay que revalidar); el DOM del watch page no se pudo inspeccionar en desarrollo |
| `tiktok_comment` | Comentar en el video de otro usuario | `account_id`, `video_url`, `comment` (1-2200) | Visita el permalink `/video/<id>`; espera el rail de engagement hidratado; resuelve el campo de comentario (data-e2e → placeholder → editor) y abre el rail vía el icono de comentarios si es lazy; escribe y envía con Enter; verifica por read-back (el campo se vacía Y el texto aparece publicado) | Browser | IMPLEMENTADO (v1; requiere validación manual) | El DOM del watch page no se pudo inspeccionar en desarrollo → selectores resilientes + read-back; nunca reporta éxito sin observar el comentario publicado (si queda dudoso devuelve `UI_TIMEOUT` y pide verificar antes de reenviar) |
| `tiktok_comments` | Leer comentarios de los propios videos | `account_id`, `video_id?`, `limit?` | Navega a `/tiktokstudio/comment-management`, espera hidratación, carga la lista perezosa con scroll estable, scrapea texto visible + links a `/video/<id>` (scrape defensivo, nunca fabrica); filtra por `video_id` si se pide | Browser (síncrona, solo lectura) | IMPLEMENTADO (v1; requiere validación manual) | El DOM de comment-management no se pudo inspeccionar en desarrollo → scrape estructural por texto/links; leer es una operación READ (no sujeta al cap protector); validación final manual contra cuenta con comentarios |
| `tiktok_delete_comment` | Eliminar un comentario propio | `account_id`, `comment_text` | Navega a `/tiktokstudio/comment-management`; ubica la fila del comentario por texto (misma resolución 3-tier que reply); abre el menú "…" de la fila → Delete; confirma el diálogo si aparece; verifica por read-back que el texto del comentario desaparece | Browser + read-back | IMPLEMENTADO (v1; requiere validación manual) | El DOM de comment-management no se pudo inspeccionar en desarrollo → selectores resilientes + read-back; comparte el bucket de rate limit "comment" (20/hora) |
| `tiktok_delete` | Eliminar video propio | `account_id`, `video_url` | Studio content manager; menú "…" → Delete → confirmar; verificación por reload (la fila ya no existe) | Browser | IMPLEMENTADO | Si el post está en otra página del listado puede reportarse `NOT_FOUND` |
| `tiktok_update_profile` | Actualizar nombre/bio | `account_id`, `display_name?`, `bio?` | Modal "Edit profile"; Save deshabilitado = no-op exitoso; read-back del título para detectar rechazo silencioso de nickname (cooldown semanal) | Browser | IMPLEMENTADO | Cambio de nickname limitado por TikTok (~1 vez/semana) |
| `tiktok_update_avatar` | Actualizar foto de perfil | `account_id`, `image_path/image_url/image_base64` (exactamente uno) | Modal "Edit profile" + input file + diálogo de crop; verificación: URL del avatar cambia tras reload | Browser | IMPLEMENTADO | Imágenes ≤10 MB; png/jpeg/webp |
| `tiktok_analytics` | Scrapear métricas de posts | `account_id` | Studio content manager con scroll completo (`loadAllPostRows`), parseo K/M/B, `posted_at` derivado del id; guarda muestra local | Browser | IMPLEMENTADO | Solo views/likes/comments/caption/privacidad visibles en el listado; puede reportarse `truncated` si se alcanza el cap de scrolls |
| `tiktok_monetization_status` | Leer estado de monetización | `account_id` | Navega a `/tiktokstudio/monetization`, scrapeo defensivo por texto visible + pares etiqueta/valor (sin selectores frágiles) | Browser | IMPLEMENTADO (v1; requiere validación manual con cuenta apta) | El enrolamiento exige elegibilidad estricta (10k+ followers, 100k vistas/30d, cuenta 30+ días, 18+); la cuenta actual no califica. El DOM de monetización no pudo inspeccionarse en el entorno de desarrollo: debe validarse contra una cuenta real apta |
| `tiktok_comment_reply` | Responder un comentario | `account_id`, `comment_text`, `reply` | Navega a `/tiktokstudio/comment-management`, localiza el comentario por su texto (selectores multi-nivel), abre el editor de respuesta, escribe y envía; verificación por read-back del texto publicado | Browser | IMPLEMENTADO (v1; requiere validación manual con cuenta con comentarios) | Como el DOM de comment-management no pudo inspeccionarse (necesita sesión con comentarios), usa selectores resilientes (texto → role/aria → estructural) y verifica por read-back; nunca reporta éxito sin observar la respuesta publicada |
| `tiktok_pin_video` | Fijar/destrabar video en el perfil | `account_id`, `video_url`, `action` (`pin`/`unpin`) | Abre el video propio, usa su menú de acciones ("Pin to profile"/"Unpin"), y verifica navegando de vuelta al perfil por el badge "Pinned" del tile (read-back observable) | Browser | IMPLEMENTADO (v1; requiere validación manual) | Límite de TikTok: hasta 3 videos fijados. El DOM del menú de acciones no se inspeccionó en desarrollo → selectores resilientes (role/aria → texto) + verificación por perfil; nunca reporta éxito sin confirmar el estado (o ya-estaba-en-estado deseado) |
| `tiktok_playlist_manage` | Crear / añadir / quitar post de playlist | `account_id`, `action` (`create`/`add`/`remove`), `name`, `video_url?` (add/remove) | `create`: perfil propio → "Manage playlists" → "Create playlist" → nombre → confirmar, verificado por read-back del nombre. `add`/`remove`: menú del video → "Add to playlist"/"Remove from playlist" → elegir playlist, verificado por read-back | Browser | IMPLEMENTADO (v1; requiere validación manual) | Solo disponible con 10k+ seguidores (elegibilidad de TikTok); la cuenta actual no califica → DOM no inspeccionado, selectores resilientes + read-back. Un post público solo puede estar en UNA playlist. Si no aparece "Create playlist", devuelve `NOT_READY` (no fabrica disponibilidad) |
| `tiktok_search` | Buscar videos/usuarios/hashtags | `query`, `type?` (`video`/`user`/`hashtag`), `account_id?`, `limit?` | Navega a `/search/<type>?q=...` (anónimo o con la sesión de la cuenta), espera links de resultado reales, extrae links + snippet visible; scrape defensivo, nunca fabrica. Lista vacía = observado sin resultados | Browser (anónimo o auth) | IMPLEMENTADO (v1; requiere validación manual) | Búsqueda pública; sin canonicalizar el orden ni puntuar. El DOM de resultados no se inspeccionó en desarrollo → se lee por links reales + texto visible; si no renderiza, `NOT_READY` (o lista vacía si el estado vacío es observable) |
| `tiktok_sounds` | Leer sounds en Discover | `account_id?`, `country?`, `limit?` | Navega a `/discover`, espera links `/music/<id>` reales, extrae sound_id + URL + snippet visible + count de videos (best-effort); scrape defensivo, nunca fabrica un ranking | Browser (anónimo o auth) | IMPLEMENTADO (v1; requiere validación manual) | Solo lo observado; el DOM de Discover no se inspeccionó en desarrollo → se lee por links reales a `/music/<id>`; si no renderiza, `NOT_READY` (o lista vacía si la página mostró texto de music/sound) |
| `tiktok_trending_topics` | Leer topics/hashtags en tendencia desde Discover | `account_id?`, `country?`, `limit?` | Navega a `/discover`, espera links `/tag/<slug>` reales, extrae hashtag + URL + snippet visible + count de posts (best-effort); scrape defensivo, nunca fabrica un ranking | Browser (anónimo o auth) | IMPLEMENTADO (v1; requiere validación manual) | Solo lo observado; el DOM de Discover no se inspeccionó en desarrollo → se lee por links reales a `/tag/<slug>`; si no renderiza, `NOT_READY` (o lista vacía si la página mostró texto de trending/#) |
| `tiktok_trending_creators` | Leer creadores en tendencia desde Discover | `account_id?`, `country?`, `limit?` | Navega a `/discover`, espera links `/@<handle>` reales, extrae handle + URL + snippet visible + count de seguidores (best-effort); scrape defensivo, nunca fabrica un ranking | Browser (anónimo o auth) | IMPLEMENTADO (v1; requiere validación manual) | Solo lo observado; el DOM de Discover no se inspeccionó en desarrollo → se lee por links reales a `/@<handle>`; si no renderiza, `NOT_READY` (o lista vacía si la página mostró texto de creator/@/followers) |
| `tiktok_series` | Leer historial local / crecimiento | `account_id`, `video_id?`, `hours?` | Cálculo puro sobre `state.json` | — (local) | IMPLEMENTADO | Solo tiene datos de muestras previas de `tiktok_analytics` |
| `tiktok_hooks` | Analizar aperturas de captions | `account_id?`, `tag/niche?`, `caption?`, `maturity_days?`, `recency_days?` | Heurística local (10 patrones regex) sobre métricas propias | — (local) | IMPLEMENTADO | Análisis estadístico local, NO datos de TikTok; requiere ≥3 posts por patrón para marcar confianza |
| `tiktok_niches` | Listar nichos sugeridos | — | Lista estática | — | IMPLEMENTADO | Taxonomía cerrada de 24 entradas |
| `tiktok_scheduled` | Listar posts programados | `account_id?`, `include_done?` | Derivado del registro local de operaciones `post` con `schedule_at` | — | IMPLEMENTADO | Refleja solo el registro local; cambios hechos directamente en TikTok Studio no son visibles (lo indica en la respuesta) |
| `tiktok_cancel_scheduled` | Cancelar post programado | `operation_id`, `account_id` | Ejecuta `deleteVideo` sobre el video retenido y marca `cancelled` | Browser | IMPLEMENTADO | Requiere que exista `video_url` registrada; si no, sugiere borrarlo manualmente en Studio |

---

## 5. Mapa de capacidades

Estados: `IMPLEMENTED` · `PARTIAL` · `PLANNED` · `RESEARCH` · `BLOCKED` · `NOT_SUPPORTED`

### Account

| Capacidad | Estado | Notas |
|---|---|---|
| login (QR) | IMPLEMENTED | `tiktok_connect` / `tiktok_connect_status` |
| logout | NOT_SUPPORTED | No hay implementación; solo marcado manual como `logged_out` ante `SESSION_EXPIRED` |
| profile (nombre/bio) | IMPLEMENTED | `tiktok_update_profile` |
| avatar | IMPLEMENTED | `tiktok_update_avatar` |
| settings | RESEARCH | Sin implementación ni investigación registrada |
| lista de followers | RESEARCH | — |
| lista de following | RESEARCH | — |
| notificaciones | RESEARCH | — |

### Publishing

| Capacidad | Estado | Notas |
|---|---|---|
| video | IMPLEMENTED | `tiktok_post` |
| photo (carrusel) | PLANNED | Fase 6 |
| draft | RESEARCH | — |
| scheduling | IMPLEMENTED | Scheduler nativo de TikTok Studio (sin worker local) |
| delete | IMPLEMENTED | `tiktok_delete` |
| edit | NOT_SUPPORTED | No hay edición de posts publicados |
| media mixing (video + audio) | IMPLEMENTED | `tiktok_mix_media` — pre-procesamiento local con `ffmpeg-static`; reemplazo o superposición de audio antes de `tiktok_post` |
| quiz / trivia visual | IMPLEMENTED | `tiktok_make_quiz` — quema pregunta + opciones sobre el video con `drawtext`; quiz visual (no interactivo). El quiz interactivo nativo (sticker "Quiz") solo existe en la app móvil, no en la web |
| duet / stitch | IMPLEMENTED (composición local) | `tiktok_make_duet` — arma el MP4 de duet (pantalla dividida) o stitch (clip inicial + continuación) con ffmpeg. El editor nativo de Duet/Stitch es solo app móvil; este crea el video equivalente que los creadores de PC suben |
| usar sonido de otro video | COVERED (bajo `tiktok_mix_media`) | El caso "usar el sonido de otro video" se cubre con `tiktok_mix_media` (`audio_url`/`audio_path`/`audio_base64` → reemplaza o superpone el audio localmente antes de `tiktok_post`). Límite documentado: no se baja el audio de un video TikTok ajeno por su `video_url` porque requiere intercepción de red de la sesión, que no está implementada ni se inventa; el flujo nativo de Studio ("Use sound") arranca grabación y no aplica a un MP4 pre-editado |
| playlists (crear / añadir / quitar post) | PARTIAL (v1) | `tiktok_playlist_manage` (`create`/`add`/`remove`) desde el perfil web; requiere 10k+ seguidores (elegibilidad). DOM no inspeccionado → selectores resilientes + read-back, validación manual pendiente |

### Engagement

| Capacidad | Estado | Notas |
|---|---|---|
| like | IMPLEMENTED | `tiktok_like` (idempotente desde DEC-017: lee `aria-pressed` y nunca togglea al revés) |
| unlike | PARTIAL (v1) | `tiktok_unlike` lee `aria-pressed` del botón antes de clickear (nunca togglea al revés), intercepta `commit/item/digg` y verifica por read-back que el like desapareció; validación manual pendiente |
| follow | IMPLEMENTED | `tiktok_follow` |
| unfollow | PARTIAL (v1) | `tiktok_unfollow` resuelve el botón solo en estado Following/Friends/Requested, confirma el diálogo si aparece, intercepta el endpoint de unfollow y verifica por read-back el flip de vuelta a Follow; if no-op cuando ya no se sigue; validación manual pendiente |
| comment | PARTIAL (v1) | `tiktok_comment` publica un comentario en el video de otro usuario (watch page), verificado por read-back. El DOM del watch page no se inspeccionó en desarrollo → selectores resilientes + validación manual pendiente |
| reply | PARTIAL (v1) | `tiktok_comment_reply` responde un comentario en Comment Management ubicándolo por texto; verifica por read-back; validación manual pendiente |
| delete comment | PARTIAL (v1) | `tiktok_delete_comment` elimina un comentario en Comment Management (menú "…" → Delete → confirmar → read-back de la ausencia del texto); validación manual pendiente |
| leer comentarios | PARTIAL (v1) | `tiktok_comments` lee los comentarios de los propios videos desde Comment Management (scrape defensivo por texto/links); validación manual pendiente |
| share | RESEARCH | — |
| save/favorite | RESEARCH | — |
| mensajería | RESEARCH | Superficie sensible; evaluar riesgo antes |

### Discovery

| Capacidad | Estado |
|---|---|
| búsqueda de videos | PARTIAL (v1) | `tiktok_search` (`type: video`) — lee resultados reales + links desde la búsqueda web |
| búsqueda de usuarios | PARTIAL (v1) | `tiktok_search` (`type: user`) — links reales + snippet |
| búsqueda de hashtags | PARTIAL (v1) | `tiktok_search` (`type: hashtag`) — links reales + snippet |
| contenido en tendencia | PARTIAL (v1) | `tiktok_trending_topics` lee topics/hashtags desde Discover (links reales a `/tag/<slug>` + snippet + count de posts best-effort); validación manual pendiente |
| explore / FYP | PARTIAL (v1) | `tiktok_trending` lee el feed For You (personalizado, no ranking global) |
| sounds | PARTIAL (v1) | `tiktok_sounds` lee sounds desde Discover (links reales a `/music/<id>` + snippet + count de videos best-effort); validación manual pendiente |
| creadores | PARTIAL (v1) | `tiktok_trending_creators` lee creadores desde Discover (links reales a `/@<handle>` + snippet + count de seguidores best-effort); validación manual pendiente |

Fase 3 del roadmap.

### Analytics

| Capacidad | Estado | Notas |
|---|---|---|
| métricas por video (views/likes/comments) | PARTIAL | Scrapeadas del Studio content manager; sin watch time, fuentes de tráfico ni retención |
| serie histórica local | IMPLEMENTED | Muestreo incremental en `tiktok_analytics`, lectura con `tiktok_series` |
| crecimiento por ventana | IMPLEMENTED | Cálculo local (`growthSince`) |
| hooks | IMPLEMENTED | Heurística local sobre historial propio |
| niches | IMPLEMENTED | Lista estática local |
| monetización (lectura de estado) | PARTIAL (v1) | `tiktok_monetization_status` lee `/tiktokstudio/monetization` de forma defensiva. El enrolamiento exige elegibilidad (10k+ followers); la cuenta actual no califica y el DOM no se inspeccionó en desarrollo → validación manual pendiente |
| responder comentarios | PARTIAL (v1) | `tiktok_comment_reply` responde desde el Comment Management web de Studio (`/tiktokstudio/comment-management`), localizando el comentario por su texto y verificando por read-back. El DOM no se pudo inspeccionar (requiere sesión con comentarios) → validación manual pendiente |
| fijar videos en el perfil | PARTIAL (v1) | `tiktok_pin_video` fija/desfija un video propio desde el menú de acciones del video y verifica por el badge "Pinned" en el perfil. Límite de 3 videos fijados. El DOM del menú no se inspeccionó → validación manual pendiente |
| analíticas de perfil (seguidores, totales) | PARTIAL (v1) | `tiktok_profile_analytics` lee el header del perfil propio (display name, @handle, bio, totales Following/Followers/Likes/Videos) vía el link del nav (no hace falta el handle); DOM no inspeccionado → scraping defensivo, validación manual pendiente |
| analíticas profundas de Studio (watch time, tráfico, retención) | PARTIAL (v1) | `tiktok_studio_analytics` lee `/tiktokstudio/analytics` de forma defensiva (pares label/valor visibles: Views, Watch time, Followers, Likes, etc.); solo reporta lo visible, `NOT_READY` si no renderiza; DOM no inspeccionado → validación manual pendiente |

### LIVE

| Capacidad | Estado |
|---|---|
| descubrir LIVE | RESEARCH |
| información de LIVE | RESEARCH |
| interacción en LIVE | RESEARCH |
| comentarios en LIVE | RESEARCH |

Fase 5 del roadmap.

---

## 6. Browser automation

**Por qué:** ninguna operación implementada está disponible en una API oficial accesible para este proyecto; toda la automatización se hace conduciendo la interfaz web de TikTok y TikTok Studio con Playwright (Chromium).

**Cómo funciona:**

- **Contexto persistente por cuenta:** `chromium.launchPersistentContext(dataDir/profiles/<account_id>)`. Las cookies y el estado de sesión los conserva el propio perfil del navegador entre ejecuciones; el proyecto no copia ni exporta cookies.
- **Login:** navegador headed hacia `https://www.tiktok.com/login/qrcode`. El QR se extrae del canvas (`[data-e2e="qr-code"]` o fallback a screenshot) y se retransmite por el relay mientras cambia. La autenticación se confirma únicamente cuando aparece la cookie `sessionid` con valor largo. Se detecta además texto de rechazo ("couldn't log in", "too many attempts", …).
- **Perfiles de país:** 19 países mapeados a locale + timezone IANA; alinean la huella del navegador con la región esperada de la cuenta.
- **Headed/headless:** headed por defecto en escritorio; headless con `TIKTOK_HEADLESS=true`; en Linux sin DISPLAY se levanta Xvfb automáticamente (login QR requiere navegador headed).
- **Detección de navegador:** busca Chrome/Edge/Brave instalados; configurable con `TIKTOK_BROWSER_PATH` o `TIKTOK_BROWSER_CHANNEL`.
- **Bloqueo de recursos:** se abortan dominios de telemetría (`mon.tiktokv.com`, logs) y, salvo `loadMedia`, imágenes/videos/fuentes (el avatar es la única op que carga media porque necesita los píxeles).
- **Waits e hidratación:** navegación con `domcontentloaded` + gates de hidratación (`waitForHydrated` con `HYDRATION_PROBES.profileActions`, `.videoActions`, `.studioContent`). Un timeout de probe devuelve `NOT_READY` (estado desconocido), nunca "vacío" o "ausente".
- **Selectores:** ver sección 7.
- **Verificación de acciones:** cada op confirma mediante la respuesta de la API interna correspondiente (interceptada con `page.waitForResponse`), o mediante evidencia secundaria verificable (flip del botón Follow, redirect a `tiktokstudio/content`, toast de éxito, desaparición de la fila tras reload, cambio de la URL del avatar, cierre del modal con read-back). Un click sin confirmación es un fallo (`UI_TIMEOUT`), nunca un éxito.
- **Diagnóstico en fallos:** `captureUiState` adjunta screenshot (en `%TMP%/tiktok-mcp-shots`), árbol de accesibilidad interactivo, volcado de controles y requests pendientes, tanto en logs stderr como en el campo `data` del resultado.
- **Modales:** `dismissBlockingModal` cierra overlays TUX/react-joyride que interceptan clicks, con polling dentro de una ventana temporal.
- **Timeouts explícitos:** cada goto/waitFor/click tiene budget; el upload del editor de caption espera hasta 90 s.

**Limitaciones:** dependencia total de una UI que rota selectores sin aviso; riesgo de captcha/challenge (`CAPTCHA_CHALLENGE` mapeado pero sin resolución automática); fragilidad inherente a cambios de TikTok Studio.

---

## 7. Selectores

Estrategia implementada en `social-selectors.ts` (verificada, no inventar otros):

1. **Prioridad ordenada, no carrera:** `resolveElement(page, strategies)` prueba estrategias en orden y devuelve la primera que alcanza estado visible/attached. Una estrategia precisa nunca es vencida por una laxa que matchee el nodo equivocado.
2. **Orden típico de capas:** `data-e2e` primero (rápido cuando es válido) → `aria-label` → rol ARIA + nombre accesible (`getByRole`) → texto → selectores estructurales (xpath/CSS de contenedores, ej. fila ancestro con `button.TUXButton`). El primer strategy puede tener budget mayor (`firstTimeoutMs`) para absorber esperas largas (upload).
3. **Probes de hidratación:** predicados en página que solo son verdaderos cuando el contenido REAL existe (botones de acción del perfil en cualquier estado Follow/Following/Friends/Requested; rail de engagement del video; filas del content manager o vacío confirmado tras dwell de 15 s). Distinguen `NOT_READY` de `NOT_FOUND`.
4. **Fallback de diagnóstico:** si todas las estrategias fallan, `axSnapshot` captura roles+nombres de nodos interactivos y va adjunto al error.
5. Exclusiones deliberadas: los selectores de Follow excluyen el estado "Following" para nunca convertir un follow en unfollow accidental.

---

## 8. Sesiones y autenticación

- **Cuentas:** registro local en `state.json` con estados `connecting | active | logged_out | restricted`, país, tag, timestamps y último error. No se almacenan contraseñas ni tokens en el código ni en el estado; la sesión vive dentro del perfil del navegador.
- **Perfiles persistentes:** un directorio por cuenta (`profiles/<account_id>`, id saneado). El lock por cuenta evita dos navegadores simultáneos sobre el mismo perfil.
- **QR login:** flujo descrito en la sección 6. El relay (`POST /v1/connect/relay`) crea sesión efímera con `token` público de lectura y `writer` privado para actualizar/completar. HTTPS obligatorio salvo localhost.
- **Expiración/recuperación:** cualquier operación que reciba `SESSION_EXPIRED` marca la cuenta `logged_out` automáticamente; el agente debe relanzar `tiktok_connect`. `common()` en el runtime rechaza operar sobre cuentas que no estén `active`.

## 9. Rate limiting

Implementado en `social-rate-limit.ts`, consultado **antes de abrir el navegador** (`gate()`) y registrado solo tras confirmación de éxito (`recordAction`):

- Separación mínima: 30 s entre dos acciones cualesquiera de la misma cuenta.
- Ventanas protectoras: `post` máx **3/día**, `follow` máx **20/hora**, `like` máx **60/hora**.
- Historial de acciones en `state.json`, podado a 48 h.
- Al alcanzar un límite la operación falla **antes** de tocar el navegador con `error_code: "RATE_LIMITED_PROTECTIVE"` y `retry_after_ms`.
- Los rate limits impuestos por TikTok (HTTP 429, códigos internos ≥10000, nickname en cooldown) se mapean a `"RATE_LIMITED"` desde las respuestas reales.
- `delete`, `profile`, `avatar` y `analytics` pasan por el gate de espaciado mínimo pero no tienen ventana de volumen propia.

---

## 10. Errores

Categorías tipadas reales (`TikTokOpResult.error_code` en `tiktok-operations.ts`):

| Código | Significado |
|---|---|
| `SESSION_EXPIRED` | Sesión inválida/expirada (401/403 o código interno 8). Marca la cuenta `logged_out`. |
| `RATE_LIMITED` | Límite impuesto por TikTok (429, flood control interno). |
| `RATE_LIMITED_PROTECTIVE` | Límite preventivo local (sección 9), con `retry_after_ms`. |
| `NOT_FOUND` | Contenido renderizado observado y el objetivo estaba ausente. |
| `INVALID_INPUT` | Validación de entrada fallida (formato, tamaños, ventana de scheduling). |
| `UPLOAD_FAILED` | La subida no llegó al editor de caption. |
| `UI_TIMEOUT` | Elemento o confirmación de UI nunca apareció (posible selector rotado). |
| `LAUNCH_FAILED` | No se pudo abrir la sesión del navegador. |
| `CAPTCHA_CHALLENGE` | TikTok exigió verificación de seguridad (códigos internos 20000–29999). |
| `SCHEDULE_FAILED` | El scheduler nativo no aceptó la fecha/hora; se abortó ANTES de publicar (nunca publica "ahora" por accidente). |
| `NOT_READY` | La página cargó pero el contenido necesario nunca se renderizó: NADA fue observado del objetivo. Distinto de `NOT_FOUND` por diseño. |
| `UNKNOWN` | Error no clasificado. |

Los errores de las tools MCP se devuelven como `{ isError: true, content: [{ error: true, message }] }`. Los fallos de operación quedan en el job con `status: "failed"`, `error` y `error_code` consultables vía `tiktok_operation_status`. Los diagnósticos de UI (screenshot, AX tree, controles, requests pendientes) viajan en `data`.

---

## 11. Scheduler

- **No hay worker local.** `schedule_at` activa el control nativo "Schedule" de TikTok Studio: TikTok publica aunque este servidor esté apagado.
- **Validación temprana:** ISO-8601 válido, entre ~15 minutos y ~10 días (ventana propia de TikTok), validado antes de lanzar el navegador.
- **Zona horaria:** el instante absoluto se convierte a hora de pared de la zona del perfil de país (`wallClockInTz`) porque el picker interpreta lo tecleado en la zona de la sesión del navegador.
- **Seguridad de invariantes:** se fija radio → modal "Allow" → campos de fecha/hora; se leen de vuelta y si no coinciden exactamente se aborta con `SCHEDULE_FAILED` antes de submit.
- **Registro:** el post queda como operación `post` con `schedule_at` en su input; `tiktok_scheduled` deriva el listado de ahí (estados derivados: `scheduled | due | done | failed | cancelled`). Es un registro local: no ve cambios hechos fuera del MCP.
- **Cancelación:** `tiktok_cancel_scheduled` borra el video retenido vía `deleteVideo` y marca la operación original `cancelled`. Requiere `video_url` registrada (los posts programados sí tienen fila con id en Studio antes de publicarse).

---

## 12. Analytics

Separación estricta entre datos observados de TikTok y cálculo local:

- **Datos observados (scrape):** `tiktok_analytics` lee del Studio content manager views/likes/comments/caption/privacidad por post, con scroll hasta estabilización (`loadAllPostRows`, cap 40 scrolls; reporta `truncated` si se corta). La fecha de publicación se **deriva localmente** del id del video (Snowflake-style: bits altos = timestamp), no scrapeada.
- **Persistencia:** cada scrape guarda muestra incremental en `state.json` (cap 50.000 filas; omitidas las muestras idénticas a la anterior). Sin muestra previa no hay historia: `tiktok_series` solo lee lo almacenado localmente.
- **Cálculo local:** `seriesFor` (serie por video), `latestForAccount` (último sample por post), `growthSince` (delta por ventana con flag `comparable`).
- **Hooks:** heurística 100 % local (`tiktok-hooks.ts`): extrae la primera línea útil de la caption, clasifica en 10 patrones regex, compara medianas de views contra la mediana propia de la cuenta (lift). Reglas anti-basura: madurez mínima (default 7 días), ventana de recencia (default 90 días), confianza solo con ≥3 posts por patrón, notas explícitas de exclusiones.
- **Nichos:** taxonomía estática de 24 categorías con aliases.
- **Etiquetado obligatorio:** todo output de hooks/niches/growth es análisis local sobre datos propios; jamás presentarlos como métricas oficiales de TikTok.

---

## 13. Testing

Actual (`npm test` = build + `node --test dist/tests/*.test.js`, framework `node:test`):

- Unitarios puros (sin navegador): validadores de input y mapeo de errores (`op-validators.test.ts` — `normalizeHandle`, `isValidHandle`, `isValidVideoPermalink`, `mapTikTokError`) y capa de estabilización de selectores (`social-selectors.test.ts` — `resolveElement` con fallback, `waitForHydrated` con timeout sin lanzar, `axSnapshot`). Estos tests detectaron y fijaron un bug real de `normalizeHandle`: el orden `replace(/^@/).trim()` dejaba un `@` inicial cuando había espacios antes del handle (p. ej. `"  @brand"`), ahora `trim()` primero y luego quita el `@` (DEC-021).
- Unitarios/integración local: persistencia de cuentas y muestras de analíticas (recordSample dedup, series, latest), contrato de las 35 tools vía `InMemoryTransport` (nombres, ausencia de campos de pago, llamada a `tiktok_niches`), arranque real del binario empaquetado por stdio, contrato HTTP del cliente QR relay (con fetch inyectado). La fusión de media (`tiktok_mix_media`), el quiz visual (`tiktok_make_quiz`) y el duet/stitch (`tiktok_make_duet`) se validan con una ejecución manual real de `ffmpeg` sobre archivos de prueba; no hay test automatizado del binario. `tiktok_monetization_status` se implementó sin poder inspeccionar el DOM real (requiere cuenta apta autenticada): su validación final es manual. Igual para `tiktok_comment_reply`, que depende del DOM de Comment Management (requiere una cuenta con comentarios): validación final manual. `tiktok_pin_video`, que depende del menú de acciones del video, también requiere validación manual contra una cuenta real. `tiktok_playlist_manage` comparte la misma situación: solo está disponible para cuentas con 10k+ seguidores, así que su validación final es manual contra una cuenta apta. `tiktok_search` también se implementó sin inspeccionar el DOM de resultados en desarrollo (búsqueda pública): se lee por links reales + texto visible y su validación final es manual. `tiktok_comment` comparte la situación del watch page (DOM de comentarios no inspeccionado en desarrollo): selectores resilientes + read-back, validación final manual contra una cuenta real. `tiktok_like` y `tiktok_unlike`, al depender ambos del atributo `aria-pressed` del botón de like en el watch page (misma superficie no inspeccionada en desarrollo desde DEC-017), requieren validación manual: se debe confirmar que el like aparece realmente (y que un like repetido no hace unlike). `tiktok_unfollow`, al depender del estado textual del botón de follow en el perfil público y del posible diálogo de confirmación (superficie no inspeccionada en desarrollo), también requiere validación manual contra una cuenta con seguidores. `tiktok_delete_comment`, al depender del menú "…" de cada fila de comentario en Comment Management (superficie no inspeccionada en desarrollo), también requiere validación manual. `tiktok_comments`, al depender del DOM de Comment Management (misma superficie que `tiktok_comment_reply`), también requiere validación manual contra una cuenta real con comentarios. `tiktok_sounds`, al depender del DOM de Discover y de la presencia de links a `/music/<id>` (superficie no inspeccionada en desarrollo), también requiere validación manual. `tiktok_trending_topics`, al depender del DOM de Discover y de la presencia de links a `/tag/<slug>` (superficie no inspeccionada en desarrollo), también requiere validación manual. `tiktok_trending_creators`, al depender del DOM de Discover y de la presencia de links a `/@<handle>` (superficie no inspeccionada en desarrollo), también requiere validación manual. `tiktok_profile_analytics` (header del perfil propio; DOM no inspeccionado en desarrollo) y `tiktok_studio_analytics` (overview de Studio; DOM no inspeccionado en desarrollo) también requieren validación manual contra una cuenta real autenticada.
- **No existen tests de browser contra TikTok real automatizados.**

Estrategia definida:

1. **Unitarios:** lógica pura y sin red (store, métricas, hooks, schedule-time, rate-limit, validaciones). Deben correr siempre.
2. **Integración local:** server ↔ runtime con transports en memoria; contratos de tools.
3. **Pruebas manuales con cuenta real:** toda operación de navegador nueva exige validación manual contra TikTok antes de considerarla funcional. Diferenciar claramente qué quedó cubierto por cuál nivel.
4. Antes de aceptar una nueva tool: typecheck, tests existentes en verde, tests nuevos para lógica testable, y una ejecución manual documentada de la operación real.

---

## 14. Seguridad

- **Almacenamiento local:** todo en `TIKTOK_MCP_DATA_DIR` (default `~/.tiktok-mcp`): `state.json` (escritura atómica temp+rename, permisos `0600`) y perfiles de navegador.
- **Secretos:** no hay claves de API ni pagos. Las cookies de sesión viven solo dentro del perfil del navegador; el código fuente no las maneja (el campo `cookies` del request existe pero hoy siempre llega vacío desde el runtime).
- **Redacción de inputs:** los valores `*_base64` se sustituyen por un placeholder antes de persistir el input de una operación.
- **SSRF:** `fetchSsrfSafe` bloquea URLs con credenciales, localhost/`.local`, IPs privadas (incluida IPv6 ULA/link-local y mapeo ::ffff:), resuelve DNS y valida cada redirect (máx 5), con límites de bytes en streaming (100 MB video, 10 MB imagen).
- **Archivos temporales:** media materializada en `%TMP%/tiktok-mcp-uploads` con cleanup en `finally`; screenshots de diagnóstico en `%TMP%/tiktok-mcp-shots` (contienen contenido de la cuenta: tratar como sensibles).
- **Logs:** stderr con controles de página y requests pendientes; nunca loguear cookies ni valores base64.
- **Reglas Git:** no commitear nunca `state.json`, perfiles, screenshots, ni secretos. Mantener los datos bajo el directorio de datos configurado, fuera del repo.
- **Superficie externa única:** el relay QR efímero; no transporta credenciales, solo la imagen del QR y un flag de completitud.

---

## 15. Extensibilidad — cómo agregar una nueva capacidad

1. Definir la operación y verificar que TikTok no ofrece mejor vía oficial.
2. Buscar implementación reutilizable en `tiktok-operations.ts` (gate de rate limit, `openAuthenticatedSession`, `resolveElement`, `waitForHydrated`, `submitAndAwaitTikTokApi`, `captureUiState`, `dismissBlockingModal`).
3. Implementar la operación en `tiktok-operations.ts` con `TikTokOpResult` y verificación de confirmación real (respuesta de API interna o evidencia secundaria verificable). Nunca dar por bueno un click sin confirmación.
4. Integrar en `LocalTikTokRuntime` con `this.start(...)` (job asíncrono + polling) o método síncrono si es lectura local.
5. Agregar la tool en `server.ts` con schema zod completo y descripción precisa.
6. Actualizar el test de conteo de tools (`16`) y agregar tests unitarios de la lógica nueva.
7. Probar manualmente contra una cuenta real y documentar el resultado.
8. Actualizar `README.md`, `SKILL.md` si aplica, este documento (secciones 4, 5 y Decision Log si hubo decisión arquitectónica).

---

## 16. Agentes y skills

- `AGENTS.md` — reglas globales para agentes (prioridades, git, testing, estilo).
- `SDD.md` (este archivo) — arquitectura, estado real y decisiones.
- `SKILL.md` — conocimiento especializado de operación distribuido junto al paquete npm.
- Subagentes: usarlos solo cuando aporten ventaja real y la tarea sea independiente; no duplicar responsabilidades ni crear subagentes para tareas pequeñas.
- No asumir estructura concreta de OpenCode u otro orquestador si no está confirmada en la configuración del proyecto.

---

## 17. Roadmap

| Fase | Alcance | Estado |
|---|---|---|
| 1 | Estabilizar el MCP existente: comprender la arquitectura, pruebas, endurecer selectores y errores | Completada (tests unitarios de estabilización `op-validators.test.ts` + `social-selectors.test.ts`; centralización de validadores/mapeo de errores en `op-validators.ts`; registro en DEC-021) |
| 2 | Completar engagement: unlike/unfollow, comentarios (leer, escribir, responder, borrar) | En curso (escribir comentarios `tiktok_comment`; leer comentarios `tiktok_comments`; response en Studio `tiktok_comment_reply`; borrar comentarios `tiktok_delete_comment`; unlike `tiktok_unlike`; unfollow `tiktok_unfollow`) |
| 3 | Discovery y trends: búsquedas (videos/usuarios/hashtags), tendencias, sounds | Completada (búsqueda `tiktok_search`; sounds `tiktok_sounds`; tendencias `tiktok_trending`; topics `tiktok_trending_topics`; creadores `tiktok_trending_creators`) |
| 4 | Analytics avanzados: analíticas de perfil, métricas profundas de Studio, histórico más rico | Completada (`tiktok_profile_analytics` lee totales del perfil; `tiktok_studio_analytics` lee el overview de Studio de forma defensiva; registro en DEC-022) |
| 5 | LIVE: descubrimiento, información e interacción | Planificado |
| 6 | Cobertura adicional: photo posts, drafts, edición de posts publicados, APIs oficiales donde apliquen (ya implementados: fusión de media `tiktok_mix_media`, quiz visual `tiktok_make_quiz`, duet/stitch local `tiktok_make_duet`, lectura de monetización `tiktok_monetization_status`, respuesta de comentarios `tiktok_comment_reply`, fijar videos `tiktok_pin_video` y playlists `tiktok_playlist_manage`) | Planificado |
| 7 | Integración del agente con canales externos (WhatsApp/Telegram) | Planificado |

El roadmap puede modificarse; cualquier cambio relevante se registra en el Decision Log.

---

## 18. Decision Log

No hay decisiones históricas inventadas. Se registran aquí decisiones observables y comprobables en el código actual (documentadas retroactivamente) y las futuras con el formato indicado.

## DEC-001 — Scheduling nativo de TikTok en lugar de worker local

Fecha: preexistente al SDD (registrado retroactivamente desde el código)
Estado: Aceptada (implementada)
Decisión: usar el control nativo "Schedule" de TikTok Studio en lugar de un scheduler propio.
Motivo: TikTok publica aunque el servidor esté apagado; se elimina toda la infraestructura de workers y su confiabilidad.
Alternativas consideradas: cola local con worker que publique a la hora indicada.
Consecuencias: ventana limitada (~15 min–10 días); dependencia del widget de scheduling de Studio; necesidad de verificación estricta (abort con `SCHEDULE_FAILED` en lugar de publicar "ahora").

## DEC-002 — Verificación por intercepción de la API interna de TikTok

Fecha: preexistente al SDD (registrado retroactivamente desde el código)
Estado: Aceptada (implementada)
Decisión: confirmar cada operación por la respuesta real del endpoint interno (`status_code === 0`), con evidencias secundarias acotadas (flip de botón, redirect/toast, read-backs), nunca por el hecho de haber clickeado.
Motivo: evitar falsos positivos; distinguir "no observado" (`NOT_READY`) de "observado y ausente" (`NOT_FOUND`).
Alternativas consideradas: confiar en estado de UI (rechazado: generó bugs históricos documentados en comentarios del código).
Consecuencias: acoplamiento a endpoints internos no documentados que pueden rotar; a cambio, resultados confiables.

## DEC-XXX — Plantilla para decisiones futuras

Fecha:
Estado: (Propuesta / Aceptada / Rechazada / Sustituida)
Decisión:
Motivo:
Alternativas consideradas:
Consecuencias:

## DEC-003 — Fusión local de media con `ffmpeg-static` en lugar de edición en la app

Fecha: 2026-08-30
Estado: Aceptada (implementada)
Decisión: agregar `tiktok_mix_media`, una tool local que fusiona un video con una pista de audio separada mediante el binario estático `ffmpeg-static`, y exponer el MP4 resultante a `tiktok_post` (`video_path`).
Motivo: el MCP no podía editar media (unir video + audio por separado). `ffmpeg-static` es self-hosted, no requiere instalación manual externa y cumple el principio de no subir media a servicios ajenos.
Alternativas consideradas: instalar ffmpeg en el sistema (rechazado: rompe self-hosted y requiere permisos/espacio); librerías de edición Python/JS pesadas (rechazado: más dependencias, sin binario garantizado).
Consecuencias: nueva dependencia `ffmpeg-static` (~80 MB binario); la tool es síncrona y de solo procesamiento local (no toca el navegador ni TikTok); repositorio y disco requieren suficiente espacio (el disco C: estaba 100% lleno durante el desarrollo).

## DEC-004 — Quiz/trivia visual con `drawtext` en lugar de quiz interactivo nativo

Fecha: 2026-08-30
Estado: Aceptada (implementada)
Decisión: implementar `tiktok_make_quiz`, que quema la pregunta y las opciones (A/B/C/D) como overlays de texto sobre el video con `drawtext`, en lugar de intentar manipular el sticker "Quiz" interactivo nativo de TikTok.
Motivo: tras investigación (2026), TikTok no tiene quiz interactivo nativo configurable desde la web; el sticker "Quiz" existe solo en el editor de la app móvil, y no hay respuesta de API interna verificable por browser. El formato de los creadores (y de las herramientas de quiz) es precisamente quemar el texto en el MP4 y subirlo, que es lo que este MCP puede hacer de forma verificable.
Alternativas consideradas: automatizar el sticker móvil (rechazado: solo app móvil, no verificable en web); quiz interactivo vía API (no existe API oficial accesible).
Consecuencias: quiz visual = contenido de trivia 100 % funcional y verificado; no es interactivo (el viewer no toca opciones). Se resolvió el conflicto de rutas Windows (`:`) con `drawtext` ejecutando ffmpeg en un workdir dedicado con rutas relativas.

## DEC-005 — Duet/Stitch como composición local con ffmpeg

Fecha: 2026-08-30
Estado: Aceptada (implementada)
Decisión: implementar `tiktok_make_duet`, que compone localmente el MP4 de duet (pantalla dividida) o stitch (clip inicial del video ajeno + continuación propia) con ffmpeg, en lugar de automatizar el editor nativo de Duet/Stitch.
Motivo: tras investigación (2026), el editor nativo de Duet y Stitch solo existe en la app móvil de TikTok — no en la web de escritorio ni en TikTok Studio, que es lo que este MCP automatiza. El método real y verificado de los creadores en PC es componer el video equivalente (pantalla dividida o clip+continuación) y subirlo como video normal, que es exactamente lo que produce esta tool.
Alternativas consideradas: automatizar el editor móvil (rechazado: solo app móvil, no verificable en web); emulador Android (rechazado: mayor complejidad y vulnerabilidad de la sesión).
Consecuencias: el duet/stitch armado es contenido funcional y verificable, pero no crea el vínculo formal con el video original que genera el editor nativo. Se detecta por clip si existe pista de audio (probe) y se mezcla/concatena o se sustituye por silencio.

## DEC-006 — Monetización como lectura defensiva (no enrolamiento)

Fecha: 2026-08-30
Estado: Aceptada (implementada v1, validación manual pendiente)
Decisión: implementar `tiktok_monetization_status` como una consulta de lectura del estado/rendimiento de monetización en TikTok Studio web (`/tiktokstudio/monetization`), con un scrape defensivo por texto visible y pares etiqueta/valor que no dependa de selectores frágiles.
Motivo: TikTok Studio (web) sí expone la superficie de monetización, pero el enrolamiento en programas (p. ej. Creator Rewards) exige elegibilidad estricta — 10 000+ seguidores, 100 000 vistas en 30 días, cuenta de 30+ días y 18+ años. La cuenta actual no califica, y el DOM de esa página solo se puede verificar contra una cuenta apta autenticada. Implementar selectores específicos sin inspección real violaría el principio del proyecto de no inventar selectores; por eso el scrape es resiliente y se documenta que la validación final es manual.
Alternativas consideradas: posponer hasta tener cuenta apta (rechazado: perdía el orden del roadmap y el usuario pidió implementar v1); documentar solo el límite (rechazado: se perdió una capacidad de lectura útil).
Consecuencias: la tool lee el estado sin fabricar elegibilidad; ante una página sin hidratar devuelve `NOT_READY`, nunca un falso "no elegible". El resultado debe validarse contra una cuenta real que cumpla los requisitos.

---

## DEC-007 — Responder comentarios desde el Comment Management web

Fecha: 2026-08-30
Estado: Aceptada (implementada v1, validación manual pendiente)
Decisión: implementar `tiktok_comment_reply` para responder a un comentario desde el Comment Management de TikTok Studio web (`/tiktokstudio/comment-management`), localizando el comentario por su texto y publicando la respuesta con verificación por read-back.
Motivo: a diferencia de duet/quiz/monetización, la gestión de comentarios (responder, likear, borrar, filtrar por estado como "not replied") es una superficie web pública confirmada de TikTok Studio. Esa es la vía idónea según el objetivo del proyecto (operar lo que un usuario real puede hacer; preferir superficie real de TikTok). El flujo es un editor de texto + envío, más predecible que otros.
Alternativas consideradas: un endpoint interno de comentarios (rechazado: no se debe inventar sin observarlo en una sesión real); verificar el DOM en vivo primero (aparcado: requería una cuenta con comentarios que no está conectada; se usa selectores resilientes multi-nivel y read-back en su lugar).
Consecuencias: como el DOM de comment-management no pudo inspeccionarse en el entorno de desarrollo, la tool usa selectores resilientes (texto → role/aria → estructural) y verifica el éxito por read-back del texto de respuesta publicado; ante falla de confirmación devuelve un error que advierte que NO debe reenviarse sin comprobar, y adjunta `captureUiState` para ajustar selectores. La validación final es manual con una cuenta que tenga comentarios.

---

## DEC-008 — Fijar videos al perfil con verificación por read-back del badge

Fecha: 2026-08-30
Estado: Aceptada (implementada v1, validación manual pendiente)
Decisión: implementar `tiktok_pin_video` (`action: "pin" | "unpin"`) para fijar/desfijar un video propio desde el menú de acciones del video ("Pin to profile"/"Unpin from profile"), con verificación real navegando de vuelta al perfil y comprobando si el tile del video lleva el badge "Pinned".
Motivo: fijar videos es una capacidad web real de TikTok (limitada a 3 videos). La verificación por read-back del perfil es observable y no depende de un endpoint interno inventado ni de selectores frágiles; evita reportar éxito sin confirmar.
Alternativas consideradas: interceptar un endpoint interno de pin (rechazado: no se debe inventar sin observarlo); verificar solo el texto del menú (rechazado: demasiado frágil y no prueba el estado persistido).
Consecuencias: la acción se asienta en el perfil real; si el menú no muestra la entrada deseada, se interpreta como "ya en estado deseado" solo si el perfil lo confirma; ante duda, devuelve error advirtiendo que no debe re-ejecutarse a ciegas y adjunta `captureUiState`. Validación final manual con una cuenta real. Los playlists quedan fuera por su mecánica distinta (creación/organización).

---

## DEC-009 — "Usar sonido de otro video" cubierto por `tiktok_mix_media`

Fecha: 2026-08-30
Estado: Aceptada (cerrado, sin código nuevo)
Decisión: cerrar el ítem #2 ("sonido de otro video") documentando que la capacidad técnica ya está cubierta por `tiktok_mix_media`, que acepta `audio_url`/`audio_path`/`audio_base64` y reemplaza o superpone la pista de audio localmente con `ffmpeg-static` antes de `tiktok_post`.
Motivo: el flujo nativo de TikTok ("Use sound" sobre un video) arranca la grabación y no aplica a subir un MP4 pre-editado desde la web de Studio. La alternativa web para "usar el sonido de un video TikTok ajeno por su `video_url`" requeriría interceptar la descarga del clip del video ajeno por la sesión de red, capacidad que no está implementada y que, según el principio del proyecto, no debe inventarse sin verificarla. Crear `tiktok_use_sound` como duplicado de `tiktok_mix_media` violaría la regla de no duplicar lógica.
Alternativas consideradas: implementar la descarga del clip ajeno por la sesión (rechazado: intercepción de red nueva no verificada); crear una tool duplicada (rechazado: duplicación de lógica).
Consecuencias: el caso "tener el archivo de audio/video y usarlo como sonido" queda resuelto y documentado; el caso "bajar automáticamente el audio de un video TikTok ajeno" queda explícitamente fuera de alcance hasta que exista una intercepción de red verificada. Sin cambios de herramientas ni de conteo (sigue en 22).

---

## DEC-010 — Playlists: crear y gestionar con verificación por read-back

Fecha: 2026-08-30
Estado: Aceptada (implementada v1, validación manual pendiente)
Decisión: implementar `tiktok_playlist_manage` (`action: "create" | "add" | "remove"`) para crear un playlist y añadir/quitar un post público del mismo desde el perfil web ("Manage playlists" / el menú "Add to playlist"/"Remove from playlist" del video), con verificación por read-back del estado resultante.
Motivo: la documentación oficial (Help Center + Creator Academy "TikTok Studio Web") confirma que los playlists existen en la web, pero solo para creadores con 10k+ seguidores. La cuenta actual no califica, así que —igual que monetización/comentarios/pin— se implementa con selectores resilientes y read-back, y se documenta la validación manual contra una cuenta apta.
Alternativas consideradas: posponer hasta cuenta apta (rechazado: el usuario pidió implementar v1); solo crear (rechazado: gestionar también es parte del ítem).
Consecuencias: la ruta `create` resuelve el perfil propio por el nav link; si no aparece "Create playlist", devuelve `NOT_READY` (no fabrica disponibilidad). Un post público solo puede estar en una playlist a la vez; documentado. Conteo pasa de 22 a 23 tools.

---

## DEC-011 — Búsqueda (Discovery) como lectura defensiva anónima

Fecha: 2026-08-30
Estado: Aceptada (implementada v1, validación manual pendiente)
Decisión: implementar `tiktok_search` (`type: "video" | "user" | "hashtag"`) navegando a `/search/<type>?q=...` en la búsqueda web de TikTok (sesión anónima salvo que se pase `account_id`), esperando la aparición de links de resultado reales y extrayendo esos links + el texto visible asociado. Es una operación READ: nunca fabrica resultados; una lista vacía refleja el estado vacío observado y `NOT_READY` ante no-render.
Motivo: la búsqueda es la capacidad más fundamental de la Fase 3 y es pública en la web. Se prioriza la honestidad (solo lo observado) y la reutilización de patrones existentes de scrape defensivo, sin inventar selectores ni endpoints.
Alternativas consideradas: imponer cuenta obligatoria (rechazado: la búsqueda es pública y debe funcionar sin login); interceptar el endpoint interno de búsqueda (rechazado: no se inventa sin observar).
Consecuencias: `account_id` es opcional; la tool usa un perfil anónimo (`__search__`) cuando no hay cuenta. El DOM de resultados no se inspeccionó en desarrollo → validación manual pendiente. Conteo pasa de 23 a 24 tools.

---

## DEC-012 — Comentar en videos de otros desde el watch page con verificación por read-back

Fecha: 2026-08-30

Estado: Aceptada (implementada v1, validación manual pendiente)
Decisión: implementar `tiktok_comment` para publicar un comentario en el video de otro usuario navegando al permalink `/video/<id>`, esperando el rail de engagement hidratado, resolviendo el campo de comentario con selectores resilientes (data-e2e → placeholder → editor) y abriendo el rail vía el icono de comentarios si el campo es lazy. Se escribe el texto y se envía con Enter. La verificación es por read-back estricto: el campo queda vacío Y el texto aparece publicado en el DOM; si no se confirma, devuelve `UI_TIMEOUT` con diagnóstico y advierte que no se reenvíe sin verificar.
Motivo: la interacción social de comentar en videos ajenos es la capacidad más común que faltaba del espectro de engagement; el watch page expone el campo de comentario y TikTok lo publica vía la UI, lo que permite verificación honesta por read-back sin inventar endpoints internos.
Alternativas consideradas: interceptar el endpoint interno de publicación de comentarios (rechazado: no se inventa sin observar); reutilizar Comment Management de Studio (rechazado: solo gestiona comentarios recibidos, no comentar en videos ajenos).
Consecuencias: la tool es asíncrona (`comment`), comparte la ventana de rate limit de "comment" con `tiktok_comment_reply` (20/hora) y exige permalink `/video/<id>`. El DOM del watch page no se pudo inspeccionar en desarrollo → selectores resilientes + validación manual pendiente. Conteo pasa de 25 a 26 tools.

---

## DEC-013 — Lectura de comentarios desde Comment Management como operación READ síncrona

Fecha: 2026-08-30

Estado: Aceptada (implementada v1, validación manual pendiente)
Decisión: implementar `tiktok_comments` para leer los comentarios de los propios videos navegando a `/tiktokstudio/comment-management`, esperando la hidratación de la superficie de comentarios, cargando la lista perezosa con scroll hasta estabilizar (misma regla que `loadAllPostRows`) y scrapeando por texto visible + links a `/video/<id>` (scrape estructural defensivo, nunca fabrica). Opcionalmente filtra por `video_id`. Es una operación READ síncrona (no pasa por un job asíncrono ni está sujeta al cap protector de acciones).
Motivo: leer los comentarios recibidos es la base para luego responder, dar like, fijar o eliminar — y complementa `tiktok_comment_reply` (escribir) con la lectura que faltaba del ciclo de engagement.
Alternativas consideradas: interceptar el endpoint interno de listado de comentarios (rechazado: no se inventa sin observar); devolver un job asíncrono como las acciones (rechazado: al ser solo lectura conviene la respuesta directa y síncrona, del mismo modo que `search`/`trending`).
Consecuencias: la tool es síncrona y abre el navegador autenticado al igual que `comment_reply`; requiere sesión activa y su DOM no se pudo inspeccionar en desarrollo → scrape estructural + validación manual pendiente contra una cuenta real con comentarios. Conteo pasa de 26 a 27 tools.

---

## DEC-014 — Unlike idempotente leyendo `aria-pressed` del botón de like

Fecha: 2026-08-31

Estado: Aceptada (implementada v1, validación manual pendiente)
Decisión: implementar `tiktok_unlike` reutilizando el patrón de `likeVideo` (página watch, probe de hidratación del rail, intercepción de `commit/item/digg`) pero con dos diferencias clave: (1) antes de clickear, lee el estado del like desde el atributo `aria-pressed` del botón — si el video no está likeado, devuelve un no-op exitoso `{ unliked: false, was_liked: false }` en lugar de togglear el botón al revés; (2) tras la llamada a la API, verifica por read-back que `aria-pressed` quedó en `false`, de modo que nunca reporta éxito sin observar que el like realmente desapareció. Comparte el bucket de rate limit "like" (60/hora) ya que usa el mismo endpoint `digg`.
Motivo: el like de TikTok es un toggle; sin leer el estado, un "unlike" sobre un video no likeado convertiría por error un no-op en un like. Leer el estado del botón elimina esa ambigüedad y complementa el ciclo de engagement inverso (like/unlike).
Alternativas consideradas: leer el estado de la clase CSS del botón (rechazado: más frágil que `aria-pressed`); interceptar el endpoint de estado de relación (rechazado: no se inventa sin observar).
Consecuencias: la tool es asíncrona (job) y depende del atributo `aria-pressed` del botón de like en el watch page — si TikTok rota ese atributo hay que revalidar; misma superficie sin inspeccionar en desarrollo que `tiktok_like`/`tiktok_comment`, por lo que su validación final es manual contra una cuenta real. Conteo pasa de 27 a 28 tools.

---

## DEC-015 — Unfollow idempotente invirtiendo la exclusión del botón follow

Fecha: 2026-08-31

Estado: Aceptada (implementada v1, validación manual pendiente)
Decisión: implementar `tiktok_unfollow` reutilizando el patrón de `followUser` (perfil público, probe de hidratación de acciones, intercepción de `commit/follow/user` o `passport/web/user/follow`) pero invirtiendo la guarda: resolve el botón SOLO en estado Following/Friends/Requested (donde follow lo excluye para nunca click-to-unfollow), de modo que nunca clickea salvo que ya se siga; si el botón no está en estado following, devuelve un no-op exitoso `{ unfollowed: false, was_following: false }`. Al clickear, TikTok puede mostrar un diálogo de confirmación ("Unfollow @handle?") — se resuelve y confirma si aparece. Verifica por read-back que el botón flipea de vuelta a Follow (si no, `UI_TIMEOUT` y no reejecutar a ciegas). Comparte el bucket de rate limit "follow" (20/hora).
Motivo: el follow de TikTok es un toggle; sin leer el estado, un "unfollow" que ya no sigue convertiría por error un no-op en un follow. Además, TikTok puede pedir confirmación explícita que una operación de unfollow debe manejar para reportar con honestidad.
Alternativas consideradas: click directo al botón "Following" sin confirmar el diálogo (rechazado: el diálogo puede quedar abierto o anular la acción, y el read-back no confirmaría el flip); interceptar el endpoint de estado de relación (rechazado: no se inventa sin observar).
Consecuencias: la tool es asíncrona (job) y depende del texto del botón de follow en el perfil público (Follow vs Following/Friends/Requested) y del posible diálogo de confirmación — superficie no inspeccionada en desarrollo, por lo que su validación final es manual contra una cuenta con seguidores. Conteo pasa de 28 a 29 tools.

---

## DEC-016 — Borrado de comentario en Comment Management con verificación por ausencia

Fecha: 2026-08-31

Estado: Aceptada (implementada v1, validación manual pendiente)
Decisión: implementar `tiktok_delete_comment` para eliminar un comentario de los propios videos navegando a `/tiktokstudio/comment-management`, esperando la hidratación de la superficie (mismo predicado que `commentReply`), ubicando la fila del comentario por texto (misma resolución 3-tier: text-substring → aria-comment → structural-comment), abriendo el menú "…" de la fila, seleccionando Delete, confirmando el diálogo si aparece (scoped a `:visible` para excluir el menú oculto), y verificando por read-back que el texto del comentario ya NO está en la página. Si el comentario no se encuentra devuelve `NOT_FOUND`. Comparte el bucket de rate limit "comment" (20/hora).
Motivo: cierra el ciclo de engagement de comentarios (leer, escribir, responder, borrar) sobre la misma superficie de Comment Management ya usada por `tiktok_comments`/`tiktok_comment_reply`. No se conoce un endpoint oficial de borrado de comentario, así que la verificación honesta es por read-back de la ausencia del texto (mismo principio que `commentReply`).
Alternativas consideradas: interceptar el endpoint interno de borrado de comentario (rechazado: no se inventa sin observar); borrar sin confirmar el diálogo (rechazado: el diálogo puede quedar abierto o anular la acción).
Consecuencias: la tool es asíncrona (job) y depende del menú "…" de cada fila de comentario en Comment Management — superficie no inspeccionada en desarrollo, por lo que su validación final es manual contra una cuenta real con comentarios. Conteo pasa de 29 a 30 tools.

---

## DEC-017 — Like idempotente (reutiliza la lectura de `aria-pressed` de unlike)

Fecha: 2026-08-31

Estado: Aceptada (implementada)
Decisión: igualar `likeVideo` con la lectura de estado que ya implementó `unlikeVideo` (DEC-014): antes de clickear lee el atributo `aria-pressed` del botón de like — si el video ya está likeado, devuelve un no-op exitoso `{ liked: false, was_liked: true }` en lugar de togglear el botón al revés (que convertía un like repetido en unlike); si no está likeado, clickea, intercepta `commit/item/digg` y verifica por read-back que `aria-pressed` quedó en `true`, de modo que nunca reporta éxito sin observar que el like realmente se aplicó.
Motivo: resolver la limitación de engagement más importante documentada — "repetir un like ejecuta un unlike". Con la lectura de estado, `like` y `unlike` son ahora recíprocos e idempotentes (repetir cualquiera de los dos es un no-op), eliminando la ambigüedad del toggle.
Alternativas consideradas: dejar `like` como toggle puro y confiar en la intercepción de API (rechazado: la API `digg` no distingue like de unlike, y el comportamiento observado del usuario es el que importa); leer el estado vía clase CSS (rechazado: más frágil que `aria-pressed`, ya validado en DEC-014).
Consecuencias: no cambia el conteo de tools ni rompe el contrato de parámetros; cambia el shape de retorno de `likeVideo` de `{ liked: boolean }` a `{ liked: boolean; was_liked: boolean }` (compatible: ambos estaban ya en uso en `unlikeVideo`). `like` y `unlike` comparten la misma dependencia de `aria-pressed` del watch page, sin inspeccionar en desarrollo → validación manual pendiente.

---

## DEC-018 — Sounds trending desde Discover como operación READ síncrona

Fecha: 2026-08-31

Estado: Aceptada (implementada v1, validación manual pendiente)
Decisión: implementar `tiktok_sounds` para leer los sounds que TikTok muestra en su página Discover (`/discover`), esperando que aparezcan links reales a `/music/<id>`, y extrayendo para cada uno su `sound_id`, URL, snippet visible y (best-effort) el count de videos. Reutiliza exactamente el patrón defensivo de `trendingFeed`/`searchByType` (scrape por links reales + recorrido de `parentElement` para el snippet); nunca fabrica un ranking. Si la página renderiza pero no hay links `/music/<id>`, devuelve lista vacía solo cuando el texto de la página contiene music/sound; de lo contrario `NOT_READY`.
Motivo: los sounds son una pieza central de la Fase 3 (Discovery/trends) que el roadmap marcaba pendiente; leer los sonidos en tendencia con sus enlaces es la base para luego reutilizar ese audio (vía `tiktok_make_duet`/`tiktok_mix_media`) o crear contenido alrededor de un sound de moda.
Alternativas consideradas: navegar a un listado específico de sounds trending (rechazado: no se conoce una URL web estable pública de ese listado sin inventar); interceptar un endpoint interno de sounds (rechazado: no se observa sin inspeccionar una sesión real).
Consecuencias: la tool es síncrona de lectura (no pasa por un job ni está sujeta al cap protector). Depende de que Discover exponga links a `/music/<id>` — superficie no inspeccionada en desarrollo, por lo que su validación final es manual contra TikTok real. Conteo pasa de 30 a 31 tools.

---

## DEC-019 — Trending topics/hashtags desde Discover como operación READ síncrona

Fecha: 2026-08-31

Estado: Aceptada (implementada v1, validación manual pendiente)
Decisión: implementar `tiktok_trending_topics` para leer los topics/hashtags que TikTok muestra en su página Discover (`/discover`), esperando que aparezcan links reales a `/tag/<slug>`, y extrayendo para cada uno su hashtag, URL, snippet visible y (best-effort) el count de posts. Reutiliza exactamente el patrón defensivo de `soundsFeed` (DEC-018) y `trendingFeed`; nunca fabrica un ranking. Si la página renderiza pero no hay links `/tag/<slug>`, devuelve lista vacía solo cuando el texto de la página contiene trending/#; de lo contrario `NOT_READY`.
Motivo: el "contenido en tendencia" (topics/hashtags) era la pieza que faltaba de la Fase 3 junto con sounds; leer los hashtags en tendencia con sus enlaces permite a un agente crear contenido alineado (captions, hooks) alrededor de temas de moda.
Alternativas consideradas: interceptar un endpoint interno de trending topics (rechazado: no se observa sin inspeccionar una sesión real); inventar una URL dedicada de trends (rechazado: no conocida de forma estable).
Consecuencias: la tool es síncrona de lectura (no pasa por un job ni está sujeta al cap protector). Depende de que Discover exponga links a `/tag/<slug>` — superficie no inspeccionada en desarrollo, por lo que su validación final es manual contra TikTok real. Conteo pasa de 31 a 32 tools.

---

## DEC-020 — Trending creators desde Discover como operación READ síncrona (cierra Fase 3)

Fecha: 2026-08-31

Estado: Aceptada (implementada v1, validación manual pendiente)
Decisión: implementar `tiktok_trending_creators` para leer los creadores que TikTok muestra en su página Discover (`/discover`), esperando que aparezcan links reales a `/@<handle>`, y extrayendo para cada uno su handle, URL, snippet visible y (best-effort) el count de seguidores. Reutiliza exactamente el patrón defensivo de `soundsFeed` (DEC-018) y `trendingTopicsFeed` (DEC-019); nunca fabrica un ranking. Si la página renderiza pero no hay links `/@<handle>`, devuelve lista vacía solo cuando el texto de la página contiene creator/@/followers; de lo contrario `NOT_READY`.
Motivo: los creadores eran la última capacidad pendiente de la Fase 3 (Discovery/trends); con esto la Fase 3 queda cubierta y un agente puede descubrir contenido, sonidos, temas y perfiles en tendencia para orientar estrategia de contenido y colaboraciones.
Alternativas consideradas: reutilizar `tiktok_search` (`type: user`) como único camino a creadores (rechazado: es búsqueda dirigida, no descubrimiento de tendencia); inventar una URL dedicada de creators trending (rechazado: no conocida de forma estable).
Consecuencias: la tool es síncrona de lectura (no pasa por un job ni está sujeta al cap protector). Depende de que Discover exponga links a `/@<handle>` — superficie no inspeccionada en desarrollo, por lo que su validación final es manual contra TikTok real. Conteo pasa de 32 a 33 tools.

---

## DEC-021 — Fase 1: estabilización (validadores puros testables + tests unitarios de la capa de selectores)

Fecha: 2026-08-31

Estado: Aceptada (cierra Fase 1)
Decisión: crear `src/runtime/op-validators.ts` con los validadores puros y sin efectos que antes vivían inline en las operaciones — `normalizeHandle`, `isValidHandle`, `isValidVideoPermalink` (reutilizados en follow/unfollow/like/unlike/comment reemplazando duplicados) y `mapTikTokError` (movido desde `tiktok-operations.ts`) — para poder testearlos sin Chromium. El script `test` ahora corre todos los `dist/tests/*.test.js` (antes solo `local.test.js`). Se añadieron `op-validators.test.ts` y `social-selectors.test.ts` (resolveElement con fallback, waitForHydrated, axSnapshot con page mock).
Motivo: "endurecer errores/pruebas" de la Fase 1 sin tocar el comportamiento de las operaciones en producción ni arriesgar selectores contra DOM real no inspeccionado. Centraliza lógica duplicada (no duplicar lógica) y da cobertura automatizada a las decisiones que gatean cada operación.
Bug detectado y fijado: el orden de `normalizeHandle` era `replace(/^@/).trim()`; con input con espacios antes del `@` (`"  @brand"`) no se quitaba el `@` y quedaba inválido o producía una URL con `@` duplicado. Se corrigió a `trim()` primero y luego `replace(/^@/,"")`. Los tests assert sobre handles con/without espaciado evitan una regresión.
Alternativas consideradas: endurecer selectores de producción (rechazado por ahora: las ops ya son resilientes por links/roles y modificar selectores sin poder probar contra TikTok real — superficie no inspeccionada en desarrollo — contradice "no romper herramientas existentes"); escribir tests que arranquen Chromium (rechazado: pesado y no repetible en CI).
Consecuencias: no cambia el conteo de tools (33) ni rompe contratos; `mapTikTokError` pasa a `op-validators.ts` con el mismo enum extensible `OpErrorCode` (compatible estructuralmente con `TikTokOpResult["error_code"]`). Aumenta de 4 a 18 los tests unitarios/integración ejecutados por `npm test`.

---

## DEC-022 — Fase 4: Analytics avanzados (`tiktok_profile_analytics` + `tiktok_studio_analytics`)

Fecha: 2026-08-31

Estado: Aceptada (implementada v1, validación manual pendiente)
Decisión: implementar dos lecturas adicionales de analíticas propias: (1) `tiktok_profile_analytics` lee el header del perfil público de la cuenta (display name, @handle, bio y totales Following/Followers/Likes/Videos), resolviendo el perfil propio desde el link del nav con el helper extraído `resolveOwnProfileUrl` (antes embebido en `openEditProfileModal`, refactor sin cambio de comportamiento); (2) `tiktok_studio_analytics` lee `/tiktokstudio/analytics` de forma defensiva extrayendo pares label/valor visibles (Views, Watch time, Followers, Likes, etc.).
Motivo: cerrar la Fase 4 del roadmap ("Analíticas de perfil" y "Analíticas profundas de Studio"), que estaban en RESEARCH. Ambas son lecturas read-only sobre datos propios, de bajo riesgo, y reutilizan los patrones defensivos existentes (waitForHydrated, captureUiState, NOT_READY vs vacío) sin fabricar métricas.
Alternativas consideradas: scrapear los gráficos internos de Studio vía canvas (rechazado: no se puede leer canvas sin inspeccionar el DOM real); estimar métricas (rechazado: nunca fabricar).
Consecuencias: dos tools nuevas síncronas-de-ui vía job (`this.start`), consistentes con `tiktok_analytics`/`tiktok_monetization_status`. Reutiliza `resolveOwnProfileUrl` (extraído sin romper `openEditProfileModal`). Conteo pasa de 33 a 35 tools. Ambas superficies no inspeccionadas en desarrollo → validación manual pendiente contra una cuenta real autenticada.

---

## 19. Limitaciones

**De TikTok:**
- Rotación frecuente e indocumentada de `data-e2e`, clases y flujos de UI.
- Captchas/challenges posibles (`CAPTCHA_CHALLENGE` se detecta, no se resuelve automáticamente).
- Rechazo de logins QR por distancia geográfica entre navegador y teléfono.
- Cooldown de cambio de nickname (~1/semana) y rechazos silenciosos o inline.
- Ventana de scheduling propia (~15 min–10 días), granularidad de 5 minutos.

**De APIs oficiales:** no se usa ninguna API oficial hoy; no hay Research Display API / Content Posting API integrada.

**De browser automation:**
- Una sesión por cuenta a la vez (lock).
- Requiere navegador Chrome-family instalado (o Chromium de Playwright) y, en VPS Linux, Xvfb para el login.
- Operaciones lentas (lanzamiento de navegador por operación) y sujetas a timeouts de UI.
- Endpoints internos interceptados no son contractuales y pueden cambiar.
- No hay intercepción de red para descargar el MP4 de un video ajeno: por eso "usar el sonido de un video TikTok por su `video_url`" queda fuera y se cubre vía `tiktok_mix_media` con una URL/path de audio local (el flujo nativo "Use sound" de Studio arranca grabación y no aplica a un MP4 pre-editado).

**Del MCP:**
- Registro de operaciones podado a 2.000; métricas a 50.000 filas; acciones a 48 h (afecta ventanas históricas largas).
- `tiktok_scheduled` solo ve lo registrado por este MCP.
- Analíticas limitadas a lo visible en el listado del content manager.

**De seguridad:**
- Los perfiles de navegador contienen cookies de sesión válidas: proteger el directorio de datos (chmod 600 solo cubre `state.json`).
- Screenshots de diagnóstico contienen contenido de la cuenta.

**De testing:**
- Ningún test automatizado ejercita TikTok real; la validación final de cada operación es manual.

---

## 20. Regla fundamental

Este documento debe representar el estado REAL del sistema. Nunca documentar como implementada una capacidad que solamente esté planificada. Cuando una implementación cambie significativamente la arquitectura, actualizar este documento en el mismo cambio (secciones 3, 4, 5, 18 y las que apliquen).
