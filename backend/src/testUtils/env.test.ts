import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { withEnv } from "./env.js";

describe("test env helpers", () => {
    it("serializes temporary environment mutations", async () => {
        const original = process.env.MIRA_WITH_ENV_TEST;
        let releaseFirst!: () => void;
        let firstTask!: Promise<void>;
        const firstEntered = new Promise<void>((resolve) => {
            firstTask = withEnv({ MIRA_WITH_ENV_TEST: "first" }, async () => {
                assert.equal(process.env.MIRA_WITH_ENV_TEST, "first");
                resolve();
                await new Promise<void>((release) => {
                    releaseFirst = release;
                });
                assert.equal(process.env.MIRA_WITH_ENV_TEST, "first");
            });
        });

        await firstEntered;
        let secondStarted = false;
        const second = withEnv({ MIRA_WITH_ENV_TEST: "second" }, () => {
            secondStarted = true;
            assert.equal(process.env.MIRA_WITH_ENV_TEST, "second");
            return process.env.MIRA_WITH_ENV_TEST;
        });

        assert.equal(process.env.MIRA_WITH_ENV_TEST, "first");
        assert.equal(secondStarted, false);
        releaseFirst();
        assert.equal(await second, "second");
        assert.equal(secondStarted, true);
        await firstTask;
        assert.equal(process.env.MIRA_WITH_ENV_TEST, original);
    });
});
