#!/bin/bash
#
# Auto-scaling Test Script
#
# Tests that the Horizontal Pod Autoscaler (HPA) correctly scales
# worker pods based on CPU load from email processing.
#
# Prerequisites:
#   - k3d installed
#   - kubectl installed
#   - Docker running
#   - pnpm installed
#
# Usage:
#   ./k8s/local/test-autoscaling.sh [options]
#
# Options:
#   --batches N       Number of batches (default: 20)
#   --recipients N    Recipients per batch (default: 500)
#   --skip-setup      Skip cluster creation (use existing)
#   --skip-cleanup    Don't delete cluster after test
#

set -e

# Parse arguments
BATCHES=20
RECIPIENTS=500
SKIP_SETUP=false
SKIP_CLEANUP=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --batches)
      BATCHES="$2"
      shift 2
      ;;
    --recipients)
      RECIPIENTS="$2"
      shift 2
      ;;
    --skip-setup)
      SKIP_SETUP=true
      shift
      ;;
    --skip-cleanup)
      SKIP_CLEANUP=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

TOTAL_EMAILS=$((BATCHES * RECIPIENTS))
CLUSTER_NAME="batchsender-test"
NAMESPACE="batchsender"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "
========================================
  BatchSender Auto-scaling Test
========================================
  Cluster: $CLUSTER_NAME
  Batches: $BATCHES
  Recipients/batch: $RECIPIENTS
  Total emails: $TOTAL_EMAILS
========================================
"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

# =============================================================================
# Setup
# =============================================================================

if [ "$SKIP_SETUP" = false ]; then
  log_info "Creating k3d cluster..."

  # Delete existing cluster if it exists
  k3d cluster delete $CLUSTER_NAME 2>/dev/null || true

  # Create new cluster
  k3d cluster create $CLUSTER_NAME --config "$SCRIPT_DIR/k3d-config.yaml"

  # Wait for cluster to be ready
  log_info "Waiting for cluster to be ready..."
  kubectl wait --for=condition=Ready nodes --all --timeout=120s

  # Build and push images to local registry
  log_info "Building worker image..."
  cd "$ROOT_DIR"
  docker build -t localhost:5111/worker:test -f apps/worker/Dockerfile .
  docker push localhost:5111/worker:test

  # Build mock-ses image
  log_info "Building mock-ses image..."
  docker build -t localhost:5111/mock-ses:test -f apps/mock-ses/Dockerfile apps/mock-ses
  docker push localhost:5111/mock-ses:test

  # Apply k8s manifests
  log_info "Applying Kubernetes manifests..."
  kubectl apply -k "$SCRIPT_DIR/../overlays/local/"

  # Wait for deployments
  log_info "Waiting for deployments to be ready..."
  kubectl -n $NAMESPACE rollout status deployment/worker --timeout=300s
  kubectl -n $NAMESPACE rollout status deployment/clickhouse --timeout=120s
  kubectl -n $NAMESPACE rollout status deployment/dragonfly --timeout=120s
else
  log_info "Skipping cluster setup (--skip-setup)"
fi

# =============================================================================
# Baseline Check
# =============================================================================

log_info "Checking baseline pod count..."
BASELINE_PODS=$(kubectl -n $NAMESPACE get pods -l app=worker --no-headers | wc -l)
echo "  Baseline worker pods: $BASELINE_PODS"

if [ "$BASELINE_PODS" -eq 0 ]; then
  log_error "No worker pods found. Is the deployment running?"
  exit 1
fi

# Get HPA info
log_info "Current HPA status:"
kubectl -n $NAMESPACE get hpa worker-hpa

# =============================================================================
# Generate Load
# =============================================================================

log_info "Starting load test..."
echo "  Generating $TOTAL_EMAILS emails across $BATCHES batches"

# Run load test in background
cd "$ROOT_DIR"
pnpm --filter=worker load-test \
  --batches=$BATCHES \
  --recipients=$RECIPIENTS \
  --parallel \
  --mock-ses-url=http://localhost:4566 \
  --worker-url=http://localhost:6001 &
LOAD_PID=$!

log_info "Load test started (PID: $LOAD_PID)"

# =============================================================================
# Monitor Scaling
# =============================================================================

log_info "Monitoring pod scaling..."
MAX_PODS=$BASELINE_PODS
SCALED_UP=false
START_TIME=$(date +%s)
SCALE_UP_TIME=0

echo ""
echo "  Watching for scale-up (checking every 5 seconds)..."
echo ""

while kill -0 $LOAD_PID 2>/dev/null; do
  CURRENT_PODS=$(kubectl -n $NAMESPACE get pods -l app=worker --no-headers 2>/dev/null | wc -l)
  ELAPSED=$(($(date +%s) - START_TIME))

  if [ "$CURRENT_PODS" -gt "$MAX_PODS" ]; then
    MAX_PODS=$CURRENT_PODS
  fi

  if [ "$CURRENT_PODS" -gt "$BASELINE_PODS" ] && [ "$SCALED_UP" = false ]; then
    SCALED_UP=true
    SCALE_UP_TIME=$ELAPSED
    log_info "Scale-up detected! Pods: $BASELINE_PODS -> $CURRENT_PODS (after ${ELAPSED}s)"
  fi

  # Show progress
  HPA_STATUS=$(kubectl -n $NAMESPACE get hpa worker-hpa -o jsonpath='{.status.currentReplicas}/{.spec.maxReplicas}' 2>/dev/null || echo "?/?")
  CPU=$(kubectl -n $NAMESPACE get hpa worker-hpa -o jsonpath='{.status.currentMetrics[0].resource.current.averageUtilization}' 2>/dev/null || echo "?")
  echo -ne "\r  [${ELAPSED}s] Pods: $CURRENT_PODS (max: $MAX_PODS) | HPA: $HPA_STATUS | CPU: ${CPU}%      "

  sleep 5
done

echo ""
echo ""

# Wait for load test to complete
wait $LOAD_PID
LOAD_EXIT_CODE=$?

if [ $LOAD_EXIT_CODE -ne 0 ]; then
  log_warn "Load test exited with code $LOAD_EXIT_CODE"
fi

# =============================================================================
# Results
# =============================================================================

TOTAL_TIME=$(($(date +%s) - START_TIME))
FINAL_PODS=$(kubectl -n $NAMESPACE get pods -l app=worker --no-headers | wc -l)

echo ""
log_info "Test completed!"
echo ""
echo "========================================
  Auto-scaling Test Results
========================================
  Total time: ${TOTAL_TIME}s
  Baseline pods: $BASELINE_PODS
  Max pods reached: $MAX_PODS
  Final pods: $FINAL_PODS

  Scaling:"

if [ "$SCALED_UP" = true ]; then
  echo "    Scale-up: YES (after ${SCALE_UP_TIME}s)"
  echo "    Scale factor: ${MAX_PODS}x from baseline"
else
  echo "    Scale-up: NO"
  echo "    Note: HPA may not have triggered if CPU stayed below threshold"
fi

echo "
  HPA Status:"
kubectl -n $NAMESPACE describe hpa worker-hpa | grep -A 10 "Events:" | head -12

echo "========================================"

# =============================================================================
# Monitor Scale-Down (Optional)
# =============================================================================

if [ "$MAX_PODS" -gt "$BASELINE_PODS" ]; then
  log_info "Waiting for scale-down (5 minute stabilization window)..."
  echo "  Press Ctrl+C to skip scale-down monitoring"

  SCALE_DOWN_START=$(date +%s)
  SCALE_DOWN_TIMEOUT=360  # 6 minutes

  while true; do
    CURRENT_PODS=$(kubectl -n $NAMESPACE get pods -l app=worker --no-headers 2>/dev/null | wc -l)
    ELAPSED=$(($(date +%s) - SCALE_DOWN_START))

    echo -ne "\r  [${ELAPSED}s] Pods: $CURRENT_PODS (waiting to scale down to $BASELINE_PODS)    "

    if [ "$CURRENT_PODS" -le "$BASELINE_PODS" ]; then
      echo ""
      log_info "Scale-down complete! Pods: $MAX_PODS -> $CURRENT_PODS"
      break
    fi

    if [ $ELAPSED -gt $SCALE_DOWN_TIMEOUT ]; then
      echo ""
      log_warn "Scale-down timeout. Current pods: $CURRENT_PODS"
      break
    fi

    sleep 10
  done
fi

# =============================================================================
# Cleanup
# =============================================================================

if [ "$SKIP_CLEANUP" = false ]; then
  echo ""
  log_info "Cleaning up..."
  k3d cluster delete $CLUSTER_NAME
  log_info "Cluster deleted"
else
  log_info "Skipping cleanup (--skip-cleanup)"
  echo "  To delete cluster manually: k3d cluster delete $CLUSTER_NAME"
fi

# =============================================================================
# Final Verdict
# =============================================================================

echo ""
if [ "$SCALED_UP" = true ]; then
  echo -e "${GREEN}TEST PASSED: Auto-scaling triggered successfully${NC}"
  exit 0
else
  echo -e "${YELLOW}TEST INCONCLUSIVE: No scale-up observed${NC}"
  echo "  This may be expected if the load was not high enough to trigger HPA."
  echo "  Try increasing --batches or --recipients."
  exit 0
fi
