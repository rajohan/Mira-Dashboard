import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

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

afterEach(() => {
    cleanup();
});

/** Implements resize observer mock. */
class ResizeObserverMock implements ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverMock,
});

if (!Element.prototype.getAnimations) {
    Object.defineProperty(Element.prototype, "getAnimations", {
        configurable: true,
        value: () => [],
    });
}
