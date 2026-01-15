#!/bin/bash

#######################################################
#  BatchSender Sealed Secrets Generator
#######################################################
#
# This script reads .env.prod and automatically generates
# all sealed secrets for production deployment.
#
# Prerequisites:
# - .env.prod file exists in project root
# - sealed-secrets-cert.pem exists (from bootstrap)
# - kubeseal installed
#
# Usage:
#   ./scripts/seal-secrets.sh
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
echo -e "${BOLD}${CYAN}🔒 BatchSender Sealed Secrets Generator${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Check prerequisites
command -v kubeseal >/dev/null 2>&1 || {
  echo -e "${RED}✗ kubeseal not found${NC}"
  echo -e "  Install: ${CYAN}brew install kubeseal${NC}"
  exit 1
}

if [ ! -f ".env.prod" ]; then
  echo -e "${RED}✗ .env.prod file not found${NC}"
  echo ""
  echo -e "  Create .env.prod with your production secrets:"
  echo -e "  ${CYAN}cp .env.example .env.prod${NC}"
  echo ""
  echo -e "  Required variables:"
  echo -e "  - DATABASE_URL"
  echo -e "  - RESEND_API_KEY"
  echo -e "  - WEBHOOK_SECRET"
  echo -e "  - CLICKHOUSE_PASSWORD"
  echo -e "  - CLICKHOUSE_USER"
  echo -e "  - CLICKHOUSE_DATABASE"
  echo -e "  - B2_KEY_ID"
  echo -e "  - B2_APP_KEY"
  echo -e "  - B2_BUCKET"
  echo ""
  exit 1
fi

if [ ! -f "sealed-secrets-cert.pem" ]; then
  echo -e "${RED}✗ sealed-secrets-cert.pem not found${NC}"
  echo -e "  Run bootstrap first: ${CYAN}./scripts/bootstrap-infrastructure.sh${NC}"
  exit 1
fi

# Load .env.prod
echo -e "${CYAN}→${NC} Loading secrets from .env.prod..."
set -a
source .env.prod
set +a

# Validate required variables
MISSING_VARS=0

check_var() {
  if [ -z "${!1}" ]; then
    echo -e "${RED}✗ Missing: ${1}${NC}"
    MISSING_VARS=$((MISSING_VARS + 1))
  fi
}

check_var "DATABASE_URL"
check_var "RESEND_API_KEY"
check_var "WEBHOOK_SECRET"
check_var "CLICKHOUSE_PASSWORD"
check_var "CLICKHOUSE_USER"
check_var "CLICKHOUSE_DATABASE"
check_var "B2_KEY_ID"
check_var "B2_APP_KEY"
check_var "B2_BUCKET"

if [ $MISSING_VARS -gt 0 ]; then
  echo ""
  echo -e "${RED}✗ Found ${MISSING_VARS} missing variables in .env.prod${NC}"
  exit 1
fi

echo -e "${GREEN}✓${NC} All required variables present"
echo ""

# Create k8s/base directories if they don't exist
mkdir -p k8s/base/worker
mkdir -p k8s/base/clickhouse

# Encrypt worker secrets
echo -e "${CYAN}→${NC} Encrypting worker secrets..."
kubectl create secret generic worker-secrets \
  --from-literal=DATABASE_URL="$DATABASE_URL" \
  --from-literal=RESEND_API_KEY="$RESEND_API_KEY" \
  --from-literal=WEBHOOK_SECRET="$WEBHOOK_SECRET" \
  --from-literal=CLICKHOUSE_PASSWORD="$CLICKHOUSE_PASSWORD" \
  --namespace=batchsender \
  --dry-run=client -o yaml | \
  kubeseal --cert=sealed-secrets-cert.pem -o yaml > k8s/base/worker/sealed-secrets.yaml

echo -e "${GREEN}✓${NC} Created: k8s/base/worker/sealed-secrets.yaml"

# Encrypt ClickHouse secrets
echo -e "${CYAN}→${NC} Encrypting ClickHouse secrets..."
kubectl create secret generic clickhouse-secrets \
  --from-literal=password="$CLICKHOUSE_PASSWORD" \
  --from-literal=user="$CLICKHOUSE_USER" \
  --from-literal=database="$CLICKHOUSE_DATABASE" \
  --namespace=batchsender \
  --dry-run=client -o yaml | \
  kubeseal --cert=sealed-secrets-cert.pem -o yaml > k8s/base/clickhouse/sealed-secrets.yaml

echo -e "${GREEN}✓${NC} Created: k8s/base/clickhouse/sealed-secrets.yaml"

# Encrypt Backblaze B2 secrets
echo -e "${CYAN}→${NC} Encrypting Backblaze B2 secrets..."
kubectl create secret generic clickhouse-b2-secret \
  --from-literal=B2_KEY_ID="$B2_KEY_ID" \
  --from-literal=B2_APP_KEY="$B2_APP_KEY" \
  --from-literal=B2_BUCKET="$B2_BUCKET" \
  --namespace=batchsender \
  --dry-run=client -o yaml | \
  kubeseal --cert=sealed-secrets-cert.pem -o yaml > k8s/base/clickhouse/sealed-b2-secret.yaml

echo -e "${GREEN}✓${NC} Created: k8s/base/clickhouse/sealed-b2-secret.yaml"

# Summary
echo ""
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}${GREEN}✓ All secrets encrypted successfully!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${BOLD}Generated files:${NC}"
echo -e "  • k8s/base/worker/sealed-secrets.yaml"
echo -e "  • k8s/base/clickhouse/sealed-secrets.yaml"
echo -e "  • k8s/base/clickhouse/sealed-b2-secret.yaml"
echo ""
echo -e "${BOLD}${CYAN}Next steps:${NC}"
echo -e "  1. Review the generated files (they're encrypted and safe to commit)"
echo -e "  2. Commit to git:"
echo -e "     ${CYAN}git add k8s/base/*/sealed-*.yaml${NC}"
echo -e "     ${CYAN}git commit -m 'Add encrypted production secrets'${NC}"
echo -e "  3. Push to GitHub:"
echo -e "     ${CYAN}git push origin main${NC}"
echo -e "  4. Deploy to production:"
echo -e "     ${CYAN}kubectl apply -k k8s/overlays/production${NC}"
echo ""
echo -e "${YELLOW}⚠️  Important: Never commit .env.prod to git!${NC}"
echo -e "  Add it to .gitignore if not already present."
echo ""
