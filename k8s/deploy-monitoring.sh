#!/bin/bash
# Deploy monitoring stack to Hetzner Kubernetes cluster

echo "🚀 Deploying monitoring stack to Hetzner..."

# Create namespace if it doesn't exist
kubectl create namespace batchsender --dry-run=client -o yaml | kubectl apply -f -

# Deploy Prometheus
echo "📊 Deploying Prometheus..."
kubectl apply -f monitoring/prometheus-deployment.yaml

# Deploy Grafana
echo "📈 Deploying Grafana..."
kubectl apply -f monitoring/grafana-deployment.yaml

# Wait for deployments
echo "⏳ Waiting for pods to be ready..."
kubectl wait --namespace=batchsender --for=condition=ready pod -l app=prometheus --timeout=120s
kubectl wait --namespace=batchsender --for=condition=ready pod -l app=grafana --timeout=120s

echo ""
echo "✅ Monitoring stack deployed!"
echo ""
echo "📊 Grafana will be available at: https://grafana.valuekeys.io"
echo "   (after DNS propagation)"
echo ""
echo "⚠️  IMPORTANT STEPS:"
echo "1. Add DNS A record: grafana.valuekeys.io → Your Hetzner Load Balancer IP"
echo "2. Change Grafana admin password in grafana-deployment.yaml"
echo "3. Import dashboard from: docker-compose.monitoring.yml"
echo ""
echo "To check status:"
echo "kubectl get pods -n batchsender"
echo "kubectl get ingress -n batchsender"