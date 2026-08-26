import { describe, expect, test } from "bun:test";

import { Redacted } from "effect";

import {
    createDockerPgBouncerAdminCollector,
    readBoundedPgBouncerOutput,
    type PgBouncerAdminProcess,
} from "./dockerPgBouncerAdminCollector.ts";

const encoder = new TextEncoder();
const resolved = Object.freeze({
    connection: Object.freeze({
        controlDatabase: "postgres",
        hostname: "127.0.0.1",
        password: Redacted.make("private-password"),
        port: 6432,
    }),
    source: Object.freeze({ containerId: "a".repeat(64), containerPort: 7543 }),
});

describe("Docker PgBouncer admin collector", () => {
    test("combines process output chunks within the fixed memory bound", async () => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode("first"));
                controller.enqueue(encoder.encode("-second"));
                controller.close();
            },
        });

        const output = await readBoundedPgBouncerOutput(stream);

        expect(new TextDecoder().decode(output)).toBe("first-second");
    });

    test("rejects process output beyond the fixed memory bound", async () => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array(512 * 1024 + 1));
                controller.close();
            },
        });

        const output = readBoundedPgBouncerOutput(stream);
        expect(output).rejects.toThrow("PgBouncer output failed");
        await output.catch(() => {});
    });

    test("uses the resolved container and keeps the password out of arguments", async () => {
        const calls: { arguments_: readonly string[]; stdin: Uint8Array }[] = [];
        const process: PgBouncerAdminProcess = (arguments_, stdin) => {
            calls.push({ arguments_, stdin });
            const command = arguments_.at(-1);
            const stdout =
                command === "SHOW POOLS"
                    ? 'database,user,cl_active\n"app,a",observer,2\n'
                    : 'database,total_query_count,avg_query_time\n"app,a",4,12.5\n';
            return Promise.resolve({
                exitCode: 0,
                stderr: encoder.encode(""),
                stdout: encoder.encode(stdout),
            });
        };

        const result = await createDockerPgBouncerAdminCollector(process).collect(
            resolved,
            new AbortController().signal
        );

        expect(result).toEqual({
            pools: [{ cl_active: "2", database: "app,a", user: "observer" }],
            stats: [
                {
                    avg_query_time: "12.5",
                    database: "app,a",
                    total_query_count: "4",
                },
            ],
        });
        expect(calls).toHaveLength(2);
        for (const call of calls) {
            expect(call.arguments_).toContain(resolved.source.containerId);
            expect(call.arguments_).toContain("7543");
            expect(JSON.stringify(call.arguments_)).not.toContain("private-password");
            expect(JSON.stringify(call.arguments_)).not.toContain("--tuples-only");
            expect(new TextDecoder().decode(call.stdin)).toBe("private-password\n");
        }
    });

    test("parses escaped quotes and empty result sets", async () => {
        const process: PgBouncerAdminProcess = (arguments_) =>
            Promise.resolve({
                exitCode: 0,
                stderr: encoder.encode(""),
                stdout: encoder.encode(
                    arguments_.at(-1) === "SHOW POOLS"
                        ? 'database,user\n"app""quoted",observer\n'
                        : ""
                ),
            });

        const collection = createDockerPgBouncerAdminCollector(process).collect(
            resolved,
            new AbortController().signal
        );
        expect(collection).resolves.toEqual({
            pools: [{ database: 'app"quoted', user: "observer" }],
            stats: [],
        });
        await collection;
    });

    test("fails closed for process and CSV failures", async () => {
        const failedProcess: PgBouncerAdminProcess = () =>
            Promise.resolve({
                exitCode: 1,
                stderr: encoder.encode("private failure"),
                stdout: encoder.encode("private output"),
            });
        const failedCollection = createDockerPgBouncerAdminCollector(
            failedProcess
        ).collect(resolved, new AbortController().signal);
        expect(failedCollection).rejects.toThrow("PgBouncer collection failed");
        await failedCollection.catch(() => {});

        const malformedProcess: PgBouncerAdminProcess = () =>
            Promise.resolve({
                exitCode: 0,
                stderr: encoder.encode(""),
                stdout: encoder.encode("database,database\napp,app\n"),
            });
        const malformedCollection = createDockerPgBouncerAdminCollector(
            malformedProcess
        ).collect(resolved, new AbortController().signal);
        expect(malformedCollection).rejects.toThrow("PgBouncer CSV failed");
        await malformedCollection.catch(() => {});
    });

    test("aborts and awaits the sibling process when either admin query fails", async () => {
        let siblingSettled = false;
        const process: PgBouncerAdminProcess = (arguments_, _stdin, signal) => {
            if (arguments_.at(-1) === "SHOW POOLS") {
                return Promise.reject(new Error("first query failed"));
            }
            return new Promise((resolve) => {
                signal.addEventListener(
                    "abort",
                    () => {
                        siblingSettled = true;
                        resolve({
                            exitCode: 1,
                            stderr: encoder.encode(""),
                            stdout: encoder.encode(""),
                        });
                    },
                    { once: true }
                );
            });
        };

        const collection = createDockerPgBouncerAdminCollector(process).collect(
            resolved,
            new AbortController().signal
        );
        expect(collection).rejects.toThrow("first query failed");
        await collection.catch(() => {});
        expect(siblingSettled).toBe(true);
    });
});
