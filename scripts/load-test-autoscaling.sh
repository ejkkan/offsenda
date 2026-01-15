#!/bin/bash
# Autoscaling Load Test Script
# This script generates synthetic load to test queue-depth based autoscaling
# Run this against staging or production (during low-traffic hours)

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
API_URL="${API_URL:-http://localhost:3000}"
API_KEY="${API_KEY:-}"
NAMESPACE="${NAMESPACE:-batchsender}"
BATCH_SIZE="${BATCH_SIZE:-5000}"  # Number of emails per batch
NUM_BATCHES="${NUM_BATCHES:-5}"    # Number of batches to create

echo -e "${BLUE}=== Autoscaling Load Test ===${NC}"
echo "API URL: $API_URL"
echo "Namespace: $NAMESPACE"
echo "Batch size: $BATCH_SIZE emails"
echo "Number of batches: $NUM_BATCHES"
echo ""

# Check prerequisites
if [ -z "$API_KEY" ]; then
  echo -e "${RED}ERROR: API_KEY environment variable not set${NC}"
  echo "Usage: API_KEY=your-key API_URL=https://your-api.com ./scripts/load-test-autoscaling.sh"
  exit 1
fi

command -v kubectl >/dev/null 2>&1 || {
  echo -e "${RED}ERROR: kubectl not found. Please install kubectl.${NC}"
  exit 1
}

command -v jq >/dev/null 2>&1 || {
  echo -e "${YELLOW}WARNING: jq not found. Install jq for better output formatting.${NC}"
}

echo -e "${YELLOW}Starting load test in 5 seconds... (Ctrl+C to cancel)${NC}"
sleep 5

# Function to create a test batch
create_batch() {
  local batch_num=$1
  local recipients='['

  # Generate recipients
  for i in $(seq 1 $BATCH_SIZE); do
    recipients+='{"email":"test'$i'@example.com","name":"Test User '$i'"},'
  done
  recipients="${recipients%,}]"  # Remove trailing comma and close array

  local payload=$(cat <<EOF
{
  "name": "Load Test Batch $batch_num - $(date +%s)",
  "subject": "Autoscaling Load Test",
  "fromEmail": "loadtest@example.com",
  "fromName": "Load Test",
  "htmlContent": "<p>This is a load test email to test autoscaling.</p>",
  "textContent": "This is a load test email to test autoscaling.",
  "recipients": $recipients
}
EOF
)

  echo -e "${BLUE}Creating batch $batch_num/${NUM_BATCHES} with $BATCH_SIZE recipients...${NC}"

  response=$(curl -s -X POST "$API_URL/api/batches" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "$payload")

  if command -v jq >/dev/null 2>&1; then
    batch_id=$(echo "$response" | jq -r '.id')
  else
    batch_id=$(echo "$response" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
  fi

  if [ -z "$batch_id" ] || [ "$batch_id" = "null" ]; then
    echo -e "${RED}Failed to create batch. Response: $response${NC}"
    return 1
  fi

  echo -e "${GREEN}✓ Batch created: $batch_id${NC}"
  echo "$batch_id"
}

# Function to start sending a batch
send_batch() {
  local batch_id=$1

  echo -e "${BLUE}Starting batch: $batch_id${NC}"

  response=$(curl -s -X POST "$API_URL/api/batches/$batch_id/send" \
    -H "Authorization: Bearer $API_KEY")

  echo -e "${GREEN}✓ Batch queued for sending${NC}"
}

# Function to monitor autoscaling
monitor_autoscaling() {
  echo ""
  echo -e "${BLUE}=== Monitoring Autoscaling ===${NC}"
  echo ""

  # Monitor in background
  (
    for i in {1..60}; do  # Monitor for 10 minutes (60 * 10 seconds)
      echo -e "${YELLOW}--- Check $i ($(date +%H:%M:%S)) ---${NC}"

      # Get HPA status
      echo -e "${BLUE}HPA Status:${NC}"
      kubectl get hpa worker-hpa -n $NAMESPACE 2>/dev/null || echo "HPA not found"

      # Get current worker count
      echo -e "${BLUE}Worker Pods:${NC}"
      kubectl get pods -n $NAMESPACE -l app=batchsender-worker --no-headers 2>/dev/null | wc -l | xargs echo "Count:"
      kubectl get pods -n $NAMESPACE -l app=batchsender-worker --no-headers 2>/dev/null || echo "No workers found"

      # Get queue depth
      echo -e "${BLUE}Queue Depth:${NC}"
      worker_pod=$(kubectl get pods -n $NAMESPACE -l app=batchsender-worker -o name 2>/dev/null | head -1)
      if [ ! -z "$worker_pod" ]; then
        kubectl exec -n $NAMESPACE $worker_pod -- curl -s localhost:3000/api/metrics 2>/dev/null | grep "nats_queue_depth{" || echo "No queue metrics"
      fi

      echo ""
      sleep 10
    done
  ) &

  MONITOR_PID=$!
  echo -e "${GREEN}Monitoring started (PID: $MONITOR_PID)${NC}"
  echo -e "${YELLOW}Press Ctrl+C to stop monitoring${NC}"
}

# Main load test
echo -e "${BLUE}=== Creating Test Batches ===${NC}"
batch_ids=()

for i in $(seq 1 $NUM_BATCHES); do
  batch_id=$(create_batch $i)
  if [ ! -z "$batch_id" ]; then
    batch_ids+=("$batch_id")
    sleep 1  # Brief pause between batch creation
  fi
done

echo ""
echo -e "${GREEN}✓ Created ${#batch_ids[@]} batches${NC}"
echo ""

# Send all batches
echo -e "${BLUE}=== Starting All Batches ===${NC}"
for batch_id in "${batch_ids[@]}"; do
  send_batch "$batch_id"
  sleep 0.5
done

echo ""
echo -e "${GREEN}✓ All batches queued!${NC}"
echo ""
echo -e "${YELLOW}Expected behavior:${NC}"
echo "1. Queue depth will spike to ~$((BATCH_SIZE * NUM_BATCHES)) messages"
echo "2. HPA should detect high queue depth (>1000 msgs/pod)"
echo "3. Workers should scale up from 2 to ~$((BATCH_SIZE * NUM_BATCHES / 1000)) pods"
echo "4. Emails will process faster with more workers"
echo "5. After queue empties, workers will scale back down to 2 (after 5 min)"
echo ""

# Start monitoring
monitor_autoscaling

# Wait for monitoring to finish or user interrupt
wait $MONITOR_PID 2>/dev/null || true

echo ""
echo -e "${GREEN}=== Load Test Complete ===${NC}"
echo ""
echo "Review the results:"
echo "1. Check Grafana dashboards for metrics"
echo "2. View HPA scaling events: kubectl describe hpa worker-hpa -n $NAMESPACE"
echo "3. Check batch completion times in the API"
