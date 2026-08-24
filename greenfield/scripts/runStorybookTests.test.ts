import { describe, expect, test } from "bun:test";
import path from "node:path";

import { createStorybookTestCommand, runStorybookTests } from "./runStorybookTests.ts";

const projectRoot = path.resolve(import.meta.dir, "..");

describe("Storybook test runner", () => {
    test("uses one deterministic browser worker", () => {
        expect(createStorybookTestCommand("/tmp/dashboard")).toEqual([
            "/tmp/dashboard/node_modules/.bin/vitest",
            "run",
            "--config",
            ".storybook/vitest.config.ts",
            "--project=storybook",
            "--maxWorkers=1",
            "--no-file-parallelism",
        ]);
    });

    test("preserves a successful child result", async () => {
        expect(
            await runStorybookTests(projectRoot, [process.execPath, "-e", "void 0"])
        ).toBe(0);
    });
});
