#!/bin/bash

# Quick script to create test batches on demand

echo "🚀 Creating test batch..."

# Random batch size
SIZES=(5 10 25 50 100 200 500)
SIZE=${SIZES[$RANDOM % ${#SIZES[@]}]}

# Random priority
PRIORITIES=("normal" "high")
PRIORITY=${PRIORITIES[$RANDOM % ${#PRIORITIES[@]}]}

# Generate recipients
recipients="["
for i in $(seq 1 $SIZE); do
    recipients+="{\"email\":\"user$i@test.com\",\"name\":\"User $i\"}"
    if [ $i -lt $SIZE ]; then
        recipients+=","
    fi
done
recipients+="]"

# Create batch
response=$(curl -s -X POST http://localhost:6001/api/batches \
  -H "Authorization: Bearer test-api-key" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"Load Test - $SIZE recipients\",
    \"from\": {\"email\": \"loadtest@batchsender.com\", \"name\": \"Load Test\"},
    \"subject\": \"Test Email - $(date +%H:%M:%S)\",
    \"htmlContent\": \"<h1>Load Test</h1><p>This batch has $SIZE recipients.</p><p>Priority: $PRIORITY</p>\",
    \"provider\": \"mock\",
    \"priority\": \"$PRIORITY\",
    \"recipients\": $recipients
  }")

batch_id=$(echo $response | grep -o '"id":"[^"]*' | sed 's/"id":"//')

if [ -z "$batch_id" ]; then
    echo "❌ Failed to create batch"
    echo "Response: $response"
    exit 1
fi

echo "✓ Created batch with $SIZE recipients (Priority: $PRIORITY)"
echo "  Batch ID: $batch_id"

# Send the batch
curl -s -X POST http://localhost:6001/api/batches/$batch_id/send \
  -H "Authorization: Bearer test-api-key" > /dev/null

echo "✓ Batch sent! Watch the metrics in Grafana"
echo ""
echo "📊 Current queue depth:"
curl -s http://localhost:6001/api/metrics | grep -E "nats_queue_depth|queue_email_pending" | grep -v "^#"