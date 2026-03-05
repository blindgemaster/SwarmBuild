"use client";

export function TabGroup({
    tabs,
    active,
    onChange,
}: {
    tabs: { key: string; label: string; count?: number }[];
    active: string;
    onChange: (key: string) => void;
}) {
    return (
        <div className="tab-group">
            {tabs.map((tab) => (
                <button
                    key={tab.key}
                    onClick={() => onChange(tab.key)}
                    className={`tab ${active === tab.key ? "tab-active" : ""}`}
                >
                    {tab.label}
                    {tab.count !== undefined && (
                        <span className="ml-1.5 text-xs opacity-50">{tab.count}</span>
                    )}
                </button>
            ))}
        </div>
    );
}
