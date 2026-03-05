-- Swarmbuild Database Schema
-- Run this in your Supabase SQL editor to initialize tables.

-- ─────────────────────────────────────────
-- Jobs — submitted ideas/projects
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now(),

    -- Submission
    title           TEXT NOT NULL,
    description     TEXT NOT NULL,
    output_type     TEXT NOT NULL CHECK (output_type IN ('rest-api', 'cli', 'library', 'script', 'fullstack')),
    tech_stack      JSONB DEFAULT '[]'::jsonb,
    constraints     TEXT,
    examples        TEXT,

    -- Status lifecycle
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'plan_ready', 'approved', 'running', 'complete', 'failed', 'cancelled')),

    -- Pre-run Lobby State (for Agent Teams)
    lobby_state     TEXT DEFAULT 'gathering'
                    CHECK (lobby_state IN ('gathering', 'planning', 'ready_wait', 'executing')),


    -- Generated plan (created by harness-gen)
    agent_prompt    TEXT,
    test_harness    JSONB,
    task_list       JSONB,

    -- GitHub output
    github_repo     TEXT,
    clone_url       TEXT,

    -- Completion
    completed_at    TIMESTAMPTZ,
    error_message   TEXT,

    -- Original poster
    poster_id       UUID NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_poster ON jobs(poster_id);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);

-- ─────────────────────────────────────────
-- Contributors — users joining a job
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contributors (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id          UUID REFERENCES jobs(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL,
    joined_at       TIMESTAMPTZ DEFAULT now(),
    last_seen       TIMESTAMPTZ DEFAULT now(),
    left_at         TIMESTAMPTZ,

    -- Worker auth
    worker_token    TEXT UNIQUE NOT NULL,
    token_expires   TIMESTAMPTZ NOT NULL,

    -- Lobby State
    role            TEXT,
    is_ready        BOOLEAN DEFAULT false,

    -- What the contributor ran
    num_agents      INT DEFAULT 1,
    token_cap       INT DEFAULT 500000,

    -- Reported by worker
    tokens_used     INT DEFAULT 0,
    sessions_run    INT DEFAULT 0,
    commits_pushed  INT DEFAULT 0,

    -- Credit awarded
    credits_earned  INT DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_contributors_job ON contributors(job_id);
CREATE INDEX IF NOT EXISTS idx_contributors_user ON contributors(user_id);
CREATE INDEX IF NOT EXISTS idx_contributors_token ON contributors(worker_token);

-- ─────────────────────────────────────────
-- Credit events — append-only ledger
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT now(),

    event_type  TEXT NOT NULL CHECK (event_type IN (
        'contributed',
        'spent',
        'signup_bonus'
    )),
    amount      INT NOT NULL,
    job_id      UUID REFERENCES jobs(id),
    note        TEXT
);

CREATE INDEX IF NOT EXISTS idx_credits_user ON credit_events(user_id);

-- ─────────────────────────────────────────
-- Comments — threaded discussion per job
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id      UUID REFERENCES jobs(id) ON DELETE CASCADE,
    user_id     UUID REFERENCES profiles(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ DEFAULT now(),
    content     TEXT NOT NULL,
    parent_id   UUID REFERENCES comments(id)
);

CREATE INDEX IF NOT EXISTS idx_comments_job ON comments(job_id);

-- ─────────────────────────────────────────
-- Votes — upvotes on jobs
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS votes (
    job_id      UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL,
    PRIMARY KEY (job_id, user_id)
);

-- ─────────────────────────────────────────
-- Tasks — agent tasks (moved from git to DB)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id          UUID REFERENCES jobs(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now(),

    title           TEXT NOT NULL,
    description     TEXT,
    status          TEXT NOT NULL DEFAULT 'available'
                    CHECK (status IN ('available', 'locked', 'completed', 'failed')),
    
    assigned_role   TEXT,
    locked_by_token TEXT REFERENCES contributors(worker_token) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_job ON tasks(job_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

-- ─────────────────────────────────────────
-- Messages — real-time discussion (human + agent)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id          UUID REFERENCES jobs(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ DEFAULT now(),

    author_name     TEXT NOT NULL,
    author_type     TEXT NOT NULL CHECK (author_type IN ('human', 'agent')),
    content         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_job ON messages(job_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at ASC);

-- ─────────────────────────────────────────
-- Job Logs — persisted agent stdout/stderr lines
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_logs (
    id          BIGSERIAL PRIMARY KEY,
    job_id      UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ DEFAULT now(),
    content     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_job_logs_job ON job_logs(job_id, id);

-- ─────────────────────────────────────────
-- User profiles — synced from Supabase Auth
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
    id              UUID PRIMARY KEY,
    username        TEXT UNIQUE,
    display_name    TEXT,
    avatar_url      TEXT,
    github_username TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);
