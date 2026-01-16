#!/bin/bash
# Deploy monitoring stack to Hetzner Kubernetes cluster

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🚀 Deploying monitoring stack to Hetzner..."

# Create namespace if it doesn't exist
kubectl create namespace batchsender --dry-run=client -o yaml | kubectl apply -f -

# Deploy sealed secrets for monitoring
echo "🔐 Deploying monitoring secrets..."
if [ -f monitoring/sealed-grafana-secret.yaml ]; then
  kubectl apply -f monitoring/sealed-grafana-secret.yaml
else
  echo "⚠️  Warning: sealed-grafana-secret.yaml not found. Run: pnpm seal-secrets"
fi

if [ -f monitoring/sealed-prometheus-auth.yaml ]; then
  kubectl apply -f monitoring/sealed-prometheus-auth.yaml
else
  echo "⚠️  Warning: sealed-prometheus-auth.yaml not found. Run: pnpm seal-secrets"
fi

# Deploy kube-state-metrics (for cluster visibility)
echo "📊 Deploying kube-state-metrics..."
kubectl apply -f monitoring/kube-state-metrics.yaml

# Deploy Prometheus
echo "📊 Deploying Prometheus..."
kubectl apply -f monitoring/prometheus-deployment.yaml

# Deploy Grafana
echo "📈 Deploying Grafana..."
kubectl apply -f monitoring/grafana-deployment.yaml

# Wait for deployments
echo "⏳ Waiting for pods to be ready..."
kubectl wait --namespace=batchsender --for=condition=ready pod -l app=kube-state-metrics --timeout=120s
kubectl wait --namespace=batchsender --for=condition=ready pod -l app=prometheus --timeout=120s
kubectl wait --namespace=batchsender --for=condition=ready pod -l app=grafana --timeout=120s

echo ""
echo "✅ Monitoring stack deployed!"
echo ""
echo "📊 Grafana: https://grafana.valuekeys.io"
echo "📊 Prometheus: https://prometheus.valuekeys.io"
echo ""
echo "To check status:"
echo "  kubectl get pods -n batchsender -l 'app in (prometheus,grafana,kube-state-metrics)'"
echo "  kubectl get ingress -n batchsender"