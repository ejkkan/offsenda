#!/bin/bash

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 BatchSender Full Demo Script${NC}"
echo "================================="

# Step 1: Start monitoring if not running
echo -e "\n${YELLOW}1. Starting monitoring stack...${NC}"
if docker ps | grep -q prometheus; then
    echo "   ✓ Monitoring already running"
else
    docker compose -f docker-compose.monitoring.yml up -d
    echo "   ⏳ Waiting for monitoring to start..."
    sleep 5
fi

# Step 2: Start all services
echo -e "\n${YELLOW}2. Starting BatchSender services...${NC}"
docker compose -f docker-compose.local.yml up -d
echo "   ⏳ Waiting for services to be ready..."
sleep 10

# Step 3: Start the worker and web app
echo -e "\n${YELLOW}3. Starting BatchSender services...${NC}"
# Kill any existing processes
pkill -f "turbo dev --filter=worker" 2>/dev/null || true
pkill -f "turbo dev --filter=web" 2>/dev/null || true

# Start worker in background
bash -c 'cd /Users/erikmagnusson/Programming/batchsender && set -a && source .env.dev && pnpm dev:worker' > worker.log 2>&1 &
WORKER_PID=$!
echo "   ✓ Worker started (PID: $WORKER_PID)"

# Start web app in background
bash -c 'cd /Users/erikmagnusson/Programming/batchsender && set -a && source .env.dev && pnpm dev:web' > web.log 2>&1 &
WEB_PID=$!
echo "   ✓ Web app started (PID: $WEB_PID)"

# Wait for services to be ready
echo "   ⏳ Waiting for services to be ready..."
worker_ready=false
web_ready=false

for i in {1..30}; do
    if [ "$worker_ready" = false ] && curl -s http://localhost:6001/health > /dev/null 2>&1; then
        echo -e "   ${GREEN}✓ Worker is ready!${NC}"
        worker_ready=true
    fi
    if [ "$web_ready" = false ] && curl -s http://localhost:5001 > /dev/null 2>&1; then
        echo -e "   ${GREEN}✓ Web app is ready!${NC}"
        web_ready=true
    fi
    if [ "$worker_ready" = true ] && [ "$web_ready" = true ]; then
        break
    fi
    sleep 1
done

# Step 4: Open web interfaces
echo -e "\n${YELLOW}4. Opening web interfaces...${NC}"
if command -v open &> /dev/null; then
    # macOS
    open http://localhost:3003/d/batchsender/batchsender-monitoring
    open http://localhost:5001  # Next.js web app
elif command -v xdg-open &> /dev/null; then
    # Linux
    xdg-open http://localhost:3003/d/batchsender/batchsender-monitoring
    xdg-open http://localhost:5001
fi

echo -e "   ${GREEN}✓ Grafana:${NC} http://localhost:3003 (admin/admin)"
echo -e "   ${GREEN}✓ BatchSender Web:${NC} http://localhost:5001"
echo -e "   ${GREEN}✓ Prometheus:${NC} http://localhost:9090"

# Step 5: Create test data
echo -e "\n${YELLOW}5. Creating test batches...${NC}"

# Function to create a batch
create_batch() {
    local batch_name=$1
    local recipient_count=$2
    local priority=${3:-"normal"}

    # Generate recipients JSON array
    recipients="["
    for i in $(seq 1 $recipient_count); do
        recipients+="{\"email\":\"user$i@example.com\"}"
        if [ $i -lt $recipient_count ]; then
            recipients+=","
        fi
    done
    recipients+="]"

    # Create the batch
    response=$(curl -s -X POST http://localhost:6001/api/batches \
      -H "Authorization: Bearer test-key" \
      -H "Content-Type: application/json" \
      -d "{
        \"name\": \"$batch_name\",
        \"from\": {\"email\": \"demo@batchsender.com\", \"name\": \"Demo\"},
        \"subject\": \"$batch_name - Watch the metrics!\",
        \"htmlContent\": \"<h1>$batch_name</h1><p>This is an automated test email.</p>\",
        \"provider\": \"mock\",
        \"priority\": \"$priority\",
        \"recipients\": $recipients
      }")

    batch_id=$(echo $response | grep -o '"id":"[^"]*' | sed 's/"id":"//')

    if [ -z "$batch_id" ]; then
        echo "   ❌ Failed to create batch: $batch_name"
        return
    fi

    echo "   ✓ Created batch: $batch_name (ID: $batch_id)"

    # Send the batch
    curl -s -X POST http://localhost:6001/api/batches/$batch_id/send \
      -H "Authorization: Bearer test-key" > /dev/null

    echo "   ✓ Sent batch: $batch_name"
}

# Create multiple test batches
echo ""
create_batch "Small Test Batch" 5 "normal"
sleep 2
create_batch "Medium Campaign" 25 "normal"
sleep 2
create_batch "Large Campaign" 100 "normal"
sleep 2
create_batch "Priority Emails" 10 "high"

# Step 6: Show metrics
echo -e "\n${YELLOW}6. Checking metrics...${NC}"
sleep 5
echo -e "\n${GREEN}Current Queue Metrics:${NC}"
curl -s http://localhost:6001/api/metrics | grep -E "^(nats_queue_depth|queue_.*_pending|nats_pending_messages)" | grep -v "^#"

echo -e "\n${GREEN}Queue Status:${NC}"
curl -s http://localhost:6001/api/queue/status \
  -H "Authorization: Bearer test-key" | python3 -m json.tool 2>/dev/null || \
  curl -s http://localhost:6001/api/queue/status -H "Authorization: Bearer test-key"

# Instructions
echo -e "\n${BLUE}============================================${NC}"
echo -e "${GREEN}🎉 Demo is running!${NC}"
echo -e "${BLUE}============================================${NC}"
echo ""
echo "📊 Watch the metrics change in Grafana:"
echo "   http://localhost:3003/d/batchsender/batchsender-monitoring"
echo ""
echo "🔄 To generate more load:"
echo "   ./create-test-batch.sh"
echo ""
echo "📈 To see raw metrics:"
echo "   curl http://localhost:6001/api/metrics"
echo ""
echo "🛑 To stop everything:"
echo "   ./stop-demo.sh"
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop the worker${NC}"

# Keep services running
trap "kill $WORKER_PID $WEB_PID 2>/dev/null; exit" INT
wait $WORKER_PID $WEB_PID