import { expect, mock, test } from "bun:test";

import { captureExpectedConsoleErrors } from "./expectedConsoleError.ts";

test("captures only exact expected failures and forwards every other diagnostic", () => {
    const forwardedConsoleError = mock(() => {});
    const expectedFailure = new TypeError("expected collection failure");
    const expectedQueryCollectionFailure = new TypeError(
        "expected query collection failure"
    );
    const consoleErrors = captureExpectedConsoleErrors(
        [expectedFailure, expectedQueryCollectionFailure],
        forwardedConsoleError
    );

    try {
        console.error(expectedFailure);
        console.error(
            "[QueryCollection] Error observing query monitoring,notifications,latest:",
            expectedQueryCollectionFailure
        );
        console.error(new TypeError(expectedFailure.message));
        console.error(`TypeError: ${expectedFailure.message}\n    at expected boundary`);
        console.error("An update was not wrapped in act(...)", expectedFailure);
        console.error("An update was not wrapped in act(...)");

        consoleErrors.expectObserved();
        expect(forwardedConsoleError).toHaveBeenCalledTimes(4);
        expect(forwardedConsoleError).toHaveBeenNthCalledWith(1, expect.any(TypeError));
        expect(forwardedConsoleError).toHaveBeenNthCalledWith(
            2,
            `TypeError: ${expectedFailure.message}\n    at expected boundary`
        );
        expect(forwardedConsoleError).toHaveBeenNthCalledWith(
            3,
            "An update was not wrapped in act(...)",
            expectedFailure
        );
        expect(forwardedConsoleError).toHaveBeenNthCalledWith(
            4,
            "An update was not wrapped in act(...)"
        );
    } finally {
        consoleErrors.restore();
    }
});
