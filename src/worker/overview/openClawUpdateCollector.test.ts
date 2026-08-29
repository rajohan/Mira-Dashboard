import { describe, expect, test } from "bun:test";

import {
    collectOpenClawUpdateStatus,
    createOpenClawUpdateProcessAdapter,
} from "./openClawUpdateCollector.ts";

function processOutput(output: string, exitCode = 0) {
    return {
        exited: Promise.resolve(exitCode),
        stdout: new Blob([output]).stream(),
    };
}

describe("OpenClaw update collector", () => {
    test("projects bounded version fields from fixed commands", async () => {
        const calls: string[][] = [];
        const result = await collectOpenClawUpdateStatus(undefined, {
            adapter: {
                run: (arguments_) => {
                    calls.push([...arguments_]);
                    return Promise.resolve(
                        arguments_[0] === "--version"
                            ? "OpenClaw 2026.8.1-beta.2 (8f382a2)"
                            : JSON.stringify({
                                  availability: {
                                      available: true,
                                      latestVersion: "2026.8.1-beta.3",
                                  },
                                  channel: { value: "beta" },
                                  privateProviderShape: "discarded",
                              })
                    );
                },
            },
            openClawRoot: "/srv/openclaw",
        });
        expect(calls).toEqual([["--version"], ["update", "status", "--json"]]);
        expect(result).toEqual({
            available: true,
            channel: "beta",
            installedVersion: "2026.8.1-beta.2",
            latestVersion: "2026.8.1-beta.3",
            state: "observed",
        });
    });

    test("uses the installed version when current OpenClaw reports no update", async () => {
        const result = await collectOpenClawUpdateStatus(undefined, {
            adapter: {
                run: (arguments_) =>
                    Promise.resolve(
                        arguments_[0] === "--version"
                            ? "OpenClaw 2026.9.1-beta.1"
                            : JSON.stringify({
                                  availability: {
                                      available: false,
                                      latestVersion: null,
                                  },
                                  channel: { value: "beta" },
                              })
                    ),
            },
            openClawRoot: "/srv/openclaw",
        });

        expect(result).toEqual({
            available: false,
            channel: "beta",
            installedVersion: "2026.9.1-beta.1",
            latestVersion: "2026.9.1-beta.1",
            state: "observed",
        });
    });

    test("runs the reviewed executable with only the fixed environment", async () => {
        const calls: Array<{
            readonly command: readonly string[];
            readonly options: Readonly<Record<string, unknown>>;
        }> = [];
        const signal = new AbortController().signal;
        const adapter = createOpenClawUpdateProcessAdapter({
            homeDirectory: "/home/dashboard",
            openClawRoot: "/srv/openclaw",
            spawn: (command, options) => {
                calls.push({ command, options });
                return processOutput("  OpenClaw 2026.8.1-beta.2  \n");
            },
        });

        expect(await adapter.run(["--version"], signal)).toBe("OpenClaw 2026.8.1-beta.2");
        expect(calls).toEqual([
            {
                command: ["/home/dashboard/.local/bin/openclaw", "--version"],
                options: {
                    env: {
                        HOME: "/home/dashboard",
                        LANG: "C",
                        LC_ALL: "C",
                        OPENCLAW_STATE_DIR: "/srv/openclaw",
                        PATH: "/usr/local/bin:/usr/bin:/bin",
                    },
                    signal,
                    stderr: "ignore",
                    stdin: "ignore",
                    stdout: "pipe",
                },
            },
        ]);
    });

    test("rejects failed commands and oversized output", async () => {
        const failed = createOpenClawUpdateProcessAdapter({
            homeDirectory: "/home/dashboard",
            openClawRoot: "/srv/openclaw",
            spawn: () => processOutput("failure", 1),
        });
        const failedError = await failed
            .run(["--version"])
            .catch((error: unknown) => error);
        expect(failedError).toBeInstanceOf(Error);
        expect((failedError as Error).message).toBe("OpenClaw command failed");

        const oversized = createOpenClawUpdateProcessAdapter({
            homeDirectory: "/home/dashboard",
            openClawRoot: "/srv/openclaw",
            spawn: () => processOutput("x".repeat(16 * 1024 + 1)),
        });
        const oversizedError = await oversized
            .run(["--version"])
            .catch((error: unknown) => error);
        expect(oversizedError).toBeInstanceOf(Error);
        expect((oversizedError as Error).message).toBe("OpenClaw output is too large");
    });

    test("rejects relative and filesystem-root runtime directories", () => {
        for (const options of [
            { homeDirectory: "/", openClawRoot: "/srv/openclaw" },
            { homeDirectory: "/home/dashboard", openClawRoot: "relative" },
        ]) {
            expect(() => createOpenClawUpdateProcessAdapter(options)).toThrow(
                "OpenClaw update collector configuration is invalid"
            );
        }
    });
});
