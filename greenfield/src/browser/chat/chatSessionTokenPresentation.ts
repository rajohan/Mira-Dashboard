import { formatCompactCount } from "../lib/formatMeasurements.ts";
import type { ChatSessionOption } from "./chatTypes.ts";

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
    const freshness = session.totalTokensFresh ? "current" : "out of date";
    return {
        accessibleLabel: `Session token use: ${exact}, ${freshness}`,
        compactLabel: `${session.totalTokensFresh ? "" : "~"}${formatCompactCount(session.totalTokens)} / ${formatCompactCount(session.contextTokens)}`,
    };
}
