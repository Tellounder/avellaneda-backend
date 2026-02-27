# RUNBOOK AVVIVO PROD

## Arquitectura actual
- API: avvivo-api (Cloud Run Service)
- Reels worker: avvivo-reels-worker (Cloud Run Worker Pool)
- Ops worker: avvivo-ops-worker (Cloud Run Worker Pool)
- DB: avvivo-sql-prod (Cloud SQL Postgres)
- Cache/ratelimit: Redis Memorystore
- Storage: avvivo-reels-prod (GCS)
- Secrets: Secret Manager

## Health check rapido
gcloud run services describe avvivo-api --region us-west2 --format='value(status.latestReadyRevisionName)'
curl -sS "https://avvivo-api-976745002682.us-west2.run.app/reels?limit=1" | head -c 220; echo
