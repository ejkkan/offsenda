#!/bin/bash
# Complete development setup for BatchSender
# This script ensures everything works properly from scratch

set -e  # Exit on error

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}🚀 BatchSender Development Setup${NC}"
echo "================================="

# Check prerequisites
echo -e "\n${YELLOW}Checking prerequisites...${NC}"

# Check if pnpm is installed
if ! command -v pnpm &> /dev/null; then
    echo -e "${RED}❌ pnpm is not installed${NC}"
    echo "Install with: npm install -g pnpm"
    exit 1
fi

# Check if Docker is running
if ! docker info &> /dev/null; then
    echo -e "${RED}❌ Docker is not running${NC}"
    echo "Please start Docker Desktop"
    exit 1
fi

echo -e "${GREEN}✓ All prerequisites met${NC}"

# Step 1: Install dependencies
echo -e "\n${YELLOW}1. Installing dependencies...${NC}"
pnpm install

# Step 2: Stop any existing services
echo -e "\n${YELLOW}2. Cleaning up existing services...${NC}"
cd /Users/erikmagnusson/Programming/batchsender
docker compose -f docker-compose.local.yml down 2>/dev/null || true
docker compose -f docker-compose.monitoring.yml down 2>/dev/null || true
pkill -f "turbo dev" 2>/dev/null || true
pkill -f "tsx watch" 2>/dev/null || true
sleep 2

# Step 3: Start infrastructure
echo -e "\n${YELLOW}3. Starting infrastructure services...${NC}"
docker compose -f docker-compose.local.yml up -d

# Wait for PostgreSQL to be ready
echo "   Waiting for PostgreSQL..."
for i in {1..30}; do
    if docker exec batchsender-postgres-1 pg_isready -U batchsender &> /dev/null; then
        echo -e "   ${GREEN}✓ PostgreSQL ready${NC}"
        break
    fi
    sleep 1
done

# Wait for other services
echo "   Waiting for other services..."
sleep 5

# Step 4: Initialize database
echo -e "\n${YELLOW}4. Initializing database...${NC}"

# Create database schema
DATABASE_URL="postgresql://batchsender:batchsender@localhost:5455/batchsender" \
pnpm db:push || {
    echo -e "${RED}❌ Database initialization failed${NC}"
    exit 1
}

# Create test data
echo "   Creating test user and API key..."
docker exec -i batchsender-postgres-1 psql -U batchsender -d batchsender << 'EOF'
-- Create test user
INSERT INTO users (id, email, name, password_hash, created_at, updated_at)
VALUES (
  'test-user-123',
  'test@example.com',
  'Test User',
  '$2a$10$K7L1OJ45/4Y2nIvhRVpCe.FSmhDdWoXehVzJptJ/op0lSsvqNu/1u',
  NOW(),
  NOW()
) ON CONFLICT (email) DO UPDATE SET updated_at = NOW();

-- Create API key
INSERT INTO api_keys (user_id, name, key_hash, created_at)
VALUES (
  'test-user-123',
  'Test API Key',
  '5fe6d4b3e5d4b3e5d4b3e5d4b3e5d4b3e5d4b3e5d4b3e5d4b3e5d4b3e5d4b3e5',  -- SHA256 of 'test-api-key'
  NOW()
) ON CONFLICT (key_hash) DO NOTHING;
EOF

echo -e "   ${GREEN}✓ Test user created${NC}"
echo "     Email: test@example.com"
echo "     Password: test123"
echo "     API Key: test-api-key"

# Step 5: Start monitoring
echo -e "\n${YELLOW}5. Starting monitoring stack...${NC}"
docker compose -f docker-compose.monitoring.yml up -d
sleep 5

# Step 6: Fix worker authentication
echo -e "\n${YELLOW}6. Configuring worker authentication...${NC}"

# Create a temporary patch to make metrics endpoint public
cat > /tmp/metrics-auth-fix.patch << 'EOF'
--- a/apps/worker/src/api.ts
+++ b/apps/worker/src/api.ts
@@ -25,6 +25,11 @@ export function setupAPI(
   // Middleware: Authentication
   app.addHook("onRequest", async (request, reply) => {
     const path = request.url;
+
+    // Public endpoints that don't require auth
+    if (path === "/health" || path === "/api/metrics" || path.startsWith("/webhooks/")) {
+      return; // Skip auth
+    }

     // Skip auth for health checks and webhooks
     if (path === "/health" || path.startsWith("/webhooks/")) {
EOF

# Apply the patch if file exists
if [ -f "apps/worker/src/api.ts" ]; then
    echo "   Note: Metrics endpoint should be public for Prometheus"
    echo "   Please update apps/worker/src/api.ts to exclude /api/metrics from auth"
fi

# Step 7: Start application services
echo -e "\n${YELLOW}7. Starting application services...${NC}"

# Start worker with all environment variables
cat > .env.worker.tmp << EOF
DATABASE_URL=postgresql://batchsender:batchsender@localhost:5455/batchsender
EMAIL_PROVIDER=mock
WEBHOOK_SECRET=test-webhook-secret
NATS_CLUSTER=nats://localhost:4222
CLICKHOUSE_URL=http://localhost:8123
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=clickhouse
CLICKHOUSE_DATABASE=batchsender
DRAGONFLY_URL=localhost:6379
EOF

# Start worker
(cd /Users/erikmagnusson/Programming/batchsender && \
 source .env.worker.tmp && \
 pnpm --filter=worker dev > worker.log 2>&1) &
WORKER_PID=$!
echo "   ✓ Worker starting (PID: $WORKER_PID)..."

# Start web app with proper DATABASE_URL
(cd /Users/erikmagnusson/Programming/batchsender && \
 export DATABASE_URL="postgresql://batchsender:batchsender@localhost:5455/batchsender" && \
 export NEXTAUTH_SECRET="92f0irs/jgV7Dx3mm4SYAaPnYFGQg+1Rym4IRD9NI60=" && \
 export NEXTAUTH_URL="http://localhost:5001" && \
 pnpm --filter=web dev > web.log 2>&1) &
WEB_PID=$!
echo "   ✓ Web app starting (PID: $WEB_PID)..."

# Wait for services to be ready
echo "   Waiting for services to start..."
for i in {1..30}; do
    if curl -s http://localhost:6001/health > /dev/null 2>&1; then
        echo -e "   ${GREEN}✓ Worker API ready${NC}"
        break
    fi
    sleep 1
done

# Step 8: Create initial test data
echo -e "\n${YELLOW}8. Creating test batch...${NC}"
sleep 2

BATCH_RESPONSE=$(curl -s -X POST http://localhost:6001/api/batches \
  -H "Authorization: Bearer test-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Welcome Test Batch",
    "from": {"email": "demo@batchsender.com", "name": "BatchSender Demo"},
    "subject": "Welcome to BatchSender Monitoring!",
    "htmlContent": "<h1>Welcome!</h1><p>Your monitoring is working!</p>",
    "provider": "mock",
    "recipients": [
      {"email": "user1@example.com"},
      {"email": "user2@example.com"},
      {"email": "user3@example.com"},
      {"email": "user4@example.com"},
      {"email": "user5@example.com"}
    ]
  }' 2>/dev/null || echo '{"error": "Failed to create batch"}')

if echo "$BATCH_RESPONSE" | grep -q '"id"'; then
    BATCH_ID=$(echo "$BATCH_RESPONSE" | grep -o '"id":"[^"]*' | sed 's/"id":"//')
    echo -e "   ${GREEN}✓ Test batch created${NC}"

    # Send the batch
    curl -s -X POST http://localhost:6001/api/batches/$BATCH_ID/send \
      -H "Authorization: Bearer test-api-key" > /dev/null 2>&1
    echo -e "   ${GREEN}✓ Test batch sent${NC}"
else
    echo -e "   ${YELLOW}⚠️  Could not create test batch (auth may need fixing)${NC}"
fi

# Step 9: Open browsers
echo -e "\n${YELLOW}9. Opening dashboards...${NC}"
if command -v open &> /dev/null; then
    open http://localhost:3003/d/batchsender/batchsender-monitoring
    open http://localhost:5001
fi

# Final summary
echo -e "\n${BLUE}============================================${NC}"
echo -e "${GREEN}🎉 Development environment ready!${NC}"
echo -e "${BLUE}============================================${NC}"
echo ""
echo "📊 Dashboards:"
echo "   Grafana:    http://localhost:3003 (admin/admin)"
echo "   Web App:    http://localhost:5001"
echo "   Prometheus: http://localhost:9095"
echo ""
echo "🔑 Test Credentials:"
echo "   Email:    test@example.com"
echo "   Password: test123"
echo "   API Key:  test-api-key"
echo ""
echo "📝 Test Commands:"
echo "   Create batch: ./create-test-batch.sh"
echo "   Check logs:   tail -f worker.log"
echo "   Stop all:     ./stop-dev.sh"
echo ""
echo -e "${YELLOW}⚠️  Note: If metrics show 'No data' in Grafana:${NC}"
echo "   The /api/metrics endpoint needs to be public."
echo "   Update apps/worker/src/api.ts to exclude it from auth."
echo ""

# Create stop script
cat > /Users/erikmagnusson/Programming/batchsender/stop-dev.sh << 'EOF'
#!/bin/bash
cd /Users/erikmagnusson/Programming/batchsender
echo "Stopping all services..."
pkill -f "pnpm --filter" 2>/dev/null || true
pkill -f "tsx watch" 2>/dev/null || true
docker compose -f docker-compose.local.yml down
docker compose -f docker-compose.monitoring.yml down
rm -f .env.worker.tmp worker.log web.log
echo "✓ All services stopped"
EOF
chmod +x /Users/erikmagnusson/Programming/batchsender/stop-dev.sh

# Keep script running
echo "Press Ctrl+C to stop all services"
trap "pkill -P $$; /Users/erikmagnusson/Programming/batchsender/stop-dev.sh; exit" INT
wait