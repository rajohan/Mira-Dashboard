import type { OpenClawConfig } from "../../../contracts/openClawConfig";
import { type ChannelSummary } from "../components/features/settings/ChannelSection";

export type TimerRef = { current: ReturnType<typeof setTimeout> | undefined };

export function clearTimer(timerRef: TimerRef): void {
    if (timerRef.current === undefined) {
        return;
    }

    clearTimeout(timerRef.current);
    timerRef.current = undefined;
}

/**
 * Shows a transient settings success message.
 * @param setSuccess Set success value.
 * @param message Message to process.
 * @param timerRef Timer ref value.
 */
export function patchSuccess(
    setSuccess: (value: string | undefined) => void,
    message: string,
    timerRef?: TimerRef
): void {
    if (timerRef) {
        clearTimer(timerRef);
    }
    setSuccess(message);
    const timeoutId = setTimeout(() => {
        setSuccess(undefined);
        if (timerRef) timerRef.current = undefined;
    }, 3000);
    if (timerRef) timerRef.current = timeoutId;
}

/**
 * Returns the configured OpenClaw channels in display order.
 * @returns the configured OpenClaw channels in display order.
 */
export function configuredChannels(config?: OpenClawConfig): ChannelSummary[] {
    const channels = (config?.channels || {}) as Record<string, Record<string, unknown>>;
    return Object.entries(channels)
        .map(([id, value]) => {
            let details = Array.isArray(value.allowFrom)
                ? `${value.allowFrom.length} allowed senders`
                : undefined;
            if (typeof value.botId === "string") {
                details = value.botId;
            }
            let policy =
                typeof value.dmPolicy === "string" ? `dm: ${value.dmPolicy}` : undefined;
            if (typeof value.groupPolicy === "string") {
                policy = `group: ${value.groupPolicy}`;
            }
            return {
                details,
                enabled: value.enabled === true,
                id,
                policy,
            };
        })
        .toSorted((first, second) => first.id.localeCompare(second.id));
}

/**
 * Converts a duration value to seconds or returns the supplied fallback.
 * @param value Value to process.
 * @param fallback Fallback value.
 * @returns Converted a duration value to seconds or returns the supplied fallback.
 */
export function numberFromDuration(value: unknown, fallback: number): number {
    if (typeof value === "number") return value;
    if (typeof value !== "string") return fallback;
    const match = value.match(/^(\d+)([dhms])?$/i);
    if (!match) return fallback;
    const amount = Number(match[1]);
    const unit = (match[2] || "s").toLowerCase() as "d" | "h" | "m" | "s";
    const factors: Record<typeof unit, number> = {
        d: 86_400,
        h: 3600,
        m: 60,
        s: 1,
    };
    return amount * factors[unit];
}

/**
 * Returns undefined for empty form values before writing config patches.
 * @param value Value to process.
 * @returns undefined for empty form values before writing config patches.
 */
export function optionalFormValue(value?: string): string | undefined {
    const trimmed = value?.trim();
    return trimmed || undefined;
}
