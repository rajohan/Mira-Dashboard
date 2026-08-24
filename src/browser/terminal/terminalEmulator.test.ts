import { describe, expect, test } from "bun:test";

import { terminalEmulatorOptions, terminalWindowOptions } from "./terminalEmulator.ts";

describe("interactive terminal xterm policy", () => {
    test("keeps links, logging, proposed APIs, transparency, and stdin disabled by default", () => {
        expect(terminalEmulatorOptions).toMatchObject({
            allowProposedApi: false,
            allowTransparency: false,
            disableStdin: true,
            linkHandler: null,
            logLevel: "off",
            screenReaderMode: true,
        });
        expect(Object.values(terminalWindowOptions)).toEqual(
            Array.from({ length: Object.keys(terminalWindowOptions).length }, () => false)
        );
        expect(terminalEmulatorOptions.scrollback).toBe(2000);
    });
});
