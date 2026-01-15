#!/bin/bash
# ClickHouse restore script - restores from Backblaze B2
# Usage: ./scripts/clickhouse-restore.sh <backup_name>
# Example: ./scripts/clickhouse-restore.sh backup_full_20260113_120000

set -e

# Load environment variables
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

BACKUP_NAME="$1"

if [ -z "$BACKUP_NAME" ]; then
    echo "Usage: $0 <backup_name>"
    echo ""
    echo "Available backups:"
    docker exec batchsender-clickhouse-1 clickhouse-client --query "
        SELECT name, status, start_time, formatReadableSize(total_size) as size
        FROM system.backups
        ORDER BY start_time DESC
        LIMIT 10
        FORMAT PrettyCompact
    " 2>/dev/null || echo "No backup history in ClickHouse. Check B2 bucket manually."
    exit 1
fi

# B2 endpoint
B2_ENDPOINT="https://s3.eu-central-003.backblazeb2.com/batchsender-clickhouse-cold/backups/"

echo "WARNING: This will restore database from backup: ${BACKUP_NAME}"
echo "Existing data may be overwritten!"
read -p "Are you sure? (yes/no): " confirm

if [ "$confirm" != "yes" ]; then
    echo "Restore cancelled."
    exit 1
fi

echo "Starting restore..."

docker exec batchsender-clickhouse-1 clickhouse-client --query "
    RESTORE DATABASE default FROM S3(
        '${B2_ENDPOINT}${BACKUP_NAME}/',
        '${B2_KEY_ID}',
        '${B2_APP_KEY}'
    )
"

echo "Restore completed from: ${BACKUP_NAME}"
