import { describe, expect, test } from "bun:test";

import { executeSystemctlProcess } from "./systemctlProcess.ts";

describe("systemctl process boundary", () => {
    test("does not forward ambient HOME to the user manager command", async () => {
        const result = await executeSystemctlProcess("/usr/bin/env", []);
        const environment = new TextDecoder().decode(result.stdout).split("\n");

        expect(result.exitCode).toBe(0);
        expect(environment.some((entry) => entry.startsWith("HOME="))).toBe(false);
    });

    test("rejects caller deadlines outside the bounded process policy", async () => {
        try {
            await executeSystemctlProcess("/usr/bin/true", [], { deadlineMs: 0 });
            throw new Error("Expected bounded deadline rejection");
        } catch (error) {
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toBe("Systemctl process failed");
        }
    });
});
