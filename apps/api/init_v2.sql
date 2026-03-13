-- ============================================================
-- SwarmBuild v2 Migration
-- Run this AFTER the v1 schema (init.sql) is already in place.
-- Reference: The Engineering/10-DATABASE-SCHEMA.md
-- ============================================================

-- ─────────────────────────────────────────
-- 1. Jobs table updates
-- ─────────────────────────────────────────

-- Budget enforcement
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS budget_cap INT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS budget_warning_pct INT DEFAULT 80;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS budget_used INT DEFAULT 0;

-- Verification configuration
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS min_verification_tier INT DEFAULT 0;

-- ─────────────────────────────────────────
-- 2. Contributors table updates
-- ─────────────────────────────────────────

-- Lifecycle state machine
ALTER TABLE contributors ADD COLUMN IF NOT EXISTS contributor_status TEXT DEFAULT 'active';

-- Current work tracking
ALTER TABLE contributors ADD COLUMN IF NOT EXISTS current_task_id UUID;

-- Metrics (some already exist in v1, these are new additions)
ALTER TABLE contributors ADD COLUMN IF NOT EXISTS tasks_completed INT DEFAULT 0;

-- ─────────────────────────────────────────
-- 3. Tasks table updates
-- ─────────────────────────────────────────

-- DAG dependencies
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS depends_on UUID[] DEFAULT '{}';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parallel_group TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS estimated_duration INT;

-- Verification state
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS verification_tier INT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS verification_status TEXT DEFAULT 'none';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS verification_log JSONB DEFAULT '[]';

-- ─────────────────────────────────────────
-- 4. New tables
-- ─────────────────────────────────────────

-- Task Attempts — tracks every claim attempt with outcome
-- Reference: 01-FAULT-TOLERANCE.md
CREATE TABLE IF NOT EXISTS task_attempts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id         UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    worker_token    TEXT NOT NULL,

    -- Timing
    started_at      TIMESTAMPTZ DEFAULT now(),
    ended_at        TIMESTAMPTZ,

    -- Outcome
    outcome         TEXT NOT NULL DEFAULT 'in_progress'
                    CHECK (outcome IN (
                        'in_progress',
                        'completed',
                        'failed',
                        'agent_disconnected',
                        'agent_crashed',
                        'budget_exhausted',
                        'manually_released'
                    )),

    -- Context
    log_summary     TEXT,
    branch_name     TEXT,
    commit_sha      TEXT,
    files_changed   INT DEFAULT 0,
    tokens_used     INT DEFAULT 0
);

-- Merge Queue — FIFO queue for processing branch merges into main
-- Reference: 02-MERGE-RESOLUTION.md
CREATE TABLE IF NOT EXISTS merge_queue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    task_id         UUID NOT NULL REFERENCES tasks(id),
    worker_token    TEXT NOT NULL,

    -- Git info
    branch_name     TEXT NOT NULL,
    commit_sha      TEXT,

    -- Queue management
    position        INT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN (
                        'pending',
                        'processing',
                        'merged',
                        'conflict',
                        'failed',
                        'cancelled'
                    )),

    -- Conflict info
    conflict_tier   INT,
    conflict_files  JSONB,
    conflict_diff   TEXT,
    resolution_by   TEXT,

    -- Timing
    created_at      TIMESTAMPTZ DEFAULT now(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,

    -- Stats
    files_changed   INT DEFAULT 0,
    lines_added     INT DEFAULT 0,
    lines_removed   INT DEFAULT 0
);

-- Audit Log — comprehensive audit trail for all API actions
-- Reference: 09-SECURITY.md
CREATE TABLE IF NOT EXISTS audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp       TIMESTAMPTZ DEFAULT now(),

    -- Who
    worker_token    TEXT,
    contributor_id  UUID,
    job_id          UUID NOT NULL,
    role            TEXT,

    -- What
    action          TEXT NOT NULL,
    resource_type   TEXT,
    resource_id     TEXT,

    -- Context
    request_body    JSONB,
    response_status INT,

    -- Metadata
    ip_address      TEXT,
    user_agent      TEXT,
    duration_ms     INT
);

-- ─────────────────────────────────────────
-- 5. Indexes
-- ─────────────────────────────────────────

-- task_attempts indexes
CREATE INDEX IF NOT EXISTS idx_task_attempts_task ON task_attempts(task_id);
CREATE INDEX IF NOT EXISTS idx_task_attempts_token ON task_attempts(worker_token);
CREATE INDEX IF NOT EXISTS idx_task_attempts_outcome ON task_attempts(outcome);

-- merge_queue indexes
CREATE INDEX IF NOT EXISTS idx_merge_queue_job ON merge_queue(job_id, position);
CREATE INDEX IF NOT EXISTS idx_merge_queue_status ON merge_queue(status);

-- audit_log indexes
CREATE INDEX IF NOT EXISTS idx_audit_job ON audit_log(job_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_contributor ON audit_log(contributor_id);

-- tasks indexes (new)
CREATE INDEX IF NOT EXISTS idx_tasks_depends_on ON tasks USING GIN(depends_on);
CREATE INDEX IF NOT EXISTS idx_tasks_verification ON tasks(verification_status);

-- contributors indexes (new)
CREATE INDEX IF NOT EXISTS idx_contributors_status ON contributors(contributor_status);
CREATE INDEX IF NOT EXISTS idx_contributors_last_seen ON contributors(last_seen);
