import type { ChatSessionOption } from "./chatTypes.ts";

function compactTokenCount(value: number): string {
    if (value < 1000) return new Intl.NumberFormat().format(value);
    const divisor = value >= 1_000_000 ? 1_000_000 : 1000;
    const suffix = value >= 1_000_000 ? "m" : "k";
    const scaled = value / divisor;
    const maximumFractionDigits = scaled < 10 && !Number.isInteger(scaled) ? 1 : 0;
    return `${new Intl.NumberFormat(undefined, {
        maximumFractionDigits,
    }).format(scaled)}${suffix}`;
}

export interface ChatSessionTokenPresentation {
    readonly accessibleLabel: string;
    readonly compactLabel: string;
}

/**
 * Separates compact token chrome from exact freshness-aware accessible detail.
 * @param session Selected canonical session option.
 * @returns Compact and exact labels without changing canonical token values.
 */
export function chatSessionTokenPresentation(
    session: Pick<ChatSessionOption, "contextTokens" | "totalTokens" | "totalTokensFresh">
): ChatSessionTokenPresentation {
    if (session.contextTokens === undefined || session.totalTokens === undefined) {
        return {
            accessibleLabel: "Session token use: Unknown",
            compactLabel: "Unknown",
        };
    }
    const formatter = new Intl.NumberFormat();
    const exact = `${formatter.format(session.totalTokens)} of ${formatter.format(session.contextTokens)}`;
    const freshness = session.totalTokensFresh ? "fresh" : "stale";
    return {
        accessibleLabel: `Session token use: ${exact}, ${freshness}`,
        compactLabel: `${session.totalTokensFresh ? "" : "~"}${compactTokenCount(session.totalTokens)} / ${compactTokenCount(session.contextTokens)}`,
    };
}
