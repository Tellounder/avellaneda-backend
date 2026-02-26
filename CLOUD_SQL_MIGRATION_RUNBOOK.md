# Migracion a Cloud SQL + Estabilizacion Runtime (Google Cloud)

Fecha: 2026-02-26
Servicio: `avvivo-api` (Cloud Run, `us-west2`)

## 1) Objetivo
- Migrar PostgreSQL actual a Cloud SQL sin downtime perceptible.
- Eliminar puntos criticos in-memory para multi-instancia.
- Dejar rollback claro en caso de incidente.

## 2) Estado actual (repositorio)
- Prisma + PostgreSQL: `prisma/schema.prisma`.
- Migraciones: `prisma/migrations/*` (20 aplicadas).
- Runtime in-memory existente:
  - chat realtime broker: `src/domains/chat/realtime.ts`
  - rate limit/cache: `src/middleware/rateLimit.ts`, `src/middleware/cache.ts`, `src/utils/publicCache.ts`
  - dedup de views: `src/domains/streams/service.ts`
- Desde este cambio: Redis opcional soportado con fallback seguro en memoria.

## 3) Fase A - Preflight tecnico (sin tocar produccion)
1. Variables minimas en entorno de deploy:
   - `DATABASE_URL`
   - `DIRECT_URL` (recomendado para Prisma migrate)
   - `REDIS_URL` (recomendado para multi-instancia real)
2. Ejecutar:
```bash
npm install
npm run preflight:cloud
```
3. Resultado esperado:
   - `DB connectivity: OK`
   - `Redis connectivity: OK` o `SKIP` (si todavia no se configuro)

## 4) Fase B - Provisionar Cloud SQL (Google)
1. Crear instancia PostgreSQL (HA regional, backups y PITR activos).
2. Crear DB de aplicacion (ejemplo: `avvivo_prod`).
3. Crear usuario dedicado de aplicacion.
4. Conectar Cloud Run -> Cloud SQL:
   - Cloud Run > `avvivo-api` > Editar y desplegar nueva revision > Conexiones > Cloud SQL.
5. Guardar credenciales en Secret Manager.

## 5) Fase C - Migracion de datos sin corte (DMS)
1. Crear job de Database Migration Service:
   - Source: Postgres actual (Supabase).
   - Destination: Cloud SQL.
   - Modo: continuous migration (CDC).
2. Esperar estado `CDC running`.
3. Validar conteos de tablas criticas (`Shop`, `Stream`, `Reel`, `QuotaWallet`, `PurchaseRequest`, `ChatConversation`, `ChatMessage`).

## 6) Fase D - Cutover controlado
1. Anunciar ventana corta (5-10 min).
2. Poner frontend en modo mantenimiento (solo escritura) o bloquear escrituras en backend temporalmente.
3. Promover destino en DMS.
4. Deploy de nueva revision Cloud Run con:
   - `DATABASE_URL` apuntando a Cloud SQL.
   - `DIRECT_URL` apuntando a Cloud SQL.
5. Ejecutar migraciones en destino:
```bash
npx prisma migrate deploy
```
6. Verificar salud:
   - `GET /system/status` (admin)
   - smoke test de: auth, tiendas, streams, reels, pagos, chat.
7. Enrutar trafico gradual: 10% -> 50% -> 100%.

## 7) Fase E - Estabilizacion runtime (post-cutover)
1. Levantar Memorystore Redis.
2. Configurar envs:
   - `REDIS_URL=redis://<host>:6379`
   - `REDIS_KEY_PREFIX=avvivo`
   - `CHAT_REALTIME_BUS=redis`
   - `CHAT_REALTIME_REDIS_CHANNEL=chat:events`
3. Deploy backend.
4. Confirmar en `GET /system/status`:
   - `redis.configured=true`
   - `chatRealtime.effectiveMode=redis`

## 8) Rollback (si hay incidente)
1. Mantener revision previa de Cloud Run con trafico 0%.
2. Si hay error severo:
   - volver trafico 100% a revision previa.
   - reactivar origen (Supabase) como DB principal.
3. Investigar causa y repetir cutover en nueva ventana.

## 9) Checklist de validacion final
- Login cliente/tienda/admin.
- Recupero de clave por Resend.
- Alta/edicion de tienda.
- Publicacion reel y procesamiento.
- Agenda de vivo + recordatorio.
- Compra MercadoPago + confirmacion.
- Chat cliente/tienda realtime.
- `/system/status` sin errores.

## 10) Notas operativas
- No ejecutar `gcloud` desde PC local si no esta instalado; usar Cloud Shell.
- Mantener `migrate deploy` solo en pipeline/release, no en runtime de cada request.
- No remover origen hasta cumplir 48-72h de observacion estable.
