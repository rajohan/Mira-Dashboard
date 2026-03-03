import { RefreshCw } from "lucide-react";

import {
    SessionsByModelCard,
    SystemStatsGrid,
    TokenUsageCard,
} from "../components/features/metrics";
import { Button } from "../components/ui/Button";
import { LoadingState } from "../components/ui/LoadingState";
import { PageHeader } from "../components/ui/PageHeader";
import { useMetrics } from "../hooks";

export function Metrics() {
    const { data: metrics, isLoading, error, refetch } = useMetrics();

    if (isLoading) {
        return <LoadingState size="lg" />;
    }

    if (error) {
        return (
            <div className="flex h-64 flex-col items-center justify-center gap-4 p-6">
                <p className="text-red-400">{error.message}</p>
                <Button variant="secondary" onClick={() => refetch()}>
                    <RefreshCw className="h-4 w-4" />
                    Retry
                </Button>
            </div>
        );
    }

    if (!metrics) return null;

    const totalTokens = metrics.tokens?.total || 0;
    const byModel = metrics.tokens?.byModel || {};
    const sessionsByModel = metrics.tokens?.sessionsByModel || {};
    const byAgent = metrics.tokens?.byAgent || [];

    return (
        <div className="space-y-6 p-6">
            <PageHeader
                title="Metrics"
                actions={
                    <Button variant="secondary" size="sm" onClick={() => refetch()}>
                        <RefreshCw className="h-4 w-4" />
                    </Button>
                }
            />

            <SystemStatsGrid metrics={metrics} />

            {totalTokens > 0 && (
                <TokenUsageCard
                    totalTokens={totalTokens}
                    byModel={byModel}
                    byAgent={byAgent}
                />
            )}

            {Object.keys(sessionsByModel).length > 0 && (
                <SessionsByModelCard sessionsByModel={sessionsByModel} />
            )}
        </div>
    );
}