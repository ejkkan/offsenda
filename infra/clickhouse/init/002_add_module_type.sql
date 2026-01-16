-- Migration: Add module_type column to email_events table
-- This allows tracking which module (email, webhook, etc.) was used for each event

-- Add module_type column with default 'email' for backwards compatibility
ALTER TABLE email_events
    ADD COLUMN IF NOT EXISTS module_type Enum8(
        'email' = 1,
        'webhook' = 2
    ) DEFAULT 'email';

-- Add index for module_type queries
ALTER TABLE email_events
    ADD INDEX IF NOT EXISTS idx_module_type module_type TYPE set(2) GRANULARITY 4;
