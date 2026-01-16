#!/bin/bash
# Start local monitoring stack for batchsender

# ⚠️  DEPRECATION WARNING
echo ""
echo -e "\033[1;33m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\033[0m"
echo -e "\033[1;33m  ⚠️  DEPRECATION WARNING\033[0m"
echo -e "\033[1;33m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\033[0m"
echo ""
echo -e "  This script (\033[1mstart-monitoring.sh\033[0m) is deprecated and will be removed on \033[1m2026-02-16\033[0m"
echo ""
echo -e "  \033[1;36m→ New command:\033[0m pnpm monitoring:start"
echo ""
echo -e "  The new monitoring commands provide:"
echo -e "    • pnpm monitoring:start  - Start monitoring stack"
echo -e "    • pnpm monitoring:stop   - Stop monitoring stack"
echo -e "    • pnpm monitoring:open   - Open Grafana dashboard"
echo -e "    • Better status messages"
echo -e "    • Consistent command interface"
echo ""
echo -e "\033[1;33m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\033[0m"
echo ""
read -p "Continue with old script anyway? (y/N) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Exiting. Please use: pnpm monitoring:start"
    exit 0
fi
echo ""

echo "🚀 Starting BatchSender with monitoring..."

# Check if monitoring stack is already running
if docker ps | grep -q prometheus; then
    echo "⚠️  Monitoring stack already running"
else
    echo "📊 Starting monitoring stack (Prometheus + Grafana)..."
    docker compose -f docker-compose.monitoring.yml up -d
    echo "⏳ Waiting for services to be ready..."
    sleep 5
fi

echo ""
echo "✅ Monitoring stack is ready!"
echo ""
echo "📊 Access monitoring tools:"
echo "   Prometheus: http://localhost:9090"
echo "   Grafana:    http://localhost:3003 (admin/admin)"
echo ""
echo "🔍 To verify metrics are being collected:"
echo "   1. Start your worker: pnpm dev:simple"
echo "   2. Check worker metrics: curl localhost:6001/api/metrics"
echo "   3. See in Prometheus: http://localhost:9090/graph?g0.expr=nats_queue_depth"
echo ""
echo "📈 Pre-configured Grafana dashboard:"
echo "   http://localhost:3003/d/batchsender/batchsender-monitoring"
echo ""

# Optional: Open browser
if command -v open &> /dev/null; then
    read -p "Open Grafana in browser? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        open http://localhost:3003
    fi
fi