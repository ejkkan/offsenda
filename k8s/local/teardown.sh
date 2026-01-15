#!/bin/bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}Stopping BatchSender local Kubernetes cluster...${NC}"

if k3d cluster list | grep -q "batchsender"; then
    k3d cluster delete batchsender
    echo -e "${GREEN}✓ Cluster deleted${NC}"
else
    echo -e "${YELLOW}Cluster 'batchsender' not found${NC}"
fi

echo ""
echo -e "${GREEN}Done!${NC}"
