import { canonicalizeOpenClawHistoryPage } from "../../../../contracts/chat/openClawHistoryPageAdapter";
import type {
    CanonicalChatHistoryPage,
    CanonicalChatHistoryRow,
} from "../../../../contracts/chatCanonicalHistory";

const DEFAULT_SESSION_KEY = "agent:main:main";

/**
 * Passes raw provider history through the backend-owned canonical boundary.
 * @param messages Raw OpenClaw history rows.
 * @param sessionKey Session identity for stable row ids.
 * @returns Canonical history rows suitable for frontend tests.
 */
export function canonicalHistoryRows(
    messages: unknown[],
    sessionKey = DEFAULT_SESSION_KEY
): CanonicalChatHistoryRow[] {
    return canonicalizeOpenClawHistoryPage(
        { hasMore: false, messages, offset: 0, totalMessages: messages.length },
        { offset: 0, sessionKey }
    ).messages;
}

/**
 * Simulates the backend response received by the frontend history loader.
 * @param raw Raw OpenClaw page.
 * @param request Original page request.
 * @returns Canonical history page.
 */
export function canonicalHistoryPage(
    raw: unknown,
    request: { offset: number; sessionKey: string }
): CanonicalChatHistoryPage {
    return canonicalizeOpenClawHistoryPage(raw, request);
}
