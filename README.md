# Avellaneda en Vivo - Backend

API de negocio para el ecosistema de live shopping mayorista. Centraliza reglas, estados, cupos, sanciones, auditoria y compartidos (OG share).

## Que es / como funciona
- **Auth**: Firebase Admin valida el token y determina el rol.
- **Roles**:
  - **Admin**: crea y gestiona tiendas, modera, sanciona.
  - **Tienda**: opera su agenda, reels y datos.
  - **Cliente**: consume y reporta/califica.

El backend es la fuente unica de verdad: la UI solo consulta estados.

## Stack
- Node.js + TypeScript
- Express
- Prisma + PostgreSQL
- Firebase Admin SDK

## Requisitos
- Node.js LTS
- PostgreSQL accesible via `DATABASE_URL`

## Configuracion minima (.env)
```
DATABASE_URL=postgresql://...
FIREBASE_PROJECT_ID=avellaneda-en-vivo
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
ADMIN_EMAILS=admin1@gmail.com,admin2@gmail.com
CORS_ORIGINS=http://localhost:5173,https://avellaneda-en-vivo.web.app,https://www.avellanedaenvivo.com.ar
APP_URL=https://www.avellanedaenvivo.com.ar
PUBLIC_SHARE_URL=https://www.avellanedaenvivo.com.ar
RESEND_API_KEY=re_xxx
RESEND_FROM="Avellaneda en Vivo <no-reply@avellanedaenvivo.com.ar>"
RESEND_REPLY_TO=administracion@avellanedaenvivo.com.ar
NODE_ENV=production
```
Opcionales:
```
ENABLE_NOTIFICATION_CRON=true
ENABLE_SANCTIONS_CRON=true
NOTIFICATION_CRON_MINUTES=5
NOTIFICATION_WINDOW_MINUTES=15
SANCTIONS_CRON_MINUTES=30
REDIS_URL=redis://127.0.0.1:6379
REDIS_KEY_PREFIX=avvivo
CHAT_REALTIME_BUS=redis
CHAT_REALTIME_REDIS_CHANNEL=chat:events
```

## Inicio rapido
1) `npm install`
2) `npm run dev`

## Scripts utiles
- `npm run dev` - servidor en caliente
- `npm run start` - servidor directo
- `npx prisma migrate dev` - migraciones
- `npm run preflight:cloud` - chequeo de conectividad DB/Redis antes de deploy
- `npm run import:shops -- /ruta/datos.json` - importar tiendas
- `npm run backfill:quotawallets` - reparar wallets
- `npm run sanctions:run` - ejecutar sanciones manualmente

## Endpoints clave (referencia)
- `GET /auth/me` - perfil y rol actual
- `POST /auth/forgot-password` - envio de recuperacion de clave via no-reply (Resend)
- `GET /shops` / `PUT /shops/:id` - tiendas
- `POST /streams` / `PUT /streams/:id` - vivos
- `GET /reels` / `POST /reels` - reels
- `GET /reports` - reportes (admin)
- `GET /share/reels/:id` - preview/OG y redirect al front (`?reelId=...`)

## Estructura
- `src/routes` -> rutas
- `src/domains` -> controllers + services por dominio
- `src/services` -> reglas de negocio compartidas
- `prisma/schema.prisma` -> modelo de datos
