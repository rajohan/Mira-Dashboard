import { afterAll, afterEach, beforeAll, beforeEach, expect } from "bun:test";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { PropertySymbol } from "happy-dom";
import { act } from "react";

interface HappyDomAsyncTaskOwner {
    readonly abort: () => Promise<void>;
}

interface HappyDomTimerOwner {
    readonly setTimeout: typeof globalThis.setTimeout;
}

function isHappyDomTimerOwner(value: unknown): value is HappyDomTimerOwner {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof Reflect.get(value, "setTimeout") === "function"
    );
}

GlobalRegistrator.register({ url: "https://dashboard.test/" });

const browserFetch = globalThis.fetch;
const dashboardTestFetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(
        input instanceof Request ? input.url : input.toString(),
        globalThis.location.href
    );
    if (
        url.origin === globalThis.location.origin &&
        url.pathname === "/api/health/ready"
    ) {
        return Promise.resolve(Response.json({ status: "ready" }));
    }
    return browserFetch(input, init);
};
Reflect.set(globalThis, "fetch", dashboardTestFetch);

const happyDomTimerOwner: unknown = Reflect.get(document, PropertySymbol.window);
if (!isHappyDomTimerOwner(happyDomTimerOwner)) {
    throw new TypeError("HappyDOM did not expose its owning window timer");
}
const browserSetTimeout = globalThis.setTimeout;
const maximumZeroDelayDrainPasses = 64;
const maximumZeroDelaySchedulesDuringDrain = 256;
let zeroDelayGeneration = 0;
let drainedZeroDelayGeneration = 0;
let drainingZeroDelayQueue = false;
let zeroDelaySchedulesDuringDrain = 0;
const trackedBrowserSetTimeout = (
    callback: Parameters<typeof globalThis.setTimeout>[0],
    delay?: number,
    ...arguments_: unknown[]
): ReturnType<typeof globalThis.setTimeout> => {
    if (!delay) {
        zeroDelayGeneration += 1;
        if (drainingZeroDelayQueue) {
            zeroDelaySchedulesDuringDrain += 1;
            if (zeroDelaySchedulesDuringDrain > maximumZeroDelaySchedulesDuringDrain) {
                throw new Error(
                    `HappyDOM scheduled more than ${maximumZeroDelaySchedulesDuringDrain} zero-delay callbacks during teardown`
                );
            }
        }
    }
    return Reflect.apply(browserSetTimeout, happyDomTimerOwner, [
        callback,
        delay,
        ...arguments_,
    ]) as ReturnType<typeof globalThis.setTimeout>;
};
Reflect.set(globalThis, "setTimeout", trackedBrowserSetTimeout);
Reflect.set(happyDomTimerOwner, "setTimeout", trackedBrowserSetTimeout);

const [matcherModule, animationMocks, testingLibrary] = await Promise.all([
    import("@testing-library/jest-dom/matchers"),
    import("jsdom-testing-mocks"),
    import("@testing-library/react"),
]);
const { default: _defaultMatchers, ...matchers } = matcherModule;
expect.extend(matchers);

const { configMocks, mockAnimationsApi } = animationMocks;

function runReactAct(trigger: () => void): void {
    act(() => {
        trigger();
    });
}

configMocks({
    act: runReactAct,
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
});
mockAnimationsApi();

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { cleanup } = testingLibrary;

function isHappyDomAsyncTaskOwner(value: unknown): value is HappyDomAsyncTaskOwner {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof Reflect.get(value, "abort") === "function"
    );
}

async function drainHappyDomZeroDelayQueue(): Promise<void> {
    if (zeroDelayGeneration === drainedZeroDelayGeneration) return;

    drainingZeroDelayQueue = true;
    zeroDelaySchedulesDuringDrain = 0;
    let passCount = 0;
    let expectedGeneration: number;
    try {
        do {
            passCount += 1;
            if (passCount > maximumZeroDelayDrainPasses) {
                throw new Error(
                    `HappyDOM zero-delay work did not settle after ${maximumZeroDelayDrainPasses} drain passes`
                );
            }
            expectedGeneration = zeroDelayGeneration + 1;
            await new Promise<void>((resolve) => trackedBrowserSetTimeout(resolve, 0));
        } while (zeroDelayGeneration !== expectedGeneration);
        drainedZeroDelayGeneration = zeroDelayGeneration;
    } finally {
        drainingZeroDelayQueue = false;
    }
}

afterEach(async () => {
    cleanup();
    document.body.replaceChildren();
    // HappyDOM groups zero-delay callbacks. Drain every finite nested batch before
    // aborting longer-lived tasks, or abort can strand its private callback queue.
    const happyDom: unknown = Reflect.get(globalThis, "happyDOM");
    try {
        await drainHappyDomZeroDelayQueue();
    } finally {
        if (isHappyDomAsyncTaskOwner(happyDom)) await happyDom.abort();
    }
});
