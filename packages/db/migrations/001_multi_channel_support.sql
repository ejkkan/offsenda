-- Migration: Multi-Channel Support
-- Date: 2026-01-16
-- Description: Add generic payload and identifier columns for multi-channel messaging

-- 1. Add new module types (sms and push)
-- Note: This may fail if the types already exist, which is fine
DO $$
BEGIN
    ALTER TYPE module_type ADD VALUE IF NOT EXISTS 'sms';
    ALTER TYPE module_type ADD VALUE IF NOT EXISTS 'push';
EXCEPTION WHEN duplicate_object THEN
    NULL;
END$$;

-- 2. Add payload JSONB column to batches table
ALTER TABLE batches
ADD COLUMN IF NOT EXISTS payload JSONB;

COMMENT ON COLUMN batches.payload IS 'Module-specific payload. Email: {subject, htmlContent, textContent, fromEmail?, fromName?}. SMS: {message, fromNumber?}. Push: {title, body, data?, icon?}. Webhook: {body, method?, headers?}';

-- 3. Add identifier column to recipients table
ALTER TABLE recipients
ADD COLUMN IF NOT EXISTS identifier VARCHAR(500);

COMMENT ON COLUMN recipients.identifier IS 'Generic recipient identifier (email, phone number, device token, URL)';

-- 4. Backfill identifier from email for existing records
UPDATE recipients
SET identifier = email
WHERE identifier IS NULL AND email IS NOT NULL;

-- 5. Create index on identifier column
CREATE INDEX IF NOT EXISTS recipients_identifier_idx ON recipients(identifier);

-- Done! The schema now supports:
-- - Email batches (using legacy fields or payload.subject/htmlContent/etc)
-- - SMS batches (using payload.message)
-- - Push batches (using payload.title/body)
-- - Webhook batches (using payload.body)
