#!/bin/bash
# Test different rate limit scenarios

set -e

echo "╔════════════════════════════════════════════════════════════"
echo "║ BatchSender Rate Limit Testing"
echo "╚════════════════════════════════════════════════════════════"
echo ""

# Function to run tests with specific rate limit
run_scenario() {
  local name="$1"
  local ses_limit="$2"
  local mock_limit="$3"

  echo "→ Testing: $name"
  echo "  SES Rate: ${ses_limit}/sec"
  echo "  Mock Rate: ${mock_limit}/sec"
  echo ""

  SES_RATE_LIMIT="$ses_limit" \
  MOCK_RATE_LIMIT="$mock_limit" \
  pnpm test:e2e

  echo ""
  echo "✓ $name completed"
  echo "─────────────────────────────────────────────────────────────"
  echo ""
}

# Parse command line arguments
SCENARIO="${1:-aws-ses}"

case "$SCENARIO" in
  aws-ses)
    echo "Testing with AWS SES default limits (14/sec)"
    run_scenario "AWS SES Default" 14 14
    ;;

  aws-ses-increased)
    echo "Testing with increased AWS SES limits (50/sec)"
    run_scenario "AWS SES Increased" 50 50
    ;;

  high-throughput)
    echo "Testing with high throughput (100/sec)"
    run_scenario "High Throughput" 100 100
    ;;

  enterprise)
    echo "Testing enterprise scale (500/sec)"
    run_scenario "Enterprise Scale" 500 500
    ;;

  slow)
    echo "Testing slow provider (1/sec)"
    run_scenario "Slow Provider" 1 1
    ;;

  no-limit)
    echo "Testing with no rate limiting"
    run_scenario "No Rate Limit" 999999 999999
    ;;

  all)
    echo "Running all scenarios..."
    echo ""

    run_scenario "AWS SES Default (14/sec)" 14 14
    run_scenario "AWS SES Increased (50/sec)" 50 50
    run_scenario "High Throughput (100/sec)" 100 100
    run_scenario "Enterprise Scale (500/sec)" 500 500
    run_scenario "Slow Provider (1/sec)" 1 1
    run_scenario "No Rate Limit" 999999 999999

    echo ""
    echo "╔════════════════════════════════════════════════════════════"
    echo "║ All scenarios completed!"
    echo "╚════════════════════════════════════════════════════════════"
    ;;

  *)
    echo "Usage: $0 [scenario]"
    echo ""
    echo "Available scenarios:"
    echo "  aws-ses           - AWS SES default limits (14/sec) [default]"
    echo "  aws-ses-increased - Increased AWS SES limits (50/sec)"
    echo "  high-throughput   - High throughput (100/sec)"
    echo "  enterprise        - Enterprise scale (500/sec)"
    echo "  slow              - Slow provider (1/sec)"
    echo "  no-limit          - No rate limiting"
    echo "  all               - Run all scenarios"
    echo ""
    echo "Examples:"
    echo "  $0 aws-ses"
    echo "  $0 high-throughput"
    echo "  $0 all"
    exit 1
    ;;
esac
