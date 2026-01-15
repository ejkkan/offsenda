#!/bin/bash
# Start local monitoring stack for batchsender

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