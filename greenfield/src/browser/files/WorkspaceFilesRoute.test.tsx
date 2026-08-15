import { expect, jest, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { AuthStatus } from "../../contracts/auth.ts";
import type {
    ListWorkspaceFilesOutput,
    WorkspaceFileRoot,
} from "../../contracts/files.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { Route as filesLazyRoute } from "../routes/files.lazy.tsx";

const { act, render, screen } = await import("@testing-library/react");

const timestampMs = 1_800_000_000_000;
const authenticatedStatus = {
    session: {
        authenticatedAtMs: timestampMs,
        authMethod: "password",
        createdAtMs: timestampMs,
        expiresAtMs: timestampMs + 86_400_000,
        id: "a".repeat(32),
        isCurrent: true,
        lastSeenAtMs: timestampMs,
    },
    state: "authenticated",
    user: {
        id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
        username: "operator",
    },
} satisfies AuthStatus;
const root: WorkspaceFileRoot = {
    id: "workspace",
    label: "Mira workspace",
    resourceId: "11111111-1111-4111-8111-111111111111",
    writable: true,
};
const rootPage: ListWorkspaceFilesOutput = {
    directory: {
        displayPath: "/",
        name: "workspace",
        resourceId: root.resourceId,
        revision: "a".repeat(64),
        rootId: root.id,
        writable: true,
    },
    entries: [],
};

test("files lazy route waits for authentication before composing the workspace browser", async () => {
    const authentication = Promise.withResolvers<AuthStatus>();
    const query = jest.fn((name: string) => {
        if (name === "auth.status") return authentication.promise;
        if (name === "files.listRoots") return Promise.resolve({ roots: [root] });
        if (name === "files.list") return Promise.resolve(rootPage);
        return Promise.reject(new TypeError(`Unexpected Files query: ${name}`));
    });
    const client = {
        mutation: (name: string) =>
            Promise.reject(new TypeError(`Unexpected Files mutation: ${name}`)),
        query,
    } as unknown as DashboardTrpcClient;
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    const LazyFilesRoute = filesLazyRoute.options.component;
    if (LazyFilesRoute === undefined) {
        throw new TypeError("Files lazy route component is missing");
    }
    const view = render(
        <QueryClientProvider client={queryClient}>
            <DashboardTrpcProvider client={client}>
                <LazyFilesRoute />
            </DashboardTrpcProvider>
        </QueryClientProvider>
    );

    try {
        expect(filesLazyRoute.options.id).toBe("/files");
        expect(await screen.findByLabelText("Authentication status")).toHaveTextContent(
            "Checking your session…"
        );
        expect(
            screen.queryByRole("heading", { level: 2, name: "Workspace explorer" })
        ).toBeNull();
        expect(query).toHaveBeenCalledTimes(1);
        expect(query).toHaveBeenCalledWith("auth.status", {}, expect.any(Object));

        await act(async () => {
            authentication.resolve(authenticatedStatus);
            await authentication.promise;
        });

        expect(
            await screen.findByRole("heading", { level: 2, name: "Workspace explorer" })
        ).toBeVisible();
        expect(
            screen.getByRole("navigation", { name: "Workspace file tree" })
        ).toHaveTextContent("Mira workspace");
        expect(query).toHaveBeenCalledWith("files.listRoots", {}, expect.any(Object));
        expect(query).toHaveBeenCalledWith(
            "files.list",
            {
                directoryId: root.resourceId,
                limit: 100,
            },
            expect.any(Object)
        );
    } finally {
        view.unmount();
        queryClient.clear();
    }
});
