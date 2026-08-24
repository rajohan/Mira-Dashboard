import { afterEach, describe, expect, test } from "bun:test";
import Fs from "node:fs";
import Os from "node:os";
import Path from "node:path";

import { captureFailure } from "../../server/test/support/promise.ts";
import {
    discoverDockerComposeServices,
    DockerComposeDiscoveryError,
} from "./composeDiscovery.ts";

const directories: string[] = [];

function fixture(): {
    readonly appCompose: string;
    readonly root: string;
    readonly rootCompose: string;
} {
    const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "mira-docker-compose-"));
    const appDirectory = Path.join(root, "apps", "sample");
    Fs.mkdirSync(appDirectory, { recursive: true, mode: 0o700 });
    const rootCompose = Path.join(root, "compose.yaml");
    const appCompose = Path.join(appDirectory, "compose.yaml");
    directories.push(root);
    return { appCompose, root, rootCompose };
}

function identity(
    rootCompose: string,
    service = "dynamic-service",
    project = "dynamic-project"
) {
    return Object.freeze({
        configFiles: Object.freeze([rootCompose]),
        project,
        service,
    });
}

afterEach(() => {
    for (const directory of directories.splice(0)) {
        Fs.rmSync(directory, { force: true, recursive: true });
    }
});

describe("Docker Compose discovery", () => {
    test("recursively joins dynamic Engine identity to the one included image and five policy labels", () => {
        const { appCompose, root, rootCompose } = fixture();
        Fs.writeFileSync(rootCompose, "include:\n  - apps/sample/compose.yaml\n");
        Fs.writeFileSync(
            appCompose,
            [
                "services:",
                "  dynamic-service:",
                "    image: ghcr.io/example/sample:v2.10.0",
                "    labels:",
                "      unrelated.secret-shaped-label: ignored",
                '      mira.updater.enabled: "true"',
                '      mira.updater.autoUpdate: "true"',
                "      mira.updater.track: tag",
                String.raw`      mira.updater.tagPattern: ^v\d+\.\d+\.\d+$$`,
                '      mira.updater.tagPatternIsRegex: "true"',
                "",
            ].join("\n")
        );
        Fs.writeFileSync(Path.join(root, ".env"), 'THIS_IS_NOT_YAML="unterminated\n');
        Fs.writeFileSync(
            Path.join(Path.dirname(appCompose), ".env"),
            "ALSO_NOT_YAML=[\n"
        );

        const result = discoverDockerComposeServices(
            [identity(rootCompose, "dynamic-service", "renamed-project")],
            { rootComposePath: rootCompose, trustRoot: root }
        );

        expect(result.composeFiles).toEqual([appCompose, rootCompose].toSorted());
        expect(result.services).toHaveLength(1);
        expect(result.services[0]).toMatchObject({
            autoUpdate: true,
            composePath: appCompose,
            configFiles: [rootCompose],
            enabled: true,
            image: {
                registry: "ghcr.io",
                repository: "example/sample",
                tag: "v2.10.0",
            },
            imageReference: "ghcr.io/example/sample:v2.10.0",
            labels: {
                "mira.updater.autoUpdate": "true",
                "mira.updater.enabled": "true",
                "mira.updater.tagPattern": String.raw`^v\d+\.\d+\.\d+$`,
                "mira.updater.tagPatternIsRegex": "true",
                "mira.updater.track": "tag",
            },
            pinMode: "tag",
            project: "renamed-project",
            service: "dynamic-service",
            tagPolicy: {
                matchType: "regex",
                pattern: String.raw`^v\d+\.\d+\.\d+$`,
            },
        });
        expect(result.services[0]?.labels).not.toHaveProperty(
            "unrelated.secret-shaped-label"
        );
        expect(result.services[0]?.contentSha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(result.sourceRevision).toMatch(/^[0-9a-f]{64}$/u);
    });

    test("reconciles Compose additions, removals and renames before containers exist", () => {
        const { appCompose, root, rootCompose } = fixture();
        Fs.writeFileSync(rootCompose, "include:\n- apps/sample/compose.yaml\n");
        Fs.writeFileSync(
            appCompose,
            [
                "services:",
                "  first:",
                "    image: redis:8.10.0",
                "    labels: [mira.updater.enabled=true]",
                "  renamed:",
                "    image: postgres:18.4",
                "    labels: [mira.updater.enabled=true]",
                "",
            ].join("\n")
        );

        const first = discoverDockerComposeServices([identity(rootCompose, "first")], {
            rootComposePath: rootCompose,
            trustRoot: root,
        });
        const second = discoverDockerComposeServices(
            [identity(rootCompose, "renamed", "renamed-project")],
            { rootComposePath: rootCompose, trustRoot: root }
        );

        expect(first.services.map(({ service }) => service)).toEqual([
            "first",
            "renamed",
        ]);
        expect(second.services.map(({ project, service }) => [project, service])).toEqual(
            [
                ["renamed-project", "first"],
                ["renamed-project", "renamed"],
            ]
        );
        expect(
            discoverDockerComposeServices([], {
                rootComposePath: rootCompose,
                trustRoot: root,
            }).services.map(({ project, service }) => [project, service])
        ).toEqual([
            [Path.basename(root), "first"],
            [Path.basename(root), "renamed"],
        ]);

        Fs.writeFileSync(
            appCompose,
            "services:\n  renamed:\n    image: postgres:18.4\n    labels: [mira.updater.enabled=true]\n"
        );
        expect(
            discoverDockerComposeServices([], {
                rootComposePath: rootCompose,
                trustRoot: root,
            }).services.map(({ service }) => service)
        ).toEqual(["renamed"]);
    });

    test("keeps missing or invalid opt-in policy inventory-only", () => {
        const { appCompose, root, rootCompose } = fixture();
        Fs.writeFileSync(rootCompose, "include:\n- apps/sample/compose.yaml\n");
        Fs.writeFileSync(
            appCompose,
            [
                "services:",
                "  missing:",
                "    image: redis:8.10.0",
                "  invalid:",
                "    image: postgres:18.4",
                "    labels:",
                "      - mira.updater.enabled=TRUE",
                "      - mira.updater.autoUpdate=TRUE",
                "      - mira.updater.track=surprise",
                "      - mira.updater.tagPattern=^.*$$",
                "",
            ].join("\n")
        );
        const result = discoverDockerComposeServices(
            [identity(rootCompose, "missing"), identity(rootCompose, "invalid")],
            { rootComposePath: rootCompose, trustRoot: root }
        );
        expect(
            result.services.map(({ autoUpdate, enabled, service }) => ({
                autoUpdate,
                enabled,
                service,
            }))
        ).toEqual([
            { autoUpdate: false, enabled: false, service: "invalid" },
            { autoUpdate: false, enabled: false, service: "missing" },
        ]);
    });

    test("ignores foreign projects and removed-service remainders outside root-stack authority", () => {
        const { appCompose, root, rootCompose } = fixture();
        Fs.writeFileSync(rootCompose, "include:\n- apps/sample/compose.yaml\n");
        Fs.writeFileSync(
            appCompose,
            "services:\n  current:\n    image: redis:8.10.0\n    labels: [mira.updater.enabled=true]\n"
        );
        const outside = Fs.mkdtempSync(Path.join(Os.tmpdir(), "mira-foreign-compose-"));
        directories.push(outside);
        const outsideCompose = Path.join(outside, "compose.yaml");
        const secondOutsideCompose = Path.join(outside, "compose.override.yaml");
        Fs.writeFileSync(
            outsideCompose,
            "services:\n  foreign:\n    image: redis:8.10.0\n"
        );

        const result = discoverDockerComposeServices(
            [
                identity(rootCompose, "current", "root-project"),
                identity(outsideCompose, "foreign", "foreign-project"),
                identity(secondOutsideCompose, "foreign", "foreign-project"),
                identity(rootCompose, "removed", "old-project"),
            ],
            { rootComposePath: rootCompose, trustRoot: root }
        );

        expect(result.services.map(({ project, service }) => [project, service])).toEqual(
            [["root-project", "current"]]
        );
    });

    test("keeps unsupported registries and unresolved image variables inventory-only", () => {
        const { appCompose, root, rootCompose } = fixture();
        Fs.writeFileSync(rootCompose, "include:\n- apps/sample/compose.yaml\n");
        Fs.writeFileSync(
            appCompose,
            [
                "services:",
                "  supported:",
                "    image: redis:8.10.0",
                "    labels: [mira.updater.enabled=true]",
                "  quay:",
                "    image: quay.io/example/private:v1",
                "    labels: [mira.updater.enabled=true]",
                "  unresolved:",
                "    image: ${PRIVATE_IMAGE}",
                "    labels: [mira.updater.enabled=true]",
                "",
            ].join("\n")
        );

        const result = discoverDockerComposeServices(
            [identity(rootCompose, "supported", "root-project")],
            { rootComposePath: rootCompose, trustRoot: root }
        );

        expect(
            result.services.map(({ enabled, image, imageReference, service }) => ({
                enabled,
                hasSupportedImage: image !== undefined,
                imageReference,
                service,
            }))
        ).toEqual([
            {
                enabled: false,
                hasSupportedImage: false,
                imageReference: "quay.io/example/private:v1",
                service: "quay",
            },
            {
                enabled: true,
                hasSupportedImage: true,
                imageReference: "redis:8.10.0",
                service: "supported",
            },
            {
                enabled: false,
                hasSupportedImage: false,
                imageReference: "${PRIVATE_IMAGE}",
                service: "unresolved",
            },
        ]);
    });

    test("binds source revision to every graph byte and root owner identity", () => {
        const { appCompose, root, rootCompose } = fixture();
        Fs.writeFileSync(
            rootCompose,
            "include:\n- apps/sample/compose.yaml\nnetworks:\n  default: {}\n"
        );
        Fs.writeFileSync(
            appCompose,
            "services:\n  app:\n    image: redis:8.10.0\nvolumes:\n  data: {}\n"
        );
        const options = { rootComposePath: rootCompose, trustRoot: root };
        const first = discoverDockerComposeServices(
            [identity(rootCompose, "app", "first-project")],
            options
        );

        Fs.writeFileSync(
            rootCompose,
            "include:\n- apps/sample/compose.yaml\nnetworks:\n  default:\n    internal: true\n"
        );
        const rootChanged = discoverDockerComposeServices(
            [identity(rootCompose, "app", "first-project")],
            options
        );
        Fs.writeFileSync(
            appCompose,
            "services:\n  app:\n    image: redis:8.10.0\nvolumes:\n  data:\n    external: true\n"
        );
        const includeChanged = discoverDockerComposeServices(
            [identity(rootCompose, "app", "first-project")],
            options
        );
        const identityChanged = discoverDockerComposeServices(
            [identity(rootCompose, "app", "second-project")],
            options
        );
        Fs.chmodSync(appCompose, 0o400);
        const fileIdentityChanged = discoverDockerComposeServices(
            [identity(rootCompose, "app", "second-project")],
            options
        );

        expect(
            new Set([
                first.sourceRevision,
                rootChanged.sourceRevision,
                includeChanged.sourceRevision,
                identityChanged.sourceRevision,
                fileIdentityChanged.sourceRevision,
            ]).size
        ).toBe(5);
    });

    test("keeps duplicate image ownership inventory-only as an ambiguous source", () => {
        const { appCompose, root, rootCompose } = fixture();
        const duplicate = Path.join(root, "apps", "duplicate.yaml");
        Fs.writeFileSync(
            rootCompose,
            "include:\n- apps/sample/compose.yaml\n- apps/duplicate.yaml\n"
        );
        const service =
            "services:\n  duplicate:\n    image: redis:8.10.0\n    labels: [mira.updater.enabled=true]\n";
        Fs.writeFileSync(appCompose, service);
        Fs.writeFileSync(duplicate, service);
        const result = discoverDockerComposeServices(
            [identity(rootCompose, "duplicate")],
            {
                rootComposePath: rootCompose,
                trustRoot: root,
            }
        );

        expect(result.services).toHaveLength(1);
        expect(result.services[0]).toMatchObject({
            autoUpdate: false,
            enabled: false,
            imageReference: "redis:8.10.0",
            project: "dynamic-project",
            service: "duplicate",
            sourceAmbiguous: true,
        });
        expect(result.sourceRevision).toMatch(/^[0-9a-f]{64}$/u);
    });

    test("supports object include path arrays without reading environment files", () => {
        const { appCompose, root, rootCompose } = fixture();
        Fs.writeFileSync(
            rootCompose,
            "include:\n  - path:\n      - apps/sample/compose.yaml\n"
        );
        Fs.writeFileSync(
            appCompose,
            "services:\n  object-include:\n    image: redis:8.10.0\n    labels: [mira.updater.enabled=true]\n"
        );
        const result = discoverDockerComposeServices(
            [identity(rootCompose, "object-include")],
            { rootComposePath: rootCompose, trustRoot: root }
        );
        expect(result.services.map(({ service }) => service)).toEqual(["object-include"]);
    });

    test("enforces depth, file, byte, variable-path, symlink and hard-link bounds", async () => {
        const cases: Array<() => void> = [];

        {
            const { appCompose, root, rootCompose } = fixture();
            Fs.writeFileSync(rootCompose, "include:\n- apps/sample/compose.yaml\n");
            Fs.writeFileSync(appCompose, "services: {}\n");
            cases.push(
                () =>
                    discoverDockerComposeServices([], {
                        includeDepthMaximum: 0,
                        rootComposePath: rootCompose,
                        trustRoot: root,
                    }),
                () =>
                    discoverDockerComposeServices([], {
                        aggregateMaximumBytes: 5,
                        rootComposePath: rootCompose,
                        trustRoot: root,
                    }),
                () =>
                    discoverDockerComposeServices([], {
                        fileMaximum: 1,
                        rootComposePath: rootCompose,
                        trustRoot: root,
                    })
            );
        }
        {
            const { root, rootCompose } = fixture();
            Fs.writeFileSync(rootCompose, "include:\n- ${APP_COMPOSE}\n");
            cases.push(() =>
                discoverDockerComposeServices([], {
                    rootComposePath: rootCompose,
                    trustRoot: root,
                })
            );
        }
        {
            const { appCompose, root, rootCompose } = fixture();
            const real = Path.join(root, "real.yaml");
            Fs.writeFileSync(rootCompose, "include:\n- apps/sample/compose.yaml\n");
            Fs.writeFileSync(real, "services: {}\n");
            Fs.symlinkSync(real, appCompose);
            cases.push(() =>
                discoverDockerComposeServices([], {
                    rootComposePath: rootCompose,
                    trustRoot: root,
                })
            );
        }
        {
            const { appCompose, root, rootCompose } = fixture();
            const hardLink = Path.join(root, "hard-link.yaml");
            Fs.writeFileSync(rootCompose, "include:\n- apps/sample/compose.yaml\n");
            Fs.writeFileSync(appCompose, "services: {}\n");
            Fs.linkSync(appCompose, hardLink);
            cases.push(() =>
                discoverDockerComposeServices([], {
                    rootComposePath: rootCompose,
                    trustRoot: root,
                })
            );
        }

        for (const run of cases) {
            expect(await captureFailure(() => Promise.resolve(run()))).toBeInstanceOf(
                DockerComposeDiscoveryError
            );
        }
    });
});
