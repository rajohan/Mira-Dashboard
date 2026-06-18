import { DollarSign, Waves, Zap } from "lucide-react";

import {
    hasQuotaStatus,
    type QuotasResponse,
    type SyntheticQuota,
} from "../../../hooks/useQuotas";
import { formatDate, formatOsloTime } from "../../../utils/format";
import { Badge } from "../../ui/Badge";
import { Card } from "../../ui/Card";

/** Provides quota cache data rendered by the quota overview card. */
interface QuotaOverviewCardProperties {
    quotas: QuotasResponse | undefined;
}

/** Maps quota usage percentage to a visual severity level. */
function getSeverity(
    percent: number | undefined | undefined
): "success" | "warning" | "error" {
    if (!percent || percent < 80) return "success";
    if (percent < 95) return "warning";
    return "error";
}

/** Parses OpenAI reset timestamps and returns undefined when the value is unavailable or invalid. */
function tryParseOpenAiReset(value: string): Date | undefined {
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
            return undefined;
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

        if (Number.isNaN(date.getTime())) {
            return undefined;
        }

        return date;
    }

    return undefined;
}

/** Formats quota reset metadata for display in the dashboard. */
function formatResetValue(value: string | undefined | undefined): string {
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

/** Formats short rolling-window reset times without repeating today's date. */
function formatResetTime(value: string | undefined | undefined): string {
    if (!value || value === "unknown") {
        return "unknown";
    }

    const nativeDate = new Date(value);
    if (!Number.isNaN(nativeDate.getTime())) {
        return formatOsloTime(nativeDate).slice(0, 5);
    }

    const openAiDate = tryParseOpenAiReset(value);
    if (openAiDate) {
        return formatOsloTime(openAiDate).slice(0, 5);
    }

    return value;
}

/** Formats a percent value without noisy trailing decimals. */
function formatPercent(value: number): string {
    return Number.isSafeInteger(value) ? String(value) : value.toFixed(1);
}

/** Converts Synthetic.new fractional tick values into display percentages. */
function normalizeSyntheticTickPercent(value: number): number {
    return value > 0 && value <= 1 ? value * 100 : value;
}

/** Formats the Synthetic.new weekly regeneration amount when data is available. */
function formatSyntheticWeeklyRegenAmount(
    weeklyTokenLimit: SyntheticQuota["weeklyTokenLimit"]
): string | undefined {
    if (
        weeklyTokenLimit.nextRegenPercent !== undefined &&
        weeklyTokenLimit.nextRegenPercent !== undefined
    ) {
        return `+${formatPercent(weeklyTokenLimit.nextRegenPercent)}%`;
    }

    if (weeklyTokenLimit.nextRegenCredits) {
        return `+${weeklyTokenLimit.nextRegenCredits}`;
    }

    return undefined;
}

/** Formats the Synthetic.new 5h regeneration amount when data is available. */
function formatSyntheticFiveHourRegenAmount(
    rollingFiveHourLimit: SyntheticQuota["rollingFiveHourLimit"]
): string | undefined {
    if (
        rollingFiveHourLimit.tickPercent !== undefined &&
        rollingFiveHourLimit.tickPercent !== undefined
    ) {
        return `+${formatPercent(normalizeSyntheticTickPercent(rollingFiveHourLimit.tickPercent))}%`;
    }

    return undefined;
}

/** Formats one Synthetic.new regeneration window segment. */
function formatSyntheticRegenSegment(
    label: string,
    resetAt: string | undefined | undefined,
    amount: string | undefined,
    formatReset: (value: string | undefined | undefined) => string = formatResetValue
): string {
    const amountSuffix = amount ? ` (${amount})` : "";

    return `${label} ${formatReset(resetAt)}${amountSuffix}`;
}

/** Formats the Synthetic.new weekly remaining quota. */
function formatSyntheticWeeklyRemaining(
    weeklyTokenLimit: SyntheticQuota["weeklyTokenLimit"]
): string {
    return `${Math.round(weeklyTokenLimit.percentRemaining)}% left`;
}

/** Renders the quota overview card UI. */
export function QuotaOverviewCard({ quotas }: QuotaOverviewCardProperties) {
    if (!quotas) {
        return (
            <Card>
                <div className="text-primary-300 text-sm">Loading usage limits…</div>
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
                quotas.openrouter.percentUsed !== undefined
                    ? quotas.openrouter.percentUsed
                    : undefined,
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
                quotas.elevenlabs.percentUsed !== undefined
                    ? quotas.elevenlabs.percentUsed
                    : undefined,
        },
        {
            key: "synthetic",
            label: "Synthetic.new",
            icon: <Zap className="h-4 w-4" />,
            line1: hasQuotaStatus(quotas.synthetic)
                ? quotas.synthetic.status.replaceAll("_", " ")
                : `5h ${Math.round(Math.max(100 - (quotas.synthetic.rollingFiveHourLimit.percentUsed ?? 0), 0))}% left · weekly ${formatSyntheticWeeklyRemaining(quotas.synthetic.weeklyTokenLimit)}`,
            line2: hasQuotaStatus(quotas.synthetic)
                ? quotas.synthetic.note || ""
                : `Regen: ${formatSyntheticRegenSegment("5h", quotas.synthetic.rollingFiveHourLimit.nextTickAt, formatSyntheticFiveHourRegenAmount(quotas.synthetic.rollingFiveHourLimit), formatResetTime)} · ${formatSyntheticRegenSegment("weekly", quotas.synthetic.weeklyTokenLimit.nextRegenAt, formatSyntheticWeeklyRegenAmount(quotas.synthetic.weeklyTokenLimit))}`,
            percent: hasQuotaStatus(quotas.synthetic)
                ? undefined
                : Math.round(
                      Math.max(
                          quotas.synthetic.rollingFiveHourLimit.percentUsed ?? 0,
                          100 - quotas.synthetic.weeklyTokenLimit.percentRemaining
                      )
                  ),
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
                : `Resets: 5h ${formatResetTime(quotas.openai.fiveHourReset)} · weekly ${formatResetValue(quotas.openai.weeklyReset)}`,
            percent: hasQuotaStatus(quotas.openai)
                ? undefined
                : quotas.openai.percentUsed,
        },
    ];

    return (
        <Card>
            <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-primary-300 text-sm font-semibold tracking-wide uppercase">
                    Usage Limits
                </h3>
            </div>

            <div className="space-y-2">
                {providers.map((provider) => (
                    <div
                        key={provider.key}
                        className="border-primary-700 bg-primary-800/40 rounded-lg border px-3 py-2"
                    >
                        <div className="mb-1 flex items-start justify-between gap-2">
                            <div className="text-primary-100 inline-flex min-w-0 items-center gap-2 text-sm">
                                {provider.icon}
                                <span className="truncate">{provider.label}</span>
                            </div>
                            {provider.percent !== undefined && (
                                <Badge variant={getSeverity(provider.percent)}>
                                    {provider.percent}%
                                </Badge>
                            )}
                        </div>
                        <div className="text-primary-300 text-xs break-words">
                            {provider.line1}
                        </div>
                        {provider.line2 && (
                            <div className="text-primary-400 text-xs break-words">
                                {provider.line2}
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </Card>
    );
}
