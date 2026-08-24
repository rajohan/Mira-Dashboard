import { describe, expect, test } from "bun:test";

import { Redacted } from "effect";

import { databaseObservabilityPgBouncerControlAlias } from "../../shared/databaseObservabilityPolicy.ts";
import {
    createDockerDatabaseObservabilityConnectionResolver,
    databaseObservabilityDockerCapabilityLabel,
    databaseObservabilityDockerCapabilityValue,
    databaseObservabilityDockerContainerMaximum,
    databaseObservabilityDockerInspectFormat,
    type DockerDatabaseObservabilityProcess,
} from "./dockerDatabaseObservabilityEndpointResolver.ts";

const passwordValue = "private-password";
const credentials = Object.freeze({
    password: Object.freeze(
        Redacted.make(passwordValue, {
            label: "database-observability-password",
        })
    ),
});

type InspectRow = Record<string, unknown>;

function containerId(index: number): string {
    return index.toString(16).padStart(64, "0");
}

function inspectRow(
    index: number,
    overrides: {
        readonly bindings?: unknown;
        readonly capability?: string;
        readonly containerName?: string;
        readonly health?: string;
        readonly hostPort?: string;
        readonly project?: string;
        readonly running?: boolean;
        readonly service?: string;
    } = {}
): InspectRow {
    const running = overrides.running ?? true;
    const bindings = Object.hasOwn(overrides, "bindings")
        ? overrides.bindings
        : [
              {
                  HostIp: "127.0.0.1",
                  HostPort: overrides.hostPort ?? "6432",
              },
          ];
    return {
        Config: {
            Labels: {
                "com.docker.compose.project": overrides.project ?? "docker",
                "com.docker.compose.service": overrides.service ?? "pool",
                [databaseObservabilityDockerCapabilityLabel]:
                    overrides.capability ?? databaseObservabilityDockerCapabilityValue,
            },
        },
        Id: containerId(index),
        Name: overrides.containerName ?? "/pool-1",
        NetworkSettings: {
            Ports: {
                "5432/tcp": bindings,
                "6432/tcp": null,
            },
        },
        State: {
            Health: { Status: overrides.health ?? "healthy" },
            Running: running,
            Status: running ? "running" : "exited",
        },
    };
}

function projectedInspectLine(row: InspectRow): string {
    const config = row.Config as { Labels: Record<string, unknown> };
    const labels = config.Labels;
    const state = row.State as {
        Health?: { Status?: unknown };
        Running?: unknown;
        Status?: unknown;
    };
    const networkSettings = row.NetworkSettings as { Ports?: unknown };
    return [
        row.Id,
        state.Running,
        state.Status,
        state.Health?.Status ?? null,
        labels[databaseObservabilityDockerCapabilityLabel] ?? null,
        labels["com.docker.compose.project"] ?? null,
        labels["com.docker.compose.service"] ?? null,
        networkSettings.Ports ?? null,
    ]
        .map((value) => JSON.stringify(value))
        .join("\t");
}

function discoveryProcess(
    snapshots: readonly (readonly InspectRow[])[]
): DockerDatabaseObservabilityProcess & {
    readonly calls: Array<{
        readonly arguments_: readonly string[];
        readonly executable: string;
        readonly maximumBytes: number;
    }>;
} {
    const calls: Array<{
        readonly arguments_: readonly string[];
        readonly executable: string;
        readonly maximumBytes: number;
    }> = [];
    let snapshotIndex = 0;
    const process = ((executable, arguments_, _signal, maximumBytes) => {
        calls.push({ arguments_, executable, maximumBytes });
        const snapshot = snapshots[snapshotIndex];
        if (snapshot === undefined) throw new Error("Unexpected discovery call");
        if (arguments_[2] === "ps") {
            return Promise.resolve({
                exitCode: 0,
                stderr: new Uint8Array(),
                stdout: new TextEncoder().encode(
                    snapshot.map((row) => JSON.stringify(row.Id)).join("\n")
                ),
            });
        }
        if (arguments_[2] !== "inspect") {
            throw new Error("Unexpected Docker command");
        }
        snapshotIndex += 1;
        return Promise.resolve({
            exitCode: 0,
            stderr: new Uint8Array(),
            stdout: new TextEncoder().encode(
                snapshot.map((row) => projectedInspectLine(row)).join("\n")
            ),
        });
    }) as DockerDatabaseObservabilityProcess & { readonly calls: typeof calls };
    Object.defineProperty(process, "calls", { value: calls });
    return process;
}

function resolver(process: DockerDatabaseObservabilityProcess, deadlineMs = 5000) {
    return createDockerDatabaseObservabilityConnectionResolver({
        credentials,
        deadlineMs,
        process,
    });
}

const outputOverflowProcess: DockerDatabaseObservabilityProcess = () =>
    Promise.resolve({
        exitCode: 0,
        stderr: new Uint8Array(),
        stdout: new Uint8Array(256 * 1024 + 1),
    });

describe("Docker database observability endpoint resolver", () => {
    test("uses one ps snapshot and one batched inspect without topology-name authority", async () => {
        const process = discoveryProcess([
            [
                inspectRow(1, {
                    containerName: "/first-container",
                    project: "first-project",
                    service: "first-service",
                }),
                inspectRow(2, { capability: "not-enabled" }),
            ],
            [
                inspectRow(1, {
                    containerName: "/renamed-container",
                    hostPort: "7543",
                    project: "renamed-project",
                    service: "renamed-service",
                }),
                inspectRow(2, { capability: "not-enabled" }),
            ],
        ]);
        const endpointResolver = resolver(process);

        const first = await endpointResolver.resolve();
        const second = await endpointResolver.resolve();

        expect(first.connection).toMatchObject({
            controlDatabase: databaseObservabilityPgBouncerControlAlias,
            hostname: "127.0.0.1",
            port: 6432,
        });
        expect(first.source).toEqual({
            composeProject: "first-project",
            composeService: "first-service",
            containerId: containerId(1),
        });
        expect(second.connection).toMatchObject({
            controlDatabase: databaseObservabilityPgBouncerControlAlias,
            hostname: "127.0.0.1",
            port: 7543,
        });
        expect(second.source).toEqual({
            composeProject: "renamed-project",
            composeService: "renamed-service",
            containerId: containerId(1),
        });
        expect(process.calls.map(({ arguments_ }) => arguments_)).toEqual([
            [
                "--host",
                "unix:///var/run/docker.sock",
                "ps",
                "-a",
                "--no-trunc",
                "--format",
                "{{json .ID}}",
            ],
            [
                "--host",
                "unix:///var/run/docker.sock",
                "inspect",
                "--format",
                databaseObservabilityDockerInspectFormat,
                containerId(1),
                containerId(2),
            ],
            [
                "--host",
                "unix:///var/run/docker.sock",
                "ps",
                "-a",
                "--no-trunc",
                "--format",
                "{{json .ID}}",
            ],
            [
                "--host",
                "unix:///var/run/docker.sock",
                "inspect",
                "--format",
                databaseObservabilityDockerInspectFormat,
                containerId(1),
                containerId(2),
            ],
        ]);
        expect(
            process.calls.every(({ executable }) => executable === "/usr/bin/docker")
        ).toBe(true);
    });

    test("accepts exact IPv4 and IPv6 loopback bindings", async () => {
        for (const hostIp of ["127.0.0.42", "::1"] as const) {
            const process = discoveryProcess([
                [
                    inspectRow(1, {
                        bindings: [{ HostIp: hostIp, HostPort: "6543" }],
                    }),
                ],
            ]);
            const result = await resolver(process).resolve();
            expect(result.connection).toMatchObject({
                controlDatabase: databaseObservabilityPgBouncerControlAlias,
                hostname: hostIp,
                port: 6543,
            });
        }
    });

    test("fails closed for absent, ambiguous, unhealthy, or unsafe bindings", () => {
        for (const rows of [
            [],
            [inspectRow(1, { capability: "disabled" })],
            [inspectRow(1), inspectRow(2)],
            [inspectRow(1, { health: "starting" })],
            [inspectRow(1, { bindings: null })],
            [
                inspectRow(1, {
                    bindings: [{ HostIp: "0.0.0.0", HostPort: "6432" }],
                }),
            ],
            [
                inspectRow(1, {
                    bindings: [
                        { HostIp: "127.0.0.1", HostPort: "6432" },
                        { HostIp: "::1", HostPort: "6432" },
                    ],
                }),
            ],
        ] as const) {
            expect(resolver(discoveryProcess([rows])).resolve()).rejects.toThrow(
                "Database observability Docker discovery failed"
            );
        }
    });

    test("rejects a container that disappears between ps and inspect", () => {
        const first = inspectRow(1);
        const second = inspectRow(2, { capability: "disabled" });
        const process: DockerDatabaseObservabilityProcess = (_executable, arguments_) =>
            Promise.resolve({
                exitCode: 0,
                stderr: new Uint8Array(),
                stdout:
                    arguments_[2] === "ps"
                        ? new TextEncoder().encode(
                              [first, second]
                                  .map((row) => JSON.stringify(row.Id))
                                  .join("\n")
                          )
                        : new TextEncoder().encode(projectedInspectLine(first)),
            });

        expect(resolver(process).resolve()).rejects.toThrow(
            "Database observability Docker discovery failed"
        );
    });

    test("bounds inventory, process output, and the shared discovery deadline", () => {
        const overflowRows = Array.from(
            { length: databaseObservabilityDockerContainerMaximum + 1 },
            (_, index) => inspectRow(index + 1, { capability: "disabled" })
        );
        const overflowProcess = discoveryProcess([overflowRows]);
        expect(resolver(overflowProcess).resolve()).rejects.toThrow(
            "Database observability Docker discovery failed"
        );
        expect(overflowProcess.calls).toHaveLength(1);

        expect(resolver(outputOverflowProcess).resolve()).rejects.toThrow(
            "Database observability Docker discovery failed"
        );

        let observedSignal: AbortSignal | undefined;
        const hangingProcess: DockerDatabaseObservabilityProcess = (
            _executable,
            _arguments,
            signal
        ) => {
            observedSignal = signal;
            return new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(new Error("aborted")), {
                    once: true,
                });
            });
        };
        expect(resolver(hangingProcess, 5).resolve()).rejects.toThrow(
            "Database observability Docker discovery failed"
        );
        expect(observedSignal?.aborted).toBe(true);
    });

    test("redacts credentials from resolved values, inspection, and failures", async () => {
        const unrelatedSecret = "unrelated-container-secret";
        const row = inspectRow(1);
        (row.Config as Record<string, unknown>).Env = [
            `UNRELATED_SECRET=${unrelatedSecret}`,
        ];
        (row.Config as { Labels: Record<string, unknown> }).Labels[
            "unrelated.secret.label"
        ] = unrelatedSecret;
        expect(projectedInspectLine(row)).not.toContain(unrelatedSecret);
        expect(databaseObservabilityDockerInspectFormat).not.toContain(".Config.Env");
        expect(databaseObservabilityDockerInspectFormat).not.toContain(
            "{{json .Config.Labels}}"
        );
        const result = await resolver(discoveryProcess([[row]])).resolve();
        expect(JSON.stringify(result)).not.toContain(passwordValue);
        expect(JSON.stringify(result)).not.toContain(unrelatedSecret);
        expect(Bun.inspect(result)).not.toContain(passwordValue);
        expect(JSON.stringify(result.connection.password)).toBe(
            '"<redacted:database-observability-password>"'
        );

        const secret = "failure-secret";
        let failure: unknown;
        try {
            createDockerDatabaseObservabilityConnectionResolver({
                credentials: {
                    password: Redacted.make(` ${secret}`, {
                        label: "database-observability-password",
                    }),
                },
            });
        } catch (error) {
            failure = error;
        }
        expect(String(failure)).not.toContain(secret);
        expect(Bun.inspect(failure)).not.toContain(secret);
        expect(JSON.stringify(failure)).not.toContain(secret);
    });
});
