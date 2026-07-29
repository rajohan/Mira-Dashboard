import { afterEach, expect, jest } from "bun:test";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

// jest-dom v7 eagerly imports Testing Library's document-bound helpers.
// Register Happy DOM before loading the matchers so `screen` binds to this document.
const { default: _defaultMatchers, ...matchers } =
    await import("@testing-library/jest-dom/matchers");
expect.extend(matchers);

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
    writable: true,
});

Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
});

Object.defineProperties(globalThis, {
    requestAnimationFrame: {
        configurable: true,
        value: (callback: FrameRequestCallback) =>
            setTimeout(() => callback(performance.now()), 0),
    },
    cancelAnimationFrame: {
        configurable: true,
        value: (handle: number) => clearTimeout(handle),
    },
});

const { cleanup } = await import("@testing-library/react");

afterEach(() => {
    jest.restoreAllMocks();
    cleanup();
    document.body.replaceChildren();
});
