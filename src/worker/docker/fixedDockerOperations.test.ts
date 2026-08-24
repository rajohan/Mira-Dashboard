import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    dockerOverviewCachePayloadSchema,
    type DockerOverviewCachePayload,
} from "../../contracts/docker.ts";
import { utf8ByteLength } from "../../shared/encoding.ts";
import { redactDockerLogLine } from "./dockerLogRedaction.ts";
import {
    createFixedDockerOperations,
    type FixedDockerOperationPayload,
    type FixedDockerOperationsError,
    type FixedDockerProcess,
    type FixedDockerProcessRequest,
    type FixedDockerProcessResult,
} from "./fixedDockerOperations.ts";
import type { DockerOverviewCollector } from "./overviewCollector.ts";

const sourceRevision = "a".repeat(64);
const changedSourceRevision = "b".repeat(64);
const containerId = "1".repeat(64);
const missingContainerId = "9".repeat(64);
const usedImageId = `sha256:${"1".repeat(64)}`;
const unusedImageId = `sha256:${"2".repeat(64)}`;
const secondUnusedImageId = `sha256:${"3".repeat(64)}`;
const missingImageId = `sha256:${"9".repeat(64)}`;

function snapshot(
    overrides: Partial<DockerOverviewCachePayload> = {}
): DockerOverviewCachePayload {
    return v.parse(dockerOverviewCachePayloadSchema, {
        containers: [
            {
                createdAtMs: 1_700_000_000_000,
                health: "healthy",
                id: containerId,
                image: "ghcr.io/example/app:1.0.0",
                imageId: usedImageId,
                mounts: [],
                name: "example-app-1",
                networks: [],
                ports: [],
                project: "example",
                restartCount: 0,
                service: "app",
                startedAtMs: 1_700_000_001_000,
                state: "running",
            },
        ],
        images: [
            {
                createdAtMs: 1_699_999_000_000,
                id: usedImageId,
                references: ["ghcr.io/example/app:1.0.0"],
                sizeBytes: 100,
                usedByContainerIds: [containerId],
            },
            {
                createdAtMs: 1_699_998_000_000,
                id: unusedImageId,
                references: [],
                sizeBytes: 20,
                usedByContainerIds: [],
            },
            {
                createdAtMs: 1_699_997_000_000,
                id: secondUnusedImageId,
                references: ["ghcr.io/example/old:0.9.0"],
                sizeBytes: 30,
                usedByContainerIds: [],
            },
        ],
        observedAtMs: 1_700_000_002_000,
        sourceRevision,
        updaterEvents: [],
        updaterServices: [],
        volumes: [
            {
                driver: "local",
                name: "cache-data",
                scope: "local",
                sizeBytes: 40,
                usedByContainerIds: [],
            },
            {
                driver: "local",
                name: "database-data",
                scope: "local",
                sizeBytes: 80,
                usedByContainerIds: [containerId],
            },
        ],
        ...overrides,
    });
}

function overviewHarness(
    snapshots: readonly DockerOverviewCachePayload[] = [snapshot()]
): DockerOverviewCollector & { readonly calls: number } {
    let calls = 0;
    const next = (signal?: AbortSignal): Promise<DockerOverviewCachePayload> => {
        signal?.throwIfAborted();
        const value = snapshots[Math.min(calls, snapshots.length - 1)];
        calls += 1;
        if (value === undefined) throw new Error("private overview failure");
        return Promise.resolve(value);
    };
    return {
        get calls() {
            return calls;
        },
        collect(_previous?: unknown, signal?: AbortSignal) {
            return next(signal);
        },
        async discover(_previous?: unknown, signal?: AbortSignal) {
            return {
                compose: {
                    composeFiles: [],
                    services: [],
                    sourceRevision: "b".repeat(64),
                },
                payload: await next(signal),
            };
        },
    };
}

function bytes(value = ""): Uint8Array {
    return new TextEncoder().encode(value);
}

function successfulResult(
    overrides: Partial<FixedDockerProcessResult> = {}
): FixedDockerProcessResult {
    return {
        exitCode: 0,
        stderr: bytes(),
        stderrTruncated: false,
        stdout: bytes(),
        stdoutTruncated: false,
        ...overrides,
    };
}

type ProcessOutcome =
    | FixedDockerProcessResult
    | ((request: FixedDockerProcessRequest) => FixedDockerProcessResult)
    | Error;

function processHarness(outcomes: readonly ProcessOutcome[] = []) {
    const calls: FixedDockerProcessRequest[] = [];
    const process: FixedDockerProcess = (request) => {
        calls.push(request);
        const outcome = outcomes[calls.length - 1] ?? successfulResult();
        if (outcome instanceof Error) return Promise.reject(outcome);
        return Promise.resolve(
            typeof outcome === "function" ? outcome(request) : outcome
        );
    };
    return { calls, process };
}

async function captureFailure(operation: Promise<unknown>): Promise<unknown> {
    try {
        await operation;
    } catch (error) {
        return error;
    }
    throw new Error("Expected operation to fail");
}

function expectReason(
    error: unknown,
    reason: FixedDockerOperationsError["reason"]
): void {
    expect(error).toMatchObject({
        message: "Docker worker operation failed",
        name: "FixedDockerOperationsError",
        reason,
    });
}

describe("fixed Docker worker operations", () => {
    test("reads only an exact source-fenced container and returns bounded redacted logs", async () => {
        const rawSecret = "private-password";
        const bearerSecret = "abc.def.ghi";
        const { calls, process } = processHarness([
            successfulResult({
                stderr: bytes(
                    `2026-08-13T12:00:01.000000000Z Authorization: Bearer ${bearerSecret}\n`
                ),
                stdout: bytes(
                    [
                        `2026-08-13T12:00:02.000000000Z password=${rawSecret}`,
                        "2026-08-13T12:00:03.000000000Z \u001B[31mordinary output",
                        "",
                    ].join("\n")
                ),
            }),
        ]);
        const operations = createFixedDockerOperations({
            nowMs: () => 1_700_000_003_000,
            overview: overviewHarness(),
            process,
        });

        const result = await operations.readContainerLogs({
            containerId,
            sourceRevision,
            tail: 3,
        });

        expect(result).toEqual({
            containerId,
            lines: [
                "2026-08-13T12:00:01.000000000Z Authorization: [REDACTED]",
                "2026-08-13T12:00:02.000000000Z password=[REDACTED]",
                "2026-08-13T12:00:03.000000000Z �[31mordinary output",
            ],
            observedAtMs: 1_700_000_003_000,
            redacted: true,
            sourceRevision,
            truncated: false,
        });
        expect(JSON.stringify(result)).not.toContain(rawSecret);
        expect(JSON.stringify(result)).not.toContain(bearerSecret);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            arguments: [
                "--host",
                "unix:///var/run/docker.sock",
                "logs",
                "--tail",
                "3",
                "--timestamps",
                containerId,
            ],
            cwd: "/",
            environment: {
                DOCKER_CONFIG: "/nonexistent/mira-dashboard-docker-config",
                DOCKER_HOST: "unix:///var/run/docker.sock",
                HOME: "/nonexistent",
                LANG: "C",
                LC_ALL: "C",
                PATH: "/usr/bin:/bin",
            },
            executable: "/usr/bin/docker",
            stderrMaximumBytes: 256 * 1024,
            stdoutMaximumBytes: 256 * 1024,
        });
        expect(calls[0]!.arguments).not.toContain("sh");
        expect(calls[0]!.arguments).not.toContain("-c");
    });

    test("marks a tail-window cut and drops its partial first physical line", async () => {
        const { process } = processHarness([
            successfulResult({
                stdout: bytes(
                    "partial-private-fragment\n2026-08-13T12:00:03.000000000Z safe\n"
                ),
                stdoutTruncated: true,
            }),
        ]);
        const result = await createFixedDockerOperations({
            nowMs: () => 1_700_000_003_000,
            overview: overviewHarness(),
            process,
        }).readContainerLogs({ containerId, sourceRevision, tail: 10 });

        expect(result.lines).toEqual(["2026-08-13T12:00:03.000000000Z safe"]);
        expect(result.truncated).toBe(true);
        expect(JSON.stringify(result)).not.toContain("partial-private-fragment");
    });

    test("fails closed before logs when the source changed or target disappeared", async () => {
        for (const [input, expectedReason] of [
            [{ containerId, sourceRevision: changedSourceRevision, tail: 2 }, "conflict"],
            [{ containerId: missingContainerId, sourceRevision, tail: 2 }, "not-found"],
        ] as const) {
            const harness = processHarness();
            const failure = await captureFailure(
                createFixedDockerOperations({
                    overview: overviewHarness(),
                    process: harness.process,
                }).readContainerLogs(input)
            );
            expectReason(failure, expectedReason);
            expect(harness.calls).toHaveLength(0);
        }
    });

    test("projects exact unused image and volume candidates without invoking Docker", async () => {
        const harness = processHarness();
        const operations = createFixedDockerOperations({
            overview: overviewHarness(),
            process: harness.process,
        });

        expect(
            await operations.previewPrune({ sourceRevision, target: "images" })
        ).toEqual({
            estimatedReclaimableBytes: 50,
            items: [
                { id: unusedImageId, references: [], sizeBytes: 20 },
                {
                    id: secondUnusedImageId,
                    references: ["ghcr.io/example/old:0.9.0"],
                    sizeBytes: 30,
                },
            ],
            sourceRevision,
            target: "images",
        });
        expect(
            await operations.previewPrune({ sourceRevision, target: "volumes" })
        ).toEqual({
            estimatedReclaimableBytes: 40,
            items: [{ name: "cache-data", sizeBytes: 40 }],
            sourceRevision,
            target: "volumes",
        });
        expect(harness.calls).toHaveLength(0);
    });

    test("executes only exact full-id container operations through the fixed socket", async () => {
        const harness = processHarness();
        const operations = createFixedDockerOperations({
            overview: overviewHarness(),
            process: harness.process,
        });

        for (const operation of [
            "container-restart",
            "container-start",
            "container-stop",
        ] as const) {
            expect(
                await operations.execute({ containerId, operation, sourceRevision })
            ).toEqual({ operation, status: "completed", targetCount: 1 });
        }

        expect(harness.calls.map(({ arguments: arguments_ }) => arguments_)).toEqual([
            [
                "--host",
                "unix:///var/run/docker.sock",
                "container",
                "restart",
                containerId,
            ],
            ["--host", "unix:///var/run/docker.sock", "container", "start", containerId],
            ["--host", "unix:///var/run/docker.sock", "container", "stop", containerId],
        ]);
    });

    test("revalidates exact unused image and volume targets before non-forced deletion", async () => {
        const harness = processHarness();
        const operations = createFixedDockerOperations({
            overview: overviewHarness(),
            process: harness.process,
        });

        expect(
            await operations.execute({
                imageId: unusedImageId,
                operation: "image-delete",
                sourceRevision,
            })
        ).toEqual({
            operation: "image-delete",
            status: "completed",
            targetCount: 1,
        });
        expect(
            await operations.execute({
                operation: "volume-delete",
                sourceRevision,
                volumeName: "cache-data",
            })
        ).toEqual({
            operation: "volume-delete",
            status: "completed",
            targetCount: 1,
        });

        expect(harness.calls.map(({ arguments: arguments_ }) => arguments_)).toEqual([
            ["--host", "unix:///var/run/docker.sock", "image", "rm", unusedImageId],
            ["--host", "unix:///var/run/docker.sock", "volume", "rm", "cache-data"],
        ]);
        expect(
            harness.calls.flatMap(({ arguments: arguments_ }) => arguments_)
        ).not.toContain("--force");
    });

    test("removes every exact reference for an unused multi-tagged image", async () => {
        const multiTaggedReferences = [
            "ghcr.io/example/old:0.9.0",
            "ghcr.io/example/old:stable",
        ];
        const overview = snapshot({
            images: snapshot().images.map((image) =>
                image.id === secondUnusedImageId
                    ? { ...image, references: multiTaggedReferences }
                    : image
            ),
        });
        const harness = processHarness();
        const operations = createFixedDockerOperations({
            overview: overviewHarness([overview]),
            process: harness.process,
        });

        expect(
            await operations.execute({
                imageId: secondUnusedImageId,
                operation: "image-delete",
                sourceRevision,
            })
        ).toEqual({
            operation: "image-delete",
            status: "completed",
            targetCount: 1,
        });
        expect(
            await operations.execute({
                imageIds: [secondUnusedImageId],
                operation: "prune-execute",
                sourceRevision,
                target: "images",
            })
        ).toEqual({
            operation: "prune-execute",
            status: "completed",
            targetCount: 1,
        });

        expect(harness.calls.map(({ arguments: arguments_ }) => arguments_)).toEqual([
            [
                "--host",
                "unix:///var/run/docker.sock",
                "image",
                "rm",
                ...multiTaggedReferences,
            ],
            [
                "--host",
                "unix:///var/run/docker.sock",
                "image",
                "rm",
                ...multiTaggedReferences,
            ],
        ]);
        for (const call of harness.calls) {
            expect(call.arguments).not.toContain(secondUnusedImageId);
            expect(call.arguments).not.toContain("--force");
        }
    });

    test("rejects in-use and missing storage without dispatching a mutation", async () => {
        for (const [payload, expectedReason] of [
            [
                { imageId: usedImageId, operation: "image-delete", sourceRevision },
                "conflict",
            ],
            [
                { imageId: missingImageId, operation: "image-delete", sourceRevision },
                "not-found",
            ],
            [
                {
                    operation: "volume-delete",
                    sourceRevision,
                    volumeName: "database-data",
                },
                "conflict",
            ],
            [
                {
                    operation: "volume-delete",
                    sourceRevision,
                    volumeName: "missing-data",
                },
                "not-found",
            ],
        ] as const) {
            const harness = processHarness();
            const failure = await captureFailure(
                createFixedDockerOperations({
                    overview: overviewHarness(),
                    process: harness.process,
                }).execute(payload)
            );
            expectReason(failure, expectedReason);
            expect(harness.calls).toHaveLength(0);
        }
    });

    test("prunes only the exact canonical candidates carried by the durable payload", async () => {
        const harness = processHarness();
        const operations = createFixedDockerOperations({
            overview: overviewHarness(),
            process: harness.process,
        });

        expect(
            await operations.execute({
                imageIds: [unusedImageId, secondUnusedImageId],
                operation: "prune-execute",
                sourceRevision,
                target: "images",
            })
        ).toEqual({
            operation: "prune-execute",
            status: "completed",
            targetCount: 2,
        });
        expect(
            await operations.execute({
                operation: "prune-execute",
                sourceRevision,
                target: "volumes",
                volumeNames: ["cache-data"],
            })
        ).toEqual({
            operation: "prune-execute",
            status: "completed",
            targetCount: 1,
        });

        expect(harness.calls.map(({ arguments: arguments_ }) => arguments_)).toEqual([
            [
                "--host",
                "unix:///var/run/docker.sock",
                "image",
                "rm",
                unusedImageId,
                secondUnusedImageId,
            ],
            ["--host", "unix:///var/run/docker.sock", "volume", "rm", "cache-data"],
        ]);
        for (const call of harness.calls) {
            expect(call.arguments).not.toContain("prune");
            expect(call.arguments).not.toContain("-a");
            expect(call.arguments).not.toContain("-f");
        }
    });

    test("batches large image prunes and reports unknown outcome after partial execution", async () => {
        const longRepository = ["x".repeat(100), "y".repeat(100), "z".repeat(100)].join(
            "/"
        );
        const bulkImages = ["4", "5"].map((digit, imageIndex) => ({
            createdAtMs: 1_699_996_000_000 - imageIndex,
            id: `sha256:${digit.repeat(64)}`,
            references: Array.from(
                { length: 64 },
                (_, referenceIndex) =>
                    `ghcr.io/${longRepository}/bulk-${imageIndex}:${String(referenceIndex).padStart(2, "0")}`
            ),
            sizeBytes: 10,
            usedByContainerIds: [],
        }));
        const overview = snapshot({
            images: [...snapshot().images, ...bulkImages],
        });
        const harness = processHarness([
            successfulResult(),
            new Error("private second-batch failure"),
        ]);
        const failure = await captureFailure(
            createFixedDockerOperations({
                overview: overviewHarness([overview]),
                process: harness.process,
            }).execute({
                imageIds: bulkImages.map(({ id }) => id),
                operation: "prune-execute",
                sourceRevision,
                target: "images",
            })
        );

        expectReason(failure, "unknown-outcome");
        expect(harness.calls).toHaveLength(2);
        expect(harness.calls[0]!.arguments.length).toBeLessThan(132);
        for (const call of harness.calls) {
            expect(
                ["/usr/bin/docker", ...call.arguments].reduce(
                    (bytes, argument) => bytes + utf8ByteLength(argument) + 1,
                    0
                )
            ).toBeLessThanOrEqual(32 * 1024);
        }
        expect(
            harness.calls.flatMap(({ arguments: arguments_ }) => arguments_.slice(4))
        ).toEqual(bulkImages.flatMap(({ references }) => references));
        expect(
            harness.calls.flatMap(({ arguments: arguments_ }) => arguments_)
        ).not.toContain("--force");
    });

    test("rejects stale, in-use, missing, duplicate, and unsorted prune payloads before dispatch", async () => {
        for (const payload of [
            {
                imageIds: [usedImageId],
                operation: "prune-execute",
                sourceRevision,
                target: "images",
            },
            {
                imageIds: [missingImageId],
                operation: "prune-execute",
                sourceRevision,
                target: "images",
            },
            {
                imageIds: [unusedImageId, unusedImageId],
                operation: "prune-execute",
                sourceRevision,
                target: "images",
            },
            {
                imageIds: [secondUnusedImageId, unusedImageId],
                operation: "prune-execute",
                sourceRevision,
                target: "images",
            },
            {
                imageIds: [],
                operation: "prune-execute",
                sourceRevision: changedSourceRevision,
                target: "images",
            },
        ] as const) {
            const harness = processHarness();
            const failure = await captureFailure(
                createFixedDockerOperations({
                    overview: overviewHarness(),
                    process: harness.process,
                }).execute(payload as unknown as FixedDockerOperationPayload)
            );
            expect(failure).toBeInstanceOf(Error);
            expect(harness.calls).toHaveLength(0);
        }
    });

    test("executes fixed root stack start, stop, and restart without caller paths or services", async () => {
        const harness = processHarness();
        const operations = createFixedDockerOperations({
            overview: overviewHarness(),
            process: harness.process,
        });

        for (const operation of ["stack-start", "stack-stop", "stack-restart"] as const) {
            await operations.execute({ operation, sourceRevision });
        }

        expect(
            harness.calls.map(({ arguments: arguments_, cwd, executable }) => ({
                arguments: arguments_,
                cwd,
                executable,
            }))
        ).toEqual([
            {
                arguments: [
                    "--file",
                    "/opt/docker/compose.yaml",
                    "--project-directory",
                    "/opt/docker",
                    "start",
                ],
                cwd: "/opt/docker",
                executable: "/opt/docker/bin/docker-compose-doppler",
            },
            {
                arguments: [
                    "--file",
                    "/opt/docker/compose.yaml",
                    "--project-directory",
                    "/opt/docker",
                    "stop",
                ],
                cwd: "/opt/docker",
                executable: "/opt/docker/bin/docker-compose-doppler",
            },
            {
                arguments: [
                    "--file",
                    "/opt/docker/compose.yaml",
                    "--project-directory",
                    "/opt/docker",
                    "restart",
                ],
                cwd: "/opt/docker",
                executable: "/opt/docker/bin/docker-compose-doppler",
            },
        ]);
    });

    test("classifies read failures as unavailable and dispatched mutation failures as unknown", async () => {
        const privateFailure = "registry password=private-value";
        const readFailure = await captureFailure(
            createFixedDockerOperations({
                overview: overviewHarness(),
                process: processHarness([
                    successfulResult({
                        exitCode: 1,
                        stderr: bytes(privateFailure),
                    }),
                ]).process,
            }).readContainerLogs({ containerId, sourceRevision, tail: 2 })
        );
        expectReason(readFailure, "unavailable");

        for (const outcome of [
            successfulResult({ exitCode: 1, stderr: bytes(privateFailure) }),
            new Error(privateFailure),
            (request: FixedDockerProcessRequest) =>
                successfulResult({
                    stdout: new Uint8Array(request.stdoutMaximumBytes + 1),
                }),
        ] as const) {
            const failure = await captureFailure(
                createFixedDockerOperations({
                    overview: overviewHarness(),
                    process: processHarness([outcome]).process,
                }).execute({
                    containerId,
                    operation: "container-restart",
                    sourceRevision,
                })
            );
            expectReason(failure, "unknown-outcome");
            expect(JSON.stringify(failure)).not.toContain(privateFailure);
            expect(Bun.inspect(failure)).not.toContain(privateFailure);
            expect((failure as Error).cause).toBeUndefined();
        }
    });

    test("redacts structured secrets, known tokens, malformed suffixes, and controls", () => {
        const privateFragments = [
            "nested-private",
            "quoted-private-suffix",
            "ghp_abcdefghijklmnopqrstuvwxyz",
        ];
        const output = [
            '{"credentials":{"password":"nested-private"},"safe":true}',
            '{"password":"private"quoted-private-suffix,"safe":true}',
            "token=ghp_abcdefghijklmnopqrstuvwxyz",
            "safe\u0000\u001B[31m",
        ].map((line) => redactDockerLogLine(line));

        for (const fragment of privateFragments) {
            expect(output.join("\n")).not.toContain(fragment);
        }
        expect(output[0]).toBe('{"credentials":[REDACTED],"safe":true}');
        expect(output[1]).toBe('{"password":[REDACTED],"safe":true}');
        expect(output[2]).toBe("token=[REDACTED]");
        expect(output[3]).toBe("safe��[31m");
    });
});
