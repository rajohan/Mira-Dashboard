import { describe, expect, jest, test } from "bun:test";

import type {
    WorkspaceFileContentTicket,
    WorkspaceFileEntry,
} from "../../contracts/files.ts";
import type { WorkspaceFileClient } from "./workspaceFileClient.ts";
import {
    prepareWorkspaceFilePreview,
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
