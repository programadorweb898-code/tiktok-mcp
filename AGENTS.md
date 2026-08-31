# AGENTS.md — Instrucciones para agentes

Este archivo es el documento principal de instrucciones para agentes que trabajen en este proyecto.

- NO debe contener detalles específicos de implementación que deberían vivir en skills.
- NO debe inventar capacidades, APIs, endpoints, selectores ni comportamientos de TikTok.
- Debe respetar y aprovechar la arquitectura existente del repositorio.
- Antes de modificar código, el agente debe inspeccionar la implementación existente y reutilizar sus patrones.
- No realizar refactors grandes cuando una modificación localizada sea suficiente.

## Objetivo del proyecto

Desarrollamos un MCP local para automatizar TikTok mediante un navegador persistente y Playwright.

El objetivo final es proporcionar a un agente una interfaz MCP capaz de realizar la mayor cantidad posible de operaciones que un usuario real puede realizar en TikTok.

El proyecto debe priorizar:

1. Uso de APIs oficiales de TikTok cuando una capacidad esté disponible y sea apropiada.
2. Browser automation con Playwright cuando la API oficial no proporcione la capacidad necesaria.
3. Implementaciones locales y self-hosted.
4. Seguridad de las sesiones y credenciales.
5. Verificación de cada operación realizada.
6. Manejo correcto de errores, estados intermedios, timeouts y rate limits.
7. Compatibilidad con el protocolo MCP.
8. No romper las herramientas existentes.

## Arquitectura

La arquitectura conceptual es:

```
MCP Server
    ↓
Runtime
    ↓
TikTok Operations
    ↓
Browser / APIs
    ↓
TikTok
```

Las nuevas capacidades deben integrarse siguiendo los patrones arquitectónicos existentes.

## Reglas de desarrollo

- Inspeccionar primero el código existente antes de implementar una nueva funcionalidad.
- Buscar implementaciones similares antes de crear código nuevo.
- Reutilizar funciones, helpers, selectores y mecanismos existentes siempre que sea posible.
- No duplicar lógica.
- No crear una segunda arquitectura paralela.
- Mantener separadas:
  - definición de tools MCP
  - runtime
  - operaciones de TikTok
  - selectores
  - manejo de sesión
  - rate limiting
  - manejo de errores
  - tests
- Toda nueva tool MCP debe tener validación de parámetros.
- Toda operación de navegador debe verificar que la acción realmente ocurrió.
- No asumir que un click exitoso significa que TikTok procesó correctamente la operación.
- Evitar selectores frágiles cuando existan estrategias de selección más robustas.
- Respetar los mecanismos existentes de autenticación y perfiles persistentes.
- No almacenar credenciales o cookies sensibles en el código fuente.
- No introducir secretos en Git.
- No modificar archivos no relacionados con la tarea.

## MCP

Cada nueva capacidad debe exponerse como una tool MCP solamente cuando tenga una operación real implementada detrás.

Las tools deben:

- tener nombres claros;
- tener descripciones precisas;
- definir correctamente sus parámetros;
- devolver resultados estructurados cuando sea apropiado;
- devolver errores útiles;
- evitar afirmar que una operación fue exitosa si no pudo verificarse.

## Testing

Después de modificar código:

1. Ejecutar typecheck.
2. Ejecutar los tests existentes.
3. Crear o actualizar tests para la nueva funcionalidad cuando sea razonablemente posible.
4. No eliminar tests existentes para ocultar fallos.
5. Si una funcionalidad requiere interacción real con TikTok para validarse, diferenciar claramente entre:
   - tests unitarios;
   - tests de integración;
   - pruebas manuales con una cuenta real.

## Git

- No hacer commits automáticamente salvo que el usuario lo solicite.
- No hacer push automáticamente.
- No modificar la rama principal sin autorización explícita.
- Antes de realizar cambios importantes, explicar brevemente qué archivos serán modificados.
- Mantener los cambios pequeños y revisables.

## SDD

El archivo `SDD.md` será la especificación de diseño del proyecto.

Antes de realizar cambios arquitectónicos:

- consultar `SDD.md`;
- comprobar que el cambio sea compatible con sus objetivos;
- actualizar `SDD.md` si la arquitectura cambia realmente.

## Skills y subagentes

El conocimiento especializado debe mantenerse fuera de este archivo siempre que sea posible.

Utilizar skills para conocimiento específico como:

- automatización del navegador TikTok;
- engagement;
- analytics;
- testing;
- discovery;
- LIVE;
- MCP.

Los subagentes especializados deben utilizarse únicamente cuando aporten una ventaja real y la tarea sea suficientemente independiente.

No crear subagentes innecesarios para tareas pequeñas.

## Orquestación

Cuando una solicitud involucre varias áreas:

1. Identificar qué componentes están afectados.
2. Consultar las skills correspondientes.
3. Delegar tareas independientes cuando sea beneficioso.
4. Integrar los resultados en el agente principal.
5. Revisar que la implementación final respete la arquitectura completa.
6. Ejecutar typecheck y tests.

## Principio fundamental

No implementar una funcionalidad simplemente porque "parece posible".

Primero determinar:

- si TikTok proporciona una API oficial;
- si la capacidad ya existe en el repositorio;
- si existe una implementación reutilizable;
- qué limitaciones tiene;
- cómo verificar que realmente funciona.

Priorizar siempre:

correctitud > seguridad > mantenibilidad > cobertura de funcionalidades > velocidad de implementación.

Cuando exista incertidumbre sobre el comportamiento de TikTok, inspeccionar el código existente, documentación disponible o realizar una prueba controlada antes de asumir el comportamiento.

Nunca inventar APIs, endpoints, selectores o capacidades de TikTok.
