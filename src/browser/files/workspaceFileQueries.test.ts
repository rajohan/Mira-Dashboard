import { describe, expect, test } from "bun:test";

import type { ListWorkspaceFilesOutput } from "../../contracts/files.ts";
import { accumulateWorkspaceFilePages } from "./workspaceFileQueries.ts";

const directoryId = "11111111-1111-4111-8111-111111111111";
const revision = "a".repeat(64);

function page(
    entryId: string,
    overrides: Partial<ListWorkspaceFilesOutput> = {}
): ListWorkspaceFilesOutput {
    return {
        directory: {
            displayPath: "/docs",
            name: "docs",
            resourceId: directoryId,
            revision,
            rootId: "workspace",
            writable: true,
        },
        entries: [
            {
                kind: "file",
                mimeType: "text/plain",
                name: `${entryId}.txt`,
                previewKind: "text",
                resourceId: entryId,
                revision,
                sizeBytes: 4,
                writable: true,
            },
        ],
        ...overrides,
    };
}

describe("workspace file query projection", () => {
    test("combines pages from one exact directory revision", () => {
        const cursor = "44444444-4444-4444-8444-444444444444";
        const accumulated = accumulateWorkspaceFilePages([
            page("22222222-2222-4222-8222-222222222222", {
                nextCursor: cursor,
            }),
            page("33333333-3333-4333-8333-333333333333"),
        ]);

        expect(accumulated).toMatchObject({
            stable: true,
            entries: [
                { resourceId: "22222222-2222-4222-8222-222222222222" },
                { resourceId: "33333333-3333-4333-8333-333333333333" },
            ],
        });
        expect(accumulated?.nextCursor).toBeUndefined();
    });

    test("stops before combining a changed directory revision", () => {
        const accumulated = accumulateWorkspaceFilePages([
            page("22222222-2222-4222-8222-222222222222"),
            page("33333333-3333-4333-8333-333333333333", {
                directory: {
                    ...page("55555555-5555-4555-8555-555555555555").directory,
                    revision: "b".repeat(64),
                },
            }),
        ]);

        expect(accumulated?.stable).toBe(false);
        expect(accumulated?.entries).toHaveLength(1);
    });

    test("rejects repeated opaque resource identities across pages", () => {
        const entryId = "22222222-2222-4222-8222-222222222222";
        const accumulated = accumulateWorkspaceFilePages([page(entryId), page(entryId)]);

        expect(accumulated?.stable).toBe(false);
        expect(accumulated?.entries).toHaveLength(1);
    });
});
