import { Card } from "./Card";

/** Provides props for metric card. */
interface MetricCardProps {
    title: string;
    value?: string | number;
    subtitle?: string;
    percent?: number;
    showValue?: boolean;
    showPercentLabel?: boolean;
    color?: "green" | "blue" | "purple" | "orange" | "red";
    icon?: React.ReactNode;
}

const colorClasses = {
    green: "bg-emerald-500/20 text-emerald-300",
    blue: "bg-accent-500/20 text-accent-300",
    purple: "bg-primary-700 text-primary-200",
    orange: "bg-amber-500/20 text-amber-300",
    red: "bg-rose-500/20 text-rose-300",
};

const barColorClasses = {
    green: "bg-emerald-500",
    blue: "bg-accent-500",
    purple: "bg-primary-500",
    orange: "bg-amber-500",
    red: "bg-rose-500",
};

/** Renders the metric card UI. */
export function MetricCard({
    title,
    value,
    subtitle,
    percent,
    showValue = true,
    showPercentLabel = true,
    color = "blue",
    icon,
}: MetricCardProps) {
    /** Returns color. */
    const getColor = (p: number): "green" | "blue" | "orange" | "red" => {
        if (p < 50) return "green";
        if (p < 75) return "blue";
        if (p < 90) return "orange";
        return "red";
    };

    const effectiveColor = percent === undefined ? color : getColor(percent);

    return (
        <Card>
            <div className="mb-3 flex items-center gap-3">
                {icon && (
                    <div className={"rounded-lg p-2 " + colorClasses[effectiveColor]}>
                        {icon}
                    </div>
                )}
                <div className="text-primary-300 text-sm">{title}</div>
            </div>
            <div className="flex items-end justify-between">
                <div>
                    {showValue ? <div className="text-2xl font-bold">{value}</div> : null}
                    {subtitle ? (
                        <div
                            className={
                                showValue
                                    ? "text-primary-400 mt-1 text-xs"
                                    : "text-primary-300 text-sm"
                            }
                        >
                            {subtitle}
                        </div>
                    ) : null}
                </div>
                {percent !== undefined && showPercentLabel && (
                    <div className="text-primary-300 text-lg font-semibold">
                        {percent}%
                    </div>
                )}
            </div>
            {percent !== undefined && (
                <div className="bg-primary-700 mt-3 h-2 overflow-hidden rounded-full">
                    <div
                        className={
                            "h-full transition-all duration-500 " +
                            barColorClasses[effectiveColor]
                        }
                        style={{ width: Math.min(percent, 100) + "%" }}
                    />
                </div>
            )}
        </Card>
    );
}
