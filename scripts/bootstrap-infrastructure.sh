#!/bin/bash

#######################################################
#  BatchSender Infrastructure Bootstrap Script
#######################################################
#
# This script installs all infrastructure components
# on an existing k3s cluster:
# - KEDA (worker autoscaling)
# - Sealed Secrets (secret encryption)
# - Prometheus + Grafana (monitoring)
# - Metrics Server (CPU/memory metrics)
# - cert-manager (SSL certificates)
#
# Prerequisites:
# - kubeconfig file in ./kubeconfig
# - kubectl, helm installed
#
# Usage:
#   ./scripts/bootstrap-infrastructure.sh
#
#######################################################

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# Header
clear
echo -e "${BOLD}${BLUE}"
echo "  ╔══════════════════════════════════════════════════════════╗"
echo "  ║                                                          ║"
echo "  ║     🚀 BatchSender Infrastructure Bootstrap             ║"
echo "  ║                                                          ║"
echo "  ╚══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check prerequisites
echo -e "${CYAN}  [1/6]${NC} Checking prerequisites..."

if [ ! -f "./kubeconfig" ]; then
  echo -e "${RED}  ✗ kubeconfig not found${NC}"
  echo -e "    Run: ${CYAN}hetzner-k3s create --config cluster-config.yaml${NC}"
  exit 1
fi

command -v kubectl >/dev/null 2>&1 || {
  echo -e "${RED}  ✗ kubectl not found${NC}"
  echo -e "    Install: ${CYAN}brew install kubectl${NC}"
  exit 1
}

command -v helm >/dev/null 2>&1 || {
  echo -e "${RED}  ✗ helm not found${NC}"
  echo -e "    Install: ${CYAN}brew install helm${NC}"
  exit 1
}

command -v kubeseal >/dev/null 2>&1 || {
  echo -e "${RED}  ✗ kubeseal not found${NC}"
  echo -e "    Install: ${CYAN}brew install kubeseal${NC}"
  exit 1
}

# Set kubeconfig
export KUBECONFIG="./kubeconfig"

# Verify cluster is accessible
echo -e "${CYAN}  →${NC} Verifying cluster connection..."
if ! kubectl cluster-info >/dev/null 2>&1; then
  echo -e "${RED}  ✗ Cannot connect to cluster${NC}"
  echo -e "    Check your kubeconfig: ${CYAN}./kubeconfig${NC}"
  exit 1
fi

echo -e "${GREEN}  ✓${NC} All prerequisites met"

# Install Metrics Server
echo -e "${CYAN}  [2/6]${NC} Installing Metrics Server..."
echo -e "    ${YELLOW}Provides CPU/memory metrics for autoscaling${NC}"

kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

# Patch metrics-server for k3s compatibility
kubectl patch deployment metrics-server -n kube-system --type='json' -p='[
  {
    "op": "add",
    "path": "/spec/template/spec/containers/0/args/-",
    "value": "--kubelet-insecure-tls"
  }
]' 2>/dev/null || true

echo -e "${GREEN}  ✓${NC} Metrics Server installed"

# Install KEDA
echo -e "${CYAN}  [3/6]${NC} Installing KEDA for worker autoscaling..."
echo -e "    ${YELLOW}Scales workers based on NATS queue depth${NC}"

helm repo add kedacore https://kedacore.github.io/charts >/dev/null 2>&1 || true
helm repo update >/dev/null 2>&1

helm upgrade --install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --version 2.16.0 \
  --set image.keda.tag=2.16.0 \
  --set image.metricsApiServer.tag=2.16.0 \
  --set image.webhooks.tag=2.16.0 \
  --wait \
  --timeout 5m

echo -e "${GREEN}  ✓${NC} KEDA installed"

# Install Sealed Secrets
echo -e "${CYAN}  [4/6]${NC} Installing Sealed Secrets for secret encryption..."
echo -e "    ${YELLOW}Encrypts secrets so they can be safely stored in Git${NC}"

helm repo add sealed-secrets https://bitnami-labs.github.io/sealed-secrets >/dev/null 2>&1 || true
helm repo update >/dev/null 2>&1

helm upgrade --install sealed-secrets sealed-secrets/sealed-secrets \
  --namespace kube-system \
  --version 2.16.2 \
  --wait \
  --timeout 5m

# Wait for sealed-secrets controller to be ready
echo -e "${CYAN}  →${NC} Waiting for Sealed Secrets controller..."
kubectl wait --for=condition=available --timeout=120s \
  deployment/sealed-secrets -n kube-system

echo -e "${GREEN}  ✓${NC} Sealed Secrets installed"

# Fetch Sealed Secrets certificate
echo -e "${CYAN}  →${NC} Fetching Sealed Secrets certificate..."
kubeseal --fetch-cert \
  --controller-name=sealed-secrets \
  --controller-namespace=kube-system \
  > sealed-secrets-cert.pem

echo -e "${GREEN}  ✓${NC} Certificate saved to: ${CYAN}sealed-secrets-cert.pem${NC}"

# Install Prometheus + Grafana
echo -e "${CYAN}  [5/6]${NC} Installing Prometheus + Grafana monitoring stack..."
echo -e "    ${YELLOW}This may take 5-10 minutes...${NC}"

helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
helm repo update >/dev/null 2>&1

# Create monitoring namespace
kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f - >/dev/null 2>&1

# Install kube-prometheus-stack
helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --version 67.4.0 \
  --set prometheus.prometheusSpec.retention=30d \
  --set prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.resources.requests.storage=20Gi \
  --set prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.storageClassName=hcloud-volumes \
  --set grafana.persistence.enabled=true \
  --set grafana.persistence.size=10Gi \
  --set grafana.persistence.storageClassName=hcloud-volumes \
  --set grafana.adminPassword=admin \
  --set grafana.service.type=ClusterIP \
  --wait \
  --timeout 10m

echo -e "${GREEN}  ✓${NC} Monitoring stack installed"

# Install cert-manager
echo -e "${CYAN}  [6/6]${NC} Installing cert-manager for SSL certificates..."
echo -e "    ${YELLOW}Automatically manages TLS certificates${NC}"

helm repo add jetstack https://charts.jetstack.io >/dev/null 2>&1 || true
helm repo update >/dev/null 2>&1

helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --version v1.16.2 \
  --set crds.enabled=true \
  --wait \
  --timeout 5m

echo -e "${GREEN}  ✓${NC} cert-manager installed"

# Final summary
echo ""
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}${GREEN}  ✓ Infrastructure bootstrap complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${BOLD}Installed components:${NC}"
echo -e "  ┌─────────────────────────────────────────────────────────┐"
echo -e "  │ ✓ Metrics Server (CPU/memory metrics)                  │"
echo -e "  │ ✓ KEDA (worker autoscaling)                            │"
echo -e "  │ ✓ Sealed Secrets (secret encryption)                   │"
echo -e "  │ ✓ Prometheus + Grafana (monitoring)                    │"
echo -e "  │ ✓ cert-manager (SSL certificates)                      │"
echo -e "  └─────────────────────────────────────────────────────────┘"
echo ""
echo -e "  ${BOLD}Important files:${NC}"
echo -e "  • Kubeconfig: ${CYAN}./kubeconfig${NC}"
echo -e "  • Sealed Secrets cert: ${CYAN}sealed-secrets-cert.pem${NC}"
echo ""
echo -e "  ${BOLD}Next steps:${NC}"
echo -e "  1. Encrypt secrets: ${CYAN}./scripts/seal-secrets.sh${NC}"
echo -e "  2. Deploy app: ${CYAN}kubectl apply -k k8s/overlays/production${NC}"
echo -e "  3. Verify: ${CYAN}./scripts/verify-deployment.sh${NC}"
echo ""
echo -e "  ${BOLD}Access Grafana:${NC}"
echo -e "  ${CYAN}kubectl port-forward -n monitoring svc/monitoring-grafana 3000:80${NC}"
echo -e "  Username: admin"
echo -e "  Password: admin (change after first login)"
echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
