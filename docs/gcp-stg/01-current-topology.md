# Topologia Actual - PROD vs STG

## 1) Mapa actual verificable

### PROD (segun repo)
```text
[Browser]
  -> Firebase Hosting (front prod)
      -> API Render (VITE_API_URL=https://avellaneda-backend.onrender.com)
          -> Postgres (Prisma: DATABASE_URL/DIRECT_URL)
          -> Supabase Storage (reels/chat/reports)
  -> Workers backend (reels + maintenance)
```

### STG (segun repo)
```text
[Browser]
  -> Firebase Hosting stg (project stg-avellanedaenvivo)
      -> API Render STG (VITE_API_URL=https://stg-avellaneda-backend.onrender.com)
          -> Postgres STG (DATABASE_URL/DIRECT_URL en .env.staging)
          -> Supabase Storage STG (reels/chat/reports)
  -> Workers: definidos por script en backend, pero runtime final fuera de git (TODO inventario consola)
```

## 2) Evidencia tecnica por componente

| Componente | Evidencia repo | Observacion |
|---|---|---|
| Front prod URL | `distrito-moda--avellaneda -en-vivo/.env.production` | API/share en `avellaneda-backend.onrender.com` |
| Front stg URL | `distrito-moda--avellaneda -en-vivo/.env.staging` | API/share en `stg-avellaneda-backend.onrender.com` |
| Firebase projects | `distrito-moda--avellaneda -en-vivo/.firebaserc` | aliases `prod` y `stg` definidos |
| API rutas base | `src/app/app.ts` | `/streams`, `/reels`, `/shops`, `/chat`, `/storage`, etc. |
| API start | `package.json` | `start`, `start:render` |
| Workers scripts | `package.json` | `worker:reels`, `worker:maintenance` |
| DB Prisma | `prisma/schema.prisma` | `DATABASE_URL` + `DIRECT_URL` |
| Storage | `src/domains/storage/service.ts` | buckets `SUPABASE_REELS_BUCKET`, `SUPABASE_CHAT_BUCKET`, `SUPABASE_REPORTS_BUCKET` |
| Realtime chat | `src/domains/chat/realtime.ts` | broker actual in-memory |
| SSE endpoint | `src/routes/chat.routes.ts` + `src/domains/chat/controller.ts` | `/chat/events/stream` |
| Reels worker tuning | `src/workers/reelsWorker.ts` | batch, interval, timeout, retries, lock ttl |
| Reels media engine | `src/services/reelsMedia.service.ts` | ffmpeg/sharp, queue en memoria |

## 3) Inconsistencias detectables hoy

1. URLs STG backend no unificadas:
- Front STG apunta a `https://stg-avellaneda-backend.onrender.com` (`.env.staging` front).
- Backend STG publica share/backend como `https://avellaneda-backend-stg.onrender.com` (`.env.staging` backend).
- Riesgo: links/share/callbacks cruzados.

2. Realtime con bus local en memoria:
- `src/domains/chat/realtime.ts` fuerza modo `memory`.
- En multi-instancia no comparte eventos entre instancias.

3. Cola async de video dentro del proceso API:
- `src/services/reelsMedia.service.ts` usa `videoQueue[]`, `completedJobs` y `queueRunning` en memoria local.
- Riesgo alto si se escala horizontalmente (estado no compartido).

4. Límite de reel hard en 10s (no 15):
- Backend clamp: `src/domains/reels/service.ts:134` y uso `src/domains/reels/service.ts:237`.
- Front manda 10s: `components/Dashboard.tsx:666` y `components/Dashboard.tsx:891`.

5. Infra no versionada en IaC:
- No hay `render.yaml`, `Dockerfile`, `terraform`, `cloudbuild`.
- Riesgo de drift entre consola y repo.

## 4) Que no se puede afirmar solo con repo (TODO)
- Estado real de workers hoy en STG (Render vs VM vs mixto): requiere inventario en consolas.
- Tamaños de instancia efectivos por servicio desplegado.
- Limites reales de cuenta y cuotas cloud actuales.
