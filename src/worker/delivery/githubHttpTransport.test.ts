import { describe, expect, test } from "bun:test";

import { Redacted } from "effect";

import {
    createDeliveryGitHubHttpTransport,
    DeliveryGitHubError,
    type DeliveryGitHubFetch,
} from "./githubHttpTransport.ts";

function token(value = "github_pat_test_value_long_enough") {
    return Redacted.make(value, { label: "test-github-token" });
}

describe("Delivery GitHub HTTPS transport", () => {
    test("gates ordinary requests on the exact Mira identity and fixed HTTPS authority", async () => {
        const calls: Array<{
            authorization: string | null;
            redirect?: "error" | "follow" | "manual";
            url: string;
        }> = [];
        const fetch: DeliveryGitHubFetch = (input, init) => {
            const headers = new Headers(init.headers);
            calls.push({
                authorization: headers.get("authorization"),
                redirect: init.redirect,
                url: input,
            });
            if (input.endsWith("/user")) {
                return Promise.resolve(
                    Response.json({
                        avatar_url: "https://avatars.githubusercontent.com/u/42",
                        id: 42,
                        login: "mira-2026",
                        type: "User",
                    })
                );
            }
            return Promise.resolve(
                Response.json({ object: { sha: "a".repeat(40), type: "commit" } })
            );
        };
        const transport = createDeliveryGitHubHttpTransport({
            expectedLogin: "mira-2026",
            fetch,
            readRetryDelayMs: 0,
            token: token(),
        });

        await transport.requestJson({ kind: "main-ref" });
        await transport.requestJson({ kind: "main-ref" });

        expect(transport.verifyIdentity()).resolves.toEqual({
            id: 42,
            login: "mira-2026",
            type: "User",
        });

        expect(calls.map(({ url }) => url)).toEqual([
            "https://api.github.com/user",
            "https://api.github.com/repos/rajohan/Mira-Dashboard/git/ref/heads/main",
            "https://api.github.com/repos/rajohan/Mira-Dashboard/git/ref/heads/main",
        ]);
        expect(calls.every(({ redirect }) => redirect === "error")).toBeTrue();
        expect(
            calls.every(({ authorization }) => authorization?.startsWith("Bearer "))
        ).toBeTrue();
    });

    test("reads the latest release from the fixed repository authority", () => {
        const calls: string[] = [];
        const transport = createDeliveryGitHubHttpTransport({
            expectedLogin: "mira-2026",
            fetch: (input) => {
                calls.push(input);
                return Promise.resolve(
                    calls.length === 1
                        ? Response.json({ id: 42, login: "mira-2026", type: "User" })
                        : Response.json({ tag_name: "v1.2.3" })
                );
            },
            token: token(),
        });

        expect(transport.requestJson({ kind: "latest-release" })).resolves.toEqual({
            tag_name: "v1.2.3",
        });
        expect(calls.at(-1)).toBe(
            "https://api.github.com/repos/rajohan/Mira-Dashboard/releases/latest"
        );
    });

    test("resolves one release tag through the fixed commit endpoint", () => {
        const calls: string[] = [];
        const transport = createDeliveryGitHubHttpTransport({
            expectedLogin: "mira-2026",
            fetch: (input) => {
                calls.push(input);
                return Promise.resolve(
                    calls.length === 1
                        ? Response.json({ id: 42, login: "mira-2026", type: "User" })
                        : Response.json({ sha: "a".repeat(40) })
                );
            },
            token: token(),
        });

        expect(
            transport.requestJson({
                kind: "release-tag-commit",
                tagName: "v1.2.3",
            })
        ).resolves.toEqual({ sha: "a".repeat(40) });
        expect(calls.at(-1)).toBe(
            "https://api.github.com/repos/rajohan/Mira-Dashboard/commits/v1.2.3"
        );
    });

    test("rejects identity mismatch without calling the requested endpoint", async () => {
        const calls: string[] = [];
        const transport = createDeliveryGitHubHttpTransport({
            expectedLogin: "rajohan",
            fetch: (input) => {
                calls.push(input);
                return Promise.resolve(
                    Response.json({ id: 42, login: "mira-2026", type: "User" })
                );
            },
            token: token(),
        });

        const error = await transport
            .requestJson({
                expectedHeadSha: "a".repeat(40),
                kind: "pull-request-review-approve",
                pullRequestNumber: 12,
            })
            .catch((error: unknown) => error);

        expect(error).toBeInstanceOf(DeliveryGitHubError);
        expect((error as DeliveryGitHubError).reason).toBe("authentication");
        expect(calls).toEqual(["https://api.github.com/user"]);
    });

    test("classifies dispatch failures for mutations as unknown and never exposes provider bodies", async () => {
        let calls = 0;
        const transport = createDeliveryGitHubHttpTransport({
            expectedLogin: "mira-2026",
            fetch: () => {
                calls += 1;
                if (calls === 1) {
                    return Promise.resolve(
                        Response.json({ id: 42, login: "mira-2026", type: "User" })
                    );
                }
                throw new Error("secret upstream diagnostic");
            },
            token: token(),
        });

        const error = await transport
            .requestJson({
                expectedHeadSha: "a".repeat(40),
                kind: "pull-request-merge",
                pullRequestNumber: 12,
            })
            .catch((error: unknown) => error);

        expect(error).toBeInstanceOf(DeliveryGitHubError);
        expect((error as DeliveryGitHubError).reason).toBe("unknown-outcome");
        expect(String(error)).not.toContain("secret");
    });

    test("bounds streamed provider responses", async () => {
        let calls = 0;
        const transport = createDeliveryGitHubHttpTransport({
            expectedLogin: "mira-2026",
            fetch: () => {
                calls += 1;
                if (calls === 1) {
                    return Promise.resolve(
                        Response.json({ id: 42, login: "mira-2026", type: "User" })
                    );
                }
                return Promise.resolve(new Response("x".repeat(8 * 1024 * 1024 + 1)));
            },
            readRetryDelayMs: 0,
            token: token(),
        });

        const error = await transport
            .requestJson({ kind: "main-ref" })
            .catch((error: unknown) => error);

        expect(error).toBeInstanceOf(DeliveryGitHubError);
        expect((error as DeliveryGitHubError).reason).toBe("limit-exceeded");
    });

    test("treats an invalid successful mutation response as unknown", async () => {
        let calls = 0;
        const transport = createDeliveryGitHubHttpTransport({
            expectedLogin: "mira-2026",
            fetch: () => {
                calls += 1;
                return Promise.resolve(
                    calls === 1
                        ? Response.json({ id: 42, login: "mira-2026", type: "User" })
                        : new Response("not-json", { status: 200 })
                );
            },
            token: token(),
        });

        const error = await transport
            .requestJson({
                expectedHeadSha: "a".repeat(40),
                kind: "pull-request-merge",
                pullRequestNumber: 12,
            })
            .catch((error: unknown) => error);

        expect(error).toBeInstanceOf(DeliveryGitHubError);
        expect((error as DeliveryGitHubError).reason).toBe("unknown-outcome");
    });

    test("retries only safe reads after a bounded transient response", () => {
        let calls = 0;
        const transport = createDeliveryGitHubHttpTransport({
            expectedLogin: "mira-2026",
            fetch: () => {
                calls += 1;
                if (calls === 1) {
                    return Promise.resolve(
                        Response.json({ id: 42, login: "mira-2026", type: "User" })
                    );
                }
                return Promise.resolve(
                    calls === 2
                        ? new Response("", { status: 502 })
                        : Response.json({ object: { sha: "a".repeat(40) } })
                );
            },
            readRetryDelayMs: 0,
            token: token(),
        });

        expect(transport.requestJson({ kind: "main-ref" })).resolves.toEqual({
            object: { sha: "a".repeat(40) },
        });
        expect(calls).toBe(3);
    });

    test("retains the bounded 202 status for asynchronous update-branch semantics", () => {
        let calls = 0;
        const transport = createDeliveryGitHubHttpTransport({
            expectedLogin: "mira-2026",
            fetch: () => {
                calls += 1;
                return Promise.resolve(
                    calls === 1
                        ? Response.json({
                              id: 42,
                              login: "mira-2026",
                              type: "User",
                          })
                        : Response.json(
                              {
                                  message: "Updating pull request branch",
                                  url: "https://api.github.com/update/1",
                              },
                              { status: 202 }
                          )
                );
            },
            token: token(),
        });

        expect(
            transport.requestJsonWithStatus({
                expectedHeadSha: "a".repeat(40),
                kind: "pull-request-update-branch",
                pullRequestNumber: 12,
            })
        ).resolves.toEqual({
            body: {
                message: "Updating pull request branch",
                url: "https://api.github.com/update/1",
            },
            status: 202,
        });
    });
});
