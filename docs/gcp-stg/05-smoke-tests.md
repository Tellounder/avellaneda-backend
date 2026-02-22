# Smoke Tests STG (10 minutos)

Objetivo: validar que STG es usable antes de seguir con migracion.

## Escala de severidad
- `S0`: bloquea salida (core roto).
- `S1`: funcionalidad critica degradada.
- `S2`: issue menor o workaround disponible.

## Checklist rapido

| # | Caso | Severidad | Paso | OK | FAIL |
|---|---|---|---|---|---|
| 1 | Login admin | S0 | Ingresar con cuenta admin en STG | Accede a panel admin y `/auth/me` devuelve rol correcto | No autentica o no reconoce rol |
| 2 | Listado tiendas home | S0 | Abrir home y seccion tiendas | Carga datos reales sin skeleton infinito | No carga, 5xx, o loops |
| 3 | Alta tienda | S1 | Crear tienda desde admin | Guarda y aparece en listados | Error API/validacion rota |
| 4 | Upload logo tienda | S1 | Subir imagen en flujo tienda/autoregistro | URL final valida y visible | Error storage o URL invalida |
| 5 | Crear reel foto | S0 | Publicar reel `PHOTO_SET` | `PROCESSING -> ACTIVE/HIDDEN` en ventana razonable | Queda en `PROCESSING` infinito |
| 6 | Crear reel video | S0 | Publicar reel `VIDEO` | Worker procesa y finaliza estado | Timeout/OOM/error permanente |
| 7 | Estado reel | S0 | Consultar `/reels/:id/status` | Devuelve payload consistente | 401/403 inesperado o no cambia estado |
| 8 | Reels publicos | S1 | Ver tira de reels en home | Reels activos visibles y reproducibles | No aparecen o media rota |
| 9 | Chat cliente->tienda | S1 | Enviar texto/imagen y recibir evento | mensaje persiste + SSE/polling actualiza | no persiste o no notifica |
| 10 | Share basico | S2 | Abrir `/share/reels/:id` y `/share/streams/:id` | Responde con metadata/preview | error 404/500 |

## Criterio de aprobacion
- Release candidato STG aceptable si:
  - 0 fallos S0
  - maximo 1 fallo S1 con workaround documentado
  - S2 abiertos con ticket

## Evidencia minima por test
- Captura de pantalla.
- Network (request/response clave).
- ID de recurso (shopId/reelId/conversationId).
- Timestamp local.

## Endpoints a vigilar durante smoke
- `GET /auth/me`
- `GET /shops/featured`
- `GET /streams`
- `GET /reels`
- `POST /storage/reels/upload-url`
- `POST /storage/reels/confirm`
- `POST /reels`
- `GET /reels/:id/status`
- `GET /chat/events/stream`

## Notas operativas
- Si reel queda en `PROCESSING`, revisar inmediatamente logs de worker y timeout/retries.
- Si chat SSE falla, validar fallback por polling de conversaciones cada 30s en widgets chat (`ClientChatWidget` y `ShopChatWidget`).
