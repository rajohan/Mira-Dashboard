import { GlobalRegistrator } from "@happy-dom/global-registrator";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, expect, jest } from "bun:test";

expect.extend(matchers);

GlobalRegistrator.register();

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
    writable: true,
});

Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
});

Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: () => 0,
});

const { cleanup } = await import("@testing-library/react");

afterEach(() => {
    jest.restoreAllMocks();
    cleanup();
    document.body.innerHTML = "";
});
