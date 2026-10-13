-- 002_queue_governance.sql
-- Queue Governance: Single-queue per channel, Admin ACLs, and Secret Attachment Toggle

ALTER TABLE queues 
ADD COLUMN IF NOT EXISTS admin_user_ids TEXT[] NOT NULL DEFAULT '{}',
ADD COLUMN IF NOT EXISTS allow_secret BOOLEAN NOT NULL DEFAULT FALSE;
