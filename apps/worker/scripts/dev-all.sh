#!/bin/bash
#
# Start all worker services for local development
#
# Usage: ./scripts/dev-all.sh
#
# Services:
#   - API Server      (port 6001)
#   - Batch Processor (port 6002)
#   - Sender Worker   (port 6003)
#   - Webhook Processor (port 6004)
#   - Leader Services (port 6005)
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Trap to kill all background processes on exit
cleanup() {
    echo -e "\n${YELLOW}Shutting down all services...${NC}"
    kill $(jobs -p) 2>/dev/null || true
    wait
    echo -e "${GREEN}All services stopped.${NC}"
}
trap cleanup EXIT INT TERM

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Starting BatchSender Services${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Check if infrastructure is running
if ! curl -s http://localhost:4222 > /dev/null 2>&1; then
    echo -e "${YELLOW}Warning: NATS doesn't seem to be running on localhost:4222${NC}"
    echo -e "${YELLOW}Run 'docker-compose up -d' first${NC}"
    echo ""
fi

# Start services with different ports
echo -e "${GREEN}Starting API Server on port 6001...${NC}"
PORT=6001 tsx watch src/entrypoints/api-server.ts 2>&1 | sed 's/^/[API]     /' &
sleep 1

echo -e "${GREEN}Starting Batch Processor on port 6002...${NC}"
PORT=6002 tsx watch src/entrypoints/batch-processor.ts 2>&1 | sed 's/^/[BATCH]   /' &
sleep 1

echo -e "${GREEN}Starting Sender Worker on port 6003...${NC}"
PORT=6003 tsx watch src/entrypoints/sender-worker.ts 2>&1 | sed 's/^/[SENDER]  /' &
sleep 1

echo -e "${GREEN}Starting Webhook Processor on port 6004...${NC}"
PORT=6004 tsx watch src/entrypoints/webhook-processor.ts 2>&1 | sed 's/^/[WEBHOOK] /' &
sleep 1

echo -e "${GREEN}Starting Leader Services on port 6005...${NC}"
PORT=6005 tsx watch src/entrypoints/leader-services.ts 2>&1 | sed 's/^/[LEADER]  /' &

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}  All services starting...${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "  API Server:       http://localhost:6001"
echo -e "  Batch Processor:  http://localhost:6002/health"
echo -e "  Sender Worker:    http://localhost:6003/health"
echo -e "  Webhook Processor:http://localhost:6004/health"
echo -e "  Leader Services:  http://localhost:6005/health"
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop all services${NC}"
echo ""

# Wait for all background processes
wait
