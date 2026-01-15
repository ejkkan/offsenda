#!/bin/bash

# Check if BatchSender ports are available

echo "🔍 Checking port availability for BatchSender..."
echo "=============================================="

check_port() {
    local port=$1
    local service=$2
    if lsof -i :$port > /dev/null 2>&1; then
        echo "❌ Port $port ($service) is IN USE"
        lsof -i :$port | grep LISTEN | head -1
    else
        echo "✅ Port $port ($service) is available"
    fi
}

check_port 5455 "PostgreSQL"
check_port 4222 "NATS"
check_port 8123 "ClickHouse HTTP"
check_port 9000 "ClickHouse Native"
check_port 6379 "DragonflyDB/Redis"
check_port 9095 "Prometheus"
check_port 3003 "Grafana"
check_port 6001 "Worker API"
check_port 3000 "Web Dashboard"

echo ""
echo "If any ports show as IN USE, you can:"
echo "1. Stop the conflicting service"
echo "2. Or update the port in docker-compose.local.yml and .env.dev"