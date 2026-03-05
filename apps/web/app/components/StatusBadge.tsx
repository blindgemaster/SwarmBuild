export function StatusBadge({ status }: { status: string }) {
    return (
        <span className={`badge badge-${status}`}>
            {status === "running" && <span className="live-dot mr-1" />}
            {status.replace("_", " ")}
        </span>
    );
}
