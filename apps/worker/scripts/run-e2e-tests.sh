#!/bin/bash

# E2E Test Runner Script
# This script sets up infrastructure, runs tests, and cleans up

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}================================${NC}"
echo -e "${GREEN}  BatchSender E2E Test Runner${NC}"
echo -e "${GREEN}================================${NC}"
echo ""

# Check if docker is running
if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}Error: Docker is not running${NC}"
    exit 1
fi

# Function to cleanup
cleanup() {
    echo ""
    echo -e "${YELLOW}Cleaning up test infrastructure...${NC}"
    docker-compose -f docker-compose.test.yml down -v > /dev/null 2>&1 || true
    echo -e "${GREEN}✓ Cleanup complete${NC}"
}

# Trap cleanup on exit
trap cleanup EXIT INT TERM

echo -e "${YELLOW}Step 1: Starting test infrastructure...${NC}"
docker-compose -f docker-compose.test.yml up -d

echo ""
echo -e "${YELLOW}Step 2: Waiting for services to be healthy...${NC}"

# Wait for NATS
echo -n "  Waiting for NATS..."
for i in {1..30}; do
    if curl -s http://localhost:8222/healthz > /dev/null 2>&1; then
        echo -e " ${GREEN}✓${NC}"
        break
    fi
    sleep 1
    if [ $i -eq 30 ]; then
        echo -e " ${RED}✗ (timeout)${NC}"
        exit 1
    fi
done

# Wait for PostgreSQL
echo -n "  Waiting for PostgreSQL..."
for i in {1..30}; do
    if docker exec batchsender-test-postgres pg_isready -U test > /dev/null 2>&1; then
        echo -e " ${GREEN}✓${NC}"
        break
    fi
    sleep 1
    if [ $i -eq 30 ]; then
        echo -e " ${RED}✗ (timeout)${NC}"
        exit 1
    fi
done

# Wait for ClickHouse
echo -n "  Waiting for ClickHouse..."
for i in {1..30}; do
    if curl -s http://localhost:8124/ping > /dev/null 2>&1; then
        echo -e " ${GREEN}✓${NC}"
        break
    fi
    sleep 1
    if [ $i -eq 30 ]; then
        echo -e " ${RED}✗ (timeout)${NC}"
        exit 1
    fi
done

echo ""
echo -e "${GREEN}✓ All services are ready${NC}"
echo ""

# Run database migrations if needed
echo -e "${YELLOW}Step 3: Running database migrations...${NC}"
cd ../../packages/db
pnpm db:push || echo -e "${YELLOW}Warning: Migration failed or already up to date${NC}"
cd ../../apps/worker

echo ""
echo -e "${YELLOW}Step 4: Running E2E tests...${NC}"
echo ""

# Run tests
if pnpm test:e2e; then
    echo ""
    echo -e "${GREEN}================================${NC}"
    echo -e "${GREEN}  ✓ All E2E tests passed!${NC}"
    echo -e "${GREEN}================================${NC}"
    exit 0
else
    echo ""
    echo -e "${RED}================================${NC}"
    echo -e "${RED}  ✗ E2E tests failed${NC}"
    echo -e "${RED}================================${NC}"
    exit 1
fi
