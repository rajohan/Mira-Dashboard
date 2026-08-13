import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import Fs from "node:fs";
import Os from "node:os";
import Path from "node:path";

import { captureFailure } from "../../server/test/support/promise.ts";
import { linuxRenameExchange } from "../files/linuxRenameExchange.ts";
import {
    dockerComposeWrapper,
    type DockerComposeDiscoveredService,
} from "./composeDiscovery.ts";
import {
    DockerComposeImageUpdateError,
    type DockerComposeCommandRunner,
    updateDockerComposeImage,
} from "./composeImageUpdate.ts";

const directories: string[] = [];
const runtimeImageId = `sha256:${"a".repeat(64)}`;

function sha256(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}

function fixture(source: string): {
    readonly appCompose: string;
    readonly root: string;
} {
    const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "mira-compose-update-"));
    const appDirectory = Path.join(root, "apps", "sample");
    Fs.mkdirSync(appDirectory, { recursive: true, mode: 0o700 });
    const appCompose = Path.join(appDirectory, "compose.yaml");
    Fs.writeFileSync(appCompose, source, { mode: 0o640 });
    Fs.chmodSync(appCompose, 0o640);
    directories.push(root);
    return { appCompose, root };
}

function discovered(
    composePath: string,
    imageReference: string,
    contentSha256: string
): DockerComposeDiscoveredService {
    return Object.freeze({
        autoUpdate: true,
        composePath,
        configFiles: Object.freeze([composePath]),
        contentSha256,
        enabled: true,
        image: Object.freeze({
            name: "ghcr.io/example/app",
            registry: "ghcr.io" as const,
            repository: "example/app",
            tag: imageReference.split(":").at(-1),
        }),
        imageReference,
        labels: Object.freeze({ "mira.updater.enabled": "true" }),
        pinMode: "tag" as const,
        project: "renamed-project",
        service: "renamed-service",
        tagPolicy: Object.freeze({
            matchType: "regex" as const,
            pattern: String.raw`^\d+\.\d+\.\d+$`,
        }),
    });
}

function revalidated(target: DockerComposeDiscoveredService) {
    return Object.freeze({ runtimeImageId, target });
}

function restoreImageReference(): Promise<void> {
    return Promise.resolve();
}

function runner(outcomes: readonly number[] = []): DockerComposeCommandRunner & {
    readonly calls: Array<{
        readonly arguments_: readonly string[];
        readonly cwd: string;
        readonly deadlineMs: number;
        readonly executable: string;
        readonly outputMaximumBytes: number;
    }>;
} {
    const calls: Array<{
        readonly arguments_: readonly string[];
        readonly cwd: string;
        readonly deadlineMs: number;
        readonly executable: string;
        readonly outputMaximumBytes: number;
    }> = [];
    const command = ((executable, arguments_, options) => {
        calls.push({
            arguments_: [...arguments_],
            cwd: options.cwd,
            deadlineMs: options.deadlineMs,
            executable,
            outputMaximumBytes: options.outputMaximumBytes,
        });
        return Promise.resolve({ exitCode: outcomes[calls.length - 1] ?? 0 });
    }) as DockerComposeCommandRunner & { readonly calls: typeof calls };
    Object.defineProperty(command, "calls", { value: calls });
    return command;
}

afterEach(() => {
    for (const directory of directories.splice(0)) {
        Fs.rmSync(directory, { force: true, recursive: true });
    }
});

describe("Docker Compose image update", () => {
    for (const fixtureCase of [
        {
            name: "LF single quotes",
            newline: "\n",
            source: [
                "# leading comment",
                "services:  # services comment",
                "  renamed-service: # service comment",
                "    image : 'ghcr.io/example/app:1.0.0'  # image comment",
                "    labels:",
                '      mira.updater.enabled: "true"',
                '      mira.updater.autoUpdate: "true"',
                "    environment:",
                "      SECRET: ${OPAQUE_SECRET}",
                "networks:",
                "  default: {}",
                "",
            ].join("\n"),
        },
        {
            name: "CRLF double quotes",
            newline: "\r\n",
            source: [
                "services:",
                '    "renamed-service":',
                '        image: "ghcr.io/example/app:1.0.0" # keep me',
                "        labels:",
                "            - mira.updater.enabled=true",
                '        command: ["do", "not", "rewrite"]',
                "volumes:",
                "    data: {}",
                "",
            ].join("\r\n"),
        },
        {
            name: "LF unquoted",
            newline: "\n",
            source: [
                "services:",
                "  other:",
                "    image: redis:8.10.0",
                "  renamed-service:",
                "    image: ghcr.io/example/app:1.0.0",
                "    labels: [mira.updater.enabled=true]",
                "",
            ].join("\n"),
        },
    ] as const) {
        test(`changes only the exact image scalar bytes for ${fixtureCase.name}`, async () => {
            const { appCompose, root } = fixture(fixtureCase.source);
            const expectedImage = "ghcr.io/example/app:1.0.0";
            const targetImage = "ghcr.io/example/app:2.10.3";
            const expectedHash = sha256(fixtureCase.source);
            const target = discovered(appCompose, expectedImage, expectedHash);
            const runCompose = runner();

            const result = await updateDockerComposeImage(
                {
                    expectedContentSha256: expectedHash,
                    expectedImageReference: expectedImage,
                    project: target.project,
                    service: target.service,
                    targetImageReference: targetImage,
                },
                {
                    composePath: appCompose,
                    revalidateTarget: () => Promise.resolve(revalidated(target)),
                    restoreImageReference,
                    runCompose,
                    trustRoot: root,
                }
            );

            const actual = Fs.readFileSync(appCompose, "utf8");
            const expected = fixtureCase.source.replace(expectedImage, targetImage);
            expect(actual).toBe(expected);
            expect(actual.replace(targetImage, expectedImage)).toBe(fixtureCase.source);
            expect(actual.includes(fixtureCase.newline)).toBe(true);
            expect(Fs.statSync(appCompose).mode & 0o777).toBe(0o640);
            expect(result).toMatchObject({
                fromImageReference: expectedImage,
                project: "renamed-project",
                service: "renamed-service",
                status: "updated",
                toImageReference: targetImage,
            });
            expect(result.rollback).toBeFunction();
            expect(result.settle).toBeFunction();
            result.settle();
            expect(runCompose.calls).toEqual([
                {
                    arguments_: [
                        "--file",
                        "/opt/docker/compose.yaml",
                        "--project-directory",
                        "/opt/docker",
                        "config",
                        "--quiet",
                    ],
                    cwd: "/opt/docker",
                    deadlineMs: 30_000,
                    executable: dockerComposeWrapper,
                    outputMaximumBytes: 65_536,
                },
                {
                    arguments_: [
                        "--file",
                        "/opt/docker/compose.yaml",
                        "--project-directory",
                        "/opt/docker",
                        "up",
                        "--detach",
                        "--wait",
                        "--wait-timeout",
                        "150",
                        "--pull",
                        "always",
                        "--no-deps",
                        "renamed-service",
                    ],
                    cwd: "/opt/docker",
                    deadlineMs: 180_000,
                    executable: dockerComposeWrapper,
                    outputMaximumBytes: 65_536,
                },
            ]);
            expect(
                Fs.readdirSync(Path.dirname(appCompose)).filter((name) =>
                    name.startsWith(".mira-docker-")
                )
            ).toEqual([]);
        });
    }

    test("retains exact rollback material until Git settlement", async () => {
        const source =
            "services:\n  renamed-service:\n    image: ghcr.io/example/app:1.0.0 # original\n";
        const { appCompose, root } = fixture(source);
        const target = discovered(
            appCompose,
            "ghcr.io/example/app:1.0.0",
            sha256(source)
        );
        const runCompose = runner();
        const result = await updateDockerComposeImage(
            {
                expectedContentSha256: sha256(source),
                expectedImageReference: target.imageReference,
                project: target.project,
                service: target.service,
                targetImageReference: "ghcr.io/example/app:2.0.0",
            },
            {
                composePath: appCompose,
                revalidateTarget: () => Promise.resolve(revalidated(target)),
                restoreImageReference,
                runCompose,
                trustRoot: root,
            }
        );

        expect(Fs.readFileSync(appCompose, "utf8")).toContain(
            "ghcr.io/example/app:2.0.0"
        );
        expect(await result.rollback()).toBe(true);
        expect(Fs.readFileSync(appCompose, "utf8")).toBe(source);
        expect(await result.rollback()).toBe(false);
        expect(runCompose.calls).toHaveLength(4);
        for (const call of [runCompose.calls[1], runCompose.calls[3]]) {
            expect(call?.arguments_).toContain("--wait");
            expect(call?.arguments_).toContain("--wait-timeout");
            expect(call?.arguments_).toContain("150");
            expect(call?.deadlineMs).toBe(180_000);
        }
    });

    test("restores a mutable tag from the exact pre-update image without pulling", async () => {
        const source =
            "services:\n  renamed-service:\n    image: ghcr.io/example/app:1.0.0\n";
        const { appCompose, root } = fixture(source);
        const target = discovered(
            appCompose,
            "ghcr.io/example/app:1.0.0",
            sha256(source)
        );
        const movedImageId = `sha256:${"b".repeat(64)}`;
        const restored: Array<{ imageId: string; imageReference: string }> = [];
        const runCompose = runner();
        const result = await updateDockerComposeImage(
            {
                expectedContentSha256: sha256(source),
                expectedImageReference: target.imageReference,
                project: target.project,
                service: target.service,
                targetImageReference: "ghcr.io/example/app:2.0.0",
            },
            {
                composePath: appCompose,
                revalidateTarget: (phase) =>
                    Promise.resolve({
                        runtimeImageId:
                            phase === "post-rollback" && restored.length === 0
                                ? movedImageId
                                : runtimeImageId,
                        target,
                    }),
                restoreImageReference(imageId, imageReference) {
                    restored.push({ imageId, imageReference });
                    return Promise.resolve();
                },
                runCompose,
                trustRoot: root,
            }
        );

        expect(await result.rollback()).toBe(true);
        expect(restored).toEqual([
            {
                imageId: runtimeImageId,
                imageReference: "ghcr.io/example/app:1.0.0",
            },
        ]);
        expect(runCompose.calls[1]?.arguments_).toContain("always");
        expect(runCompose.calls[3]?.arguments_).toContain("never");
        expect(runCompose.calls[3]?.arguments_).toContain("--force-recreate");
        expect(runCompose.calls[3]?.arguments_).not.toContain("always");
        expect(Fs.readFileSync(appCompose, "utf8")).toBe(source);
    });

    test("fails rollback closed when the restored runtime image cannot be verified", async () => {
        const source =
            "services:\n  renamed-service:\n    image: ghcr.io/example/app:1.0.0\n";
        const { appCompose, root } = fixture(source);
        const target = discovered(
            appCompose,
            "ghcr.io/example/app:1.0.0",
            sha256(source)
        );
        const movedImageId = `sha256:${"b".repeat(64)}`;
        const runCompose = runner();
        const result = await updateDockerComposeImage(
            {
                expectedContentSha256: sha256(source),
                expectedImageReference: target.imageReference,
                project: target.project,
                service: target.service,
                targetImageReference: "ghcr.io/example/app:2.0.0",
            },
            {
                composePath: appCompose,
                revalidateTarget: (phase) =>
                    Promise.resolve({
                        runtimeImageId:
                            phase === "post-rollback" ? movedImageId : runtimeImageId,
                        target,
                    }),
                restoreImageReference,
                runCompose,
                trustRoot: root,
            }
        );

        expect(await result.rollback()).toBe(false);
        expect(await result.rollback()).toBe(false);
        expect(Fs.readFileSync(appCompose, "utf8")).toBe(source);
    });

    test("reopens and rejects source-CAS drift before publishing or invoking Compose", async () => {
        const source =
            "services:\n  renamed-service:\n    image: ghcr.io/example/app:1.0.0\n";
        const { appCompose, root } = fixture(source);
        const expectedImage = "ghcr.io/example/app:1.0.0";
        const target = discovered(appCompose, expectedImage, sha256(source));
        const runCompose = runner();
        let callCount = 0;

        const failure = await captureFailure(() =>
            updateDockerComposeImage(
                {
                    expectedContentSha256: sha256(source),
                    expectedImageReference: expectedImage,
                    project: target.project,
                    service: target.service,
                    targetImageReference: "ghcr.io/example/app:2.0.0",
                },
                {
                    composePath: appCompose,
                    revalidateTarget: () => {
                        callCount += 1;
                        if (callCount === 2) {
                            Fs.appendFileSync(appCompose, "# concurrent edit\n");
                        }
                        return Promise.resolve(revalidated(target));
                    },
                    restoreImageReference,
                    runCompose,
                    trustRoot: root,
                }
            )
        );

        expect(failure).toMatchObject({ reason: "conflict" });
        expect(Fs.readFileSync(appCompose, "utf8")).toBe(`${source}# concurrent edit\n`);
        expect(runCompose.calls).toEqual([]);
    });

    test("preserves a typed conflict from pre-update target revalidation", async () => {
        const source =
            "services:\n  renamed-service:\n    image: ghcr.io/example/app:1.0.0\n";
        const { appCompose, root } = fixture(source);
        const expected = new DockerComposeImageUpdateError("conflict");
        const failure = await captureFailure(() =>
            updateDockerComposeImage(
                {
                    expectedContentSha256: sha256(source),
                    expectedImageReference: "ghcr.io/example/app:1.0.0",
                    project: "renamed-project",
                    service: "renamed-service",
                    targetImageReference: "ghcr.io/example/app:2.0.0",
                },
                {
                    composePath: appCompose,
                    revalidateTarget: () => Promise.reject(expected),
                    restoreImageReference,
                    runCompose: runner(),
                    trustRoot: root,
                }
            )
        );

        expect(failure).toBe(expected);
        expect(failure).toMatchObject({ reason: "conflict", rollbackCompleted: true });
        expect(Fs.readFileSync(appCompose, "utf8")).toBe(source);
    });

    test("atomically restores a concurrent edit made after the final reopen", async () => {
        const source =
            "services:\n  renamed-service:\n    image: ghcr.io/example/app:1.0.0\n";
        const { appCompose, root } = fixture(source);
        const expectedImage = "ghcr.io/example/app:1.0.0";
        const target = discovered(appCompose, expectedImage, sha256(source));
        const runCompose = runner();
        let raced = false;

        const failure = await captureFailure(() =>
            updateDockerComposeImage(
                {
                    expectedContentSha256: sha256(source),
                    expectedImageReference: expectedImage,
                    project: target.project,
                    service: target.service,
                    targetImageReference: "ghcr.io/example/app:2.0.0",
                },
                {
                    composePath: appCompose,
                    revalidateTarget: () => Promise.resolve(revalidated(target)),
                    restoreImageReference,
                    renameExchange: (directoryFd, leftName, rightName) => {
                        if (!raced) {
                            raced = true;
                            Fs.appendFileSync(appCompose, "# last-moment edit\n");
                        }
                        linuxRenameExchange(directoryFd, leftName, rightName);
                    },
                    runCompose,
                    trustRoot: root,
                }
            )
        );

        expect(failure).toMatchObject({ reason: "conflict" });
        expect(Fs.readFileSync(appCompose, "utf8")).toBe(`${source}# last-moment edit\n`);
        expect(runCompose.calls).toEqual([]);
    });

    test("fails closed for ambiguous image scalars without formatting fallback", async () => {
        const source = [
            "services:",
            "  renamed-service:",
            "    <<: *defaults",
            "    image: ghcr.io/example/app:1.0.0",
            "    image: ghcr.io/example/app:1.0.0",
            "",
        ].join("\n");
        const { appCompose, root } = fixture(source);
        const target = discovered(
            appCompose,
            "ghcr.io/example/app:1.0.0",
            sha256(source)
        );
        const runCompose = runner();
        const failure = await captureFailure(() =>
            updateDockerComposeImage(
                {
                    expectedContentSha256: sha256(source),
                    expectedImageReference: target.imageReference,
                    project: target.project,
                    service: target.service,
                    targetImageReference: "ghcr.io/example/app:2.0.0",
                },
                {
                    composePath: appCompose,
                    revalidateTarget: () => Promise.resolve(revalidated(target)),
                    restoreImageReference,
                    runCompose,
                    trustRoot: root,
                }
            )
        );
        expect(failure).toBeInstanceOf(DockerComposeImageUpdateError);
        expect(Fs.readFileSync(appCompose, "utf8")).toBe(source);
        expect(runCompose.calls).toEqual([]);
    });

    test("rolls the exact bytes and running service back after apply failure", async () => {
        const source =
            "services:\n  renamed-service:\n    image: ghcr.io/example/app:1.0.0 # original\n";
        const { appCompose, root } = fixture(source);
        const target = discovered(
            appCompose,
            "ghcr.io/example/app:1.0.0",
            sha256(source)
        );
        const runCompose = runner([0, 17, 0, 0]);
        const failure = await captureFailure(() =>
            updateDockerComposeImage(
                {
                    expectedContentSha256: sha256(source),
                    expectedImageReference: target.imageReference,
                    project: target.project,
                    service: target.service,
                    targetImageReference: "ghcr.io/example/app:2.0.0",
                },
                {
                    composePath: appCompose,
                    revalidateTarget: () => Promise.resolve(revalidated(target)),
                    restoreImageReference,
                    runCompose,
                    trustRoot: root,
                }
            )
        );
        expect(failure).toMatchObject({ reason: "unavailable", rollbackCompleted: true });
        expect(Fs.readFileSync(appCompose, "utf8")).toBe(source);
        expect(runCompose.calls.map(({ arguments_ }) => arguments_.slice(-2))).toEqual([
            ["config", "--quiet"],
            ["--no-deps", "renamed-service"],
            ["config", "--quiet"],
            ["--no-deps", "renamed-service"],
        ]);
        for (const call of [runCompose.calls[1], runCompose.calls[3]]) {
            expect(call?.arguments_).toContain("--wait");
            expect(call?.arguments_).toContain("--wait-timeout");
            expect(call?.arguments_).toContain("150");
            expect(call?.deadlineMs).toBe(180_000);
        }
    });

    test("does not overwrite a third-party edit while settling a failed validation", async () => {
        const source =
            "services:\n  renamed-service:\n    image: ghcr.io/example/app:1.0.0\n";
        const { appCompose, root } = fixture(source);
        const target = discovered(
            appCompose,
            "ghcr.io/example/app:1.0.0",
            sha256(source)
        );
        const runCompose = (() => {
            Fs.appendFileSync(appCompose, "# third-party edit\n");
            return Promise.resolve({ exitCode: 1 });
        }) as DockerComposeCommandRunner;
        const failure = await captureFailure(() =>
            updateDockerComposeImage(
                {
                    expectedContentSha256: sha256(source),
                    expectedImageReference: target.imageReference,
                    project: target.project,
                    service: target.service,
                    targetImageReference: "ghcr.io/example/app:2.0.0",
                },
                {
                    composePath: appCompose,
                    revalidateTarget: () => Promise.resolve(revalidated(target)),
                    restoreImageReference,
                    runCompose,
                    trustRoot: root,
                }
            )
        );
        expect(failure).toMatchObject({
            reason: "rollback-failed",
            rollbackCompleted: false,
        });
        expect(Fs.readFileSync(appCompose, "utf8")).toContain("# third-party edit");
    });
});
