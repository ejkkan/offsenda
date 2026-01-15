#!/bin/bash
#
# Test Script - Sets up Docker services and runs tests
#
# Usage:
#   ./scripts/test.sh              # Run all tests
#   ./scripts/test.sh --unit       # Unit tests only (no Docker)
#   ./scripts/test.sh --integration # Integration tests only
#   ./scripts/test.sh --load       # Run load test
#   ./scripts/test.sh --load --size=large  # Large load test
#   ./scripts/test.sh --keep       # Keep services running after tests
#
# Size presets:
#   small:  1 batch × 100 recipients = 100 emails
#   medium: 5 batches × 200 recipients = 1K emails
#   large:  10 batches × 1000 recipients = 10K emails
#   stress: 50 batches × 2000 recipients = 100K emails
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# Parse arguments
RUN_UNIT=true
RUN_INTEGRATION=true
RUN_LOAD=false
KEEP_SERVICES=false
TEST_SIZE="small"
CUSTOM_BATCHES=""
CUSTOM_RECIPIENTS=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --unit)
      RUN_UNIT=true
      RUN_INTEGRATION=false
      shift
      ;;
    --integration)
      RUN_UNIT=false
      RUN_INTEGRATION=true
      shift
      ;;
    --load)
      RUN_LOAD=true
      RUN_UNIT=false
      RUN_INTEGRATION=false
      shift
      ;;
    --size=*)
      TEST_SIZE="${1#*=}"
      shift
      ;;
    --batches=*)
      CUSTOM_BATCHES="${1#*=}"
      shift
      ;;
    --recipients=*)
      CUSTOM_RECIPIENTS="${1#*=}"
      shift
      ;;
    --keep)
      KEEP_SERVICES=true
      shift
      ;;
    --help|-h)
      echo "Usage: ./scripts/test.sh [options]"
      echo ""
      echo "Options:"
      echo "  --unit              Run unit tests only (no Docker needed)"
      echo "  --integration       Run integration tests only"
      echo "  --load              Run load test"
      echo "  --size=SIZE         Test size: small, medium, large, stress (default: small)"
      echo "  --batches=N         Custom number of batches"
      echo "  --recipients=N      Custom recipients per batch"
      echo "  --keep              Keep Docker services running after tests"
      echo "  --help              Show this help"
      echo ""
      echo "Size presets:"
      echo "  small   1 batch × 100 recipients = 100 emails"
      echo "  medium  5 batches × 200 recipients = 1K emails"
      echo "  large   10 batches × 1000 recipients = 10K emails"
      echo "  stress  50 batches × 2000 recipients = 100K emails"
      echo ""
      echo "Examples:"
      echo "  ./scripts/test.sh --load --size=medium"
      echo "  ./scripts/test.sh --load --batches=20 --recipients=500"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Set batch/recipient counts based on size preset
case $TEST_SIZE in
  small)
    BATCHES=${CUSTOM_BATCHES:-1}
    RECIPIENTS=${CUSTOM_RECIPIENTS:-100}
    ;;
  medium)
    BATCHES=${CUSTOM_BATCHES:-5}
    RECIPIENTS=${CUSTOM_RECIPIENTS:-200}
    ;;
  large)
    BATCHES=${CUSTOM_BATCHES:-10}
    RECIPIENTS=${CUSTOM_RECIPIENTS:-1000}
    ;;
  stress)
    BATCHES=${CUSTOM_BATCHES:-50}
    RECIPIENTS=${CUSTOM_RECIPIENTS:-2000}
    ;;
  *)
    echo "Unknown size: $TEST_SIZE (use: small, medium, large, stress)"
    exit 1
    ;;
esac

# Override with custom values if provided
[ -n "$CUSTOM_BATCHES" ] && BATCHES=$CUSTOM_BATCHES
[ -n "$CUSTOM_RECIPIENTS" ] && RECIPIENTS=$CUSTOM_RECIPIENTS

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Cleanup function
cleanup() {
  if [ "$KEEP_SERVICES" = false ] && [ "$SERVICES_STARTED" = true ]; then
    log_info "Stopping Docker services..."
    docker compose -f docker-compose.local.yml down -v --remove-orphans 2>/dev/null || true
  fi
}

trap cleanup EXIT

SERVICES_STARTED=false

# =============================================================================
# Unit Tests (no Docker needed)
# =============================================================================

if [ "$RUN_UNIT" = true ] && [ "$RUN_INTEGRATION" = false ]; then
  echo ""
  echo "=========================================="
  echo "  Running Unit Tests"
  echo "=========================================="
  echo ""

  # Run unit tests (exclude integration and e2e tests)
  (cd apps/worker && pnpm vitest run src/providers/*.test.ts)

  log_success "Unit tests completed!"
  exit 0
fi

# =============================================================================
# Start Docker Services
# =============================================================================

if [ "$RUN_INTEGRATION" = true ] || [ "$RUN_LOAD" = true ]; then
  echo ""
  echo "=========================================="
  echo "  Setting up Test Environment"
  echo "=========================================="
  echo ""

  # Check if Docker is running
  if ! docker info > /dev/null 2>&1; then
    log_error "Docker is not running. Please start Docker and try again."
    exit 1
  fi

  # Stop any existing services
  log_info "Cleaning up existing services..."
  docker compose -f docker-compose.local.yml down -v --remove-orphans 2>/dev/null || true

  # Start services (including worker for load tests)
  log_info "Starting Docker services..."
  if [ "$RUN_LOAD" = true ]; then
    docker compose -f docker-compose.local.yml up -d postgres nats clickhouse mock-ses worker
  else
    docker compose -f docker-compose.local.yml up -d postgres nats clickhouse mock-ses
  fi

  SERVICES_STARTED=true

  # Wait for PostgreSQL
  log_info "Waiting for PostgreSQL (port 5433)..."
  for i in {1..30}; do
    if docker compose -f docker-compose.local.yml exec -T postgres pg_isready -U batchsender > /dev/null 2>&1; then
      log_success "PostgreSQL ready"
      break
    fi
    if [ $i -eq 30 ]; then
      log_error "PostgreSQL failed to start"
      exit 1
    fi
    sleep 1
  done

  # Wait for NATS
  log_info "Waiting for NATS..."
  for i in {1..30}; do
    if curl -s http://localhost:8222/healthz > /dev/null 2>&1; then
      log_success "NATS ready"
      break
    fi
    if [ $i -eq 30 ]; then
      log_error "NATS failed to start"
      exit 1
    fi
    sleep 1
  done

  # Wait for ClickHouse
  log_info "Waiting for ClickHouse..."
  for i in {1..30}; do
    if curl -s http://localhost:8123/ping > /dev/null 2>&1; then
      log_success "ClickHouse ready"
      break
    fi
    if [ $i -eq 30 ]; then
      log_error "ClickHouse failed to start"
      exit 1
    fi
    sleep 1
  done

  # Wait for mock-ses
  log_info "Waiting for Mock SES..."
  for i in {1..30}; do
    if curl -s http://localhost:4566/health > /dev/null 2>&1; then
      log_success "Mock SES ready"
      break
    fi
    if [ $i -eq 30 ]; then
      log_warn "Mock SES not responding (may need to build first)"
    fi
    sleep 1
  done

  # Wait for worker (if load testing)
  if [ "$RUN_LOAD" = true ]; then
    log_info "Waiting for Worker..."
    for i in {1..60}; do
      if curl -s http://localhost:6001/health > /dev/null 2>&1; then
        log_success "Worker ready"
        break
      fi
      if [ $i -eq 60 ]; then
        log_error "Worker failed to start"
        docker compose -f docker-compose.local.yml logs worker --tail=50
        exit 1
      fi
      sleep 2
    done
  fi

  # Run database migrations
  log_info "Running database migrations..."
  DATABASE_URL="postgresql://batchsender:batchsender@localhost:5433/batchsender" pnpm --filter=@batchsender/db db:push || {
    log_warn "Migration failed, trying to continue..."
  }

  log_success "Test environment ready!"
  echo ""
fi

# =============================================================================
# Run Tests
# =============================================================================

# Export test environment variables
export DATABASE_URL="postgresql://batchsender:batchsender@localhost:5433/batchsender"
export NATS_CLUSTER="localhost:4222"
export CLICKHOUSE_URL="http://localhost:8123"
export CLICKHOUSE_USER="default"
export CLICKHOUSE_PASSWORD="clickhouse"
export WEBHOOK_SECRET="test-secret"
export EMAIL_PROVIDER="mock"
export SES_ENDPOINT="http://localhost:4566/ses/send"
export NODE_ENV="test"

if [ "$RUN_LOAD" = true ]; then
  TOTAL=$((BATCHES * RECIPIENTS))
  echo "=========================================="
  echo "  Running Load Test ($TEST_SIZE)"
  echo "=========================================="
  echo "  Batches: $BATCHES"
  echo "  Recipients/batch: $RECIPIENTS"
  echo "  Total emails: $TOTAL"
  echo "=========================================="
  echo ""

  pnpm --filter=worker load-test --batches=$BATCHES --recipients=$RECIPIENTS

  log_success "Load test completed!"

elif [ "$RUN_UNIT" = true ] && [ "$RUN_INTEGRATION" = true ]; then
  echo "=========================================="
  echo "  Running All Tests"
  echo "=========================================="
  echo ""

  # Run both unit and integration tests (using vitest.config.ts)
  pnpm --filter=worker test:run

  log_success "All tests completed!"

elif [ "$RUN_INTEGRATION" = true ]; then
  echo "=========================================="
  echo "  Running Integration Tests"
  echo "=========================================="
  echo ""

  # Run integration tests only
  pnpm --filter=worker test:integration

  log_success "Integration tests completed!"
fi

echo ""
if [ "$KEEP_SERVICES" = true ]; then
  log_info "Services kept running. Stop with: docker compose -f docker-compose.local.yml down"
fi
