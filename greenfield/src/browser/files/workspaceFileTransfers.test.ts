import { describe, expect, jest, test } from "bun:test";

import {
    workspaceFileLimits,
    type WorkspaceFileContentTicket,
    type WorkspaceFileEntry,
} from "../../contracts/files.ts";
import type { WorkspaceFileClient } from "./workspaceFileClient.ts";
import {
    prepareWorkspaceFilePreview,
    revealWorkspaceFileSecrets,
    uploadWorkspaceFile,
    validateWorkspaceFileSelection,
} from "./workspaceFileTransfers.ts";

const entryId = "22222222-2222-4222-8222-222222222222";
const ticketId = "33333333-3333-4333-8333-333333333333";
const revision = "a".repeat(64);

const entry: WorkspaceFileEntry = {
    kind: "file",
    mimeType: "text/plain",
    name: "README.md",
    previewKind: "text",
    resourceId: entryId,
    revision,
    sizeBytes: 5,
    writable: true,
};

function contentTicket(): WorkspaceFileContentTicket {
    return {
        disposition: "preview",
        expiresAtMs: Date.now() + 60_000,
        fileName: entry.name,
        mimeType: "text/plain",
        previewKind: "text",
        revision,
        sizeBytes: 5,
        ticketId,
        url: `/api/files/content/${ticketId}`,
    };
}

function client(operations: {
    readonly mutation?: (...arguments_: unknown[]) => Promise<unknown>;
    readonly query?: (...arguments_: unknown[]) => Promise<unknown>;
}): WorkspaceFileClient {
    return {
        mutation: (operations.mutation ??
            (() =>
                Promise.reject(
                    new Error("mutation")
                ))) as WorkspaceFileClient["mutation"],
        query: (operations.query ??
            (() => Promise.reject(new Error("query")))) as WorkspaceFileClient["query"],
    };
}

describe("workspace file transfers", () => {
    test("materializes bounded UTF-8 text without rendering HTML", async () => {
        const query = jest.fn(() => Promise.resolve(contentTicket()));
        const result = await prepareWorkspaceFilePreview(
            client({ query }),
            entry,
            new AbortController().signal,
            () => Promise.resolve(new Response("hello"))
        );

        expect(result.content).toBe("hello");
        expect(query).toHaveBeenCalledWith(
            "files.prepareContent",
            { disposition: "preview", resourceId: entryId },
            expect.anything()
        );
    });

    test("keeps oversized text projections download-only without fetching them", async () => {
        const oversizedTextBytes = workspaceFileLimits.maximumTextPreviewBytes + 1;
        const largeEntry: WorkspaceFileEntry = {
            ...entry,
            previewKind: "download-only",
            sizeBytes: oversizedTextBytes,
        };
        const ticket: WorkspaceFileContentTicket = {
            ...contentTicket(),
            previewKind: "download-only",
            sizeBytes: oversizedTextBytes,
        };
        const fetcher = jest.fn(() => Promise.reject(new Error("must not fetch")));

        const result = await prepareWorkspaceFilePreview(
            client({ query: () => Promise.resolve(ticket) }),
            largeEntry,
            new AbortController().signal,
            fetcher
        );

        expect(result).toEqual({ ticket });
        expect(fetcher).not.toHaveBeenCalled();
    });

    test("forwards an oversized reveal authority without materializing raw config", async () => {
        const oversizedTextBytes = workspaceFileLimits.maximumTextPreviewBytes + 1;
        const uploadTicketId = "44444444-4444-4444-8444-444444444444";
        const secretEntry: WorkspaceFileEntry = {
            ...entry,
            mimeType: "application/json",
            name: "openclaw.json",
            previewKind: "download-only",
            requiresSecretReveal: true,
            sizeBytes: oversizedTextBytes,
        };
        const revealTicket: WorkspaceFileContentTicket = {
            ...contentTicket(),
            fileName: secretEntry.name,
            mimeType: "application/json",
            previewKind: "download-only",
            sizeBytes: oversizedTextBytes,
        };
        const mutation = jest.fn((...arguments_: unknown[]) =>
            arguments_[0] === "files.prepareReveal"
                ? Promise.resolve(revealTicket)
                : Promise.resolve({
                      expiresAtMs: Date.now() + 60_000,
                      ticketId: uploadTicketId,
                      uploadUrl: `/api/files/uploads/${uploadTicketId}`,
                  })
        );
        const fetcher = jest.fn((_input: RequestInfo | URL, init?: RequestInit) => {
            expect(init?.method).toBe("PUT");
            return Promise.resolve(
                Response.json(
                    {
                        acceptedAtMs: Date.now(),
                        jobRunId: "oversized-config-repair",
                        ticketId: uploadTicketId,
                    },
                    { status: 202 }
                )
            );
        });

        const revealed = await revealWorkspaceFileSecrets(
            client({ mutation }),
            secretEntry,
            new AbortController().signal,
            fetcher
        );
        expect(revealed).toEqual({
            revealTicketId: ticketId,
            secretsRevealed: true,
            ticket: revealTicket,
        });
        expect(fetcher).not.toHaveBeenCalled();

        await uploadWorkspaceFile(
            client({ mutation }),
            {
                expectedRevision: revision,
                file: new File(["{}"], "openclaw.json", {
                    type: "application/json",
                }),
                kind: "replace",
                mimeType: "application/json",
                revealTicketId: revealed.revealTicketId,
                resourceId: entryId,
            },
            new AbortController().signal,
            fetcher
        );
        expect(mutation).toHaveBeenLastCalledWith(
            "files.prepareWrite",
            expect.objectContaining({ revealTicketId: ticketId }),
            expect.anything()
        );
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test("reveals config through an uncached mutation and binds its write ticket", async () => {
        const secretEntry: WorkspaceFileEntry = {
            ...entry,
            name: "openclaw.json",
            requiresSecretReveal: true,
        };
        const revealTicket = {
            ...contentTicket(),
            fileName: secretEntry.name,
            mimeType: "application/json",
            sizeBytes: new TextEncoder().encode('{"token":"secret"}').byteLength,
        };
        const mutation = jest.fn((...arguments_: unknown[]) =>
            arguments_[0] === "files.prepareReveal"
                ? Promise.resolve(revealTicket)
                : Promise.resolve({
                      expiresAtMs: Date.now() + 60_000,
                      ticketId,
                      uploadUrl: `/api/files/uploads/${ticketId}`,
                  })
        );
        const fetcher = jest.fn((_input: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method === "PUT") {
                return Promise.resolve(
                    Response.json(
                        {
                            acceptedAtMs: Date.now(),
                            jobRunId: "file-write-job",
                            ticketId,
                        },
                        { status: 202 }
                    )
                );
            }
            expect(init).toMatchObject({ cache: "no-store" });
            return Promise.resolve(new Response('{"token":"secret"}'));
        });

        const revealed = await revealWorkspaceFileSecrets(
            client({ mutation }),
            secretEntry,
            new AbortController().signal,
            fetcher
        );
        expect(revealed).toMatchObject({
            content: '{"token":"secret"}',
            revealTicketId: ticketId,
            secretsRevealed: true,
        });
        expect(mutation).toHaveBeenCalledWith(
            "files.prepareReveal",
            { resourceId: entryId },
            expect.anything()
        );

        await uploadWorkspaceFile(
            client({ mutation }),
            {
                expectedRevision: revision,
                file: new File(["{}"], "openclaw.json", {
                    type: "application/json",
                }),
                kind: "replace",
                mimeType: "application/json",
                revealTicketId: revealed.revealTicketId,
                resourceId: entryId,
            },
            new AbortController().signal,
            fetcher
        );
        expect(mutation).toHaveBeenLastCalledWith(
            "files.prepareWrite",
            expect.objectContaining({ revealTicketId: ticketId }),
            expect.anything()
        );
    });

    test("prepares and accepts one exact same-origin upload", async () => {
        const mutation = jest.fn(() =>
            Promise.resolve({
                expiresAtMs: Date.now() + 60_000,
                ticketId,
                uploadUrl: `/api/files/uploads/${ticketId}`,
            })
        );
        const fetcher = jest.fn((_input: RequestInfo | URL, init?: RequestInit) =>
            Promise.resolve(
                Response.json(
                    {
                        acceptedAtMs: Date.now(),
                        jobRunId: "file-write-job",
                        ticketId,
                    },
                    { status: 202 }
                )
            ).then((response) => {
                expect(init).toMatchObject({
                    credentials: "same-origin",
                    method: "PUT",
                });
                return response;
            })
        );
        const file = new File(["hello"], "hello.txt", { type: "text/plain" });

        const result = await uploadWorkspaceFile(
            client({ mutation }),
            {
                directoryId: "11111111-1111-4111-8111-111111111111",
                file,
                kind: "create",
            },
            new AbortController().signal,
            fetcher
        );

        expect(result).toEqual({
            jobRunId: "file-write-job",
            status: "accepted",
            ticketId,
        });
        expect(mutation).toHaveBeenCalledWith(
            "files.prepareUpload",
            expect.objectContaining({
                fileName: "hello.txt",
                mimeType: "text/plain",
                sizeBytes: 5,
            }),
            expect.anything()
        );
    });

    test("normalizes browser-added MIME parameters to an allowlisted media type", async () => {
        const mutation = jest.fn(() =>
            Promise.resolve({
                expiresAtMs: Date.now() + 60_000,
                ticketId,
                uploadUrl: `/api/files/uploads/${ticketId}`,
            })
        );
        const file = new File(["hello"], "hello.txt", {
            type: "Text/Plain; Charset=UTF-8",
        });

        await uploadWorkspaceFile(
            client({ mutation }),
            {
                directoryId: "11111111-1111-4111-8111-111111111111",
                file,
                kind: "create",
            },
            new AbortController().signal,
            () =>
                Promise.resolve(
                    Response.json(
                        {
                            acceptedAtMs: Date.now(),
                            jobRunId: "file-write-job",
                            ticketId,
                        },
                        { status: 202 }
                    )
                )
        );

        expect(mutation).toHaveBeenCalledWith(
            "files.prepareUpload",
            expect.objectContaining({ mimeType: "text/plain" }),
            expect.anything()
        );
    });

    test("reconciles an ambiguous raw response without redispatching", async () => {
        const mutation = jest.fn(() =>
            Promise.resolve({
                expiresAtMs: Date.now() + 60_000,
                ticketId,
                uploadUrl: `/api/files/uploads/${ticketId}`,
            })
        );
        const query = jest.fn(() =>
            Promise.resolve({
                jobRunId: "reconciled-job",
                status: "accepted" as const,
                ticketId,
            })
        );

        const result = await uploadWorkspaceFile(
            client({ mutation, query }),
            {
                directoryId: "11111111-1111-4111-8111-111111111111",
                file: new File(["x"], "x.bin"),
                kind: "create",
            },
            new AbortController().signal,
            () => Promise.reject(new TypeError("network"))
        );

        expect(result.status).toBe("accepted");
        expect(mutation).toHaveBeenCalledTimes(1);
        expect(query).toHaveBeenCalledWith(
            "files.getWriteStatus",
            { ticketId },
            expect.anything()
        );
    });

    test("validates create names and byte limits before reservation", () => {
        expect(validateWorkspaceFileSelection(new File(["x"], "../escape"))).toContain(
            "valid literal name"
        );
        expect(
            validateWorkspaceFileSelection(
                new File([new Uint8Array(16 * 1024 * 1024 + 1)], "large.bin")
            )
        ).toContain("16 MiB");
    });
});
