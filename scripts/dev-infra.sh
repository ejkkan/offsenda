#!/bin/bash

# Start local development infrastructure (NATS + ClickHouse)

set -e

echo "Starting local development infrastructure..."

# Start only NATS and ClickHouse (not the worker)
docker compose -f docker-compose.local.yml up -d nats clickhouse

echo ""
echo "Waiting for services to be ready..."
sleep 3

# Check NATS
if curl -s "http://localhost:8222/healthz" | grep -q "ok" > /dev/null 2>&1; then
    echo "NATS: Ready (localhost:4222)"
else
    echo "NATS: Starting up..."
fi

# Check ClickHouse
if curl -s "http://localhost:8123/ping" > /dev/null 2>&1; then
    echo "ClickHouse: Ready (localhost:8123)"
else
    echo "ClickHouse: Starting up..."
fi

echo ""
echo "Infrastructure started! You can now run:"
echo "  pnpm dev:worker   # Start the worker service"
echo "  pnpm dev:web      # Start the web app"
echo ""
echo "To stop infrastructure:"
echo "  docker compose -f docker-compose.local.yml down"
