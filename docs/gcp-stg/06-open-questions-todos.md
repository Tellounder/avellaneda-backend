# Open Questions y TODOs (STG -> GCP)

## 1) Infra y costos
- TODO: confirmar limites vigentes de free tier en Cloud Run/Cloud Scheduler/Cloud Tasks para esta cuenta.
- TODO: definir presupuesto mensual objetivo de STG-lab.
- TODO: decidir si se acepta `min-instances=1` en workers (costo basal) o si se implementa run-once.

## 2) Diseño de workers en Cloud Run
- TODO: elegir estrategia final:
  - Service continuo (sin cambios de codigo), o
  - Jobs + Scheduler (requiere run-once).
- TODO: definir timeouts y memoria por worker reels para evitar OOM.

## 3) Realtime y escalado
- TODO: decidir bus realtime para chat fuera de memoria local.
- TODO: evaluar Redis/Memorystore para multi-instancia.
- TODO: definir politicas de reconexion y heartbeat en SSE bajo Cloud Run.

## 4) Cola de reels
- TODO: definir si Cloud Tasks entra en low-cost de laboratorio.
- TODO: si no entra, definir alternativa temporal controlada.
- TODO: separar definitivamente “queue local en memoria” del proceso API.

## 5) Storage y DB
- TODO: decidir si STG-lab mantiene Supabase temporal o migra ya a full-GCP.
- TODO: si se exige full Google inmediato:
  - DB -> Cloud SQL (no free realista)
  - Storage -> Cloud Storage (adaptador de codigo requerido)

## 6) Variables y dominios
- TODO: unificar hostname backend STG (hoy hay dos variantes en envs).
- TODO: completar matriz final de env por servicio Cloud Run con naming definitivo.
- TODO: documentar origen unico de verdad para env (evitar drift consola vs archivo).

## 7) Observabilidad
- TODO: definir alertas minimas:
  - error rate API
  - latencia p95
  - reels `PROCESSING` > umbral
  - reinicios worker / OOM
- TODO: checklist de logs operativos por incidente.

## 8) Reels 15 segundos
- Evidencia actual: clamp hard en 10 segundos (`src/domains/reels/service.ts`, `components/Dashboard.tsx`).
- TODO: definir si STG-lab cambia a 15s ahora o despues de estabilizar Cloud Run.
- TODO: acordar test de regresion para 15s (upload, status, playback).

## 9) Inventario fuera de git (pendiente)
- TODO: inventario real de recursos activos hoy (Render + GCP) desde consola.
- TODO: snapshot de configuracion actual para comparacion pre/post migracion.

## 10) Bloqueos a monitorear
- `P2024` pool timeout DB.
- `P1001` DB unreachable.
- `ECONNRESET`/timeouts en descarga media del worker.
- Reels en `PROCESSING` con `processingJobId` nulo o stale.
