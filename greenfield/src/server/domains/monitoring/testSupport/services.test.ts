import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { captureFailure } from "../../../test/support/promise.ts";
import { uuid } from "./monitoringService.ts";
import {
    createTestMonitoringCatalogService,
    createTestMonitoringService,
} from "./services.ts";

describe("monitoring service test doubles", () => {
    test("names the unexpected catalog method", async () => {
        const service = createTestMonitoringCatalogService();
        const failure = await captureFailure(() =>
            Effect.runPromise(service.deleteReport({ id: uuid(1) }))
        );

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain("deleteReport");
    });

    test("names the unexpected ingestion method", async () => {
        const service = createTestMonitoringService();
        const failure = await captureFailure(() =>
            Effect.runPromise(service.submitCompleteSnapshot({}))
        );

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain("submitCompleteSnapshot");
    });
});
