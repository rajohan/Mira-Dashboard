import { describe, expect, test } from "bun:test";

import { createDevelopmentPtyProcess } from "./developmentPtyProcess.ts";

describe("source-development PTY simulator", () => {
    test("preserves the PTY handle protocol without launching or exposing a host shell", async () => {
        const output: string[] = [];
        const handle = createDevelopmentPtyProcess({
            callbacks: {
                onInputDrain() {},
                onOutput(data) {
                    output.push(Buffer.from(data).toString("utf8"));
                    return "accepted";
                },
                onOutputBackpressure() {},
            },
            dimensions: { columns: 120, rows: 40 },
            realpathFencedWorkingDirectory: "/private/production/workspace",
            sessionId: "018f1f46-7b72-7d9a-8c41-a3d83d674812",
        });
        await Promise.resolve();

        const commands = Buffer.from("profile\npwd\nls -la /\n", "utf8");
        expect(handle.writeInput(commands)).toEqual({
            acceptedBytes: commands.byteLength,
            status: "accepted",
        });
        expect(output.join("")).toContain(
            "Mira Dashboard isolated source-development terminal (no host shell)."
        );
        expect(output.join("")).toContain("profile=isolated-simulator authority=none");
        expect(output.join("")).toContain("/workspace");
        expect(output.join("")).toContain("unsupported simulated command: ls -la /");
        expect(output.join("")).not.toContain("/private/production/workspace");

        expect(handle.writeInput(Buffer.from("exit\n", "utf8"))).toEqual({
            acceptedBytes: 5,
            status: "accepted",
        });
        expect(await handle.exited).toEqual({ exitCode: 0, signalCode: null });
        expect(handle.writeInput(Buffer.from("pwd\n", "utf8"))).toEqual({
            acceptedBytes: 0,
            status: "closed",
        });
    });
});
