#!/bin/bash

#######################################################
#  BatchSender Production Deployment Verifier
#######################################################
#
# This script verifies that all services are deployed
# correctly in production.
#
# Prerequisites:
# - kubectl configured with production cluster
# - Services deployed via: kubectl apply -k k8s/overlays/production
#
# Usage:
#   export KUBECONFIG=./kubeconfig
#   ./scripts/verify-deployment.sh
#
#######################################################

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

NAMESPACE="batchsender"
ERRORS=0

echo ""
echo -e "${BOLD}${CYAN}🔍 BatchSender Production Deployment Verification${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Helper functions
check_step() {
  if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓${NC} $1"
  else
    echo -e "${RED}✗${NC} $1"
    ERRORS=$((ERRORS + 1))
  fi
}

# Check namespace
echo -e "${CYAN}[1/8]${NC} Checking namespace..."
kubectl get namespace $NAMESPACE >/dev/null 2>&1
check_step "Namespace '$NAMESPACE' exists"

# Check PostgreSQL
echo -e "${CYAN}[2/8]${NC} Checking PostgreSQL..."
kubectl wait --for=condition=ready pod -l app=postgres -n $NAMESPACE --timeout=30s >/dev/null 2>&1
check_step "PostgreSQL pod is ready"

# Check DragonflyDB
echo -e "${CYAN}[3/8]${NC} Checking DragonflyDB..."
kubectl wait --for=condition=ready pod -l app=dragonfly -n $NAMESPACE --timeout=30s >/dev/null 2>&1
check_step "DragonflyDB pod is ready"

# Check NATS
echo -e "${CYAN}[4/8]${NC} Checking NATS cluster..."
NATS_READY=$(kubectl get pods -l app=nats -n $NAMESPACE -o jsonpath='{.items[*].status.conditions[?(@.type=="Ready")].status}' 2>/dev/null | grep -o "True" | wc -l)
if [ "$NATS_READY" -ge 1 ]; then
  check_step "NATS pods ready ($NATS_READY/3 replicas)"
else
  echo -e "${RED}✗${NC} NATS pods not ready"
  ERRORS=$((ERRORS + 1))
fi

# Check ClickHouse
echo -e "${CYAN}[5/8]${NC} Checking ClickHouse..."
kubectl wait --for=condition=ready pod -l app=clickhouse -n $NAMESPACE --timeout=60s >/dev/null 2>&1
check_step "ClickHouse pod is ready"

# Check Worker deployment
echo -e "${CYAN}[6/8]${NC} Checking Worker deployment..."
kubectl wait --for=condition=available deployment/worker -n $NAMESPACE --timeout=60s >/dev/null 2>&1
check_step "Worker deployment is available"

WORKER_REPLICAS=$(kubectl get deployment worker -n $NAMESPACE -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
if [ -n "$WORKER_REPLICAS" ] && [ "$WORKER_REPLICAS" -ge 1 ]; then
  check_step "Worker replicas ready ($WORKER_REPLICAS)"
else
  echo -e "${RED}✗${NC} No worker replicas ready"
  ERRORS=$((ERRORS + 1))
fi

# Check KEDA ScaledObject
echo -e "${CYAN}[7/8]${NC} Checking KEDA autoscaling..."
SCALED_OBJECT=$(kubectl get scaledobject worker-scaler -n $NAMESPACE -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)
if [ "$SCALED_OBJECT" = "True" ]; then
  check_step "KEDA ScaledObject is ready"

  # Show scaling config
  MIN_REPLICAS=$(kubectl get scaledobject worker-scaler -n $NAMESPACE -o jsonpath='{.spec.minReplicaCount}' 2>/dev/null)
  MAX_REPLICAS=$(kubectl get scaledobject worker-scaler -n $NAMESPACE -o jsonpath='{.spec.maxReplicaCount}' 2>/dev/null)
  echo -e "  ${CYAN}→${NC} Scaling range: ${MIN_REPLICAS}-${MAX_REPLICAS} workers"
else
  echo -e "${RED}✗${NC} KEDA ScaledObject not ready"
  ERRORS=$((ERRORS + 1))
fi

# Check health endpoint
echo -e "${CYAN}[8/8]${NC} Checking health endpoints..."

# Get first worker pod
WORKER_POD=$(kubectl get pods -l app=worker -n $NAMESPACE -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)

if [ -n "$WORKER_POD" ]; then
  # Test health endpoint
  HEALTH_RESPONSE=$(kubectl exec -n $NAMESPACE $WORKER_POD -- curl -s http://localhost:6001/health 2>/dev/null || echo "")
  if echo "$HEALTH_RESPONSE" | grep -q "healthy"; then
    check_step "Health endpoint responding"
  else
    echo -e "${RED}✗${NC} Health endpoint not responding correctly"
    ERRORS=$((ERRORS + 1))
  fi

  # Test metrics endpoint
  METRICS_RESPONSE=$(kubectl exec -n $NAMESPACE $WORKER_POD -- curl -s http://localhost:6001/api/metrics 2>/dev/null || echo "")
  if echo "$METRICS_RESPONSE" | grep -q "worker_"; then
    check_step "Metrics endpoint responding"
  else
    echo -e "${RED}✗${NC} Metrics endpoint not responding correctly"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo -e "${RED}✗${NC} No worker pods found to test endpoints"
  ERRORS=$((ERRORS + 1))
fi

# Summary
echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

if [ $ERRORS -eq 0 ]; then
  echo -e "${BOLD}${GREEN}✓ All checks passed! Deployment is healthy.${NC}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo -e "${BOLD}Pod Status:${NC}"
  kubectl get pods -n $NAMESPACE
  echo ""
  echo -e "${BOLD}KEDA Scaling:${NC}"
  kubectl get scaledobject -n $NAMESPACE
  echo ""
  echo -e "${BOLD}Services:${NC}"
  kubectl get svc -n $NAMESPACE
  echo ""
  exit 0
else
  echo -e "${BOLD}${RED}✗ Found $ERRORS errors in deployment.${NC}"
  echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo -e "${YELLOW}Debugging information:${NC}"
  echo ""
  echo -e "${BOLD}Pod Status:${NC}"
  kubectl get pods -n $NAMESPACE
  echo ""
  echo -e "${BOLD}Recent Events:${NC}"
  kubectl get events -n $NAMESPACE --sort-by='.lastTimestamp' | tail -10
  echo ""
  exit 1
fi
