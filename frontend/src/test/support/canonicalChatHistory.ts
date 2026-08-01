import {
    canonicalizeOpenClawHistoryMessageResult,
    canonicalizeOpenClawHistoryPage,
} from "../../../../contracts/chat/openClawHistoryPageAdapter";
import type {
    CanonicalChatHistoryMessageResult,
    CanonicalChatHistoryPage,
    CanonicalChatHistoryRow,
} from "../../../../contracts/chatCanonicalHistory";
import { OpenClawChatAdapter as CanonicalOpenClawChatAdapter } from "../../components/features/chat/transport/openClawChatAdapter";

export const TEST_OPENCLAW_SESSION_KEY = "agent:main:main";

export class TestOpenClawChatAdapter extends CanonicalOpenClawChatAdapter {
    override history(raw: unknown) {
        return super.history(
            canonicalHistoryRows(Array.isArray(raw) ? raw : [], TEST_OPENCLAW_SESSION_KEY)
        );
    }
}

/**
 * Passes raw provider history through the backend-owned canonical boundary.
 * @param messages Raw OpenClaw history rows.
 * @param sessionKey Session identity for stable row ids.
 * @returns Canonical history rows suitable for frontend tests.
 */
export function canonicalHistoryRows(
    messages: unknown[],
    sessionKey = TEST_OPENCLAW_SESSION_KEY
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

/**
 * Simulates the backend response received for one full transcript message.
 * @param raw Raw OpenClaw message result.
 * @param request Original full-message request.
 * @returns Canonical full-message result.
 */
export function canonicalHistoryMessageResult(
    raw: unknown,
    request: { messageId: string; sessionKey: string }
): CanonicalChatHistoryMessageResult {
    return canonicalizeOpenClawHistoryMessageResult(raw, request);
}
