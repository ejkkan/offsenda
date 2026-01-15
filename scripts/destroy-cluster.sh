#!/bin/bash

#######################################################
#  BatchSender Cluster Destroy Script
#######################################################
#
# This script safely destroys the Hetzner k3s cluster
# and cleans up all resources.
#
# Prerequisites:
# - cluster-config.yaml exists
# - hetzner-k3s CLI installed
#
# Usage:
#   ./scripts/destroy-cluster.sh
#
# WARNING: This will delete ALL resources in the cluster!
#
#######################################################

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

echo ""
echo -e "${BOLD}${RED}⚠️  BatchSender Cluster Destruction${NC}"
echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Check prerequisites
command -v hetzner-k3s >/dev/null 2>&1 || {
  echo -e "${RED}✗ hetzner-k3s not found${NC}"
  echo -e "  Install: ${CYAN}brew install vitobotta/tap/hetzner_k3s${NC}"
  exit 1
}

if [ ! -f "cluster-config.yaml" ]; then
  echo -e "${RED}✗ cluster-config.yaml not found${NC}"
  echo -e "  Cannot determine which cluster to destroy."
  exit 1
fi

# Show cluster info
echo -e "${YELLOW}This will destroy the following cluster:${NC}"
echo ""
CLUSTER_NAME=$(grep "cluster_name:" cluster-config.yaml | awk '{print $2}')
echo -e "  Cluster: ${BOLD}${CLUSTER_NAME}${NC}"
echo ""
echo -e "${RED}${BOLD}All resources will be permanently deleted:${NC}"
echo -e "  • 3 master nodes"
echo -e "  • All worker nodes"
echo -e "  • All load balancers"
echo -e "  • All volumes"
echo -e "  • All data (databases, ClickHouse, etc.)"
echo ""

# Confirmation prompt
read -p "$(echo -e ${YELLOW}Type \'destroy\' to confirm: ${NC})" CONFIRM

if [ "$CONFIRM" != "destroy" ]; then
  echo ""
  echo -e "${GREEN}✓${NC} Cluster destruction cancelled."
  echo ""
  exit 0
fi

echo ""
echo -e "${CYAN}→${NC} Destroying cluster..."
echo ""

# Destroy cluster
hetzner-k3s delete --config cluster-config.yaml

echo ""
echo -e "${GREEN}✓${NC} Cluster destroyed successfully"
echo ""

# Offer to clean up local files
echo -e "${YELLOW}Clean up local files?${NC}"
echo -e "  • kubeconfig"
echo -e "  • sealed-secrets-cert.pem"
echo ""
read -p "$(echo -e ${YELLOW}Clean up? [y/N]: ${NC})" CLEANUP

if [ "$CLEANUP" = "y" ] || [ "$CLEANUP" = "Y" ]; then
  rm -f kubeconfig sealed-secrets-cert.pem
  echo -e "${GREEN}✓${NC} Local files cleaned up"
fi

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}${GREEN}✓ Destruction complete${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${CYAN}To create a new cluster:${NC}"
echo -e "  ${CYAN}hetzner-k3s create --config cluster-config.yaml${NC}"
echo ""
