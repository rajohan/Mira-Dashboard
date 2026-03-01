import { Card } from "./Card";

interface MetricCardProps {
    title: string;
    value: string | number;
    subtitle?: string;
    percent?: number;
    color?: "green" | "blue" | "purple" | "orange" | "red";
    icon?: React.ReactNode;
}

const colorClasses = {
    green: "bg-green-500/20 text-green-400",
    blue: "bg-blue-500/20 text-blue-400",
    purple: "bg-purple-500/20 text-purple-400",
    orange: "bg-orange-500/20 text-orange-400",
    red: "bg-red-500/20 text-red-400",
};

const barColorClasses = {
    green: "bg-green-500",
    blue: "bg-blue-500",
    purple: "bg-purple-500",
    orange: "bg-orange-500",
    red: "bg-red-500",
};

export function MetricCard({ title, value, subtitle, percent, color = "blue", icon }: MetricCardProps) {
    const getColor = (p: number): "green" | "blue" | "orange" | "red" => {
        if (p < 50) return "green";
        if (p < 75) return "blue";
        if (p < 90) return "orange";
        return "red";
    };

    const effectiveColor = percent !== undefined ? getColor(percent) : color;

    return (
        <Card>
            <div className="flex items-center gap-3 mb-3">
                {icon && (
                    <div className={"p-2 rounded-lg " + colorClasses[effectiveColor]}>
                        {icon}
                    </div>
                )}
                <div className="text-sm text-slate-400">{title}</div>
            </div>
            <div className="flex items-end justify-between">
                <div>
                    <div className="text-2xl font-bold">{value}</div>
                    {subtitle && <div className="text-xs text-slate-500 mt-1">{subtitle}</div>}
                </div>
                {percent !== undefined && (
                    <div className="text-lg font-semibold text-slate-400">{percent}%</div>
                )}
            </div>
            {percent !== undefined && (
                <div className="mt-3 h-2 bg-slate-700 rounded-full overflow-hidden">
                    <div
                        className={"h-full transition-all duration-500 " + barColorClasses[effectiveColor]}
                        style={{ width: Math.min(percent, 100) + "%" }}
                    />
                </div>
            )}
        </Card>
    );
}
