#!/bin/bash
# Update Grafana dashboard in k8s/monitoring/grafana-deployment.yaml
#
# Usage:
#   ./scripts/update-grafana-dashboard.sh              # Interactive - paste JSON
#   ./scripts/update-grafana-dashboard.sh dashboard.json  # From file

set -e

DEPLOYMENT_FILE="k8s/monitoring/grafana-deployment.yaml"

if [ ! -f "$DEPLOYMENT_FILE" ]; then
  echo "Error: $DEPLOYMENT_FILE not found. Run from repo root."
  exit 1
fi

# Get dashboard JSON
if [ -n "$1" ] && [ -f "$1" ]; then
  echo "Reading dashboard from $1..."
  DASHBOARD_JSON=$(cat "$1")
else
  echo "Paste your dashboard JSON below, then press Ctrl+D:"
  DASHBOARD_JSON=$(cat)
fi

# Validate it's valid JSON
echo "$DASHBOARD_JSON" | jq . > /dev/null 2>&1 || { echo "Error: Invalid JSON"; exit 1; }

# Format and indent for YAML embedding
INDENTED_JSON=$(echo "$DASHBOARD_JSON" | jq -c '.' | jq '.' | sed 's/^/    /')

# Create temp file with new content
TEMP_FILE=$(mktemp)

# Use awk to replace the batchsender.json section
awk -v json="$INDENTED_JSON" '
  /^  batchsender\.json: \|$/ {
    print;
    print json;
    in_json=1;
    next
  }
  in_json && /^---$/ { in_json=0 }
  in_json && /^  [a-zA-Z]/ { in_json=0 }
  !in_json { print }
' "$DEPLOYMENT_FILE" > "$TEMP_FILE"

mv "$TEMP_FILE" "$DEPLOYMENT_FILE"

echo ""
echo "Updated $DEPLOYMENT_FILE"
echo ""
echo "Next steps:"
echo "  git add $DEPLOYMENT_FILE"
echo "  git commit -m 'Update Grafana dashboard'"
echo "  git push"
echo ""
echo "Then restart Grafana:"
echo "  kubectl rollout restart deployment grafana -n monitoring"
