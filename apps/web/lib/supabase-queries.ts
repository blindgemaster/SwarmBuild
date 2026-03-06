/**
 * Direct Supabase queries for comments and votes.
 *
 * These bypass the slow Render API and talk directly to Supabase
 * from the browser, using the already-authenticated session.
 */

import { supabase } from "@/lib/supabase";
import type { Comment } from "@/lib/api";

// ── Profile helpers ───────────────────────────────────

/**
 * Ensure the current user has a profile row.
 * Uses upsert so it's safe to call repeatedly — no-ops if profile exists.
 */
async function ensureProfile(): Promise<void> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data: existing } = await supabase
        .from("profiles")
        .select("id, display_name")
        .eq("id", user.id)
        .maybeSingle();

    if (existing && existing.display_name && existing.display_name !== "New User") return;

    const meta = user.user_metadata || {};
    const display_name = meta.full_name || meta.name || "New User";
    const avatar_url = meta.avatar_url || null;
    const github_username = meta.user_name || meta.preferred_username || null;
    const email = user.email || "";
    const username = email ? email.split("@")[0] : `user-${user.id.slice(0, 8)}`;

    if (existing) {
        // Update placeholder profile with real data
        await supabase
            .from("profiles")
            .update({ display_name, avatar_url, github_username })
            .eq("id", user.id);
    } else {
        await supabase
            .from("profiles")
            .insert({ id: user.id, username, display_name, avatar_url, github_username });
    }
}

// ── Comments ──────────────────────────────────────────

export async function getCommentsDirectly(jobId: string): Promise<{ comments: Comment[]; total: number }> {
    const { data: comments, error } = await supabase
        .from("comments")
        .select("*")
        .eq("job_id", jobId)
        .order("created_at", { ascending: true });

    if (error || !comments) return { comments: [], total: 0 };

    // Fetch profiles for all comment authors in one batch
    const userIds = [...new Set(comments.map(c => c.user_id))];
    const { data: profiles } = await supabase
        .from("profiles")
        .select("id, username, display_name, avatar_url")
        .in("id", userIds);

    const profileMap = new Map(
        (profiles || []).map(p => [p.id, { username: p.username, display_name: p.display_name, avatar_url: p.avatar_url }])
    );

    // Build threaded structure
    const enriched = comments.map(c => ({
        ...c,
        profile: profileMap.get(c.user_id) || null,
        replies: [] as Comment[],
    }));

    const byId = new Map(enriched.map(c => [c.id, c]));
    const topLevel: Comment[] = [];

    for (const c of enriched) {
        if (c.parent_id && byId.has(c.parent_id)) {
            byId.get(c.parent_id)!.replies!.push(c);
        } else {
            topLevel.push(c);
        }
    }

    return { comments: topLevel, total: comments.length };
}

export async function addCommentDirectly(
    jobId: string,
    content: string,
    parentId?: string | null,
): Promise<Record<string, unknown>> {
    await ensureProfile();

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error("Not authenticated");

    const { data, error } = await supabase
        .from("comments")
        .insert({
            job_id: jobId,
            user_id: user.id,
            content,
            parent_id: parentId || null,
        })
        .select()
        .single();

    if (error) throw new Error(error.message);
    return data as Record<string, unknown>;
}

// ── Votes ─────────────────────────────────────────────

export async function getVoteStatusDirectly(jobId: string): Promise<{ voted: boolean; vote_count: number }> {
    // Count total votes
    const { count } = await supabase
        .from("votes")
        .select("user_id", { count: "exact", head: true })
        .eq("job_id", jobId);

    // Check if current user voted
    let voted = false;
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
        const { data } = await supabase
            .from("votes")
            .select("user_id")
            .eq("job_id", jobId)
            .eq("user_id", user.id)
            .maybeSingle();
        voted = !!data;
    }

    return { voted, vote_count: count || 0 };
}

export async function toggleVoteDirectly(jobId: string): Promise<{ message: string; vote_count: number; voted: boolean }> {
    await ensureProfile();

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error("Not authenticated");

    // Check existing vote
    const { data: existing } = await supabase
        .from("votes")
        .select("user_id")
        .eq("job_id", jobId)
        .eq("user_id", user.id)
        .maybeSingle();

    let action: string;
    if (existing) {
        await supabase.from("votes").delete().eq("job_id", jobId).eq("user_id", user.id);
        action = "removed";
    } else {
        await supabase.from("votes").insert({ job_id: jobId, user_id: user.id });
        action = "added";
    }

    // Get updated count
    const { count } = await supabase
        .from("votes")
        .select("user_id", { count: "exact", head: true })
        .eq("job_id", jobId);

    return { message: action, vote_count: count || 0, voted: action === "added" };
}
