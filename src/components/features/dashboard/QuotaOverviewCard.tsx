import { AlertTriangle, DollarSign, Waves, Zap } from "lucide-react";

import { hasQuotaStatus, type QuotasResponse } from "../../../hooks/useQuotas";
import { formatDate } from "../../../utils/format";
import { Badge } from "../../ui/Badge";
import { Card } from "../../ui/Card";

interface QuotaOverviewCardProps {
    quotas: QuotasResponse | undefined;
}

function getSeverity(
    percent: number | null | undefined
): "success" | "warning" | "error" {
    if (!percent || percent < 80) return "success";
    if (percent < 95) return "warning";
    return "error";
}

function tryParseOpenAiReset(value: string): Date | null {
    const timeOnlyMatch = value.match(/^(\d{1,2}):(\d{2})$/);
    if (timeOnlyMatch) {
        const now = new Date();
        const date = new Date(now);
        date.setHours(Number(timeOnlyMatch[1]), Number(timeOnlyMatch[2]), 0, 0);
        return date;
    }

    const withDayMonthMatch = value.match(
        /^(\d{1,2}):(\d{2})\s+on\s+(\d{1,2})\s+([A-Za-z]{3})$/i
    );
    if (withDayMonthMatch) {
        const monthMap: Record<string, number> = {
            jan: 0,
            feb: 1,
            mar: 2,
            apr: 3,
            may: 4,
            jun: 5,
            jul: 6,
            aug: 7,
            sep: 8,
            oct: 9,
            nov: 10,
            dec: 11,
        };

        const month = monthMap[withDayMonthMatch[4].toLowerCase()];
        if (month === undefined) {
            return null;
        }

        const now = new Date();
        const year = now.getFullYear();
        const date = new Date(
            year,
            month,
            Number(withDayMonthMatch[3]),
            Number(withDayMonthMatch[1]),
            Number(withDayMonthMatch[2]),
            0,
            0
        );

        return Number.isNaN(date.getTime()) ? null : date;
    }

    return null;
}

function formatResetValue(value: string | null | undefined): string {
    if (!value || value === "unknown") {
        return "unknown";
    }

    const nativeDate = new Date(value);
    if (!Number.isNaN(nativeDate.getTime())) {
        return formatDate(nativeDate);
    }

    const openAiDate = tryParseOpenAiReset(value);
    if (openAiDate) {
        return formatDate(openAiDate);
    }

    return value;
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
                !hasQuotaStatus(quotas.openrouter) &&
                quotas.openrouter.percentUsed !== null
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
                : `${Math.max(100 - (quotas.elevenlabs.percentUsed ?? 0), 0)}% left`,
            line2: hasQuotaStatus(quotas.elevenlabs)
                ? quotas.elevenlabs.note || ""
                : `Reset ${formatResetValue(quotas.elevenlabs.resetAt)}`,
            percent:
                !hasQuotaStatus(quotas.elevenlabs) &&
                quotas.elevenlabs.percentUsed !== null
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
                : `5h ${Math.max(100 - quotas.zai.fiveHour.usedPercentage, 0)}% left · weekly ${Math.max(100 - quotas.zai.weekly.usedPercentage, 0)}% left`,
            line2: hasQuotaStatus(quotas.zai)
                ? quotas.zai.note || ""
                : `Resets: 5h ${formatResetValue(quotas.zai.fiveHour.resetAt)} · weekly ${formatResetValue(quotas.zai.weekly.resetAt)}`,
            percent: hasQuotaStatus(quotas.zai)
                ? null
                : Math.max(
                      quotas.zai.fiveHour.usedPercentage,
                      quotas.zai.weekly.usedPercentage
                  ),
            resetAt: null,
        },
        {
            key: "synthetic",
            label: "Synthetic.new",
            icon: <Zap className="h-4 w-4" />,
            line1: hasQuotaStatus(quotas.synthetic)
                ? quotas.synthetic.status.replaceAll("_", " ")
                : `5h ${Math.round(Math.max(100 - (quotas.synthetic.rollingFiveHourLimit.percentUsed ?? 0), 0))}% left · weekly ${Math.round(quotas.synthetic.weeklyTokenLimit.percentRemaining)}% left`,
            line2: hasQuotaStatus(quotas.synthetic)
                ? quotas.synthetic.note || ""
                : `Resets: 5h ${formatResetValue(quotas.synthetic.rollingFiveHourLimit.nextTickAt)} · weekly ${formatResetValue(quotas.synthetic.weeklyTokenLimit.nextRegenAt)}`,
            percent: hasQuotaStatus(quotas.synthetic)
                ? null
                : Math.round(Math.max(
                      quotas.synthetic.rollingFiveHourLimit.percentUsed ?? 0,
                      100 - quotas.synthetic.weeklyTokenLimit.percentRemaining
                  )),
            resetAt: null,
        },
        {
            key: "openai",
            label: "OpenAI / Codex",
            icon: <DollarSign className="h-4 w-4" />,
            line1: hasQuotaStatus(quotas.openai)
                ? quotas.openai.status.replaceAll("_", " ")
                : `5h ${quotas.openai.fiveHourLeftPercent}% left · weekly ${quotas.openai.weeklyLeftPercent}% left`,
            line2: hasQuotaStatus(quotas.openai)
                ? quotas.openai.note || ""
                : `Resets: 5h ${formatResetValue(quotas.openai.fiveHourReset)} · weekly ${formatResetValue(quotas.openai.weeklyReset)}`,
            percent: hasQuotaStatus(quotas.openai) ? null : quotas.openai.percentUsed,
            resetAt: null,
        },
    ];

    return (
        <Card>
            <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-primary-300">
                    Usage Limits
                </h3>
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
                        {provider.line2 && (
                            <div className="text-xs text-primary-400">
                                {provider.line2}
                            </div>
                        )}
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
