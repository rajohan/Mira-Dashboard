import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    listWorkspaceFilesInputSchema,
    listWorkspaceFilesOutputSchema,
    prepareWorkspaceFileUploadInputSchema,
    workspaceFileEntrySchema,
    workspaceFileLimits,
    workspaceFileNameSchema,
    workspaceFileProcedureContracts,
    workspaceFileRawHttpContracts,
} from "./files.ts";

const resourceId = "22222222-2222-4222-8222-222222222222";
const revision = "a".repeat(64);

describe("workspace files contracts", () => {
    test("lists metadata for files larger than the separate download budget", () => {
        expect(
            v.safeParse(workspaceFileEntrySchema, {
                kind: "file",
                name: "large.log",
                resourceId: resourceId,
                revision,
                sizeBytes: workspaceFileLimits.maximumDownloadBytes + 1,
                writable: false,
            }).success
        ).toBe(true);
    });
    test("publishes bounded session reads and recent-MFA worker writes", () => {
        expect(
            workspaceFileProcedureContracts.map(({ access, kind, name }) => ({
                access,
                kind,
                name,
            }))
        ).toEqual([
            {
                access: {
                    capabilities: ["files:read"],
                    capabilityPolicy: "all",
                    kind: "authenticated",
                    principalKinds: ["session"],
                },
                kind: "query",
                name: "files.listRoots",
            },
            expect.objectContaining({ kind: "query", name: "files.list" }),
            expect.objectContaining({ kind: "query", name: "files.prepareContent" }),
            {
                access: {
                    capabilities: ["files:write"],
                    kind: "recent-auth",
                    principalKinds: ["session"],
                    whenMfaDisabled: "deny",
                    whenMfaEnabled: "mfa",
                },
                kind: "mutation",
                name: "files.prepareWrite",
            },
            {
                access: {
                    capabilities: ["files:write"],
                    kind: "recent-auth",
                    principalKinds: ["session"],
                    whenMfaDisabled: "deny",
                    whenMfaEnabled: "mfa",
                },
                kind: "mutation",
                name: "files.prepareReveal",
            },
            expect.objectContaining({ kind: "mutation", name: "files.prepareUpload" }),
            expect.objectContaining({ kind: "query", name: "files.getWriteStatus" }),
        ]);
    });

    test("publishes only ticket-based raw paths with explicit transfer budgets", () => {
        expect(
            workspaceFileRawHttpContracts.map(({ method, path }) => [method, path])
        ).toEqual([
            ["GET", "/api/files/content/:ticketId"],
            ["HEAD", "/api/files/content/:ticketId"],
            ["PUT", "/api/files/uploads/:ticketId"],
        ]);
        expect(workspaceFileRawHttpContracts[0]?.response).toMatchObject({
            maximumBytes: workspaceFileLimits.maximumDownloadBytes,
        });
        expect(workspaceFileRawHttpContracts[2]?.requestBody).toMatchObject({
            maximumBytes: workspaceFileLimits.maximumUploadBytes,
            transfer: "streamed",
        });
    });

    test("rejects traversal-shaped names and oversized upload declarations", () => {
        for (const name of [".", "..", "../secret", "child/name", String.raw`child\name`])
            expect(() => v.parse(workspaceFileNameSchema, name)).toThrow();
        expect(() =>
            v.parse(prepareWorkspaceFileUploadInputSchema, {
                directoryId: resourceId,
                fileName: "large.bin",
                mimeType: "application/octet-stream",
                sizeBytes: workspaceFileLimits.maximumUploadBytes + 1,
            })
        ).toThrow();
    });

    test("defaults and caps directory pages", () => {
        expect(
            v.parse(listWorkspaceFilesInputSchema, { directoryId: resourceId })
        ).toEqual({
            directoryId: resourceId,
            limit: workspaceFileLimits.listPageDefault,
        });
        expect(() =>
            v.parse(listWorkspaceFilesInputSchema, {
                directoryId: resourceId,
                limit: workspaceFileLimits.listPageMaximum + 1,
            })
        ).toThrow();
    });

    test("requires strict bounded result objects", () => {
        const result = {
            directory: {
                displayPath: "/",
                name: "Workspace",
                resourceId,
                revision,
                rootId: "workspace",
                writable: true,
            },
            entries: [
                {
                    kind: "file",
                    mimeType: "text/plain",
                    modifiedAtMs: 1,
                    name: "README.md",
                    previewKind: "text",
                    resourceId: "33333333-3333-4333-8333-333333333333",
                    revision,
                    sizeBytes: 42,
                    writable: true,
                },
            ],
        };
        expect(v.parse(listWorkspaceFilesOutputSchema, result)).toEqual(result);
        expect(() =>
            v.parse(listWorkspaceFilesOutputSchema, { ...result, hostPath: "/srv" })
        ).toThrow();
    });
});
