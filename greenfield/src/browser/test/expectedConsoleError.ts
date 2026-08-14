import { expect, spyOn } from "bun:test";

interface ExpectedConsoleErrorCapture {
    readonly expectObserved: () => void;
    readonly restore: () => void;
}

function expectedErrorIdentity(
    arguments_: readonly unknown[],
    expectedErrors: readonly Error[]
): Error | undefined {
    if (arguments_.length === 1) {
        return expectedErrors.find((error) => arguments_[0] === error);
    }
    if (
        arguments_.length === 2 &&
        typeof arguments_[0] === "string" &&
        arguments_[0].startsWith("[QueryCollection] Error observing query ") &&
        arguments_[0].endsWith(":")
    ) {
        return expectedErrors.find((error) => arguments_[1] === error);
    }
    return undefined;
}

/**
 * Captures only explicitly expected error objects while preserving every other diagnostic.
 * @param expectedErrors Exact error identities that the exercised failure path logs.
 * @param forwardUnexpected Sink for diagnostics that do not match an expected failure.
 * @returns Assertions and restoration for the narrow console interception.
 */
export function captureExpectedConsoleErrors(
    expectedErrors: readonly Error[],
    forwardUnexpected: (...arguments_: unknown[]) => void = console.error.bind(console)
): ExpectedConsoleErrorCapture {
    const observedErrors = new Set<Error>();
    const consoleError = spyOn(console, "error").mockImplementation(
        (...arguments_: unknown[]) => {
            const matchedError = expectedErrorIdentity(arguments_, expectedErrors);
            if (matchedError === undefined) {
                forwardUnexpected(...arguments_);
                return;
            }
            observedErrors.add(matchedError);
        }
    );

    return {
        expectObserved: () => {
            expect([...observedErrors]).toEqual([...expectedErrors]);
        },
        restore: () => consoleError.mockRestore(),
    };
}
