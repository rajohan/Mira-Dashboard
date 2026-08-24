import { describe, expect, test } from "bun:test";

import drizzleConfiguration from "../drizzle.config.ts";
import {
    assertDrizzleKitOutput,
    checkDatabaseSchema,
    type DrizzleKitCommandResult,
} from "./checkDatabaseSchema.ts";

function commandResult(
    status: string,
    overrides: Partial<DrizzleKitCommandResult> = {}
): DrizzleKitCommandResult {
    return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({ status }),
        ...overrides,
    };
}

describe("database schema gate", () => {
    test("keeps the executable Drizzle root configuration under coverage", () => {
        expect(drizzleConfiguration).toMatchObject({
            breakpoints: true,
            dbCredentials: { url: "./data/drizzle-kit.db" },
            dialect: "sqlite",
            out: "./migrations",
            schema: "./src/server/database/schema/drizzleSchema.ts",
            strict: true,
            verbose: true,
        });
    });

    test("checks history before a non-writing schema drift comparison", () => {
        const commands: string[][] = [];
        const results = [commandResult("ok"), commandResult("no_changes")];

        checkDatabaseSchema((arguments_) => {
            commands.push([...arguments_]);
            const result = results.shift();
            if (!result) throw new Error("Unexpected Drizzle Kit command");
            return result;
        });

        expect(commands).toHaveLength(2);
        expect(commands[0]?.[0]).toBe("check");
        expect(commands[1]?.[0]).toBe("generate");
        expect(commands[1]).toContain("--explain");
    });

    test("rejects a non-zero Drizzle Kit exit", () => {
        expect(() =>
            assertDrizzleKitOutput(
                commandResult("error", { exitCode: 1, stderr: "snapshot failed" }),
                "ok"
            )
        ).toThrow("drizzle-kit exited 1: snapshot failed");
    });

    test("rejects empty, malformed, and non-object JSON", () => {
        for (const stdout of ["", "{", "null", "[]"]) {
            expect(() =>
                assertDrizzleKitOutput(commandResult("ok", { stdout }), "ok")
            ).toThrow(/drizzle-kit returned invalid JSON/u);
        }
    });

    test("rejects a schema drift result even when Drizzle exits zero", () => {
        const results = [
            commandResult("ok"),
            commandResult("ok", {
                stdout: JSON.stringify({
                    statements: [{ type: "add_column" }],
                    status: "ok",
                }),
            }),
        ];

        expect(() =>
            checkDatabaseSchema(() => {
                const result = results.shift();
                if (!result) throw new Error("Unexpected Drizzle Kit command");
                return result;
            })
        ).toThrow("drizzle-kit returned status ok; expected no_changes");
    });
});
