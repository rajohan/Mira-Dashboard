import { describe, expect, test } from "bun:test";

import { executeSystemctlProcess } from "./systemctlProcess.ts";

describe("systemctl process boundary", () => {
    test("does not forward ambient HOME to the user manager command", async () => {
        const result = await executeSystemctlProcess("/usr/bin/env", []);
        const environment = new TextDecoder().decode(result.stdout).split("\n");

        expect(result.exitCode).toBe(0);
        expect(environment.some((entry) => entry.startsWith("HOME="))).toBe(false);
    });
});
