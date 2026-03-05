import { AlertTriangle, DollarSign, Waves, Zap } from "lucide-react";

import { hasQuotaStatus, type QuotasResponse } from "../../../hooks/useQuotas";
import { formatDate } from "../../../utils/format";
import { Badge } from "../../ui/Badge";
import { Card } from "../../ui/Card";

interface QuotaOverviewCardProps {
    quotas: QuotasResponse | undefined;
}

function getSeverity(percent: number | null | undefined): "success" | "warning" | "error" {
    if (!percent || percent < 80) return "success";
    if (percent < 95) return "warning";
    return "error";
}

export function QuotaOverviewCard({ quotas }: QuotaOverviewCardProps) {
    if (!quotas) {
        return (
            <Card>
                <div className="text-sm text-primary-300">Loading usage limits…</div>
            </Card>
        );
    }

    const providers = [
        {
            key: "openrouter",
            label: "OpenRouter",
            icon: <Waves className="h-4 w-4" />,
            line1: hasQuotaStatus(quotas.openrouter)
                ? quotas.openrouter.status.replaceAll("_", " ")
                : `$${quotas.openrouter.usage.toFixed(2)} used / $${quotas.openrouter.totalCredits.toFixed(2)}`,
            line2: hasQuotaStatus(quotas.openrouter)
                ? quotas.openrouter.note || ""
                : `$${quotas.openrouter.remaining.toFixed(2)} remaining`,
            percent:
                !hasQuotaStatus(quotas.openrouter) && quotas.openrouter.percentUsed !== null
                    ? quotas.openrouter.percentUsed
                    : null,
            resetAt: null,
        },
        {
            key: "elevenlabs",
            label: "ElevenLabs",
            icon: <Zap className="h-4 w-4" />,
            line1: hasQuotaStatus(quotas.elevenlabs)
                ? quotas.elevenlabs.status.replaceAll("_", " ")
                : `${quotas.elevenlabs.used.toLocaleString()} / ${quotas.elevenlabs.total.toLocaleString()} chars`,
            line2: hasQuotaStatus(quotas.elevenlabs)
                ? quotas.elevenlabs.note || ""
                : `${quotas.elevenlabs.remaining.toLocaleString()} remaining (${quotas.elevenlabs.tier})`,
            percent:
                !hasQuotaStatus(quotas.elevenlabs) && quotas.elevenlabs.percentUsed !== null
                    ? quotas.elevenlabs.percentUsed
                    : null,
            resetAt: null,
        },
        {
            key: "zai",
            label: "Z.ai",
            icon: <AlertTriangle className="h-4 w-4" />,
            line1: hasQuotaStatus(quotas.zai)
                ? quotas.zai.status.replaceAll("_", " ")
                : `5h ${quotas.zai.fiveHour.usedPercentage}% · weekly ${quotas.zai.weekly.usedPercentage}%`,
            line2: hasQuotaStatus(quotas.zai)
                ? quotas.zai.note || ""
                : `Level ${quotas.zai.level}`,
            percent:
                !hasQuotaStatus(quotas.zai)
                    ? Math.max(quotas.zai.fiveHour.usedPercentage, quotas.zai.weekly.usedPercentage)
                    : null,
            resetAt: !hasQuotaStatus(quotas.zai) ? quotas.zai.fiveHour.resetAt : null,
        },
        {
            key: "openai",
            label: "OpenAI",
            icon: <DollarSign className="h-4 w-4" />,
            line1: hasQuotaStatus(quotas.openai)
                ? quotas.openai.status.replaceAll("_", " ")
                : quotas.openai.hardLimitUsd
                  ? `$${quotas.openai.monthUsd.toFixed(2)} / $${quotas.openai.hardLimitUsd.toFixed(2)}`
                  : `$${quotas.openai.monthUsd.toFixed(2)} this month`,
            line2: hasQuotaStatus(quotas.openai)
                ? quotas.openai.note || ""
                : quotas.openai.remainingUsd !== null
                  ? `$${quotas.openai.remainingUsd.toFixed(2)} remaining`
                  : "No hard limit in API",
            percent:
                !hasQuotaStatus(quotas.openai) && quotas.openai.percentUsed !== null
                    ? quotas.openai.percentUsed
                    : null,
            resetAt: !hasQuotaStatus(quotas.openai) ? quotas.openai.resetAt : null,
        },
    ];

    return (
        <Card>
            <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-primary-300">
                    Usage Limits
                </h3>
                <span className="text-xs text-primary-500">
                    Updated {formatDate(new Date(quotas.checkedAt))}
                </span>
            </div>

            <div className="space-y-2">
                {providers.map((provider) => (
                    <div
                        key={provider.key}
                        className="rounded-lg border border-primary-700 bg-primary-800/40 px-3 py-2"
                    >
                        <div className="mb-1 flex items-center justify-between gap-2">
                            <div className="inline-flex items-center gap-2 text-sm text-primary-100">
                                {provider.icon}
                                <span>{provider.label}</span>
                            </div>
                            {provider.percent !== null && (
                                <Badge variant={getSeverity(provider.percent)}>
                                    {provider.percent}%
                                </Badge>
                            )}
                        </div>
                        <div className="text-xs text-primary-300">{provider.line1}</div>
                        {provider.line2 && <div className="text-xs text-primary-400">{provider.line2}</div>}
                        {provider.resetAt && provider.resetAt !== "unknown" && (
                            <div className="text-xs text-primary-500">
                                Reset {formatDate(new Date(provider.resetAt))}
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </Card>
    );
}
