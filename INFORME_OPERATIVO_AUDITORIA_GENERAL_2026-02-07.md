# Informe Operativo y Auditor General - 2026-02-07

## Alcance
Se consolidaron cambios en Frontend y Backend para cerrar pendientes prioritarios de estabilidad operativa, coherencia de data-logic y trazabilidad de moderacion/sanciones.

## Cambios implementados
1. Motor de sanciones alineado con regla exacta de negocio:
- Ventana de gracia fijada en 6 minutos.
- Ancla temporal de validacion: `startTime` y fallback `scheduledAt` (sin `endTime`).
- Candidatos del motor: solo vivos con estado `LIVE`.

2. Penalty legacy retirado del flujo activo:
- Endpoint `toggle-penalty` responde `410` con mensaje de desuso.
- Servicio backend deja de operar como no-op silencioso y pasa a error controlado.

3. Conteo de vistas de vivos robustecido end-to-end:
- Dedupe temporal por espectador (`ip + user-agent`) para evitar inflado por loops/reintentos.
- Se mantiene incremento de vistas real en backend cuando corresponde.

4. Endurecimiento de acciones admin (tiendas):
- Front valida `res.ok` en acciones criticas (`activate`, `reject`, `suspend-agenda`, `lift-suspension`, `toggle-penalty`).
- Se muestra feedback de error real en UI admin cuando backend responde fallo.

5. Sincronizacion plan/cupos al editar tienda:
- Si se modifica plan en update admin, se sincroniza `quotaWallet` con limites de plan.

6. Capa anti-caida y scheduler:
- Se mantiene manejo global de errores para evitar crash por errores de pool/DB.
- Scheduler con proteccion anti-solapamiento en ejecuciones.

## Validaciones tecnicas
- Front: `npx tsc -p tsconfig.json --noEmit` OK.
- Back: `npx tsc -p tsconfig.json --noEmit` OK.
- Front build: `npm run build` OK.

## Hallazgo operativo corregido
Durante QA se detecto drift de esquema en DB (`Stream.views` ausente). Se aplico correccion aditiva segura:
- `ALTER TABLE "Stream" ADD COLUMN IF NOT EXISTS "views" INTEGER NOT NULL DEFAULT 0`

## Estado general
- Riesgo de regresion funcional: bajo-medio (con typecheck en verde y QA controlado ejecutado).
- Riesgo operativo por picos: reducido por worker de reels + anti-caida + mejoras de errores UI/API.
- Estado de moderacion/sanciones Paso 7: operativo y validado en escenario controlado.

## Pendientes recomendados (siguiente bloque)
1. Agregar migration formal para `Stream.views` (persistir cambio estructural en historial Prisma).
2. Ejecutar smoke QA manual UI admin/public/shop en produccion tras deploy.
3. Mantener workers separados (web, maintenance, reels) con monitoreo de logs y alertas.
