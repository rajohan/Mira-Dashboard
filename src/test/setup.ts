import * as matchers from "@testing-library/jest-dom/matchers";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, expect, jest } from "bun:test";

expect.extend(matchers);

GlobalRegistrator.register();

Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
});

const { cleanup } = await import("@testing-library/react");

afterEach(() => {
    jest.restoreAllMocks();
    cleanup();
    document.body.innerHTML = "";
});
