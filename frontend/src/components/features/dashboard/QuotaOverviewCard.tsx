import { DollarSign, Gauge, Waves, Zap } from "lucide-react";

import type { QuotasResponse, SyntheticQuota } from "../../../../../contracts/quotas";
import { hasQuotaStatus } from "../../../hooks/useQuotas";
import { formatDate, formatOsloTime } from "../../../utils/format";
import { Badge } from "../../ui/Badge";
import { Card } from "../../ui/Card";

/** Provides quota cache data rendered by the quota overview card. */
interface QuotaOverviewCardProperties {
    quotas: QuotasResponse | undefined;
}

/**
 * Maps quota usage percentage to a visual severity level.
 * @param percent Percent value.
 * @returns Mapped quota usage percentage to a visual severity level.
 */
function getSeverity(percent: number | undefined): "success" | "warning" | "error" {
    if (!percent || percent < 80) return "success";
    if (percent < 95) return "warning";
    return "error";
}

/**
 * Parses OpenAI reset timestamps and returns undefined when the value is unavailable or invalid.
 * @param value Value to process.
 * @returns Parsed OpenAI reset timestamps and returns undefined when the value is unavailable or invalid.
 */
function tryParseOpenAiReset(value: string): Date | undefined {
    const timeOnlyMatch = value.match(/^(\d{1,2}):(\d{2})$/);
    if (timeOnlyMatch) {
        const now = new Date();
        const date = new Date(now);
        date.setHours(Number(timeOnlyMatch[1]), Number(timeOnlyMatch[2]), 0, 0);
        return date;
    }

    const withDayMonthMatch = value.match(
        /^(\d{1,2}):(\d{2})\s+on\s+(\d{1,2})\s+([A-Z]{3})$/i
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

        const monthName = withDayMonthMatch[4];
        if (!monthName) {
            return undefined;
        }

        const month = monthMap[monthName.toLowerCase()];
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

/**
 * Formats quota reset metadata for display in the dashboard.
 * @param value Value to process.
 * @returns Formatted quota reset metadata for display in the dashboard.
 */
function formatResetValue(value: string | undefined): string {
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

/**
 * Formats short rolling-window reset times without repeating today's date.
 * @param value Value to process.
 * @returns Formatted short rolling-window reset times without repeating today's date.
 */
function formatResetTime(value: string | undefined): string {
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

/**
 * Formats a percent value without noisy trailing decimals.
 * @param value Value to process.
 * @returns Formatted a percent value without noisy trailing decimals.
 */
function formatPercent(value: number): string {
    return Number.isSafeInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * Converts Synthetic.new fractional tick values into display percentages.
 * @param value Value to process.
 * @returns Converted Synthetic.new fractional tick values into display percentages.
 */
function normalizeSyntheticTickPercent(value: number): number {
    return value > 0 && value <= 1 ? value * 100 : value;
}

/**
 * Formats the Synthetic.new weekly regeneration amount when data is available.
 * @param weeklyTokenLimit Weekly token limit value.
 * @returns Formatted the Synthetic.new weekly regeneration amount when data is available.
 */
function formatSyntheticWeeklyRegenAmount(
    weeklyTokenLimit: SyntheticQuota["weeklyTokenLimit"]
): string | undefined {
    if (weeklyTokenLimit.nextRegenPercent !== undefined) {
        return `+${formatPercent(weeklyTokenLimit.nextRegenPercent)}%`;
    }

    if (weeklyTokenLimit.nextRegenCredits) {
        return `+${weeklyTokenLimit.nextRegenCredits}`;
    }

    return undefined;
}

/**
 * Formats the Synthetic.new 5h regeneration amount when data is available.
 * @param rollingFiveHourLimit Rolling five hour limit value.
 * @returns Formatted the Synthetic.new 5h regeneration amount when data is available.
 */
function formatSyntheticFiveHourRegenAmount(
    rollingFiveHourLimit: SyntheticQuota["rollingFiveHourLimit"]
): string | undefined {
    if (rollingFiveHourLimit.tickPercent !== undefined) {
        return `+${formatPercent(normalizeSyntheticTickPercent(rollingFiveHourLimit.tickPercent))}%`;
    }

    return undefined;
}

/**
 * Formats one Synthetic.new regeneration window segment.
 * @param label Label value.
 * @param resetAt Reset at timestamp.
 * @param amount Amount value.
 * @param formatReset Format reset value.
 * @returns Formatted one Synthetic.new regeneration window segment.
 */
function formatSyntheticRegenSegment(
    label: string,
    resetAt: string | undefined,
    amount: string | undefined,
    formatReset: (value: string | undefined) => string = formatResetValue
): string {
    const amountSuffix = amount ? ` (${amount})` : "";

    return `${label} ${formatReset(resetAt)}${amountSuffix}`;
}

/**
 * Formats the Synthetic.new weekly remaining quota.
 * @param weeklyTokenLimit Weekly token limit value.
 * @returns Formatted the Synthetic.new weekly remaining quota.
 */
function formatSyntheticWeeklyRemaining(
    weeklyTokenLimit: SyntheticQuota["weeklyTokenLimit"]
): string {
    return `${Math.round(weeklyTokenLimit.percentRemaining)}% left`;
}

/**
 * Formats the OpenRouter key limit period.
 * @param value Value to process.
 * @returns Formatted the OpenRouter key limit period.
 */
function formatOpenRouterLimitReset(value: string | undefined): string {
    if (!value || value === "never") {
        return "quota";
    }

    return `${value} quota`;
}

/**
 * Formats small OpenRouter quota amounts without rounding real usage away.
 * @param value Value to process.
 * @returns Formatted small OpenRouter quota amounts without rounding real usage away.
 */
function formatOpenRouterQuotaAmount(value: number): string {
    return `$${value.toFixed(3)}`;
}

/**
 * Formats configured OpenRouter quota limits without noisy trailing zeroes.
 * @param value Value to process.
 * @returns Formatted configured OpenRouter quota limits without noisy trailing zeroes.
 */
function formatOpenRouterQuotaLimit(value: number): string {
    return `$${value.toFixed(3).replace(/\.?0+$/, "")}`;
}

/**
 * Formats the primary OpenRouter quota summary.
 * @param quota OpenRouter quota data.
 * @returns Human-readable quota summary.
 */
function formatOpenRouterPrimaryLine(quota: QuotasResponse["openrouter"]): string {
    if (hasQuotaStatus(quota)) {
        return quota.status.replaceAll("_", " ");
    }

    if (quota.limit !== undefined && quota.limitRemaining !== undefined) {
        return `${formatOpenRouterQuotaAmount(quota.limitRemaining)} left / ${formatOpenRouterQuotaLimit(quota.limit)} ${formatOpenRouterLimitReset(quota.limitReset)}`;
    }

    return `$${quota.remaining.toFixed(2)} balance`;
}

/**
 * Formats the primary OpenAI quota summary.
 * @param quota OpenAI quota data.
 * @returns Human-readable quota summary.
 */
function formatOpenAiPrimaryLine(quota: QuotasResponse["openai"]): string {
    if (hasQuotaStatus(quota)) {
        return quota.status.replaceAll("_", " ");
    }

    const fiveHourSummary =
        quota.fiveHourLeftPercent === undefined
            ? "unlimited"
            : `${quota.fiveHourLeftPercent}% left`;
    return `5h ${fiveHourSummary} · weekly ${quota.weeklyLeftPercent}% left`;
}

/**
 * Formats OpenAI quota reset metadata.
 * @param quota OpenAI quota data.
 * @returns Human-readable reset summary.
 */
function formatOpenAiSecondaryLine(quota: QuotasResponse["openai"]): string {
    if (hasQuotaStatus(quota)) {
        return quota.note || "";
    }
    if (quota.fiveHourLeftPercent === undefined) {
        return `Resets weekly ${formatResetValue(quota.weeklyReset)}`;
    }
    return `Resets: 5h ${formatResetTime(quota.fiveHourReset)} · weekly ${formatResetValue(quota.weeklyReset)}`;
}

/**
 * Renders the quota overview card UI.
 * @returns Rendered the quota overview card UI.
 */
export function QuotaOverviewCard({ quotas }: QuotaOverviewCardProperties) {
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
            icon: <Waves className="size-4" />,
            line1: formatOpenRouterPrimaryLine(quotas.openrouter),
            line2: hasQuotaStatus(quotas.openrouter)
                ? quotas.openrouter.note || ""
                : `$${quotas.openrouter.remaining.toFixed(2)} balance · $${quotas.openrouter.usageMonthly.toFixed(4)} this month`,
            percent:
                !hasQuotaStatus(quotas.openrouter) &&
                quotas.openrouter.percentUsed !== undefined
                    ? quotas.openrouter.percentUsed
                    : undefined,
        },
        {
            key: "elevenlabs",
            label: "ElevenLabs",
            icon: <Zap className="size-4" />,
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
            icon: <Zap className="size-4" />,
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
            icon: <DollarSign className="size-4" />,
            line1: formatOpenAiPrimaryLine(quotas.openai),
            line2: formatOpenAiSecondaryLine(quotas.openai),
            percent: hasQuotaStatus(quotas.openai)
                ? undefined
                : quotas.openai.percentUsed,
        },
    ];

    return (
        <Card>
            <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold tracking-wide text-primary-300 uppercase">
                    Usage Limits
                </h3>
                <Gauge className="size-4 text-primary-400" />
            </div>

            <div className="space-y-2">
                {providers.map((provider) => (
                    <div
                        key={provider.key}
                        className="rounded-lg border border-primary-700 bg-primary-800/40 px-3 py-2"
                    >
                        <div className="mb-1 flex items-start justify-between gap-2">
                            <div className="inline-flex min-w-0 items-center gap-2 text-sm text-primary-100">
                                {provider.icon}
                                <span className="truncate">{provider.label}</span>
                            </div>
                            {provider.percent !== undefined && (
                                <Badge variant={getSeverity(provider.percent)}>
                                    {formatPercent(provider.percent)}%
                                </Badge>
                            )}
                        </div>
                        <div className="text-xs wrap-break-word text-primary-300">
                            {provider.line1}
                        </div>
                        {provider.line2 && (
                            <div className="text-xs wrap-break-word text-primary-400">
                                {provider.line2}
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </Card>
    );
}
