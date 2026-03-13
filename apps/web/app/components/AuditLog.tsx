"use client";

import { useEffect, useState } from "react";

interface AuditEntry {
    id: string;
    timestamp: string;
    role: string | null;
    action: string;
    resource_type: string | null;
    resource_id: string | null;
    response_status: number;
    duration_ms: number;
}

const STATUS_COLOR: Record<string, string> = {
    "2": "text-[var(--green)]",
    "4": "text-[var(--orange)]",
    "5": "text-[var(--red)]",
};

function statusColor(code: number): string {
    return STATUS_COLOR[String(code)[0]] || "text-[var(--text-muted)]";
}

export function AuditLog({ jobId, apiUrl }: { jobId: string; apiUrl: string }) {
    const [entries, setEntries] = useState<AuditEntry[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchAudit = async () => {
            try {
                const res = await fetch(`${apiUrl}/api/jobs/${jobId}/audit`);
                if (res.ok) {
                    const data = await res.json();
                    setEntries(data.entries || []);
                }
            } catch { /* ignore */ }
            setLoading(false);
        };
        fetchAudit();
        const interval = setInterval(fetchAudit, 15000);
        return () => clearInterval(interval);
    }, [jobId, apiUrl]);

    if (loading) return <div className="text-[var(--text-muted)] text-sm p-4">Loading audit log...</div>;

    if (entries.length === 0) {
        return (
            <div className="text-center py-8 text-[var(--text-muted)] text-sm">
                No audit entries yet.
            </div>
        );
    }

    return (
        <div className="animate-fade-in">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-3">
                Audit Log ({entries.length})
            </h3>
            <div className="overflow-x-auto">
                <table className="w-full text-xs">
                    <thead>
                        <tr className="text-[var(--text-muted)] uppercase">
                            <th className="text-left pb-2 pr-3">Time</th>
                            <th className="text-left pb-2 pr-3">Agent</th>
                            <th className="text-left pb-2 pr-3">Action</th>
                            <th className="text-left pb-2 pr-3">Resource</th>
                            <th className="text-right pb-2 pr-3">Status</th>
                            <th className="text-right pb-2">Duration</th>
                        </tr>
                    </thead>
                    <tbody>
                        {entries.map((entry) => (
                            <tr key={entry.id} className="border-t border-[var(--border)]">
                                <td className="py-1.5 pr-3 text-[var(--text-muted)] whitespace-nowrap">
                                    {new Date(entry.timestamp).toLocaleTimeString()}
                                </td>
                                <td className="py-1.5 pr-3 capitalize text-[var(--text)]">
                                    {entry.role || "—"}
                                </td>
                                <td className="py-1.5 pr-3 font-medium text-[var(--text)]">
                                    {entry.action}
                                </td>
                                <td className="py-1.5 pr-3 text-[var(--text-muted)] font-mono">
                                    {entry.resource_id ? entry.resource_id.slice(0, 8) : "—"}
                                </td>
                                <td className={`py-1.5 pr-3 text-right font-bold ${statusColor(entry.response_status)}`}>
                                    {entry.response_status}
                                </td>
                                <td className="py-1.5 text-right text-[var(--text-muted)]">
                                    {entry.duration_ms}ms
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
