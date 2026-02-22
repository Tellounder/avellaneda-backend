# Plan por Fases - STG a GCP (Cloud Run)

Este plan es manual y no ejecuta nada automaticamente.

## Fase A - API en Cloud Run (sin mover DB aun)

### Objetivo
Levantar la API STG en Cloud Run usando la DB actual (temporal) para validar routing/auth/endpoints.

### Checklist de consola (manual)
- Crear servicio Cloud Run `avvivo-stg-api`.
- Runtime Node (buildpack o container).
- Setear vars equivalentes de API (`03-env-matrix.md`).
- Definir `CORS_ORIGINS` incluyendo `https://stg-avellanedaenvivo.web.app`.
- Publicar URL HTTPS de Cloud Run.
- Cambiar `VITE_API_URL` y `VITE_SHARE_URL` de STG al nuevo URL.

### Cambios de repo (solo si hace falta)
- Ninguno obligatorio para esta fase.

### Riesgos
- CORS mal configurado.
- Secretos Firebase incompletos (`FIREBASE_PRIVATE_KEY`).
- URL STG inconsistente en share/public backend.

### Valida que funciono
- `GET /shops/featured`, `GET /streams`, `GET /reels` responden desde Cloud Run.
- Login Firebase + `GET /auth/me` correcto.

---

## Fase B - Reels Worker en Cloud Run

### Objetivo
Procesar al menos 1 reel completo en STG (PROCESSING -> ACTIVE/HIDDEN) sin VM.

### Opcion B1 (sin cambios de codigo, mas simple)
- Crear servicio Cloud Run `avvivo-stg-reels-worker`.
- Comando: `npm run worker:reels`.
- Mantener 1 instancia activa.

### Opcion B2 (recomendada low-cost real)
- Convertir worker a modo run-once y usar Cloud Run Jobs + Scheduler.

### Cambios de repo imprescindibles si se elige B2
- Agregar flag de salida al worker reels (ej: `REEL_WORKER_RUN_ONCE=true`) para procesar un ciclo y terminar.
- Sin ese cambio, Job no finaliza naturalmente (porque hoy hay loop infinito con `setInterval`).

### Riesgos
- OOM por ffmpeg.
- Timeouts de descarga/proceso.
- Estado en memoria local no compartido si hay >1 instancia.

### Valida que funciono
- Crear reel video/foto en STG.
- Ver status avanzar y finalizar.
- Ver media final accesible.

---

## Fase C - Ops Worker en Cloud Run

### Objetivo
Mover scheduler/maintenance a Cloud Run y evitar dependencia VM.

### Opcion C1 (sin cambios de codigo)
- Servicio Cloud Run continuo con `npm run worker:maintenance`.

### Opcion C2 (low-cost recomendada)
- Worker run-once + Cloud Run Jobs + Scheduler por periodicidad.

### Cambios de repo imprescindibles si se elige C2
- Flag run-once para maintenance worker.

### Riesgos
- Cron duplicado si queda activo en API y worker.
- Drift de flags `ENABLE_*_CRON`.

### Valida que funciono
- `GET /system/status` refleja flags esperados.
- Logs de scheduler visibles en Cloud Logging.

---

## Fase D - Endurecimiento STG para replica empresarial

### Objetivo
Dejar blueprint para mover luego a cuenta DM robusta.

### Checklist
- Definir cola externa (Cloud Tasks) para procesamiento desacoplado.
- Definir bus realtime externo (Redis/Memorystore) para SSE multi-instancia.
- Definir paso de Storage a GCS (si se exige full Google).
- Definir paso de DB a Cloud SQL (si se exige full Google).
- Mover secretos a Secret Manager.

### Cambios de repo potenciales
- Adaptador storage GCS (hoy storage esta acoplado a Supabase en `src/domains/storage/service.ts` y `src/services/reelsMedia.service.ts`).
- Adaptador de bus realtime no-memory en `src/domains/chat/realtime.ts`.
- Adaptador cola real para reels (hoy en memoria).

### Riesgos
- Intentar escalar sin sacar estado en memoria.
- Mezclar cambios de negocio y migracion infra en un mismo release.

### Valida que funciono
- Smoke tests completos verdes.
- Logs/alertas operativas activas.

---

## Criterio de salida por fase
- Fase A salida: login + listados basicos OK.
- Fase B salida: reel publicado de punta a punta OK.
- Fase C salida: cron/maintenance estables fuera de VM.
- Fase D salida: blueprint listo para migracion empresarial.

---

## Pedido al senior de Distrito Moda (cuando me den GCP empresarial)
Necesito un espacio aislado replicable desde este laboratorio, con:
- Proyecto o namespace dedicado para Avellaneda en Vivo.
- IAM por minimo privilegio (deploy Cloud Run + lectura logs + gestionar secrets del proyecto asignado).
- Cloud Run para API + workers.
- Secret Manager habilitado.
- Logging/Monitoring con alertas basicas.
- Definicion de red y politicas para DB/Redis/Storage.

Este blueprint de lab esta pensado para escalarse sin rehacer arquitectura, solo aumentando capacidad y formalizando servicios gestionados.
