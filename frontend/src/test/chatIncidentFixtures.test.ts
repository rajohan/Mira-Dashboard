import { describe, expect, it } from "bun:test";

import {
    loadChatIncidentFixture,
    replayChatIncidentFixture,
} from "./support/chatIncidentFixture";

const FIXTURE_URLS = [
    new URL("fixtures/chat/codex-gpt-restart.json", import.meta.url),
    new URL("fixtures/chat/synthetic-model-session-message.json", import.meta.url),
    new URL("fixtures/chat/codex-gpt-duplicate-user-restart.json", import.meta.url),
];

describe("chat incident fixtures", () => {
    it("replays every versioned fixture through the production chat pipeline", async () => {
        for (const url of FIXTURE_URLS) {
            const fixture = await loadChatIncidentFixture(url);
            const result = replayChatIncidentFixture(fixture);

            expect({
                activeRunCount: result.activeRunCount,
                rows: result.rows,
                runCount: result.runCount,
            }).toEqual(fixture.expected);
            expect(new Set(result.rowKeys).size).toBe(result.rowKeys.length);
            expect(result.shadowMatches).toBe(true);
            expect(result.turnCount).toBeGreaterThan(0);
        }
    });

    it("projects distinct Codex/GPT and Synthetic delivery formats identically", async () => {
        const [codexFixture, syntheticFixture] = await Promise.all([
            loadChatIncidentFixture(FIXTURE_URLS[0]!),
            loadChatIncidentFixture(FIXTURE_URLS[1]!),
        ]);
        const codex = replayChatIncidentFixture(codexFixture);
        const synthetic = replayChatIncidentFixture(syntheticFixture);

        expect(codexFixture.deliveryFormat).toBe("codex-separated-runtime-events");
        expect(syntheticFixture.deliveryFormat).toBe("synthetic-mixed-session-message");
        expect(codex.normalizedEventKinds).not.toEqual(synthetic.normalizedEventKinds);
        expect(codex.rows).toEqual(synthetic.rows);
    });
});
