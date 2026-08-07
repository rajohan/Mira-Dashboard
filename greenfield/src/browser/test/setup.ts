import { afterAll, afterEach, beforeAll, beforeEach, expect } from "bun:test";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

interface HappyDomAsyncTaskOwner {
    readonly abort: () => Promise<void>;
}

GlobalRegistrator.register({ url: "https://dashboard.test/" });

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

afterEach(async () => {
    cleanup();
    document.body.replaceChildren();
    const happyDom: unknown = Reflect.get(globalThis, "happyDOM");
    if (isHappyDomAsyncTaskOwner(happyDom)) await happyDom.abort();
});
