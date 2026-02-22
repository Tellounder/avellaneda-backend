# STG Lab en Google Cloud - Overview

## 1) Que es este plan
Este plan define como convertir STG en un laboratorio operativo **GCP-first** (didactico, low-cost) sin tocar Produccion.

Objetivo del laboratorio:
- Entender y operar Cloud Run + secretos + observabilidad.
- Validar flujo minimo end-to-end (login, tienda, upload, reel).
- Dejar blueprint replicable para el espacio empresarial de Distrito Moda.

No objetivo (en esta etapa):
- No buscar performance masiva.
- No buscar espejo 1:1 de PROD en capacidad.
- No tocar `main`/PROD.

## 2) Diferencia STG-lab personal vs STG-empresa DM
STG-lab (esta etapa):
- Cuenta personal.
- Presupuesto low-cost.
- Priorizacion: aprendizaje + estabilidad minima.

STG-empresa DM (siguiente etapa):
- Cuenta corporativa GCP.
- Separacion formal IAM/proyecto/servicios.
- Escalado controlado con politicas del senior DM.

## 3) Que NO estamos buscando ahora
- No migrar todo PROD en un solo paso.
- No cambiar UX/StoryModal/cubo.
- No refactor global.
- No medir exito por volumen alto de tiendas concurrentes.

## 4) Evidencia usada (repo real)
- Backend runtime/scripts: `package.json` (`start`, `start:render`, `worker:reels`, `worker:maintenance`).
- Front runtime/scripts: `package.json` (`build:stg`, `deploy:stg`).
- Hosting Firebase (front): `firebase.json`, `.firebaserc`.
- URLs STG/PROD de front: `.env.production`, `.env.staging`.
- Config STG backend: `.env.staging`.
- CORS/rutas API: `src/app/app.ts`.
- SSE + broker: `src/domains/chat/realtime.ts`.
- Worker reels: `src/workers/reelsWorker.ts`.
- Pipeline media/queue: `src/services/reelsMedia.service.ts`.

## 5) Resultado esperado de esta documentacion
Un plan ejecutable manualmente para pasar STG a topologia coherente en GCP, con riesgo acotado y sin impactar PROD.
