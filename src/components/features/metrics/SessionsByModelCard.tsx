import { Users } from "lucide-react";

import { Card } from "../../ui/Card";

interface SessionsByModelCardProps {
    sessionsByModel: Record<string, number>;
}

export function SessionsByModelCard({ sessionsByModel }: SessionsByModelCardProps) {
    const sorted = Object.entries(sessionsByModel).sort((a, b) => b[1] - a[1]);

    return (
        <Card className="p-6">
            <div className="mb-4 flex items-center gap-3">
                <Users className="h-6 w-6 text-cyan-400" />
                <h2 className="text-lg font-semibold text-slate-100">
                    Sessions by Model
                </h2>
            </div>

            <div className="grid grid-cols-3 gap-3 md:grid-cols-4 lg:grid-cols-6">
                {sorted.map(([model, count]) => (
                    <div
                        key={model}
                        className="rounded-lg bg-slate-800/50 p-3 text-center"
                    >
                        <p className="text-2xl font-bold text-slate-100">{count}</p>
                        <p className="mt-1 truncate text-xs text-slate-400" title={model}>
                            {model}
                        </p>
                    </div>
                ))}
            </div>
        </Card>
    );
}