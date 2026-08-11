import { describe, expect, test } from "bun:test";

import { rejectionError } from "../../scripts/testSupport/rejection.ts";
import { runDevelopmentWebProcess } from "./developmentWeb.ts";
import { runDevelopmentWorkerProcess } from "./developmentWorker.ts";

describe("development process entrypoints", () => {
    test("rejects a missing web source commit before composition", async () => {
        const failure = await rejectionError(runDevelopmentWebProcess([]));

        expect(failure.message).toBe("Development web requires one exact source commit");
    });

    test("rejects a missing worker source commit before composition", async () => {
        const failure = await rejectionError(runDevelopmentWorkerProcess([]));

        expect(failure.message).toBe(
            "Development worker requires one exact source commit"
        );
    });
});
