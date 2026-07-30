import {
    parseChatProjectionShadowObservationResponse,
    type ChatProjectionShadowObservation,
    type ChatProjectionShadowObservationResponse,
} from "../../../../../../contracts/chatProjectionTelemetry";
import { apiPostParsed } from "../../../../hooks/useApi";
import type { ChatProjectionShadowComparison } from "./chatCanonicalProjection";

/**
 * Builds the bounded observation sent across the authenticated HTTP boundary.
 * @param comparison Browser shadow comparison.
 * @returns Content-free projection parity observation.
 */
export function chatProjectionShadowObservation(
    comparison: ChatProjectionShadowComparison
): ChatProjectionShadowObservation {
    return {
        ...(comparison.canonicalActiveRunCount === undefined
            ? {}
            : { canonicalActiveRunCount: comparison.canonicalActiveRunCount }),
        ...(comparison.canonicalCompactionPhase === undefined
            ? {}
            : { canonicalCompactionPhase: comparison.canonicalCompactionPhase }),
        ...(comparison.canonicalRowCount === undefined
            ? {}
            : { canonicalRowCount: comparison.canonicalRowCount }),
        differenceKinds: comparison.differenceKinds,
        legacyActiveRunCount: comparison.legacyActiveRunCount,
        legacyCompactionPhase: comparison.legacyCompactionPhase,
        legacyRowCount: comparison.legacyRowCount,
        matches: comparison.matches,
        schemaVersion: comparison.schemaVersion,
        ...(comparison.turnCount === undefined
            ? {}
            : { turnCount: comparison.turnCount }),
    };
}

/**
 * Builds the browser-local dedupe key for structural parity changes.
 * Projection counts are deliberately excluded so ordinary row churn does not
 * report another observation while the selected session remains in the same
 * parity state.
 * @param comparison Browser shadow comparison.
 * @param selectedSessionKey Currently selected session.
 * @returns Stable structural parity signature.
 */
export function chatProjectionShadowStateSignature(
    comparison: ChatProjectionShadowComparison,
    selectedSessionKey: string
): string {
    return JSON.stringify({
        differenceKinds: comparison.differenceKinds.toSorted(),
        matches: comparison.matches,
        selectedSessionKey,
    });
}

/**
 * Reports one bounded, content-free canonical projection parity observation.
 * @param observation Content-free parity observation.
 * @returns Validated backend acknowledgement.
 */
export function reportChatProjectionShadowObservation(
    observation: ChatProjectionShadowObservation
): Promise<ChatProjectionShadowObservationResponse> {
    return apiPostParsed(
        "/metrics/chat-projection-shadow",
        parseChatProjectionShadowObservationResponse,
        observation,
        {
            canRetryAfterSecurityVerification: false,
            canRetryAfterUnauthorizedRecovery: false,
        }
    );
}
