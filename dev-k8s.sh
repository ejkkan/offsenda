#!/bin/bash

#############################################
#  BatchSender Kubernetes Development Server
#############################################

# ⚠️  DEPRECATION WARNING
echo ""
echo -e "\033[1;33m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\033[0m"
echo -e "\033[1;33m  ⚠️  DEPRECATION WARNING\033[0m"
echo -e "\033[1;33m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\033[0m"
echo ""
echo -e "  This script (\033[1mdev-k8s.sh\033[0m) is deprecated and will be removed on \033[1m2026-02-16\033[0m"
echo ""
echo -e "  \033[1;36m→ New command:\033[0m pnpm dev --mode=k8s"
echo ""
echo -e "  The new unified dev command provides:"
echo -e "    • Automatic mode detection (K8s vs Docker)"
echo -e "    • Service discovery dashboard"
echo -e "    • Better error messages"
echo -e "    • Integrated monitoring options"
echo -e "    • Consistent command interface"
echo ""
echo -e "\033[1;33m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\033[0m"
echo ""
read -p "Continue with old script anyway? (y/N) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Exiting. Please use: pnpm dev --mode=k8s"
    exit 0
fi
echo ""

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# PIDs for cleanup
WEB_PID=""
SKAFFOLD_PID=""

# Cleanup function
cleanup() {
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}  Shutting down...${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

    if [ -n "$WEB_PID" ]; then
        echo -e "  ${CYAN}→${NC} Stopping web app..."
        kill $WEB_PID 2>/dev/null || true
    fi

    if [ -n "$SKAFFOLD_PID" ]; then
        echo -e "  ${CYAN}→${NC} Stopping skaffold..."
        kill $SKAFFOLD_PID 2>/dev/null || true
    fi

    # Kill any remaining child processes
    pkill -P $$ 2>/dev/null || true

    echo ""
    echo -e "${GREEN}  ✓ All services stopped${NC}"
    echo ""
    exit 0
}

# Trap Ctrl+C and other signals
trap cleanup SIGINT SIGTERM EXIT

# Header
clear
echo -e "${BOLD}${BLUE}"
echo "  ╔══════════════════════════════════════════════════════════╗"
echo "  ║                                                          ║"
echo "  ║        🚀 BatchSender K8s Dev Server (Skaffold)         ║"
echo "  ║                                                          ║"
echo "  ╚══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check prerequisites
echo -e "${CYAN}  [1/5]${NC} Checking prerequisites..."

command -v kubectl >/dev/null 2>&1 || {
  echo -e "${RED}  ✗ kubectl not found${NC}"
  echo -e "    Install: ${CYAN}brew install kubectl${NC}"
  exit 1
}

command -v k3d >/dev/null 2>&1 || {
  echo -e "${RED}  ✗ k3d not found${NC}"
  echo -e "    Install: ${CYAN}brew install k3d${NC}"
  exit 1
}

command -v skaffold >/dev/null 2>&1 || {
  echo -e "${RED}  ✗ skaffold not found${NC}"
  echo -e "    Install: ${CYAN}brew install skaffold${NC}"
  exit 1
}

echo -e "${GREEN}  ✓${NC} All tools installed"

# Check for .env.dev file
if [ ! -f ".env.dev" ]; then
    echo -e "${RED}  ✗ .env.dev file not found${NC}"
    echo -e "    Run: ${CYAN}cp .env.example .env.dev${NC} and configure it"
    exit 1
fi

# Load environment variables
echo -e "${CYAN}  [2/5]${NC} Loading environment variables from .env.dev..."
set -a
source .env.dev
set +a
echo -e "${GREEN}  ✓${NC} Environment loaded"

# Check if k3d cluster exists
echo -e "${CYAN}  [3/5]${NC} Checking k3d cluster..."
if k3d cluster list | grep -q "batchsender"; then
    echo -e "${GREEN}  ✓${NC} k3d cluster 'batchsender' already exists"
else
    echo -e "${YELLOW}  → Creating k3d cluster 'batchsender'...${NC}"
    k3d cluster create batchsender \
        --servers 1 \
        --agents 3 \
        --port "6001:80@loadbalancer" \
        --port "8222:8222@loadbalancer" \
        --port "8123:8123@loadbalancer" \
        --wait

    echo -e "${GREEN}  ✓${NC} Cluster created successfully"
fi

# Set kubectl context
kubectl config use-context k3d-batchsender > /dev/null 2>&1

# Create namespace if it doesn't exist
echo -e "${CYAN}  [4/7]${NC} Setting up namespace..."
kubectl create namespace batchsender --dry-run=client -o yaml | kubectl apply -f - > /dev/null 2>&1
echo -e "${GREEN}  ✓${NC} Namespace ready"

# Install KEDA for autoscaling (if not already installed)
echo -e "${CYAN}  [5/7]${NC} Checking KEDA installation..."
if kubectl get namespace keda > /dev/null 2>&1; then
    echo -e "${GREEN}  ✓${NC} KEDA already installed"
else
    echo -e "${YELLOW}  → Installing KEDA for instant worker scaling...${NC}"

    # Check if helm is installed
    if command -v helm >/dev/null 2>&1; then
        helm repo add kedacore https://kedacore.github.io/charts > /dev/null 2>&1 || true
        helm repo update > /dev/null 2>&1
        helm install keda kedacore/keda \
            --namespace keda \
            --create-namespace \
            --version 2.12.0 \
            --wait \
            --timeout 2m > /dev/null 2>&1
        echo -e "${GREEN}  ✓${NC} KEDA installed successfully"
    else
        echo -e "${YELLOW}  ⚠ Helm not found, skipping KEDA installation${NC}"
        echo -e "    Install helm: ${CYAN}brew install helm${NC}"
        echo -e "    Or manually install KEDA later"
    fi
fi

# Generate K8s ConfigMap and Secret from .env.dev
echo -e "${CYAN}  [6/7]${NC} Generating K8s config from .env.dev..."
kubectl create configmap worker-config \
  --namespace=batchsender \
  --from-literal=NODE_ENV=development \
  --from-literal=PORT=6001 \
  --from-literal=EMAIL_PROVIDER="$EMAIL_PROVIDER" \
  --from-literal=NATS_CLUSTER="nats://nats-0.nats:4222,nats://nats-1.nats:4222,nats://nats-2.nats:4222" \
  --from-literal=CLICKHOUSE_URL="http://clickhouse:8123" \
  --from-literal=CLICKHOUSE_USER="$CLICKHOUSE_USER" \
  --from-literal=CLICKHOUSE_DATABASE="$CLICKHOUSE_DATABASE" \
  --from-literal=DRAGONFLY_URL="dragonfly:6379" \
  --from-literal=BATCH_SIZE="100" \
  --from-literal=POLL_INTERVAL_MS="2000" \
  --from-literal=RATE_LIMIT_PER_SECOND="100" \
  --from-literal=RATE_LIMIT_PER_IP="100" \
  --from-literal=CONCURRENT_BATCHES="10" \
  --from-literal=MAX_CONCURRENT_EMAILS="50" \
  --dry-run=client -o yaml | kubectl apply -f - > /dev/null 2>&1

kubectl create secret generic worker-secrets \
  --namespace=batchsender \
  --from-literal=DATABASE_URL="postgresql://batchsender:batchsender@postgres:5432/batchsender" \
  --from-literal=RESEND_API_KEY="$RESEND_API_KEY" \
  --from-literal=WEBHOOK_SECRET="$WEBHOOK_SECRET" \
  --from-literal=CLICKHOUSE_PASSWORD="$CLICKHOUSE_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f - > /dev/null 2>&1

echo -e "${GREEN}  ✓${NC} K8s config generated from .env.dev"

# Start services
echo -e "${CYAN}  [7/7]${NC} Starting services..."
echo ""
echo -e "  ${BOLD}Starting:${NC}"
echo -e "  • Web app (Next.js) with hot-reload"
echo -e "  • K8s worker via Skaffold"
echo -e "  • Auto-cleanup on Ctrl+C"
echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Build db package if needed
if [ ! -d "packages/db/dist" ]; then
    echo -e "${CYAN}  ...${NC} Building @batchsender/db package..."
    pnpm --filter=@batchsender/db build > /dev/null 2>&1
fi

# Create log directory
LOG_DIR="/tmp/batchsender-logs"
rm -rf "$LOG_DIR"
mkdir -p "$LOG_DIR"

# Start web app in background
echo -e "${CYAN}  →${NC} Starting web app..."
(cd apps/web && exec pnpm dev 2>&1) > "$LOG_DIR/web.log" 2>&1 &
WEB_PID=$!

# Start Skaffold in background
echo -e "${CYAN}  →${NC} Starting Skaffold (K8s worker)..."
skaffold dev --port-forward > "$LOG_DIR/skaffold.log" 2>&1 &
SKAFFOLD_PID=$!

# Wait for web app to be ready
echo -e "${YELLOW}  Waiting for services...${NC}"
for i in {1..60}; do
    if curl -s http://localhost:5001 > /dev/null 2>&1; then
        echo -e "${GREEN}  ✓${NC} Web app ready"
        break
    fi
    if [ $i -eq 60 ]; then
        echo -e "${RED}  ✗ Web app failed to start${NC}"
        cat "$LOG_DIR/web.log"
        exit 1
    fi
    sleep 1
done

# Final status
echo ""
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}${GREEN}  ✓ All services running!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${BOLD}Services:${NC}"
echo -e "  ┌──────────────────┬─────────────────────────────────┐"
echo -e "  │ ${CYAN}Web App${NC}          │ http://localhost:5001           │"
echo -e "  │ ${CYAN}Worker API${NC}       │ http://localhost:6001           │"
echo -e "  │ ${CYAN}NATS Monitor${NC}     │ http://localhost:8222           │"
echo -e "  │ ${CYAN}ClickHouse${NC}       │ http://localhost:8123           │"
echo -e "  └──────────────────┴─────────────────────────────────┘"
echo ""
echo -e "  ${BOLD}Press Ctrl+C to stop all services${NC}"
echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${BOLD}  Live logs:${NC}"
echo ""

# Tail both log files
tail -f "$LOG_DIR/web.log" "$LOG_DIR/skaffold.log" 2>/dev/null | while IFS= read -r line; do
    if [[ "$line" == "==> "* ]]; then
        if [[ "$line" == *"web.log"* ]]; then
            echo -e "${CYAN}[web]${NC} ─────────────────────────"
        elif [[ "$line" == *"skaffold.log"* ]]; then
            echo -e "${GREEN}[k8s]${NC} ─────────────────────────"
        fi
    else
        echo "  $line"
    fi
done
