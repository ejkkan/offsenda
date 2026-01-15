#!/bin/bash
# ClickHouse backup script - backs up to Backblaze B2
# Usage: ./scripts/clickhouse-backup.sh [full|incremental]

set -e

# Load environment variables
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

# Configuration
BACKUP_TYPE="${1:-full}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="backup_${BACKUP_TYPE}_${TIMESTAMP}"

# B2 endpoint (same bucket, /backups/ prefix)
B2_ENDPOINT="https://s3.eu-central-003.backblazeb2.com/batchsender-clickhouse-cold/backups/"

# ClickHouse connection
CH_HOST="${CLICKHOUSE_HOST:-localhost}"
CH_PORT="${CLICKHOUSE_PORT:-8123}"
CH_USER="${CLICKHOUSE_USER:-default}"
CH_PASSWORD="${CLICKHOUSE_PASSWORD:-clickhouse}"

echo "Starting ClickHouse backup: ${BACKUP_NAME}"
echo "Backup type: ${BACKUP_TYPE}"
echo "Destination: B2 (batchsender-clickhouse-cold/backups/)"

# Run backup using native BACKUP command
if [ "$BACKUP_TYPE" = "full" ]; then
    # Full backup of all tables
    docker exec batchsender-clickhouse-1 clickhouse-client --query "
        BACKUP DATABASE default TO S3(
            '${B2_ENDPOINT}${BACKUP_NAME}/',
            '${B2_KEY_ID}',
            '${B2_APP_KEY}'
        ) SETTINGS compression_level=3
    "
else
    # Incremental backup (based on last full backup)
    LAST_FULL=$(docker exec batchsender-clickhouse-1 clickhouse-client --query "
        SELECT name FROM system.backups
        WHERE name LIKE 'backup_full_%'
        ORDER BY start_time DESC LIMIT 1
    " 2>/dev/null || echo "")

    if [ -z "$LAST_FULL" ]; then
        echo "No previous full backup found. Running full backup instead."
        BACKUP_NAME="backup_full_${TIMESTAMP}"
        docker exec batchsender-clickhouse-1 clickhouse-client --query "
            BACKUP DATABASE default TO S3(
                '${B2_ENDPOINT}${BACKUP_NAME}/',
                '${B2_KEY_ID}',
                '${B2_APP_KEY}'
            ) SETTINGS compression_level=3
        "
    else
        docker exec batchsender-clickhouse-1 clickhouse-client --query "
            BACKUP DATABASE default TO S3(
                '${B2_ENDPOINT}${BACKUP_NAME}/',
                '${B2_KEY_ID}',
                '${B2_APP_KEY}'
            ) SETTINGS base_backup = S3(
                '${B2_ENDPOINT}${LAST_FULL}/',
                '${B2_KEY_ID}',
                '${B2_APP_KEY}'
            ), compression_level=3
        "
    fi
fi

echo "Backup completed: ${BACKUP_NAME}"

# List recent backups
echo ""
echo "Recent backups:"
docker exec batchsender-clickhouse-1 clickhouse-client --query "
    SELECT name, status, start_time, end_time,
           formatReadableSize(total_size) as size
    FROM system.backups
    ORDER BY start_time DESC
    LIMIT 5
    FORMAT PrettyCompact
" 2>/dev/null || echo "No backup history available"
