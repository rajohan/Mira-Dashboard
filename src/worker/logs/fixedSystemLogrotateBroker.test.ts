import { describe, expect, test } from "bun:test";

import type { FixedSystemLogrotateProcess } from "./fixedSystemLogrotateBroker.ts";
import {
    createFixedSystemLogrotateBroker,
    fixedSystemLogrotateUnits,
} from "./fixedSystemLogrotateBroker.ts";

const encoder = new TextEncoder();

describe("fixed system logrotate broker", () => {
    test("queries and starts only the four exact host units without a shell", async () => {
        const calls: { arguments_: readonly string[]; executable: string }[] = [];
        const process: FixedSystemLogrotateProcess = (executable, arguments_) => {
            calls.push({ arguments_, executable });
            return Promise.resolve({
                exitCode: 0,
                stderr: new Uint8Array(),
                stdout:
                    arguments_[0] === "show"
                        ? encoder.encode("loaded\n")
                        : new Uint8Array(),
            });
        };
        const broker = createFixedSystemLogrotateBroker({ process });
        expect(await broker.availablePolicies()).toEqual(
            Object.keys(fixedSystemLogrotateUnits)
        );
        await broker.run("host-rsyslog");
        expect(calls.at(-1)).toEqual({
            arguments_: [
                "start",
                "--wait",
                "mira-dashboard-log-maintenance@host-rsyslog.service",
            ],
            executable: "/usr/bin/systemctl",
        });
    });

    test("does not expose the custom docker policy to system logrotate", () => {
        expect(fixedSystemLogrotateUnits).not.toHaveProperty("docker-managed");
    });

    test("fails with a constant error and retains no process output", async () => {
        const broker = createFixedSystemLogrotateBroker({
            process: () =>
                Promise.resolve({
                    exitCode: 1,
                    stderr: encoder.encode("private host failure /var/log/auth.log"),
                    stdout: new Uint8Array(),
                }),
        });
        try {
            await broker.run("host-rsyslog");
            throw new Error("Expected broker failure");
        } catch (error) {
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toBe("Fixed system logrotate broker failed");
            expect(JSON.stringify(error)).not.toContain("/var/log/auth.log");
        }
    });

    test("rejects non-absolute process boundaries before invocation", () => {
        expect(() =>
            createFixedSystemLogrotateBroker({ systemctlExecutable: "systemctl" })
        ).toThrow("Fixed system logrotate broker failed");
    });
});
