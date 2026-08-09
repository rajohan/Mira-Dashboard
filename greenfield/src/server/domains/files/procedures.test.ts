import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";

import type { RequestAuthentication } from "../../../contracts/security.ts";
import {
    createTestAutomationAuthentication,
    createTestRequestContext,
    createTestSessionAuthentication,
} from "../../test/support/requestContext.ts";
import type { RequestContext } from "../../trpc/context.ts";
import { router } from "../../trpc/trpc.ts";
import { WorkspaceFileError } from "./errors.ts";
import { workspaceFilesRouter } from "./procedures.ts";
import type { WorkspaceFilesService } from "./service.ts";

const resourceId = "20000000-0000-4000-8000-000000000001";
const ticketId = "20000000-0000-4000-8000-000000000002";
const filesTestRouter = router({ files: workspaceFilesRouter });

function service(overrides: Partial<WorkspaceFilesService> = {}): WorkspaceFilesService {
    return {
        acceptUpload: () => Promise.reject(new Error("unused")),
        cleanupUploadOrphans: () => Promise.reject(new Error("unused")),
        dispose: () => Promise.resolve(),
        getWriteStatus: () => Promise.reject(new Error("unused")),
        inspectContent: () => Promise.reject(new Error("unused")),
        inspectUpload: () => {
            throw new Error("unused");
        },
        list: () => Promise.reject(new Error("unused")),
        listRoots: () =>
            Promise.resolve({
                roots: [
                    {
                        id: "workspace",
                        label: "Workspace",
                        resourceId,
                        writable: true,
                    },
                ],
            }),
        prepareContent: () => Promise.reject(new Error("unused")),
        prepareUpload: () =>
            Promise.resolve({
                expiresAtMs: 1_900_000_000_000,
                ticketId,
                uploadUrl: `/api/files/uploads/${ticketId}`,
            }),
        prepareWrite: () => Promise.reject(new Error("unused")),
        readContent: () => Promise.reject(new Error("unused")),
        ...overrides,
    };
}

async function caller(
    authentication?: RequestAuthentication,
    overrides: Partial<WorkspaceFilesService> = {},
    recentAuthentication: "authorized" | "step-up-required" = "authorized"
) {
    const context = await createTestRequestContext(authentication);
    return filesTestRouter.createCaller({
        ...context,
        workspaceFileRecentAuthenticationAccess: {
            authorizeRecentMfa: () => recentAuthentication,
        },
        workspaceFilesService: service(overrides),
    } as RequestContext).files;
}

async function expectCode(
    operation: () => Promise<unknown>,
    code: TRPCError["code"]
): Promise<void> {
    const error = await operation().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe(code);
}

describe("workspace files procedures", () => {
    test("requires an exact session capability for metadata reads", async () => {
        const anonymous = await caller(undefined, {});
        await expectCode(() => anonymous.listRoots({}), "UNAUTHORIZED");

        const automation = await caller(
            createTestAutomationAuthentication(["files:read"])
        );
        await expectCode(() => automation.listRoots({}), "FORBIDDEN");

        const missing = await caller(createTestSessionAuthentication(["files:write"]));
        await expectCode(() => missing.listRoots({}), "FORBIDDEN");

        const allowed = await caller(createTestSessionAuthentication(["files:read"]));
        expect(await allowed.listRoots({})).toEqual({
            roots: [
                {
                    id: "workspace",
                    label: "Workspace",
                    resourceId,
                    writable: true,
                },
            ],
        });
    });

    test("requires recent MFA before creating an upload reservation", async () => {
        let calls = 0;
        const stale = await caller(
            createTestSessionAuthentication(["files:write"]),
            {
                prepareUpload: () => {
                    calls += 1;
                    throw new Error("must not run");
                },
            },
            "step-up-required"
        );
        const error = await stale
            .prepareUpload({
                directoryId: resourceId,
                fileName: "new.txt",
                mimeType: "text/plain",
                sizeBytes: 1,
            })
            .catch((error: unknown) => error);
        expect(error).toBeInstanceOf(TRPCError);
        expect(error).toMatchObject({ code: "FORBIDDEN" });
        expect(error).toHaveProperty("cause.reason", "step_up_required");
        expect(calls).toBe(0);

        const allowed = await caller(createTestSessionAuthentication(["files:write"]));
        expect(
            await allowed.prepareUpload({
                directoryId: resourceId,
                fileName: "new.txt",
                mimeType: "text/plain",
                sizeBytes: 1,
            })
        ).toMatchObject({ ticketId });
    });

    test("maps sanitized domain failures to declared transport errors", async () => {
        const conflict = await caller(createTestSessionAuthentication(["files:read"]), {
            list: () => Promise.reject(new WorkspaceFileError("conflict")),
        });
        await expectCode(
            () => conflict.list({ directoryId: resourceId, limit: 10 }),
            "CONFLICT"
        );

        const unavailable = await caller(
            createTestSessionAuthentication(["files:read"]),
            {
                getWriteStatus: () =>
                    Promise.reject(new WorkspaceFileError("unavailable")),
            }
        );
        await expectCode(
            () => unavailable.getWriteStatus({ ticketId }),
            "SERVICE_UNAVAILABLE"
        );
    });
});
