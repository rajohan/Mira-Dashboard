import { describe, expect, it } from "bun:test";

import {
    loadChatIncidentFixture,
    replayChatIncidentFixture,
} from "../support/chatIncidentFixture";

const FIXTURE_URLS = [
    new URL("../fixtures/chat/codex-gpt-restart.json", import.meta.url),
    new URL("../fixtures/chat/synthetic-model-session-message.json", import.meta.url),
    new URL("../fixtures/chat/codex-gpt-duplicate-user-restart.json", import.meta.url),
    new URL(
        "../fixtures/chat/synthetic-model-duplicate-user-restart.json",
        import.meta.url
    ),
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

    it("preserves restart steers identically for Codex/GPT and Synthetic", async () => {
        const [codexFixture, syntheticFixture] = await Promise.all([
            loadChatIncidentFixture(FIXTURE_URLS[2]!),
            loadChatIncidentFixture(FIXTURE_URLS[3]!),
        ]);
        const codex = replayChatIncidentFixture(codexFixture);
        const synthetic = replayChatIncidentFixture(syntheticFixture);

        expect(codexFixture.providerFormat).toBe("codex-gpt");
        expect(syntheticFixture.providerFormat).toBe("synthetic-model");
        expect(codex.normalizedEventKinds).not.toEqual(synthetic.normalizedEventKinds);
        expect(synthetic.rows).toEqual(codex.rows);
        expect(
            synthetic.rows.filter((row) => row.type === "user").map((row) => row.text)
        ).toEqual([
            "Investigate replay",
            "[System] Your previous turn was interrupted by a gateway restart. Continue the previous task.",
            "Steer after restart",
        ]);
    });
});
