# Matriz de Variables de Entorno (STG-lab vs PROD)

Regla:
- Se listan nombres y uso.
- **No** se exponen secretos.
- Cuando aplica, se muestra solo valor no sensible (URL/dominios).

## 1) Frontend (`distrito-moda--avellaneda -en-vivo`)

Evidencia: `.env.local`, `.env.production`, `.env.staging`, `services/apiModules/http.ts`, `firebase.ts`.

| Variable | STG-lab | PROD | Uso |
|---|---|---|---|
| `VITE_API_URL` | `https://stg-avellaneda-backend.onrender.com` | `https://avellaneda-backend.onrender.com` | Base API (`services/apiModules/http.ts`) |
| `VITE_SHARE_URL` | `https://stg-avellaneda-backend.onrender.com` | `https://avellaneda-backend.onrender.com` | Links share front |
| `VITE_FIREBASE_PROJECT_ID` | `stg-avellanedaenvivo` | `avellaneda-en-vivo` | Proyecto Firebase Auth |
| `VITE_FIREBASE_AUTH_DOMAIN` | `stg-avellanedaenvivo.firebaseapp.com` | `avellaneda-en-vivo.firebaseapp.com` | Auth domain |
| `VITE_FIREBASE_*` | presente | presente | Config Firebase web SDK |
| `VITE_PREACCESS_*` | presente | presente | Pantalla preacceso |
| `VITE_MP_PUBLIC_KEY` | presente | presente | Front pagos |
| `VITE_GOOGLE_MAPS_KEY` | presente en local | TODO confirmar stg/prod | Maps |

## 2) Backend API (`avellaneda-backend`)

Evidencia: `.env.staging`, `.env`, `src/app/app.ts`, `src/app/server.ts`, `src/domains/storage/service.ts`, `prisma/schema.prisma`.

| Variable | STG-lab | PROD (repo) | Uso |
|---|---|---|---|
| `NODE_ENV` | `staging` | TODO confirmar runtime real | Entorno |
| `PORT` | presente | inyectado por plataforma | puerto API |
| `RUN_SCHEDULERS_IN_API` | `false` | TODO confirmar | scheduler en API |
| `DATABASE_URL` | presente | presente | Prisma datasource |
| `DIRECT_URL` | presente | presente | Prisma directUrl |
| `CORS_ORIGINS` | incluye `stg-avellanedaenvivo.web.app` | incluye dominios prod | CORS |
| `APP_URL` | `https://stg-avellanedaenvivo.web.app` | `https://avellaneda-en-vivo.web.app` en `.env` | links |
| `FRONTEND_URL` | presente | TODO confirmar | links/payments/share |
| `PUBLIC_APP_URL` | presente | TODO confirmar | share base |
| `PUBLIC_SHARE_URL` | `https://avellaneda-backend-stg.onrender.com` | `https://www.avellanedaenvivo.com.ar` (README ejemplo) | share endpoint |
| `PUBLIC_BACKEND_URL` | `https://avellaneda-backend-stg.onrender.com` | TODO confirmar | report view URL |
| `SUPABASE_URL` | presente | presente | DB/storage integraciones |
| `SUPABASE_SERVICE_ROLE_KEY` | presente | presente | storage server-side |
| `SUPABASE_REELS_BUCKET` | `reels` | `reels` | media reels |
| `SUPABASE_CHAT_BUCKET` | `chat` | TODO confirmar | media chat |
| `SUPABASE_REPORTS_BUCKET` | `reports` | TODO confirmar | reportes QA |

## 3) Reels worker (`npm run worker:reels`)

Evidencia: `src/workers/reelsWorker.ts`, `src/services/reelsMedia.service.ts`.

| Variable | Default codigo | Observacion |
|---|---|---|
| `REEL_WORKER_BATCH` | `3` | lote por ciclo |
| `REEL_WORKER_INTERVAL_MS` | `60000` (min 15000) | frecuencia |
| `REEL_WORKER_DOWNLOAD_TIMEOUT_MS` | `180000` | timeout descarga |
| `REEL_WORKER_DOWNLOAD_RETRY_COUNT` | `4` | retries red |
| `REEL_WORKER_DOWNLOAD_RETRY_BACKOFF_MS` | `1500` | backoff inicial |
| `REEL_WORKER_DOWNLOAD_RETRY_MAX_BACKOFF_MS` | `8000` | techo backoff |
| `REEL_WORKER_PROCESS_TIMEOUT_MS` | `900000` | timeout proceso |
| `REEL_WORKER_LOCK_TTL_MS` | `600000` (min) | stale lock |
| `REEL_WORKER_MAX_RETRIES` | `5` | antes de ocultar |
| `REEL_FFMPEG_THREADS` | `1` (max 2) | CPU ffmpeg |
| `REEL_FFMPEG_TIMEOUT_MS` | `900000` | timeout ffmpeg |
| `REEL_MAX_SOURCE_VIDEO_MB` | `120` | peso max fuente |
| `NODE_OPTIONS` | warning si falta | recomendado `--max-old-space-size=...` |

## 4) Ops worker (`npm run worker:maintenance`)

Evidencia: `src/workers/maintenanceWorker.ts`, `src/app/scheduler.ts`.

| Variable | Default | Uso |
|---|---|---|
| `QUOTA_WALLET_FIX_BATCH` | `25` | maintenance batch |
| `QUOTA_WALLET_FIX_INTERVAL_MS` | `600000` | maintenance loop |
| `ENABLE_NOTIFICATION_CRON` | `false` | recordatorios |
| `ENABLE_SANCTIONS_CRON` | `false` | sanciones |
| `ENABLE_STREAMS_CRON` | `false` (forzado true en worker) | lifecycle vivos |
| `NOTIFICATION_CRON_MINUTES` | `5` | frecuencia |
| `NOTIFICATION_WINDOW_MINUTES` | `15` | ventana |
| `SANCTIONS_CRON_MINUTES` | `30` | frecuencia |
| `STREAMS_CRON_MINUTES` | `1` | frecuencia en scheduler |

## 5) Variables que faltan para STG full-GCP (a definir)

| Variable propuesta | Estado |
|---|---|
| `GOOGLE_CLOUD_PROJECT` | TODO |
| `GCP_REGION` | TODO |
| `CLOUD_TASKS_QUEUE_REELS` | TODO |
| `REDIS_URL` / `MEMORYSTORE_HOST` | TODO |
| `GCS_BUCKET_REELS` / `GCS_BUCKET_CHAT` / `GCS_BUCKET_REPORTS` | TODO |
| `SECRET_MANAGER` bindings | TODO |

## 6) Inconsistencia puntual a corregir antes de migrar
- STG usa dos hostnames backend distintos en envs:
  - front: `stg-avellaneda-backend.onrender.com`
  - back public: `avellaneda-backend-stg.onrender.com`
- Resolver unificacion antes de mover endpoints a Cloud Run.
