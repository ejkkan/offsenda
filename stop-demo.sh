#!/bin/bash

echo "🛑 Stopping BatchSender Demo..."

# Stop worker and web
echo "Stopping worker and web app..."
pkill -f "turbo dev --filter=worker" 2>/dev/null || true
pkill -f "turbo dev --filter=web" 2>/dev/null || true

# Stop services
echo "Stopping Docker services..."
docker compose -f docker-compose.local.yml down
docker compose -f docker-compose.monitoring.yml down

# Clean up log files
rm -f worker.log web.log

echo "✓ All services stopped"