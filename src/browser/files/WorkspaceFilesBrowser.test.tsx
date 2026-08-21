import { describe, expect, jest, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type {
    ListWorkspaceFilesOutput,
    WorkspaceFileRoot,
} from "../../contracts/files.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { WorkspaceFilesBrowser } from "./WorkspaceFilesBrowser.tsx";

const { render, screen, waitFor } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const revision = "a".repeat(64);
const root: WorkspaceFileRoot = {
    id: "workspace",
    label: "Workspace",
    resourceId: "11111111-1111-4111-8111-111111111111",
    writable: true,
};
const guideId = "22222222-2222-4222-8222-222222222222";
const imageId = "55555555-5555-4555-8555-555555555555";
const imageEntry = {
    kind: "file" as const,
    mimeType: "image/png",
    modifiedAtMs: 1_800_000_000_000,
    name: "diagram.png",
    previewKind: "image" as const,
    resourceId: imageId,
    revision,
    sizeBytes: 512,
    writable: true,
};

const rootPage: ListWorkspaceFilesOutput = {
    directory: {
        displayPath: "/",
        name: "workspace",
        resourceId: root.resourceId,
        revision,
        rootId: root.id,
        writable: true,
    },
    entries: [
        {
            kind: "directory",
            name: "guides",
            resourceId: guideId,
            revision,
            writable: true,
        },
        imageEntry,
    ],
};

function renderBrowser(client: DashboardTrpcClient) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(
        <QueryClientProvider client={queryClient}>
            <DashboardTrpcProvider client={client}>
                <WorkspaceFilesBrowser />
            </DashboardTrpcProvider>
        </QueryClientProvider>
    );
}

describe("WorkspaceFilesBrowser", () => {
    test("keeps the explorer mounted while a clicked folder query is pending", async () => {
        let resolveGuide!: (page: ListWorkspaceFilesOutput) => void;
        const guidePage = new Promise<ListWorkspaceFilesOutput>((resolve) => {
            resolveGuide = resolve;
        });
        const query = jest.fn((name: string, input: unknown) => {
            if (name === "files.listRoots") {
                return Promise.resolve({ roots: [root] });
            }
            if (name === "files.list") {
                const directoryId = (input as { readonly directoryId: string })
                    .directoryId;
                return directoryId === guideId ? guidePage : Promise.resolve(rootPage);
            }
            return Promise.reject(new Error("Unexpected Files query"));
        });
        const client = {
            mutation: () => Promise.reject(new Error("Unexpected Files mutation")),
            query,
        } as unknown as DashboardTrpcClient;
        const user = userEvent.setup();
        renderBrowser(client);

        const tree = await screen.findByRole("navigation", {
            name: "Workspace file tree",
        });
        await user.click(screen.getByRole("button", { name: "guides" }));

        expect(screen.getByTestId("workspace-folder-loading")).toHaveAttribute(
            "aria-busy",
            "true"
        );
        expect(screen.getByRole("navigation", { name: "Workspace file tree" })).toBe(
            tree
        );
        expect(screen.queryByText("Loading workspace files…")).toBeNull();

        resolveGuide({
            directory: {
                displayPath: "/guides",
                name: "guides",
                resourceId: guideId,
                revision: "b".repeat(64),
                rootId: root.id,
                writable: true,
            },
            entries: [
                {
                    kind: "file",
                    mimeType: "text/plain",
                    modifiedAtMs: 1_800_000_000_000,
                    name: "guide.txt",
                    previewKind: "text",
                    resourceId: "33333333-3333-4333-8333-333333333333",
                    revision,
                    sizeBytes: 5,
                    writable: true,
                },
            ],
        });

        await screen.findByRole("button", { name: "guide.txt" });
        await waitFor(() =>
            expect(screen.queryByTestId("workspace-folder-loading")).toBeNull()
        );
        expect(screen.getByRole("button", { name: "guide.txt" })).toBeTruthy();
        expect(screen.getByRole("navigation", { name: "Workspace file tree" })).toBe(
            tree
        );
    });

    test("keeps an open preview while navigating to another folder", async () => {
        let resolveGuide!: (page: ListWorkspaceFilesOutput) => void;
        const guidePage = new Promise<ListWorkspaceFilesOutput>((resolve) => {
            resolveGuide = resolve;
        });
        const query = jest.fn((name: string, input: unknown) => {
            if (name === "files.listRoots") {
                return Promise.resolve({ roots: [root] });
            }
            if (name === "files.list") {
                const directoryId = (input as { readonly directoryId: string })
                    .directoryId;
                return directoryId === guideId ? guidePage : Promise.resolve(rootPage);
            }
            if (name === "files.prepareContent") {
                return Promise.resolve({
                    disposition: "preview" as const,
                    expiresAtMs: 1_900_000_000_000,
                    fileName: imageEntry.name,
                    mimeType: imageEntry.mimeType,
                    previewKind: imageEntry.previewKind,
                    revision,
                    sizeBytes: imageEntry.sizeBytes,
                    ticketId: "44444444-4444-4444-8444-444444444444",
                    url: "/api/files/content/44444444-4444-4444-8444-444444444444",
                });
            }
            return Promise.reject(new Error("Unexpected Files query"));
        });
        const client = {
            mutation: () => Promise.reject(new Error("Unexpected Files mutation")),
            query,
        } as unknown as DashboardTrpcClient;
        const user = userEvent.setup();
        renderBrowser(client);

        await user.click(await screen.findByRole("button", { name: imageEntry.name }));
        expect(
            await screen.findByRole("heading", { name: imageEntry.name })
        ).toBeTruthy();

        await user.click(screen.getByRole("button", { name: "guides" }));

        expect(screen.getByRole("heading", { name: imageEntry.name })).toBeTruthy();
        expect(screen.queryByTestId("workspace-folder-loading")).toBeNull();

        resolveGuide({
            directory: {
                displayPath: "/guides",
                name: "guides",
                resourceId: guideId,
                revision: "b".repeat(64),
                rootId: root.id,
                writable: true,
            },
            entries: [],
        });

        await waitFor(() => expect(screen.queryByText("Loading folder…")).toBeNull());
        expect(screen.getByRole("heading", { name: imageEntry.name })).toBeTruthy();
    });

    test("navigates the reviewed nested OpenClaw hook through opaque directory ids", async () => {
        const openClawRoot: WorkspaceFileRoot = {
            id: "openclaw-config",
            label: "OpenClaw Config",
            resourceId: "66666666-6666-4666-8666-666666666666",
            writable: false,
        };
        const hooksId = "77777777-7777-4777-8777-777777777777";
        const transformsId = "88888888-8888-4888-8888-888888888888";
        const agentmailId = "99999999-9999-4999-8999-999999999999";
        const source = "export const transform = true;\n";
        const pages = new Map<string, ListWorkspaceFilesOutput>([
            [
                openClawRoot.resourceId,
                {
                    directory: {
                        displayPath: "/",
                        name: openClawRoot.label,
                        resourceId: openClawRoot.resourceId,
                        revision,
                        rootId: openClawRoot.id,
                        writable: false,
                    },
                    entries: [
                        {
                            kind: "directory",
                            name: "hooks",
                            resourceId: hooksId,
                            revision,
                            writable: false,
                        },
                    ],
                },
            ],
            [
                hooksId,
                {
                    directory: {
                        displayPath: "/hooks",
                        name: "hooks",
                        resourceId: hooksId,
                        revision,
                        rootId: openClawRoot.id,
                        writable: false,
                    },
                    entries: [
                        {
                            kind: "directory",
                            name: "transforms",
                            resourceId: transformsId,
                            revision,
                            writable: false,
                        },
                    ],
                },
            ],
            [
                transformsId,
                {
                    directory: {
                        displayPath: "/hooks/transforms",
                        name: "transforms",
                        resourceId: transformsId,
                        revision,
                        rootId: openClawRoot.id,
                        writable: false,
                    },
                    entries: [
                        {
                            kind: "file",
                            mimeType: "text/plain",
                            name: "agentmail.ts",
                            previewKind: "text",
                            resourceId: agentmailId,
                            revision,
                            sizeBytes: Buffer.byteLength(source),
                            writable: true,
                        },
                    ],
                },
            ],
        ]);
        const query = jest.fn((name: string, input: unknown) => {
            if (name === "files.listRoots") {
                return Promise.resolve({ roots: [openClawRoot] });
            }
            if (name === "files.list") {
                const directoryId = (input as { readonly directoryId: string })
                    .directoryId;
                const page = pages.get(directoryId);
                return page === undefined
                    ? Promise.reject(new Error("Unknown OpenClaw directory"))
                    : Promise.resolve(page);
            }
            if (name === "files.prepareContent") {
                return Promise.resolve({
                    disposition: "preview" as const,
                    expiresAtMs: 1_900_000_000_000,
                    fileName: "agentmail.ts",
                    mimeType: "text/plain",
                    previewKind: "text" as const,
                    revision,
                    sizeBytes: Buffer.byteLength(source),
                    ticketId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    url: "/api/files/content/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                });
            }
            return Promise.reject(new Error("Unexpected Files query"));
        });
        const client = {
            mutation: () => Promise.reject(new Error("Unexpected Files mutation")),
            query,
        } as unknown as DashboardTrpcClient;
        const fetcher = jest
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(new Response(source));
        const user = userEvent.setup();

        try {
            renderBrowser(client);
            await user.click(await screen.findByRole("button", { name: "hooks" }));
            await user.click(await screen.findByRole("button", { name: "transforms" }));
            await user.click(await screen.findByRole("button", { name: "agentmail.ts" }));

            expect(
                await screen.findByRole("heading", { name: "agentmail.ts" })
            ).toBeTruthy();
            expect(
                await screen.findByRole("region", { name: "agentmail.ts source" })
            ).toHaveTextContent(source.trim());
            expect(
                query.mock.calls
                    .filter(([name]) => name === "files.list")
                    .map(
                        ([, input]) =>
                            (input as { readonly directoryId: string }).directoryId
                    )
            ).toEqual([openClawRoot.resourceId, hooksId, transformsId]);
        } finally {
            fetcher.mockRestore();
        }
    });
});
