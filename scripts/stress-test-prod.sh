#!/bin/bash
#
# Production Stress Test Runner
#
# Usage:
#   ./scripts/stress-test-prod.sh small    # 2,000 emails
#   ./scripts/stress-test-prod.sh medium   # 25,000 emails
#   ./scripts/stress-test-prod.sh large    # 100,000 emails
#   ./scripts/stress-test-prod.sh stress   # 400,000 emails
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Configuration
export API_KEY="${API_KEY:-bsk_9b7b52f487dfbeba31ba155251ed9dbc0ede645b13f991495d213c738b9dba8c}"
export KUBECONFIG="${KUBECONFIG:-$PROJECT_ROOT/kubeconfig}"

PRESET="${1:-small}"

# Validate preset
case "$PRESET" in
  small|medium|large|stress)
    ;;
  *)
    echo "Usage: $0 [small|medium|large|stress]"
    echo ""
    echo "Presets:"
    echo "  small   - 2 batches × 1,000 = 2,000 emails (warm-up)"
    echo "  medium  - 5 batches × 5,000 = 25,000 emails (autoscaling validation)"
    echo "  large   - 10 batches × 10,000 = 100,000 emails (sustained load)"
    echo "  stress  - 20 batches × 20,000 = 400,000 emails (stress test)"
    exit 1
    ;;
esac

echo "========================================"
echo "Production Stress Test: $PRESET"
echo "========================================"
echo ""
echo "API URL: https://api.valuekeys.io"
echo "Dry Run: YES (no real emails)"
echo ""

# Run the test
cd "$PROJECT_ROOT"
pnpm tsx scripts/load-test.ts --production --preset="$PRESET"
