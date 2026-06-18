import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, jest } from "bun:test";

import { resetStubbedGlobals } from "./testUtils";

if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register({ url: "http://localhost/" });
}

Object.defineProperties(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: {
        configurable: true,
        value: true,
        writable: true,
    },
    __APP_COMMIT__: {
        configurable: true,
        value: "test-commit",
    },
});

class ResizeObserverMock implements ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverMock,
});

Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
});

afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    resetStubbedGlobals();
});
