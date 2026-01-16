#!/bin/bash

#############################################
#  BatchSender Development Server
#############################################

# ⚠️  DEPRECATION WARNING
echo ""
echo -e "\033[1;33m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\033[0m"
echo -e "\033[1;33m  ⚠️  DEPRECATION WARNING\033[0m"
echo -e "\033[1;33m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\033[0m"
echo ""
echo -e "  This script (\033[1mdev.sh\033[0m) is deprecated and will be removed on \033[1m2026-02-16\033[0m"
echo ""
echo -e "  \033[1;36m→ New command:\033[0m pnpm dev --mode=docker"
echo ""
echo -e "  The new unified dev command provides:"
echo -e "    • Automatic service discovery dashboard"
echo -e "    • Better error messages"
echo -e "    • Integrated monitoring options"
echo -e "    • Consistent command interface"
echo ""
echo -e "\033[1;33m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\033[0m"
echo ""
read -p "Continue with old script anyway? (y/N) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Exiting. Please use: pnpm dev --mode=docker"
    exit 0
fi
echo ""

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# PIDs for cleanup
WEB_PID=""
WORKER_PID=""

# Cleanup function
cleanup() {
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}  Shutting down...${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

    if [ -n "$WEB_PID" ]; then
        echo -e "  ${CYAN}→${NC} Stopping web app..."
        kill $WEB_PID 2>/dev/null || true
    fi

    if [ -n "$WORKER_PID" ]; then
        echo -e "  ${CYAN}→${NC} Stopping worker..."
        kill $WORKER_PID 2>/dev/null || true
    fi

    # Kill any remaining child processes
    pkill -P $$ 2>/dev/null || true

    echo -e "  ${CYAN}→${NC} Stopping Docker services..."
    docker compose -f docker-compose.local.yml down --remove-orphans 2>/dev/null || true

    echo ""
    echo -e "${GREEN}  ✓ All services stopped${NC}"
    echo ""
    exit 0
}

# Trap Ctrl+C and other signals
trap cleanup SIGINT SIGTERM EXIT

# Header
clear
echo -e "${BOLD}${BLUE}"
echo "  ╔══════════════════════════════════════════════════════════╗"
echo "  ║                                                          ║"
echo "  ║              🚀 BatchSender Dev Server                   ║"
echo "  ║                                                          ║"
echo "  ╚══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check for .env.dev file
if [ ! -f ".env.dev" ]; then
    echo -e "${RED}  ✗ .env.dev file not found${NC}"
    echo -e "    Run: ${CYAN}cp .env.example .env.dev${NC} and configure it"
    exit 1
fi

# Load environment variables
echo -e "${CYAN}  [1/5]${NC} Loading environment variables from .env.dev..."
set -a
source .env.dev
set +a
echo -e "${GREEN}  ✓${NC} Environment loaded"

# Check for required env vars
if [ -z "$DATABASE_URL" ]; then
    echo -e "${RED}  ✗ DATABASE_URL not set in .env${NC}"
    exit 1
fi

# RESEND_API_KEY only required if not using mock provider
if [ "$EMAIL_PROVIDER" != "mock" ] && [ -z "$RESEND_API_KEY" ]; then
    echo -e "${RED}  ✗ RESEND_API_KEY not set in .env (required unless EMAIL_PROVIDER=mock)${NC}"
    exit 1
fi

# Show email provider mode
if [ "$EMAIL_PROVIDER" = "mock" ]; then
    echo -e "${YELLOW}  ⚡ Mock email provider enabled (dry-run mode)${NC}"
fi

# Start Docker services
echo -e "${CYAN}  [2/5]${NC} Starting Docker services..."
docker compose -f docker-compose.local.yml up -d nats clickhouse 2>&1 | grep -v "Running\|Created\|Starting" || true
echo -e "${GREEN}  ✓${NC} Docker containers started"

# Wait for NATS
echo -e "${CYAN}  [3/5]${NC} Waiting for NATS..."
for i in {1..30}; do
    if curl -s "http://localhost:8222/healthz" 2>/dev/null | grep -q "ok"; then
        echo -e "${GREEN}  ✓${NC} NATS ready (localhost:4222)"
        break
    fi
    if [ $i -eq 30 ]; then
        echo -e "${RED}  ✗ NATS failed to start${NC}"
        exit 1
    fi
    sleep 1
done

# Wait for ClickHouse
echo -e "${CYAN}  [4/5]${NC} Waiting for ClickHouse..."
for i in {1..30}; do
    if curl -s "http://localhost:8123/ping" 2>/dev/null | grep -q "Ok"; then
        echo -e "${GREEN}  ✓${NC} ClickHouse ready (localhost:8123)"
        break
    fi
    if [ $i -eq 30 ]; then
        echo -e "${RED}  ✗ ClickHouse failed to start${NC}"
        exit 1
    fi
    sleep 1
done

# Ensure ClickHouse tables exist
docker exec -i batchsender-clickhouse-1 clickhouse-client --password clickhouse 2>/dev/null << 'EOF' || true
CREATE DATABASE IF NOT EXISTS batchsender;

CREATE TABLE IF NOT EXISTS batchsender.email_events
(
    event_id UUID DEFAULT generateUUIDv4(),
    event_type Enum8('queued' = 1, 'sent' = 2, 'delivered' = 3, 'opened' = 4, 'clicked' = 5, 'bounced' = 6, 'complained' = 7, 'failed' = 8),
    batch_id UUID,
    recipient_id UUID,
    user_id UUID,
    email String,
    provider_message_id String,
    metadata String DEFAULT '{}',
    error_message String DEFAULT '',
    created_at DateTime DEFAULT now(),
    event_date Date DEFAULT toDate(created_at)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(event_date)
ORDER BY (user_id, batch_id, created_at)
TTL event_date + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS batchsender.email_message_index
(
    provider_message_id String,
    recipient_id UUID,
    batch_id UUID,
    user_id UUID,
    created_at DateTime DEFAULT now()
)
ENGINE = MergeTree()
ORDER BY provider_message_id
TTL created_at + INTERVAL 30 DAY;
EOF

# Build db package if needed
if [ ! -d "packages/db/dist" ]; then
    echo -e "${CYAN}  ...${NC} Building @batchsender/db package..."
    pnpm --filter=@batchsender/db build > /dev/null 2>&1
fi

# Start services
echo -e "${CYAN}  [5/5]${NC} Starting application services..."

# Create named pipes for log aggregation
LOG_DIR="/tmp/batchsender-logs"
rm -rf "$LOG_DIR"
mkdir -p "$LOG_DIR"

# Start web app (logs to file)
(cd apps/web && exec npm run dev 2>&1) > "$LOG_DIR/web.log" 2>&1 &
WEB_PID=$!

# Start worker (logs to file)
(cd apps/worker && exec npx tsx watch src/index.ts 2>&1) > "$LOG_DIR/worker.log" 2>&1 &
WORKER_PID=$!

# Wait for services to be ready (silently)
echo -e "${YELLOW}  Waiting for services...${NC}"
for i in {1..30}; do
    WEB_READY=false
    WORKER_READY=false

    if curl -s http://localhost:5001 > /dev/null 2>&1; then
        WEB_READY=true
    fi
    if curl -s http://localhost:6001/health > /dev/null 2>&1; then
        WORKER_READY=true
    fi

    if $WEB_READY && $WORKER_READY; then
        break
    fi
    sleep 1
done

# Final status
echo ""
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}${GREEN}  ✓ All services running!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${BOLD}Services:${NC}"
echo -e "  ┌──────────────────┬─────────────────────────────────┐"
echo -e "  │ ${CYAN}Web App${NC}          │ http://localhost:5001           │"
echo -e "  │ ${CYAN}Worker API${NC}       │ http://localhost:6001           │"
echo -e "  │ ${CYAN}NATS${NC}             │ localhost:4222                  │"
echo -e "  │ ${CYAN}ClickHouse${NC}       │ http://localhost:8123           │"
echo -e "  └──────────────────┴─────────────────────────────────┘"
echo ""
echo -e "  ${BOLD}Press Ctrl+C to stop all services${NC}"
echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${BOLD}  Live logs:${NC}"
echo ""

# Simple unified log tailing using tail with line-buffering
# This uses a single tail process to avoid race conditions
tail -f "$LOG_DIR/web.log" "$LOG_DIR/worker.log" 2>/dev/null | while IFS= read -r line; do
    # Add color prefix based on content
    if [[ "$line" == "==> "* ]]; then
        # This is the file header from tail -f
        if [[ "$line" == *"web.log"* ]]; then
            echo -e "${CYAN}[web]${NC} ─────────────────────────"
        elif [[ "$line" == *"worker.log"* ]]; then
            echo -e "${GREEN}[worker]${NC} ─────────────────────────"
        fi
    else
        echo "  $line"
    fi
done
