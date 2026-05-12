import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
        __APP_COMMIT__?: string;
    }
).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as typeof globalThis & { __APP_COMMIT__?: string }).__APP_COMMIT__ =
    "test-commit";

afterEach(() => {
    cleanup();
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

if (!Element.prototype.getAnimations) {
    Object.defineProperty(Element.prototype, "getAnimations", {
        configurable: true,
        value: () => [],
    });
}
