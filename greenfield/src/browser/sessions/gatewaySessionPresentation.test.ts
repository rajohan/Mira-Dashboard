import { describe, expect, test } from "bun:test";

import type { GatewaySession } from "../../contracts/gatewaySessions.ts";
import { gatewayPrimarySessionKey } from "../../contracts/gatewaySessions.ts";
import {
    gatewaySessionMatchesFilter,
    gatewaySessionTokenPresentation,
    sortGatewaySessions,
} from "./gatewaySessionPresentation.ts";

const timestampMs = 1_800_000_000_000;

function session(
    key: string,
    kind: GatewaySession["kind"],
    displayName: string,
    overrides: Partial<GatewaySession> = {}
): GatewaySession {
    return {
        displayName,
        hasActiveRun: false,
        key,
        kind,
        totalTokensFresh: false,
        updatedAtMs: timestampMs,
        ...overrides,
    };
}

describe("Gateway session presentation", () => {
    test("pins the primary session under every accessible sort direction", () => {
        const rows = [
            session("cron:a", "cron", "Alpha"),
            session(gatewayPrimarySessionKey, "main", "Zulu"),
            session("agent:coder:main", "subagent", "Beta"),
        ];

        for (const direction of ["ascending", "descending"] as const) {
            expect(
                sortGatewaySessions(rows, {
                    direction,
                    field: "displayName",
                })[0]?.key
            ).toBe(gatewayPrimarySessionKey);
        }
    });

    test("filters exact normalized kinds and preserves ALL", () => {
        const cron = session("cron:a", "cron", "Cron A");
        expect(gatewaySessionMatchesFilter(cron, "ALL")).toBe(true);
        expect(gatewaySessionMatchesFilter(cron, "CRON")).toBe(true);
        expect(gatewaySessionMatchesFilter(cron, "HOOK")).toBe(false);
    });

    test("labels unknown, stale, and fresh token counts explicitly", () => {
        expect(
            gatewaySessionTokenPresentation(session("cron:a", "cron", "Cron"))
        ).toEqual({
            accessibleLabel: "Session token use: Unknown",
            compactLabel: "Unknown",
        });
        expect(
            gatewaySessionTokenPresentation(
                session("cron:a", "cron", "Cron", { totalTokens: 1200 })
            )
        ).toEqual({
            accessibleLabel: "Session token use: 1,200, out of date",
            compactLabel: "~1.2k (last known)",
            maximum: undefined,
            value: undefined,
        });
        expect(
            gatewaySessionTokenPresentation(
                session("cron:a", "cron", "Cron", {
                    contextTokens: 272_000,
                    totalTokens: 1200,
                    totalTokensFresh: true,
                })
            )
        ).toEqual({
            accessibleLabel: "Session token use: 1,200 of 272,000, current",
            compactLabel: "1.2k / 272k",
            maximum: 272_000,
            value: 1200,
        });
    });
});
