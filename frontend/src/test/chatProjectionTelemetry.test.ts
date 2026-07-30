import { describe, expect, it } from "bun:test";

import { parseChatProjectionShadowObservation } from "../../../contracts/chatProjectionTelemetry";
import type { ChatProjectionShadowComparison } from "../components/features/chat/domain/chatCanonicalProjection";
import {
    chatProjectionShadowObservation,
    chatProjectionShadowStateSignature,
} from "../components/features/chat/domain/chatProjectionTelemetry";

describe("canonical chat projection telemetry", () => {
    it("drops local fingerprints and sends only bounded structural parity", () => {
        const comparison: ChatProjectionShadowComparison = {
            canonicalActiveRunCount: 1,
            canonicalCompactionPhase: "active",
            canonicalFingerprint: "canonical-local-only",
            canonicalRowCount: 3,
            differenceKinds: ["rows"],
            legacyActiveRunCount: 1,
            legacyCompactionPhase: "active",
            legacyFingerprint: "legacy-local-only",
            legacyRowCount: 4,
            matches: false,
            schemaVersion: 1,
            turnCount: 2,
        };

        const observation = chatProjectionShadowObservation(comparison);

        expect(parseChatProjectionShadowObservation(observation)).toEqual({
            canonicalActiveRunCount: 1,
            canonicalCompactionPhase: "active",
            canonicalRowCount: 3,
            differenceKinds: ["rows"],
            legacyActiveRunCount: 1,
            legacyCompactionPhase: "active",
            legacyRowCount: 4,
            matches: false,
            schemaVersion: 1,
            turnCount: 2,
        });
        expect(observation).not.toHaveProperty("canonicalFingerprint");
        expect(observation).not.toHaveProperty("legacyFingerprint");
    });

    it("uses an explicit content-free error state when canonical projection fails", () => {
        const observation = chatProjectionShadowObservation({
            differenceKinds: ["canonical-error"],
            legacyActiveRunCount: 1,
            legacyCompactionPhase: "none",
            legacyFingerprint: "legacy-local-only",
            legacyRowCount: 2,
            matches: false,
            schemaVersion: 1,
        });

        expect(parseChatProjectionShadowObservation(observation)).toEqual({
            differenceKinds: ["canonical-error"],
            legacyActiveRunCount: 1,
            legacyCompactionPhase: "none",
            legacyRowCount: 2,
            matches: false,
            schemaVersion: 1,
        });
    });

    it("dedupes count churn while retaining parity and session transitions", () => {
        const comparison: ChatProjectionShadowComparison = {
            canonicalActiveRunCount: 0,
            canonicalCompactionPhase: "none",
            canonicalFingerprint: "canonical-before",
            canonicalRowCount: 1,
            differenceKinds: [],
            legacyActiveRunCount: 0,
            legacyCompactionPhase: "none",
            legacyFingerprint: "legacy-before",
            legacyRowCount: 1,
            matches: true,
            schemaVersion: 1,
            turnCount: 1,
        };
        const initial = chatProjectionShadowStateSignature(comparison, "session-a");
        const countChurn = chatProjectionShadowStateSignature(
            {
                ...comparison,
                canonicalActiveRunCount: 1,
                canonicalFingerprint: "canonical-after",
                canonicalRowCount: 3,
                legacyActiveRunCount: 1,
                legacyFingerprint: "legacy-after",
                legacyRowCount: 3,
                turnCount: 2,
            },
            "session-a"
        );

        expect(countChurn).toBe(initial);
        expect(
            chatProjectionShadowStateSignature(
                {
                    ...comparison,
                    differenceKinds: ["rows"],
                    matches: false,
                },
                "session-a"
            )
        ).not.toBe(initial);
        expect(chatProjectionShadowStateSignature(comparison, "session-b")).not.toBe(
            initial
        );
    });
});
