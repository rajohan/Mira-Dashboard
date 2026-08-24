import { describe, expect, test } from "bun:test";

import { Redacted } from "effect";

import { captureFailure } from "../../server/test/support/promise.ts";
import {
    DockerRegistryError,
    lookupDockerRegistryImage,
    type DockerRegistryFetch,
} from "./registryClient.ts";

const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;

function registryCredentials(username: string, password: string) {
    return Object.freeze({
        password: Object.freeze(Redacted.make(password, { label: "test-password" })),
        username: Object.freeze(Redacted.make(username, { label: "test-username" })),
    });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
    return Response.json(body, init);
}

describe("Docker registry client", () => {
    test("authenticates Docker Hub, follows bounded trusted pages and selects the ARM64 v8 manifest", async () => {
        const calls: Array<{
            readonly authorization?: string;
            readonly redirect?: "error" | "follow" | "manual";
            readonly url: string;
        }> = [];
        const fetchRegistry: DockerRegistryFetch = (input, init) => {
            const headers = new Headers(init.headers);
            calls.push({
                ...(headers.get("authorization") === null
                    ? {}
                    : { authorization: headers.get("authorization")! }),
                redirect: init.redirect,
                url: input,
            });
            if (input.startsWith("https://auth.docker.io/token")) {
                expect(headers.get("authorization")).toBe("Basic dXNlcjp0b2tlbg==");
                return Promise.resolve(jsonResponse({ token: "registry-bearer" }));
            }
            if (headers.get("authorization") !== "Bearer registry-bearer") {
                return Promise.resolve(
                    new Response("", {
                        headers: {
                            "www-authenticate":
                                'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/postgres:pull"',
                        },
                        status: 401,
                    })
                );
            }
            if (input.endsWith("tags/list?n=1000")) {
                return Promise.resolve(
                    jsonResponse(
                        { tags: ["18.3-alpine3.24", "not-matching"] },
                        {
                            headers: {
                                link: '</v2/library/postgres/tags/list?n=1000&last=18.3-alpine3.24>; rel="next"',
                            },
                        }
                    )
                );
            }
            if (input.includes("last=18.3-alpine3.24")) {
                return Promise.resolve(
                    jsonResponse({ tags: ["18.10-alpine3.24", "18.4-alpine3.24"] })
                );
            }
            if (input.endsWith("/manifests/18.10-alpine3.24")) {
                return Promise.resolve(
                    jsonResponse({
                        manifests: [
                            {
                                digest: digestA,
                                platform: { architecture: "amd64", os: "linux" },
                            },
                            {
                                digest: digestB,
                                platform: {
                                    architecture: "arm64",
                                    os: "linux",
                                    variant: "v8",
                                },
                            },
                        ],
                    })
                );
            }
            throw new Error(`Unexpected registry request: ${input}`);
        };

        const result = await lookupDockerRegistryImage(
            {
                name: "postgres",
                registry: "docker.io",
                repository: "library/postgres",
                tag: "18.4-alpine3.24",
            },
            {
                matchType: "regex",
                pattern: String.raw`^\d+\.\d+\-alpine\d+\.\d+$`,
            },
            "linux/arm64",
            {
                credentials: {
                    "docker.io": registryCredentials("user", "token"),
                },
                fetch: fetchRegistry,
            }
        );

        expect(result).toEqual({ digest: digestB, tag: "18.10-alpine3.24" });
        expect(calls.every(({ redirect }) => redirect === "error")).toBe(true);
        expect(calls.at(-1)?.url).toBe(
            "https://registry-1.docker.io/v2/library/postgres/manifests/18.10-alpine3.24"
        );
    });

    test("supports exact-tag GHCR and LSCR lookups without a tag-list request", async () => {
        for (const registry of ["ghcr.io", "lscr.io"] as const) {
            const calls: string[] = [];
            const result = await lookupDockerRegistryImage(
                {
                    name: `${registry}/example/app`,
                    registry,
                    repository: "example/app",
                    tag: "latest",
                },
                { matchType: "exact", pattern: "latest" },
                "linux/amd64",
                {
                    fetch: (input) => {
                        calls.push(input);
                        return Promise.resolve(
                            jsonResponse(
                                { schemaVersion: 2 },
                                { headers: { "docker-content-digest": digestA } }
                            )
                        );
                    },
                }
            );
            expect(result).toEqual({ digest: digestA, tag: "latest" });
            expect(calls).toEqual([
                `https://${registry}/v2/example/app/manifests/latest`,
            ]);
        }
    });

    test("accepts an omitted ARM64 variant when the host requests v8", async () => {
        const result = await lookupDockerRegistryImage(
            {
                name: "ghcr.io/example/app",
                registry: "ghcr.io",
                repository: "example/app",
                tag: "latest",
            },
            { matchType: "exact", pattern: "latest" },
            "linux/arm64/v8",
            {
                fetch: () =>
                    Promise.resolve(
                        jsonResponse({
                            manifests: [
                                {
                                    digest: digestA,
                                    platform: { architecture: "arm64", os: "linux" },
                                },
                            ],
                        })
                    ),
            }
        );

        expect(result).toEqual({ digest: digestA, tag: "latest" });
    });

    test("rejects cross-origin and path-changing pagination", async () => {
        for (const link of [
            '<https://attacker.invalid/v2/example/app/tags/list?n=1000>; rel="next"',
            '</v2/other/app/tags/list?n=1000>; rel="next"',
            '</v2/example/app/tags/list?n=999>; rel="next"',
            '</v2/example/app/tags/list?n=1000&unknown=value>; rel="next"',
        ]) {
            const failure = await captureFailure(() =>
                lookupDockerRegistryImage(
                    {
                        name: "ghcr.io/example/app",
                        registry: "ghcr.io",
                        repository: "example/app",
                        tag: "v1.0.0",
                    },
                    {
                        matchType: "regex",
                        pattern: String.raw`^v\d+\.\d+\.\d+$`,
                    },
                    "linux/amd64",
                    {
                        fetch: () =>
                            Promise.resolve(
                                jsonResponse({ tags: ["v1.0.0"] }, { headers: { link } })
                            ),
                    }
                )
            );
            expect(failure).toBeInstanceOf(DockerRegistryError);
        }
    });

    test("rejects an untrusted token realm without sending credentials", async () => {
        const authorizations: Array<string | null> = [];
        const failure = await captureFailure(() =>
            lookupDockerRegistryImage(
                {
                    name: "ghcr.io/example/app",
                    registry: "ghcr.io",
                    repository: "example/app",
                    tag: "latest",
                },
                { matchType: "exact", pattern: "latest" },
                "linux/amd64",
                {
                    credentials: {
                        "ghcr.io": registryCredentials("user", "private"),
                    },
                    fetch: (_input, init) => {
                        authorizations.push(
                            new Headers(init.headers).get("authorization")
                        );
                        return Promise.resolve(
                            new Response("", {
                                headers: {
                                    "www-authenticate":
                                        'Bearer realm="https://attacker.invalid/token",scope="repository:example/app:pull"',
                                },
                                status: 401,
                            })
                        );
                    },
                }
            )
        );
        expect(failure).toBeInstanceOf(DockerRegistryError);
        expect(authorizations).toEqual([null]);
    });

    test("does not accept an index digest when the requested platform is absent", async () => {
        const failure = await captureFailure(() =>
            lookupDockerRegistryImage(
                {
                    name: "ghcr.io/example/app",
                    registry: "ghcr.io",
                    repository: "example/app",
                    tag: "latest",
                },
                { matchType: "exact", pattern: "latest" },
                "linux/arm64",
                {
                    fetch: () =>
                        Promise.resolve(
                            jsonResponse(
                                {
                                    manifests: [
                                        {
                                            digest: digestA,
                                            platform: {
                                                architecture: "amd64",
                                                os: "linux",
                                            },
                                        },
                                    ],
                                },
                                {
                                    headers: {
                                        "docker-content-digest": digestB,
                                    },
                                }
                            )
                        ),
                }
            )
        );
        expect(failure).toMatchObject({ reason: "unavailable" });
    });

    test("bounds response bytes, repeated pages and the global deadline", async () => {
        const oversized = await captureFailure(() =>
            lookupDockerRegistryImage(
                {
                    name: "ghcr.io/example/app",
                    registry: "ghcr.io",
                    repository: "example/app",
                    tag: "latest",
                },
                { matchType: "exact", pattern: "latest" },
                "linux/amd64",
                {
                    fetch: () =>
                        Promise.resolve(
                            new Response(new Uint8Array(2 * 1024 * 1024 + 1), {
                                status: 200,
                            })
                        ),
                }
            )
        );
        expect(oversized).toMatchObject({ reason: "limit-exceeded" });

        const repeated = await captureFailure(() =>
            lookupDockerRegistryImage(
                {
                    name: "ghcr.io/example/app",
                    registry: "ghcr.io",
                    repository: "example/app",
                    tag: "v1.0.0",
                },
                {
                    matchType: "regex",
                    pattern: String.raw`^v\d+\.\d+\.\d+$`,
                },
                "linux/amd64",
                {
                    fetch: () =>
                        Promise.resolve(
                            jsonResponse(
                                { tags: ["v1.0.0"] },
                                {
                                    headers: {
                                        link: '</v2/example/app/tags/list?n=1000>; rel="next"',
                                    },
                                }
                            )
                        ),
                }
            )
        );
        expect(repeated).toMatchObject({ reason: "limit-exceeded" });

        const deadline = await captureFailure(() =>
            lookupDockerRegistryImage(
                {
                    name: "ghcr.io/example/app",
                    registry: "ghcr.io",
                    repository: "example/app",
                    tag: "latest",
                },
                { matchType: "exact", pattern: "latest" },
                "linux/amd64",
                {
                    deadlineMs: 5,
                    fetch: (_input, init) =>
                        new Promise<Response>((_resolve, reject) => {
                            init.signal?.addEventListener(
                                "abort",
                                () => reject(new DOMException("aborted", "AbortError")),
                                { once: true }
                            );
                        }),
                }
            )
        );
        expect(deadline).toMatchObject({ reason: "unavailable" });
    });
});
