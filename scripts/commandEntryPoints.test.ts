import { describe, expect, test } from "bun:test";

import { runBootstrap } from "./bootstrap.ts";
import { parseBuildCommandArguments } from "./buildCommand.ts";
import { parseCheckCommandArguments } from "./checkCommand.ts";
import { parseDeliveryCommandArguments } from "./deliveryCommand.ts";
import { parseDevelopmentCommandArguments } from "./developmentCommand.ts";
import { parseGenerateCommandArguments } from "./generateCommand.ts";
import {
    productionPreflightCommands,
    runProductionPreflight,
} from "./productionPreflight.ts";
import { parseStorybookCommandArguments } from "./storybookCommand.ts";
import { parseTestCommandArguments } from "./testCommand.ts";

describe("repository command entrypoints", () => {
    test("maps development subcommands onto the existing narrow runtimes", () => {
        expect(parseDevelopmentCommandArguments([]).slice(1)).toEqual([
            "scripts/developmentStack.ts",
        ]);
        expect(parseDevelopmentCommandArguments(["reset-state"]).slice(1)).toEqual([
            "scripts/developmentStack.ts",
            "--reset-state",
        ]);
        expect(parseDevelopmentCommandArguments(["remote", "status"]).slice(1)).toEqual([
            "scripts/development/developmentTailscale.ts",
            "status",
        ]);
        expect(() => parseDevelopmentCommandArguments(["remote", "remove"])).toThrow(
            "Usage: bun run dev"
        );
        expect(
            parseDevelopmentCommandArguments(["doppler", "remote", "status"]).slice(-3)
        ).toEqual(["scripts/developmentCommand.ts", "remote", "status"]);
    });

    test("keeps checks, tests, and delivery operations explicit", () => {
        expect(parseCheckCommandArguments([])).toEqual({ command: "all", fix: false });
        expect(parseCheckCommandArguments(["lint", "--fix"])).toEqual({
            command: "lint",
            fix: true,
        });
        expect(() => parseCheckCommandArguments(["typecheck", "--fix"])).toThrow();
        expect(parseTestCommandArguments(["coverage", "storybook"])).toEqual({
            command: "coverage",
            partition: "storybook",
        });
        expect(parseTestCommandArguments(["timings", "browser"])).toEqual({
            command: "timings",
            partition: "browser",
        });
        expect(
            parseDeliveryCommandArguments([
                "prepare-state",
                "--project-root=/srv/app",
            ]).slice(1)
        ).toEqual([
            "scripts/delivery/prepareProductionState.ts",
            "--project-root=/srv/app",
        ]);
        expect(() => parseDeliveryCommandArguments(["install-root"])).toThrow(
            "Usage: bun run delivery"
        );
        expect(parseBuildCommandArguments(["release"]).slice(1)).toEqual([
            "scripts/delivery/buildRelease.ts",
        ]);
        expect(parseGenerateCommandArguments(["docs"]).slice(1)).toEqual([
            "scripts/generateDocs.ts",
        ]);
        expect(parseStorybookCommandArguments(["build"])).toContain("build");
        expect(
            parseStorybookCommandArguments(["dev"], {
                MIRA_DASHBOARD_STORYBOOK_HOST: "127.0.0.1",
                MIRA_DASHBOARD_STORYBOOK_PORT: "6007",
            })
        ).toContain("6007");
        expect(() =>
            parseStorybookCommandArguments(["dev"], {
                MIRA_DASHBOARD_STORYBOOK_HOST: "--listen-everywhere",
            })
        ).toThrow();
    });

    test("bootstraps in a deterministic order and starts only when requested", async () => {
        const calls: Array<readonly string[]> = [];
        const dependencies = {
            readRuntimeVersion: () => Promise.resolve("1.4.0"),
            runtimeVersion: "1.4.0",
            run: (arguments_: readonly string[]) => {
                calls.push(arguments_);
                return Promise.resolve(0);
            },
        };
        expect(await runBootstrap(["--no-start"], "/source", dependencies)).toBe(0);
        expect(calls.map((call) => call.slice(1))).toEqual([
            ["install", "--frozen-lockfile"],
            ["scripts/installGitHooks.ts"],
            ["scripts/generateDocs.ts", "--check"],
            ["scripts/checkDatabaseSchema.ts"],
            ["scripts/developmentStack.ts", "--prepare-state"],
        ]);
        calls.length = 0;
        expect(await runBootstrap([], "/source", dependencies)).toBe(0);
        expect(calls.at(-1)?.slice(1)).toEqual(["scripts/developmentStack.ts"]);
        calls.length = 0;
        expect(await runBootstrap(["--doppler"], "/source", dependencies)).toBe(0);
        expect(calls.at(-1)?.slice(1)).toEqual([
            "scripts/developmentCommand.ts",
            "doppler",
        ]);
    });

    test("fails before installation on a mismatched runtime", () => {
        expect(
            runBootstrap(["--no-start"], "/source", {
                readRuntimeVersion: () => Promise.resolve("1.4.0"),
                runtimeVersion: "1.3.9",
                run: () => Promise.resolve(0),
            })
        ).rejects.toThrow("requires Bun 1.4.0");
    });

    test("runs the unchanged production preflight sequentially and stops on failure", async () => {
        const calls: Array<readonly string[]> = [];
        expect(
            await runProductionPreflight([], "/source", (command) => {
                calls.push(command);
                return Promise.resolve(calls.length === 3 ? 9 : 0);
            })
        ).toBe(9);
        expect(calls).toEqual(productionPreflightCommands.slice(0, 3));
    });

    test("keeps the public package surface bounded", async () => {
        const packageJson: unknown = JSON.parse(
            await Bun.file(new URL("../package.json", import.meta.url)).text()
        );
        if (
            typeof packageJson !== "object" ||
            packageJson === null ||
            !("scripts" in packageJson) ||
            typeof packageJson.scripts !== "object" ||
            packageJson.scripts === null
        ) {
            throw new TypeError("Package scripts are missing");
        }
        expect(Object.keys(packageJson.scripts)).toEqual([
            "bootstrap",
            "dev",
            "auth:reset-password",
            "check",
            "build",
            "generate",
            "delivery",
            "preflight",
            "storybook",
            "test",
        ]);
    });
});
