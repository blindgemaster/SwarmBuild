"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import Image from "next/image";
import { StatusBadge } from "@/app/components/StatusBadge";

function timeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
}

interface ProfileData {
    id: string;
    username: string;
    display_name: string;
    avatar_url: string | null;
    github_username: string | null;
    created_at: string;
}

interface ProfileStats {
    jobs_posted: number;
    comments: number;
    votes_given: number;
    credits: number;
}

interface ProfileJob {
    id: string;
    title: string;
    description: string;
    output_type: string;
    tech_stack: string[];
    status: string;
    created_at: string;
}

interface ProfileComment {
    id: string;
    job_id: string;
    job_title: string;
    content: string;
    created_at: string;
}

export default function ProfilePage() {
    const params = useParams();
    const router = useRouter();
    const userId = params.id as string;

    const [profile, setProfile] = useState<ProfileData | null>(null);
    const [stats, setStats] = useState<ProfileStats | null>(null);
    const [jobs, setJobs] = useState<ProfileJob[]>([]);
    const [comments, setComments] = useState<ProfileComment[]>([]);
    const [tab, setTab] = useState<"posts" | "comments">("posts");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    useEffect(() => {
        async function load() {
            try {
                const [profileData, jobsData, commentsData] = await Promise.all([
                    api.getProfile(userId),
                    api.getProfileJobs(userId),
                    api.getProfileComments(userId),
                ]);
                setProfile(profileData.profile as unknown as ProfileData);
                setStats(profileData.stats);
                setJobs((jobsData.jobs || []) as unknown as ProfileJob[]);
                setComments((commentsData.comments || []) as unknown as ProfileComment[]);
            } catch (e: unknown) {
                setError(e instanceof Error ? e.message : "Failed to load profile");
            } finally {
                setLoading(false);
            }
        }
        load();
    }, [userId]);

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <div className="w-6 h-6 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
            </div>
        );
    }

    if (error || !profile) {
        return (
            <div className="text-center py-16">
                <p className="text-[var(--red)] mb-4">{error || "Profile not found"}</p>
                <Link href="/" className="btn btn-outline">← Back</Link>
            </div>
        );
    }

    return (
        <div className="max-w-3xl mx-auto animate-fade-in">
            {/* Back */}
            <Link href="/" className="text-sm text-[var(--text-muted)] hover:text-[var(--accent)] mb-5 inline-flex items-center gap-1 transition-colors">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
                Back to jobs
            </Link>

            {/* Profile Card */}
            <div className="card mb-6">
                <div className="flex items-center gap-5">
                    {/* Avatar */}
                    <div className="w-20 h-20 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-3xl font-bold text-white shadow-lg shadow-indigo-500/20 shrink-0">
                        {profile.avatar_url ? (
                            <Image src={profile.avatar_url} alt={profile.display_name} width={80} height={80} className="rounded-full object-cover" />
                        ) : (
                            profile.display_name?.[0]?.toUpperCase() || profile.username?.[0]?.toUpperCase() || "?"
                        )}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                        <h1 className="text-xl font-bold tracking-tight">
                            {profile.display_name || profile.username || "Anonymous"}
                        </h1>
                        {profile.username && (
                            <p className="text-sm text-[var(--text-muted)]">@{profile.username}</p>
                        )}
                        <div className="flex items-center gap-3 mt-2 text-xs text-[var(--text-muted)]">
                            <span>Joined {timeAgo(profile.created_at)}</span>
                            {profile.github_username && (
                                <a
                                    href={`https://github.com/${profile.github_username}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center gap-1 hover:text-[var(--accent)] transition-colors"
                                >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
                                    </svg>
                                    {profile.github_username}
                                </a>
                            )}
                        </div>
                    </div>
                </div>

                {/* Stats Row */}
                {stats && (
                    <div className="grid grid-cols-4 gap-3 mt-5 pt-5 border-t border-[var(--border)]">
                        <div className="text-center">
                            <div className="text-lg font-bold">{stats.jobs_posted}</div>
                            <div className="text-xs text-[var(--text-muted)]">Jobs Posted</div>
                        </div>
                        <div className="text-center">
                            <div className="text-lg font-bold">{stats.comments}</div>
                            <div className="text-xs text-[var(--text-muted)]">Comments</div>
                        </div>
                        <div className="text-center">
                            <div className="text-lg font-bold">{stats.votes_given}</div>
                            <div className="text-xs text-[var(--text-muted)]">Votes</div>
                        </div>
                        <div className="text-center">
                            <div className="text-lg font-bold text-[var(--accent)]">{stats.credits}</div>
                            <div className="text-xs text-[var(--text-muted)]">Credits</div>
                        </div>
                    </div>
                )}
            </div>

            {/* Tabs */}
            <div className="tab-group mb-4">
                <button
                    onClick={() => setTab("posts")}
                    className={`tab ${tab === "posts" ? "tab-active" : ""}`}
                >
                    Jobs Posted <span className="ml-1.5 text-xs opacity-50">{jobs.length}</span>
                </button>
                <button
                    onClick={() => setTab("comments")}
                    className={`tab ${tab === "comments" ? "tab-active" : ""}`}
                >
                    Comments <span className="ml-1.5 text-xs opacity-50">{comments.length}</span>
                </button>
            </div>

            {/* Tab Content */}
            <div className="flex flex-col gap-3">
                {tab === "posts" && (
                    jobs.length === 0 ? (
                        <div className="text-center py-12 text-[var(--text-muted)]">
                            <p>No jobs posted yet.</p>
                        </div>
                    ) : (
                        jobs.map((job) => (
                            <div
                                key={job.id}
                                className="card cursor-pointer hover:border-[var(--border-hover)] transition-colors"
                                onClick={() => router.push(`/job/${job.id}`)}
                            >
                                <div className="flex items-center justify-between gap-3">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-1">
                                            <h3 className="font-semibold text-sm truncate">{job.title}</h3>
                                            <StatusBadge status={job.status} />
                                        </div>
                                        <p className="text-xs text-[var(--text-muted)] line-clamp-1">{job.description}</p>
                                    </div>
                                    <div className="text-xs text-[var(--text-muted)] shrink-0">
                                        {timeAgo(job.created_at)}
                                    </div>
                                </div>
                                {job.tech_stack?.length > 0 && (
                                    <div className="flex gap-1 mt-2 flex-wrap">
                                        {job.tech_stack.map((t: string) => <span key={t} className="tag text-[10px]">{t}</span>)}
                                    </div>
                                )}
                            </div>
                        ))
                    )
                )}

                {tab === "comments" && (
                    comments.length === 0 ? (
                        <div className="text-center py-12 text-[var(--text-muted)]">
                            <p>No comments yet.</p>
                        </div>
                    ) : (
                        comments.map((comment) => (
                            <div
                                key={comment.id}
                                className="card cursor-pointer hover:border-[var(--border-hover)] transition-colors"
                                onClick={() => router.push(`/job/${comment.job_id}`)}
                            >
                                <div className="flex items-center gap-2 mb-1.5">
                                    <span className="text-xs text-[var(--accent)] font-medium truncate">
                                        {comment.job_title}
                                    </span>
                                    <span className="text-xs text-[var(--text-muted)]">
                                        {timeAgo(comment.created_at)}
                                    </span>
                                </div>
                                <p className="text-sm text-[var(--text-secondary)] line-clamp-2">
                                    {comment.content}
                                </p>
                            </div>
                        ))
                    )
                )}
            </div>
        </div>
    );
}
