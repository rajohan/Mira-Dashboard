import { notifyManager } from "@tanstack/react-query";
import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup } from "@testing-library/react";
import { afterEach, expect } from "bun:test";

expect.extend(matchers);
notifyManager.setNotifyFunction((callback) => {
    act(callback);
});

afterEach(() => {
    cleanup();
});
