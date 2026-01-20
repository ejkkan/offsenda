#!/bin/bash
# =============================================================================
# DNS Failover Script for BatchSender Multi-Region Setup
# =============================================================================
#
# Simple failover script that monitors both regions and switches DNS if
# the primary region goes down.
#
# Prerequisites:
# 1. Cloudflare API token with DNS edit permissions
# 2. flarectl or cloudflare-cli installed
#
# Usage:
#   ./dns-failover.sh
#
# Run via cron every minute:
#   * * * * * /path/to/dns-failover.sh >> /var/log/dns-failover.log 2>&1
#
# =============================================================================

set -euo pipefail

# Configuration
CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
CLOUDFLARE_ZONE_ID="${CLOUDFLARE_ZONE_ID:-}"
DOMAIN="api.batchsender.com"

# Region IPs (update these with actual LoadBalancer IPs)
FALKENSTEIN_IP="${FALKENSTEIN_IP:-}"  # Primary (EU)
ASHBURN_IP="${ASHBURN_IP:-}"          # Secondary (US)

# Health check endpoints
FALKENSTEIN_HEALTH="https://api.batchsender.com/health"
ASHBURN_HEALTH="https://api-us.batchsender.com/health"

# Alert webhook (optional - Slack, Discord, etc.)
ALERT_WEBHOOK="${ALERT_WEBHOOK:-}"

# State file to track current active region
STATE_FILE="/tmp/dns-failover-state"

# Logging
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

alert() {
    local message="$1"
    log "ALERT: $message"

    if [[ -n "$ALERT_WEBHOOK" ]]; then
        curl -s -X POST "$ALERT_WEBHOOK" \
            -H "Content-Type: application/json" \
            -d "{\"text\": \"[BatchSender DNS Failover] $message\"}" \
            > /dev/null 2>&1 || true
    fi
}

check_health() {
    local url="$1"
    local timeout=10

    http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$timeout" "$url" 2>/dev/null || echo "000")

    if [[ "$http_code" == "200" ]]; then
        return 0
    else
        return 1
    fi
}

get_current_dns() {
    # Get current DNS A record for the domain
    if [[ -n "$CLOUDFLARE_API_TOKEN" ]] && [[ -n "$CLOUDFLARE_ZONE_ID" ]]; then
        curl -s -X GET "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records?name=$DOMAIN&type=A" \
            -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
            -H "Content-Type: application/json" | jq -r '.result[0].content // empty'
    else
        log "Cloudflare credentials not configured"
        echo ""
    fi
}

update_dns() {
    local new_ip="$1"
    local record_id

    if [[ -z "$CLOUDFLARE_API_TOKEN" ]] || [[ -z "$CLOUDFLARE_ZONE_ID" ]]; then
        log "Cloudflare credentials not configured - skipping DNS update"
        return 1
    fi

    # Get record ID
    record_id=$(curl -s -X GET "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records?name=$DOMAIN&type=A" \
        -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
        -H "Content-Type: application/json" | jq -r '.result[0].id // empty')

    if [[ -z "$record_id" ]]; then
        log "Could not find DNS record for $DOMAIN"
        return 1
    fi

    # Update DNS record
    curl -s -X PUT "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records/$record_id" \
        -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
        -H "Content-Type: application/json" \
        --data "{\"type\":\"A\",\"name\":\"$DOMAIN\",\"content\":\"$new_ip\",\"ttl\":60,\"proxied\":true}" \
        > /dev/null

    log "DNS updated: $DOMAIN -> $new_ip"
}

get_state() {
    if [[ -f "$STATE_FILE" ]]; then
        cat "$STATE_FILE"
    else
        echo "falkenstein"  # Default to primary
    fi
}

set_state() {
    echo "$1" > "$STATE_FILE"
}

main() {
    log "Starting health check..."

    # Check if required IPs are configured
    if [[ -z "$FALKENSTEIN_IP" ]] || [[ -z "$ASHBURN_IP" ]]; then
        log "Region IPs not configured. Set FALKENSTEIN_IP and ASHBURN_IP environment variables."
        exit 1
    fi

    # Check health of both regions
    falkenstein_healthy=false
    ashburn_healthy=false

    if check_health "$FALKENSTEIN_HEALTH"; then
        falkenstein_healthy=true
        log "Falkenstein (EU): HEALTHY"
    else
        log "Falkenstein (EU): UNHEALTHY"
    fi

    if check_health "$ASHBURN_HEALTH"; then
        ashburn_healthy=true
        log "Ashburn (US): HEALTHY"
    else
        log "Ashburn (US): UNHEALTHY"
    fi

    current_state=$(get_state)
    log "Current active region: $current_state"

    # Decision logic
    if [[ "$falkenstein_healthy" == "true" ]] && [[ "$current_state" != "falkenstein" ]]; then
        # Primary is back up, failback
        log "Primary (Falkenstein) is back up, failing back..."
        if update_dns "$FALKENSTEIN_IP"; then
            set_state "falkenstein"
            alert "Failback complete: Traffic restored to Falkenstein (EU)"
        fi
    elif [[ "$falkenstein_healthy" == "false" ]] && [[ "$ashburn_healthy" == "true" ]] && [[ "$current_state" == "falkenstein" ]]; then
        # Primary is down, secondary is up - failover
        log "Primary (Falkenstein) is down, failing over to Ashburn..."
        if update_dns "$ASHBURN_IP"; then
            set_state "ashburn"
            alert "Failover triggered: Traffic switched to Ashburn (US) - Falkenstein is down"
        fi
    elif [[ "$falkenstein_healthy" == "false" ]] && [[ "$ashburn_healthy" == "false" ]]; then
        # Both regions are down
        alert "CRITICAL: Both regions are unreachable!"
    else
        log "No action needed"
    fi

    log "Health check complete"
}

main "$@"
