# Topologia Objetivo STG - Cloud Run (GCP-first)

## 1) Objetivo de arquitectura
Pasar STG a una topologia coherente en Google Cloud, manteniendo riesgo bajo y aprendizaje alto.

```text
[Firebase Hosting STG]
  -> [Cloud Run API]
       -> [DB]
         opcion A (lab): Postgres actual (Supabase temporal)
         opcion B (full GCP): Cloud SQL Postgres
       -> [Storage]
         opcion A (lab): Supabase buckets temporal
         opcion B (full GCP): Cloud Storage
       -> [Chat realtime bus]
         opcion A minima: memory (solo 1 instancia)
         opcion B correcta: Redis (Memorystore)

[Cloud Run Reels Worker]
  -> procesa cola de reels
  -> sube media final

[Cloud Run Ops Worker]
  -> scheduler + maintenance

[Cloud Logging + Monitoring + Secret Manager]
```

## 2) Por que Cloud Run > VM en este caso
- Deploy y rollback por revision.
- Logs centralizados nativos.
- IAM/Secret Manager mas prolijo.
- Menos drift operativo manual que VM + pm2.
- Replica natural para el futuro espacio empresarial DM.

## 3) Riesgo clave del repo actual para Cloud Run

### 3.1 Workers actuales son procesos long-running
Evidencia:
- `src/workers/reelsWorker.ts` usa `setInterval(...)` continuo.
- `src/workers/maintenanceWorker.ts` usa `setInterval(...)` + `startSchedulers(...)`.

Implicacion:
- Cloud Run **Jobs** no encaja perfecto sin modo run-once.
- Cloud Run **Services** con `min-instances=0` pueden dormir y no ejecutar timers.

### 3.2 Hay estado en memoria local
Evidencia:
- Chat broker local: `src/domains/chat/realtime.ts`.
- Cola local media: `src/services/reelsMedia.service.ts` (`videoQueue`, `completedJobs`).

Implicacion:
- Multi-instancia rompe consistencia.
- Para escalar bien se necesita estado externo (Cloud Tasks/Redis).

## 4) Opciones STG-lab realistas

### Opcion 1 (sin tocar codigo, rapida)
- Cloud Run API service (1 instancia).
- Cloud Run Reels Worker service (`min-instances=1`) para mantener loop.
- Cloud Run Ops Worker service (`min-instances=1`) para scheduler.
- Pros: no cambia codigo.
- Contras: no es full free; costo basal por instancias minimas activas.

### Opcion 2 (recomendada para low-cost real)
- Agregar modo run-once en workers (pendiente, no ejecutado aqui).
- Ejecutar workers como Cloud Run Jobs + Cloud Scheduler.
- Pros: costo muy bajo por ejecucion.
- Contras: requiere cambio pequeño de codigo (imprescindible para Jobs).

## 5) Recomendacion tecnica para este laboratorio
1. Fase inicial: API en Cloud Run primero.
2. Luego mover Reels Worker.
3. Mantener DB/Storage temporales mientras no haya cuenta empresarial.
4. Cuando DM habilite espacio robusto: migrar DB/Storage/realtime a stack GCP completo.

## 6) TODOs obligatorios antes de llamar esto “full Google”
- TODO: decidir si STG-lab acepta costo minimo por servicios always-on.
- TODO: decidir run-once para workers (si se busca costo muy bajo).
- TODO: definir Redis (Memorystore) para chat multi-instancia.
- TODO: definir cola externa para reels (Cloud Tasks o Pub/Sub).
