import { Card } from "../../ui/Card";

interface Properties {
    reasons: string[];
    source: string;
}

/** Renders source-specific database maintenance reasons near the overview metrics. */
export function DatabaseAttentionCard({ reasons, source }: Properties) {
    if (reasons.length === 0) {
        return;
    }

    return (
        <Card variant="bordered" className="border-amber-500/40">
            <h3 className="font-semibold text-amber-200">{source} needs attention</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-primary-200">
                {reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                ))}
            </ul>
        </Card>
    );
}
