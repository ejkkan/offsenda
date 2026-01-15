#!/bin/bash
cd /Users/erikmagnusson/Programming/batchsender
echo "Stopping all services..."
pkill -f "pnpm --filter" 2>/dev/null || true
pkill -f "tsx watch" 2>/dev/null || true
docker compose -f docker-compose.local.yml down
docker compose -f docker-compose.monitoring.yml down
rm -f .env.worker.tmp worker.log web.log
echo "✓ All services stopped"
