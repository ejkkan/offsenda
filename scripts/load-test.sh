#!/bin/bash
#
# Load Test Runner for CCX43 Single-Node Cluster
#
# This script runs load tests against a dedicated load-test environment
# deployed with the k8s/overlays/load-test overlay.
#
# Prerequisites:
#   1. Deploy load-test overlay to CCX43 cluster:
#      kubectl apply -k k8s/overlays/load-test
#
#   2. Set up port-forward or use external URL:
#      kubectl port-forward svc/worker 6001:6001 -n batchsender
#
#   3. Create test user and API key:
#      pnpm tsx scripts/create-user.ts --email loadtest@example.com --name "Load Test"
#      pnpm tsx scripts/create-api-key.ts --user-id <user-id>
#
# Usage:
#   ./scripts/load-test.sh small      # 2,000 emails (warm-up)
#   ./scripts/load-test.sh medium     # 25,000 emails (autoscaling)
#   ./scripts/load-test.sh large      # 100,000 emails (sustained)
#   ./scripts/load-test.sh stress     # 400,000 emails (stress)
#   ./scripts/load-test.sh concurrent # 5x 10k simultaneous batches
#
# Environment Variables:
#   API_KEY      - Required: API key for authentication
#   API_URL      - Optional: API endpoint (default: http://localhost:6001)
#   KUBECONFIG   - Optional: Path to kubeconfig for pod monitoring
#   NAMESPACE    - Optional: Kubernetes namespace (default: batchsender)
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
export API_URL="${API_URL:-http://localhost:6001}"
export KUBECONFIG="${KUBECONFIG:-$PROJECT_ROOT/kubeconfig}"
export NAMESPACE="${NAMESPACE:-batchsender}"

PRESET="${1:-small}"

print_header() {
  echo ""
  echo -e "${BLUE}================================================${NC}"
  echo -e "${BLUE}  BatchSender Load Test - CCX43 Cluster${NC}"
  echo -e "${BLUE}================================================${NC}"
  echo ""
}

print_usage() {
  echo "Usage: $0 [preset|concurrent]"
  echo ""
  echo -e "${YELLOW}Presets:${NC}"
  echo "  small      - 2 batches × 1,000 = 2,000 emails (warm-up)"
  echo "  medium     - 5 batches × 5,000 = 25,000 emails (autoscaling validation)"
  echo "  large      - 10 batches × 10,000 = 100,000 emails (sustained load)"
  echo "  stress     - 20 batches × 20,000 = 400,000 emails (stress test)"
  echo "  concurrent - 5 batches × 10,000 = 50,000 emails (simultaneous)"
  echo ""
  echo -e "${YELLOW}Environment Variables:${NC}"
  echo "  API_KEY      - Required: API key for authentication"
  echo "  API_URL      - API endpoint (default: $API_URL)"
  echo "  KUBECONFIG   - Kubeconfig path (default: $KUBECONFIG)"
  echo "  NAMESPACE    - K8s namespace (default: $NAMESPACE)"
  echo ""
  echo -e "${YELLOW}Example:${NC}"
  echo "  API_KEY=bsk_xxx ./scripts/load-test.sh medium"
  echo ""
  echo -e "${YELLOW}Resource Allocation (CCX43 - 16 vCPU, 64GB RAM):${NC}"
  echo "  NATS:       3 replicas × 4Gi = 12Gi"
  echo "  Dragonfly:  3 replicas × 4Gi = 12Gi"
  echo "  ClickHouse: 1 replica × 4Gi"
  echo "  Workers:    5-50 replicas × 1Gi (KEDA scaled)"
  echo "  Web:        1 replica × 256Mi"
  echo ""
}

check_prerequisites() {
  echo -e "${YELLOW}Checking prerequisites...${NC}"

  # Check API_KEY
  if [ -z "$API_KEY" ]; then
    echo -e "${RED}Error: API_KEY environment variable not set${NC}"
    echo ""
    echo "Create a test user and API key first:"
    echo "  pnpm tsx scripts/create-user.ts --email loadtest@example.com"
    echo "  pnpm tsx scripts/create-api-key.ts --user-id <user-id>"
    exit 1
  fi
  echo -e "  ${GREEN}✓${NC} API_KEY is set"

  # Check kubectl
  if ! command -v kubectl &> /dev/null; then
    echo -e "${RED}Error: kubectl not found${NC}"
    exit 1
  fi
  echo -e "  ${GREEN}✓${NC} kubectl available"

  # Check kubeconfig
  if [ -f "$KUBECONFIG" ]; then
    echo -e "  ${GREEN}✓${NC} Kubeconfig found: $KUBECONFIG"
  else
    echo -e "  ${YELLOW}⚠${NC} Kubeconfig not found: $KUBECONFIG (pod monitoring disabled)"
  fi

  # Check API connectivity
  echo -e "${YELLOW}Testing API connectivity...${NC}"
  if curl -s --connect-timeout 5 "$API_URL/health" > /dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} API reachable at $API_URL"
  else
    echo -e "${RED}Error: Cannot reach API at $API_URL${NC}"
    echo ""
    echo "Options:"
    echo "  1. Port-forward: kubectl port-forward svc/worker 6001:6001 -n batchsender"
    echo "  2. Set API_URL to external endpoint"
    exit 1
  fi

  echo ""
}

show_cluster_status() {
  echo -e "${YELLOW}Current Cluster Status:${NC}"

  if [ -f "$KUBECONFIG" ]; then
    # Worker pods
    WORKER_COUNT=$(kubectl get pods -n "$NAMESPACE" -l app=worker --no-headers 2>/dev/null | grep -c Running || echo "0")
    echo -e "  Workers:    ${CYAN}$WORKER_COUNT${NC} running"

    # NATS pods
    NATS_COUNT=$(kubectl get pods -n "$NAMESPACE" -l app=nats --no-headers 2>/dev/null | grep -c Running || echo "0")
    echo -e "  NATS:       ${CYAN}$NATS_COUNT${NC} running"

    # Dragonfly pods
    DF_COUNT=$(kubectl get pods -n "$NAMESPACE" -l app=dragonfly --no-headers 2>/dev/null | grep -c Running || echo "0")
    echo -e "  Dragonfly:  ${CYAN}$DF_COUNT${NC} running"

    # ClickHouse pods
    CH_COUNT=$(kubectl get pods -n "$NAMESPACE" -l app=clickhouse --no-headers 2>/dev/null | grep -c Running || echo "0")
    echo -e "  ClickHouse: ${CYAN}$CH_COUNT${NC} running"
  else
    echo -e "  ${YELLOW}(kubectl not configured - skipping cluster status)${NC}"
  fi

  echo ""
}

run_concurrent_test() {
  echo -e "${BLUE}=== Concurrent Batch Test ===${NC}"
  echo "Creating 5 batches of 10,000 recipients simultaneously"
  echo ""

  # Create 5 batches concurrently
  BATCH_IDS=()
  for i in {1..5}; do
    echo -e "${YELLOW}Creating batch $i/5...${NC}"

    # Generate recipients JSON
    RECIPIENTS="["
    for j in $(seq 1 10000); do
      if [ $j -gt 1 ]; then RECIPIENTS+=","; fi
      RECIPIENTS+="{\"email\":\"user${j}batch${i}@test.local\",\"name\":\"User $j\"}"
    done
    RECIPIENTS+="]"

    PAYLOAD=$(cat <<EOF
{
  "name": "Concurrent Test Batch $i - $(date -Iseconds)",
  "subject": "Load Test $i",
  "fromEmail": "test@valuekeys.io",
  "fromName": "Load Test",
  "htmlContent": "<p>Concurrent load test batch $i</p>",
  "textContent": "Concurrent load test batch $i",
  "dryRun": true,
  "recipients": $RECIPIENTS
}
EOF
)

    RESPONSE=$(curl -s -X POST "$API_URL/api/batches" \
      -H "Authorization: Bearer $API_KEY" \
      -H "Content-Type: application/json" \
      -d "$PAYLOAD")

    BATCH_ID=$(echo "$RESPONSE" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
    if [ -n "$BATCH_ID" ] && [ "$BATCH_ID" != "null" ]; then
      BATCH_IDS+=("$BATCH_ID")
      echo -e "  ${GREEN}✓${NC} Created: $BATCH_ID"
    else
      echo -e "  ${RED}✗${NC} Failed to create batch $i"
      echo "  Response: $RESPONSE"
    fi
  done

  echo ""
  echo -e "${YELLOW}Starting all batches simultaneously...${NC}"

  # Send all batches at once
  for BATCH_ID in "${BATCH_IDS[@]}"; do
    curl -s -X POST "$API_URL/api/batches/$BATCH_ID/send" \
      -H "Authorization: Bearer $API_KEY" &
  done
  wait

  echo -e "${GREEN}✓${NC} All batches queued"
  echo ""
  echo -e "${YELLOW}Monitor progress:${NC}"
  echo "  kubectl get pods -n $NAMESPACE -l app=worker -w"
  echo "  kubectl logs -n $NAMESPACE -l app=worker -f"
  echo ""

  # Start monitoring
  cd "$PROJECT_ROOT"
  pnpm tsx scripts/load-test.ts --api-url="$API_URL" --preset=medium --namespace="$NAMESPACE"
}

# Validate preset
case "$PRESET" in
  small|medium|large|stress)
    print_header
    check_prerequisites
    show_cluster_status

    echo -e "${BLUE}=== Running $PRESET preset ===${NC}"
    echo ""

    cd "$PROJECT_ROOT"
    pnpm tsx scripts/load-test.ts \
      --api-url="$API_URL" \
      --preset="$PRESET" \
      --namespace="$NAMESPACE"
    ;;
  concurrent)
    print_header
    check_prerequisites
    show_cluster_status
    run_concurrent_test
    ;;
  -h|--help|help)
    print_header
    print_usage
    ;;
  *)
    print_header
    print_usage
    exit 1
    ;;
esac

echo ""
echo -e "${GREEN}=== Load Test Complete ===${NC}"
echo ""
echo -e "${YELLOW}Next Steps:${NC}"
echo "  1. View Grafana dashboards for metrics"
echo "  2. Check scaling: kubectl describe scaledobject worker-scaler -n $NAMESPACE"
echo "  3. View logs: kubectl logs -n $NAMESPACE -l app=worker --tail=100"
echo ""
echo -e "${YELLOW}Cost Reminder:${NC}"
echo "  CCX43 is billed hourly (~€0.14/hour)"
echo "  Delete cluster when done: hcloud server delete <name>"
echo ""
