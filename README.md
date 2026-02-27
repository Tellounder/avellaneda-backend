# Avellaneda en Vivo - Backend

API central del ecosistema Avellaneda en Vivo. Expone reglas de negocio, permisos por rol, operaciones comerciales y servicios de soporte para frontend y paneles internos.

## 1) Snapshot actual (produccion)

Estado consolidado al 2026-02-27:

- Runtime API: Cloud Run (`avvivo-api`, `us-west2`)
- Base de datos: Cloud SQL PostgreSQL 15 (`avvivo-sql-prod`)
- Cache/rate-limit/realtime bus: Memorystore Redis (`avvivo-redis-prod`)
- Storage de media y reportes: Google Cloud Storage (`avvivo-reels-prod`)
- Auth server-side: Firebase Admin
- Email transaccional: Resend
- Cobros: MercadoPago

## 2) Objetivo del servicio

Resolver de forma consistente:

- control de identidad y roles (`CLIENT`, `SHOP`, `ADMIN`)
- gestion de tiendas, vivos, reels y agenda
- cupos, compras y auditoria/sanciones
- chat cliente-tienda en tiempo real
- media upload y procesamiento de contenido
- share pages para SEO/social preview

## 3) Arquitectura

```text
Frontend (React/Firebase Hosting)
        |
        v
Cloud Run: avvivo-api (Express + Prisma)
        |
        +--> Cloud SQL (PostgreSQL)
        +--> Memorystore Redis (rate-limit/cache/chat bus)
        +--> Cloud Storage (reels/chat/reportes)
        +--> Firebase Admin (tokens/identity)
        +--> Resend (correo)
        +--> MercadoPago (pagos/webhooks)
```

## 4) Stack tecnico

- Node.js + TypeScript
- Express 4
- Prisma ORM
- PostgreSQL
- ioredis
- Firebase Admin SDK
- Multer + Sharp + ffmpeg (pipeline de media)

## 5) Dominios funcionales

Carpetas en `src/domains/`:

- `auth`
- `clients`
- `shops`
- `streams`
- `reels`
- `chat`
- `storage`
- `payments`
- `purchases`
- `notifications`
- `reports`
- `reviews`
- `agenda`
- `penalties`
- `share`
- `system`
- `testpanel`

Patron interno:

- `controller.ts`: entrada HTTP
- `service.ts`: logica de negocio
- `repo.ts`: acceso o helper de persistencia por dominio

## 6) Rutas HTTP (mapa operativo)

Base route registration en `src/app/app.ts`.

### Auth

- `POST /auth/forgot-password`
- `POST /auth/send-verification`
- `GET /auth/me`

### Shops

- `GET /shops`, `GET /shops/featured`, `GET /shops/by-letter`, `GET /shops/map-data`
- `POST /shops` (admin)
- `POST /shops/self-register`
- `PUT /shops/:id`, `DELETE /shops/:id`
- Acciones de negocio: `assign-owner`, `accept`, `activate`, `reject`, `toggle-penalty`, `suspend-agenda`, `lift-suspension`, `reset-password`, `send-invite`, compra de cuotas

### Streams (vivos)

- `GET /streams`, `GET /streams/:id`, `GET /streams/:id/calendar.ics`
- `POST /streams`, `PUT /streams/:id`, `DELETE /streams/:id`
- lifecycle: `live`, `continue`, `finish`, `cancel`, `ban`, `hide`, `show`
- interacciones: `report`, `rate`, `like`, `view`
- control cron/manual: `POST /streams/run-lifecycle`

### Reels

- `GET /reels`, `GET /reels/admin`, `GET /reels/shop/:shopId`, `GET /reels/:id`, `GET /reels/:id/status`
- `POST /reels`
- `POST /reels/:id/hide`, `POST /reels/:id/reactivate`, `POST /reels/:id/view`
- `DELETE /reels/:id`

### Storage

- `POST /storage/reels/upload-url`
- `POST /storage/reels/confirm`
- `POST /storage/reels/upload`
- `POST /storage/chat/upload-url`
- `POST /storage/chat/confirm`
- `POST /storage/shops/upload`
- `POST /storage/reports/upload`
- `GET /storage/reports/view`

### Chat

- cliente: conversaciones, mensajes, read
- tienda: conversaciones, mensajes, read
- stream SSE: `GET /chat/events/stream`

### Otros

- `notifications`, `reports`, `reviews`, `agenda`, `purchases`, `payments`, `share`, `system`, `testpanel`

## 7) Modelo de datos

Fuente de verdad: `prisma/schema.prisma`.

Ejes principales:

- identidad: `AuthUser`, `Client`, `Shop`, `Admin`
- contenido: `Stream`, `Reel`
- relacion cliente-contenido: favoritos, reminders, reviews, reports, views, likes
- negocio: `QuotaWallet`, `QuotaTransaction`, `PurchaseRequest`
- control operativo: sanciones, auditoria, schedule events, notificaciones
- chat: conversaciones, mensajes, estado de lectura

Migraciones: carpeta `prisma/migrations/`.

## 8) Variables de entorno

### Core (obligatorias)

- `DATABASE_URL`
- `DIRECT_URL`
- `NODE_ENV`
- `PORT` (cloud run inyecta por defecto)

### Auth / seguridad

- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
- `ADMIN_EMAILS`

### Integraciones

- `RESEND_API_KEY`
- `RESEND_FROM`
- `MP_ACCESS_TOKEN`
- `MP_WEBHOOK_SECRET`

### Runtime distribuido

- `REDIS_URL`
- `REDIS_KEY_PREFIX`
- `CHAT_REALTIME_BUS=redis`
- `CHAT_REALTIME_REDIS_CHANNEL`

### Storage provider

- `STORAGE_PROVIDER=gcs`
- `GCS_BUCKET`
- `GCS_CHAT_BUCKET`
- `GCS_REPORTS_BUCKET`
- `GCS_PUBLIC_BASE_URL`

### App URLs / CORS

- `APP_URL`
- `FRONTEND_URL`
- `PUBLIC_APP_URL`
- `PUBLIC_SHARE_URL`
- `PUBLIC_BACKEND_URL`
- `CORS_ORIGINS`

## 9) Scripts del repo

- `npm run dev`
- `npm run start`
- `npm run preflight:cloud`
- `npm run sanctions:run`
- `npm run qa:step7`
- `npm run worker:reels`
- `npm run worker:maintenance`
- backfills/imports en carpeta `scripts/`

## 10) Desarrollo local

1. `npm install`
2. configurar `.env`
3. `npx prisma generate`
4. `npm run dev`

API local por defecto: `http://localhost:3000`.

## 11) Operacion cloud (actual)

Confirmado en produccion:

- Cloud Run con connector a Cloud SQL
- VPC connector para salida privada a Redis
- Rate limit con cabecera `x-ratelimit-store: redis`
- Storage operativo en GCS (`storage.googleapis.com/avvivo-reels-prod/...`)
- Variables `SUPABASE_*` removidas de runtime Cloud Run

## 12) Checklist de smoke test recomendado

1. `POST /auth/forgot-password` -> `200`
2. `GET /shops/featured` -> `200`
3. `GET /streams` -> `200`
4. `GET /reels` -> `200`
5. `POST /storage/reports/upload` -> `rawUrl` en GCS
6. chat stream no autenticado -> `401/403` esperado

## 13) Storytelling (cierre)

Este backend empezo como soporte de una demo funcional y termino convirtiendose en el nucleo operativo de una plataforma comercial real. La evolucion fue de un stack inicial orientado a velocidad de salida a una arquitectura cloud distribuida con base de datos dedicada, cache/realtime centralizado y storage escalable.

La historia tecnica de este repo es la de una transicion controlada: primero validar negocio, despues endurecer operacion, y finalmente consolidar un servicio capaz de sostener carga real sin perder trazabilidad ni gobierno funcional.
