#!/bin/bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo -e "${BOLD}${BLUE}"
echo "  ╔══════════════════════════════════════════════════════════╗"
echo "  ║                                                          ║"
echo "  ║          BatchSender Local Kubernetes Setup              ║"
echo "  ║                                                          ║"
echo "  ╚══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check prerequisites
echo -e "${CYAN}  [1/7]${NC} Checking prerequisites..."

if ! command -v k3d &> /dev/null; then
    echo -e "${RED}  ✗ k3d not found. Install with: brew install k3d${NC}"
    exit 1
fi

if ! command -v kubectl &> /dev/null; then
    echo -e "${RED}  ✗ kubectl not found. Install with: brew install kubectl${NC}"
    exit 1
fi

if ! command -v docker &> /dev/null; then
    echo -e "${RED}  ✗ docker not found. Install Docker Desktop${NC}"
    exit 1
fi

echo -e "${GREEN}  ✓${NC} All prerequisites installed"

# Check if cluster already exists
if k3d cluster list | grep -q "batchsender"; then
    echo -e "${YELLOW}  !${NC} Cluster 'batchsender' already exists"
    read -p "  Delete and recreate? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${CYAN}  ...${NC} Deleting existing cluster..."
        k3d cluster delete batchsender
    else
        echo -e "${CYAN}  ...${NC} Using existing cluster"
        kubectl config use-context k3d-batchsender
    fi
fi

# Create cluster if it doesn't exist
if ! k3d cluster list | grep -q "batchsender"; then
    echo -e "${CYAN}  [2/7]${NC} Creating k3d cluster..."
    k3d cluster create --config "$SCRIPT_DIR/k3d-config.yaml"
    echo -e "${GREEN}  ✓${NC} Cluster created"
else
    echo -e "${CYAN}  [2/7]${NC} Cluster already exists"
fi

# Wait for cluster to be ready
echo -e "${CYAN}  [3/7]${NC} Waiting for cluster nodes..."
kubectl wait --for=condition=ready node --all --timeout=120s
echo -e "${GREEN}  ✓${NC} All nodes ready"

# Deploy infrastructure
echo -e "${CYAN}  [4/7]${NC} Deploying infrastructure (DragonflyDB, ClickHouse)..."
kubectl apply -k "$PROJECT_ROOT/k8s/overlays/local/"
echo -e "${GREEN}  ✓${NC} Infrastructure deployed"

# Wait for DragonflyDB
echo -e "${CYAN}  [5/7]${NC} Waiting for DragonflyDB..."
kubectl wait --for=condition=ready pod -l app=dragonfly -n batchsender --timeout=120s
echo -e "${GREEN}  ✓${NC} DragonflyDB ready"

# Wait for ClickHouse
echo -e "${CYAN}  [6/7]${NC} Waiting for ClickHouse..."
kubectl wait --for=condition=ready pod -l app=clickhouse -n batchsender --timeout=120s
echo -e "${GREEN}  ✓${NC} ClickHouse ready"

# Build and push worker image
echo -e "${CYAN}  [7/7]${NC} Building worker image..."
cd "$PROJECT_ROOT"
docker build -t registry.localhost:5111/worker:dev -f apps/worker/Dockerfile .
docker push registry.localhost:5111/worker:dev
echo -e "${GREEN}  ✓${NC} Worker image built and pushed"

# Deploy worker
echo -e "${CYAN}  ...${NC} Deploying worker..."
kubectl apply -f "$PROJECT_ROOT/k8s/base/worker/"
kubectl wait --for=condition=ready pod -l app=worker -n batchsender --timeout=120s
echo -e "${GREEN}  ✓${NC} Worker deployed"

# Final status
echo ""
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}${GREEN}  ✓ Local Kubernetes cluster ready!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${BOLD}Services:${NC}"
echo -e "  ┌──────────────────┬─────────────────────────────────┐"
echo -e "  │ ${CYAN}Worker API${NC}       │ http://localhost:6001           │"
echo -e "  │ ${CYAN}DragonflyDB${NC}      │ Internal: dragonfly:6379        │"
echo -e "  │ ${CYAN}ClickHouse${NC}       │ Internal: clickhouse:8123       │"
echo -e "  └──────────────────┴─────────────────────────────────┘"
echo ""
echo -e "  ${BOLD}Commands:${NC}"
echo -e "    kubectl get pods -n batchsender          # View pods"
echo -e "    kubectl logs -f -l app=worker -n batchsender  # Worker logs"
echo -e "    kubectl get hpa -n batchsender           # View auto-scaling"
echo -e "    pnpm dev:k8s:down                        # Stop cluster"
echo ""
echo -e "  ${BOLD}Test the worker:${NC}"
echo -e "    curl http://localhost:6001/health"
echo ""
