import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
    act,
    fireEvent,
    render,
    renderHook,
    screen,
    waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import {
    parseJsonText,
    requestBodyText,
    requestUrl,
} from "../../../../test/support/fetch";
import { DatabaseOverviewCard } from "../../components/features/dashboard/DatabaseOverviewCard";
import { DockerOverviewCard } from "../../components/features/dashboard/DockerOverviewCard";
import { GitOverviewCard } from "../../components/features/dashboard/GitOverviewCard";
import { JobsOverviewCard } from "../../components/features/dashboard/JobsOverviewCard";
import { LogRotationCard } from "../../components/features/dashboard/LogRotationCard";
import { QuotaOverviewCard } from "../../components/features/dashboard/QuotaOverviewCard";
import { ReportsOverviewCard } from "../../components/features/dashboard/ReportsOverviewCard";
import { ConfigSection } from "../../components/features/files/ConfigSection";
import { FileContentViewer } from "../../components/features/files/FileContentViewer";
import { FileTreeItem } from "../../components/features/files/FileTreeItem";
import { CodePreview } from "../../components/features/files/viewers/CodePreview";
import { JsonPreview } from "../../components/features/files/viewers/JsonPreview";
import { MarkdownPreview } from "../../components/features/files/viewers/MarkdownPreview";
import { JobExecutionQueueCard } from "../../components/features/jobs/JobExecutionQueueCard";
import { cacheKeys } from "../../hooks/useCache";
import { cronKeys } from "../../hooks/useCron";
import { useFileExplorerState } from "../../hooks/useFileExplorerState";
import { reportKeys } from "../../hooks/useReports";
import { scheduledJobKeys } from "../../hooks/useScheduledJobs";
import { useSessionActions } from "../../hooks/useSessionActions";
const originalFetch = fetch;
const originalAnimationFrame = {
    cancelAnimationFrame,
    requestAnimationFrame,
};
const animationFrameState = {
    id: 0,
    frames: new Map<number, FrameRequestCallback>(),
};
function requestAnimationFrameForTest(callback: FrameRequestCallback): number {
    const id = ++animationFrameState.id;
    animationFrameState.frames.set(id, callback);
    return id;
}
function cancelAnimationFrameForTest(handle: number): void {
    animationFrameState.frames.delete(handle);
}
beforeEach(() => {
    Object.defineProperties(globalThis, {
        requestAnimationFrame: {
            configurable: true,
            value: requestAnimationFrameForTest,
            writable: true,
        },
        cancelAnimationFrame: {
            configurable: true,
            value: cancelAnimationFrameForTest,
            writable: true,
        },
    });
});
afterEach(() => {
    Object.defineProperties(globalThis, {
        fetch: {
            configurable: true,
            value: originalFetch,
            writable: true,
        },
        requestAnimationFrame: {
            configurable: true,
            value: originalAnimationFrame.requestAnimationFrame,
            writable: true,
        },
        cancelAnimationFrame: {
            configurable: true,
            value: originalAnimationFrame.cancelAnimationFrame,
            writable: true,
        },
    });
    animationFrameState.frames.clear();
});
function renderWithQueryClient(children: ReactNode) {
    const queryClient = createQueryClient();
    return {
        ...render(
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
        queryClient,
    };
}
function createQueryClient() {
    return new QueryClient({
        defaultOptions: {
            mutations: {
                retry: false,
            },
            queries: {
                retry: false,
                staleTime: Infinity,
            },
        },
    });
}
describe("Dashboard file and overview components", () => {
    it("renders file content variants and editable text changes", async () => {
        const onContentChange = jest.fn();
        const baseFile = {
            content: "hello",
            isBinary: false,
            modified: "2026-06-24T10:00:00.000Z",
            path: "/tmp/readme.txt",
            size: 5,
        };
        const { rerender } = render(
            <FileContentViewer
                fileContent={{
                    ...baseFile,
                    size: 2_000_000,
                }}
                editedContent="hello"
                onContentChange={onContentChange}
                largeFileWarning={true}
                isEditable={false}
                markdownPreview={false}
                jsonPreview={false}
                codeEditMode={false}
                syntaxClass="syntax-test"
            />
        );
        expect(screen.getByText(/Large file/)).toBeInTheDocument();
        expect(screen.getByText("hello")).toBeInTheDocument();
        rerender(
            <FileContentViewer
                fileContent={{
                    ...baseFile,
                    content: "",
                    isBinary: true,
                    path: "/tmp/archive.bin",
                }}
                editedContent=""
                onContentChange={onContentChange}
                largeFileWarning={false}
                isEditable={false}
                markdownPreview={false}
                jsonPreview={false}
                codeEditMode={false}
                syntaxClass=""
            />
        );
        expect(screen.getByText("Binary file")).toBeInTheDocument();
        rerender(
            <FileContentViewer
                fileContent={{
                    ...baseFile,
                    content: "a",
                    isImage: true,
                    mimeType: "image/png",
                    path: "/tmp/image.png",
                }}
                editedContent=""
                onContentChange={onContentChange}
                largeFileWarning={false}
                isEditable={false}
                markdownPreview={false}
                jsonPreview={false}
                codeEditMode={false}
                syntaxClass=""
            />
        );
        expect(screen.getByAltText("image.png")).toHaveAttribute(
            "src",
            "data:image/png;base64,a"
        );
        rerender(
            <FileContentViewer
                fileContent={{
                    ...baseFile,
                    path: "/tmp/script.ts",
                }}
                editedContent="const ok = true;"
                onContentChange={onContentChange}
                largeFileWarning={false}
                isEditable={true}
                markdownPreview={false}
                jsonPreview={false}
                codeEditMode={true}
                syntaxClass="syntax-test"
            />
        );
        fireEvent.change(screen.getByDisplayValue("const ok = true;"), {
            target: {
                value: "const ok = false;",
            },
        });
        expect(onContentChange).toHaveBeenCalledWith("const ok = false;");
        rerender(
            <FileContentViewer
                fileContent={{
                    ...baseFile,
                    path: "/tmp/notes.md",
                }}
                editedContent="# Previewed notes"
                onContentChange={onContentChange}
                largeFileWarning={false}
                isEditable={true}
                markdownPreview={true}
                jsonPreview={false}
                codeEditMode={false}
                syntaxClass=""
            />
        );
        await waitFor(() => {
            expect(
                screen.getByRole("heading", {
                    name: "Previewed notes",
                })
            ).toBeInTheDocument();
        });
        rerender(
            <FileContentViewer
                fileContent={{
                    ...baseFile,
                    path: "/tmp/config.json",
                }}
                editedContent={JSON.stringify(
                    {
                        foo: "viewer",
                    },
                    undefined,
                    2
                )}
                onContentChange={onContentChange}
                largeFileWarning={false}
                isEditable={true}
                markdownPreview={false}
                jsonPreview={true}
                codeEditMode={false}
                syntaxClass=""
            />
        );
        await waitFor(() => {
            expect(screen.getByText("foo")).toBeInTheDocument();
            expect(
                screen.getByText((_content, element) =>
                    Boolean(
                        element?.classList.contains("string-value") &&
                        element.textContent?.includes("viewer")
                    )
                )
            ).toBeInTheDocument();
        });
        rerender(
            <FileContentViewer
                fileContent={{
                    ...baseFile,
                    path: "/tmp/script.ts",
                }}
                editedContent="const previewed = true;"
                onContentChange={onContentChange}
                largeFileWarning={false}
                isEditable={true}
                markdownPreview={false}
                jsonPreview={false}
                codeEditMode={false}
                syntaxClass=""
            />
        );
        await waitFor(() => {
            expect(screen.getByText(/previewed/)).toBeInTheDocument();
        });
        rerender(<MarkdownPreview content={"# Notes\n\n- one"} />);
        expect(
            screen.getByRole("heading", {
                name: "Notes",
            })
        ).toBeInTheDocument();
        rerender(<JsonPreview content="{foo: 'bar'}" />);
        expect(screen.getByText("foo")).toBeInTheDocument();
        rerender(<JsonPreview content={"{not json"} />);
        expect(
            screen.getAllByText((_content, element) =>
                Boolean(element?.textContent?.includes("Failed to parse JSON"))
            ).length
        ).toBeGreaterThan(0);
        rerender(<CodePreview language="ts" content="const covered = true;" />);
        expect(screen.getByText(/covered/)).toBeInTheDocument();
        rerender(
            <CodePreview language="graphql" content="query Viewer { viewer { id } }" />
        );
        const graphQlKeyword = screen.getByText("query", {
            selector: ".token",
        });
        expect(graphQlKeyword).toHaveTextContent("query");
        expect(graphQlKeyword).toHaveStyle({
            color: "#f92672",
        });
    });
    it("drives file explorer hook directory loading, JSON validation, and saves", async () => {
        let savedFileBody: unknown;
        const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (url === "/api/files" && method === "GET") {
                    return Response.json({
                        files: [
                            {
                                name: "src",
                                path: "src",
                                type: "directory",
                            },
                            {
                                name: "config.json5",
                                path: "src/config.json5",
                                size: 10,
                                type: "file",
                            },
                        ],
                    });
                }
                if (url === "/api/files?path=src" && method === "GET") {
                    return Response.json({
                        files: [
                            {
                                name: "config.json5",
                                path: "src/config.json5",
                                size: 10,
                                type: "file",
                            },
                        ],
                    });
                }
                if (url === "/api/files/src%2Fconfig.json5" && method === "GET") {
                    return Response.json({
                        content: "{foo: 1}",
                        isBinary: false,
                        modified: "2026-07-28T12:00:00.000Z",
                        path: "src/config.json5",
                        size: 10,
                    });
                }
                if (url === "/api/files/src%2Fconfig.json5" && method === "PUT") {
                    savedFileBody = parseJsonText(requestBodyText(init?.body));
                    return Response.json({
                        isSuccess: true,
                        modified: "2026-07-28T12:01:00.000Z",
                        path: "src/config.json5",
                        size: 10,
                    });
                }
                throw new Error(`Unexpected file explorer test fetch: ${method} ${url}`);
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const queryClient = createQueryClient();
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        );
        const { result, unmount } = renderHook(() => useFileExplorerState(), {
            wrapper,
        });
        await waitFor(() => {
            expect(result.current.files).toHaveLength(2);
        });
        await act(async () => {
            await result.current.handleToggle("src");
        });
        expect(result.current.expandedPaths.has("src")).toBe(true);
        expect(result.current.files[0]?.children).toHaveLength(1);
        await act(async () => {
            await result.current.handleToggle("src");
        });
        expect(result.current.expandedPaths.has("src")).toBe(false);
        act(() => {
            result.current.handleSelect("src/config.json5");
        });
        await waitFor(() => {
            expect(result.current.fileContent?.content).toBe("{foo: 1}");
        });
        act(() => {
            result.current.setJsonPreview(false);
            result.current.handleContentChange("{bad json");
        });
        expect(result.current.isJsonEditing).toBe(true);
        expect(result.current.jsonValidation.valid).toBe(false);
        await act(async () => {
            await result.current.handleSave();
        });
        expect(result.current.error).toMatch(/Invalid JSON/);
        act(() => {
            result.current.handleContentChange("{foo: 2}");
        });
        await act(async () => {
            await result.current.handleSave();
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/files/src%2Fconfig.json5",
            expect.objectContaining({
                method: "PUT",
            })
        );
        expect(savedFileBody).toEqual({
            content: "{foo: 2}",
        });
        act(() => {
            result.current.handleRefresh();
        });
        expect(result.current.hasChanges).toBe(false);
        unmount();
        queryClient.clear();
    });
    it("does not show a late secret reveal after selecting another config file", async () => {
        const { promise: revealResponse, resolve: resolveReveal } =
            Promise.withResolvers<Response>();
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (url === "/api/files" && method === "GET") {
                    return Response.json({
                        files: [],
                    });
                }
                if (url === "/api/config-files/openclaw.json" && method === "GET") {
                    return Response.json({
                        content: '{"token":"__MIRA_REDACTED__"}',
                        isBinary: false,
                        masked: true,
                        modified: "2026-07-28T12:00:00.000Z",
                        path: "config:openclaw.json",
                        size: 31,
                    });
                }
                if (url === "/api/config-files/other.json" && method === "GET") {
                    return Response.json({
                        content: '{"other":"masked"}',
                        isBinary: false,
                        masked: true,
                        modified: "2026-07-28T12:00:00.000Z",
                        path: "config:other.json",
                        size: 18,
                    });
                }
                if (
                    url === "/api/config-files/openclaw.json?reveal=1" &&
                    method === "GET"
                ) {
                    return revealResponse;
                }
                throw new Error(`Unexpected reveal-race test fetch: ${method} ${url}`);
            }
        );
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const queryClient = createQueryClient();
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        );
        const { result, unmount } = renderHook(() => useFileExplorerState(), {
            wrapper,
        });
        act(() => {
            result.current.handleSelect("config:openclaw.json");
        });
        await waitFor(() => {
            expect(result.current.fileContent?.content).toContain("__MIRA_REDACTED__");
        });
        let revealPromise: Promise<void> | undefined;
        act(() => {
            revealPromise = result.current.handleReveal();
        });
        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/config-files/openclaw.json?reveal=1",
                expect.objectContaining({
                    credentials: "include",
                })
            );
        });
        act(() => {
            result.current.handleSelect("config:other.json");
        });
        await waitFor(() => {
            expect(result.current.fileContent?.content).toBe('{"other":"masked"}');
        });
        resolveReveal(
            Response.json({
                content: '{"token":"raw-secret"}',
                isBinary: false,
                modified: "2026-07-28T12:00:00.000Z",
                path: "config:openclaw.json",
                size: 22,
            })
        );
        await act(async () => {
            await revealPromise;
        });
        expect(result.current.selectedPath).toBe("config:other.json");
        expect(result.current.fileContent?.content).toBe('{"other":"masked"}');
        unmount();
        queryClient.clear();
    });
    it("updates the revealed config baseline after a successful save", async () => {
        let savedContent: string | undefined;
        const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (url === "/api/files" && method === "GET") {
                    return Response.json({
                        files: [],
                    });
                }
                if (url === "/api/config-files/openclaw.json" && method === "GET") {
                    return Response.json({
                        content: '{"token":"__MIRA_REDACTED__"}',
                        isBinary: false,
                        masked: true,
                        modified: "2026-07-28T12:00:00.000Z",
                        path: "config:openclaw.json",
                        size: 31,
                    });
                }
                if (
                    url === "/api/config-files/openclaw.json?reveal=1" &&
                    method === "GET"
                ) {
                    return Response.json({
                        content: '{"token":"original-secret"}',
                        isBinary: false,
                        modified: "2026-07-28T12:00:00.000Z",
                        path: "config:openclaw.json",
                        size: 27,
                    });
                }
                if (url === "/api/config-files/openclaw.json" && method === "PUT") {
                    savedContent = (
                        JSON.parse(requestBodyText(init?.body)) as {
                            content: string;
                        }
                    ).content;
                    return Response.json({
                        isSuccess: true,
                        modified: "2026-07-28T12:01:00.000Z",
                        path: "config:openclaw.json",
                        relativePath: "openclaw.json",
                        size: 27,
                    });
                }
                throw new Error(
                    `Unexpected reveal-save baseline fetch: ${method} ${url}`
                );
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const queryClient = createQueryClient();
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        );
        const { result, unmount } = renderHook(() => useFileExplorerState(), {
            wrapper,
        });
        act(() => {
            result.current.handleSelect("config:openclaw.json");
        });
        await waitFor(() => {
            expect(result.current.fileContent?.masked).toBe(true);
        });
        await act(async () => {
            await result.current.handleReveal();
        });
        expect(result.current.fileContent?.content).toBe('{"token":"original-secret"}');
        act(() => {
            result.current.handleContentChange('{"token":"updated-secret"}');
        });
        await act(async () => {
            await result.current.handleSave();
        });
        expect(savedContent).toBe('{"token":"updated-secret"}');
        expect(result.current.fileContent?.content).toBe('{"token":"updated-secret"}');
        act(() => {
            result.current.handleContentChange('{"token":"original-secret"}');
        });
        expect(result.current.hasChanges).toBe(true);
        unmount();
        queryClient.clear();
    });
    it("keeps cached report metrics visible when a refresh fails", async () => {
        const fetchMock = jest.fn((input: RequestInfo | URL) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                if (url === "/api/reports") {
                    throw new Error("Reports refresh failed");
                }
                throw new Error(`Unexpected reports overview fetch: ${url}`);
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const queryClient = createQueryClient();
        queryClient.setQueryData(reportKeys.list(), {
            items: [
                {
                    bodyMd: "Heartbeat looks good.",
                    createdAt: "2026-06-24T10:05:00.000Z",
                    dedupeKey: "heartbeat:ok",
                    id: 1,
                    metadata: {},
                    occurredAt: "2026-06-24T10:05:00.000Z",
                    source: "openclaw",
                    sourceJobId: "heartbeat",
                    status: "ok",
                    summary: "Heartbeat looks good.",
                    title: "Cached heartbeat report",
                    type: "heartbeat",
                    updatedAt: "2026-06-24T10:05:00.000Z",
                },
            ],
        });
        render(
            <QueryClientProvider client={queryClient}>
                <ReportsOverviewCard />
            </QueryClientProvider>
        );
        await act(async () => {
            await queryClient.invalidateQueries({
                queryKey: reportKeys.list(),
            });
        });
        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/reports",
                expect.objectContaining({
                    credentials: "include",
                })
            );
            expect(queryClient.getQueryState(reportKeys.list())?.status).toBe("error");
        });
        expect(screen.queryByText("Reports unavailable.")).not.toBeInTheDocument();
        expect(screen.getByText(/Cached heartbeat report/)).toBeInTheDocument();
        queryClient.clear();
    });
    it("keeps cached operations metrics visible when cache refreshes fail", async () => {
        const fetchMock = jest.fn((input: RequestInfo | URL) => {
            return Promise.try(() => {
                throw new Error(`Cache refresh failed: ${requestUrl(input)}`);
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const queryClient = createQueryClient();
        queryClient.setQueryData(cacheKeys.entry("docker.summary"), {
            data: {
                containers: [
                    {
                        health: "healthy",
                        state: "running",
                    },
                ],
                images: [
                    {
                        size: 2048,
                    },
                ],
                updaterSummary: {
                    updateAvailable: 1,
                },
                volumes: [{}],
            },
            key: "docker.summary",
        });
        queryClient.setQueryData(cacheKeys.entry("git.workspace"), {
            data: {
                checkedAt: "2026-07-15T12:00:00.000Z",
                dirtyCount: 0,
                dirtyRepos: [],
                missingRepos: [],
                repos: [
                    {
                        branch: "main",
                        category: "workspace",
                        checkedAt: "2026-07-15T12:00:00.000Z",
                        dirty: false,
                        exists: true,
                        key: "workspace",
                        name: "Cached workspace",
                        path: "/home/ubuntu/.openclaw",
                        remote: undefined,
                        statusSummary: {
                            conflicted: 0,
                            deleted: 0,
                            modified: 0,
                            renamed: 0,
                            staged: 0,
                            total: 0,
                            untracked: 0,
                        },
                    },
                ],
            },
            key: "git.workspace",
        });
        queryClient.setQueryData(cacheKeys.entry("database.summary"), {
            data: {
                databases: [{}],
                deadTuples: [],
                overview: {
                    averageCacheHitRatio: 99.5,
                    pgbouncer: {
                        waitingClients: 0,
                    },
                    totalBackends: 3,
                    totalDatabaseSizeBytes: 4096,
                },
                topQueries: [],
            },
            key: "database.summary",
        });
        render(
            <QueryClientProvider client={queryClient}>
                <DockerOverviewCard />
                <GitOverviewCard />
                <DatabaseOverviewCard />
            </QueryClientProvider>
        );
        for (const key of ["docker.summary", "git.workspace", "database.summary"]) {
            await act(async () => {
                await queryClient.invalidateQueries({
                    queryKey: cacheKeys.entry(key),
                });
            });
        }
        await waitFor(() => {
            expect(
                queryClient.getQueryState(cacheKeys.entry("docker.summary"))?.status
            ).toBe("error");
            expect(
                queryClient.getQueryState(cacheKeys.entry("git.workspace"))?.status
            ).toBe("error");
            expect(
                queryClient.getQueryState(cacheKeys.entry("database.summary"))?.status
            ).toBe("error");
        });
        expect(screen.queryByText("Docker cache unavailable.")).not.toBeInTheDocument();
        expect(screen.queryByText("Git cache unavailable.")).not.toBeInTheDocument();
        expect(screen.queryByText("Database cache unavailable.")).not.toBeInTheDocument();
        expect(screen.getByText("Cached workspace")).toBeInTheDocument();
        expect(screen.getByText("99.5%")).toBeInTheDocument();
        expect(screen.getByText("2.0 KB")).toBeInTheDocument();
        queryClient.clear();
    });
    it("keeps cached job metrics visible when job refreshes fail", async () => {
        const fetchMock = jest.fn((input: RequestInfo | URL) => {
            return Promise.try(() => {
                throw new Error(`Job refresh failed: ${requestUrl(input)}`);
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const queryClient = createQueryClient();
        queryClient.setQueryData(scheduledJobKeys.list(), {
            jobs: [
                {
                    enabled: true,
                    isRunning: false,
                    name: "Cached dashboard job",
                },
                {
                    enabled: false,
                    isRunning: false,
                    name: "Disabled dashboard job",
                },
            ],
        });
        queryClient.setQueryData(cronKeys.jobs(), {
            jobs: [
                {
                    enabled: true,
                    id: "cached-cron",
                    name: "Cached cron job",
                },
                {
                    enabled: false,
                    id: "disabled-cron",
                    name: "Disabled cron job",
                },
            ],
        });
        render(
            <QueryClientProvider client={queryClient}>
                <JobsOverviewCard />
            </QueryClientProvider>
        );
        await act(async () => {
            await queryClient.invalidateQueries({
                queryKey: scheduledJobKeys.list(),
            });
        });
        await act(async () => {
            await queryClient.invalidateQueries({
                queryKey: cronKeys.jobs(),
            });
        });
        await waitFor(() => {
            expect(queryClient.getQueryState(scheduledJobKeys.list())?.status).toBe(
                "error"
            );
            expect(queryClient.getQueryState(cronKeys.jobs())?.status).toBe("error");
        });
        expect(screen.queryByText("Jobs unavailable.")).not.toBeInTheDocument();
        expect(screen.getByText("Dashboard jobs").nextElementSibling).toHaveTextContent(
            "2"
        );
        expect(screen.getByText("OpenClaw cron").nextElementSibling).toHaveTextContent(
            "2"
        );
        expect(screen.getByText("Disabled").nextElementSibling).toHaveTextContent("2");
        queryClient.clear();
    });
    it("shows queue pressure and cancels an active job execution", async () => {
        let claimsPaused = false;
        let delayNextPause = true;
        let executionStatus: "cancelled" | "queued" = "queued";
        let failNextClaimsUpdate = false;
        const pauseMutationGate = Promise.withResolvers<void>();
        const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
            return Promise.try(async () => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                const execution = {
                    actionKey: "backup.run",
                    attempt: 0,
                    availableAt: "2026-07-22T10:00:00.000Z",
                    cancelRequestedAt: undefined,
                    cancellable: true,
                    displayName: "Host backup",
                    finishedAt:
                        executionStatus === "cancelled"
                            ? "2026-07-22T10:01:00.000Z"
                            : undefined,
                    id: "execution-1",
                    queuedAt: "2026-07-22T10:00:00.000Z",
                    resourceClass: "host-heavy",
                    scheduledJobId: "backup.kopia",
                    scheduledRunId: 42,
                    startedAt: undefined,
                    status: executionStatus,
                    triggerType: "manual",
                };
                if (url === "/api/job-executions?include=claims" && method === "GET") {
                    return Response.json({
                        executions: [execution],
                        summary: {
                            activeResourceClasses: [],
                            claimsPaused,
                            oldestQueuedAt:
                                executionStatus === "queued"
                                    ? execution.queuedAt
                                    : undefined,
                            queued: executionStatus === "queued" ? 1 : 0,
                            running: 0,
                            workerCapacity: 1,
                            workerCount: 1,
                            workerOnline: true,
                        },
                    });
                }
                if (url === "/api/job-executions/claims" && method === "PATCH") {
                    const requestedPause = (
                        JSON.parse(requestBodyText(init?.body)) as {
                            paused: boolean;
                        }
                    ).paused;
                    if (failNextClaimsUpdate) {
                        failNextClaimsUpdate = false;
                        return Response.json(
                            {},
                            {
                                status: 500,
                            }
                        );
                    }
                    if (requestedPause && delayNextPause) {
                        delayNextPause = false;
                        await pauseMutationGate.promise;
                    }
                    claimsPaused = requestedPause;
                    return Response.json({
                        isOk: true,
                        state: {
                            paused: claimsPaused,
                            updatedAt: "2026-07-30T08:00:00.000Z",
                        },
                    });
                }
                if (
                    url === "/api/job-executions/execution-1/cancel" &&
                    method === "POST"
                ) {
                    executionStatus = "cancelled";
                    return Response.json({
                        execution: {
                            ...execution,
                            status: "cancelled",
                        },
                        isOk: true,
                    });
                }
                throw new Error(`Unexpected queue API call: ${method} ${url}`);
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const queryClient = createQueryClient();
        render(
            <QueryClientProvider client={queryClient}>
                <JobExecutionQueueCard />
            </QueryClientProvider>
        );
        expect(await screen.findByText("Host backup")).toBeInTheDocument();
        expect(screen.getByText("host heavy")).toBeInTheDocument();
        expect(screen.getByText("Worker idle")).toBeInTheDocument();
        expect(screen.getByText("Active class").querySelector("svg")).not.toBeNull();
        await userEvent.click(
            screen.getByRole("button", {
                name: "Pause worker claims",
            })
        );
        expect(await screen.findByText("Saving...")).toBeInTheDocument();
        expect(
            screen.getByRole("button", {
                name: "Pause worker claims",
            })
        ).toBeDisabled();
        pauseMutationGate.resolve();
        await waitFor(() => {
            expect(claimsPaused).toBe(true);
            expect(screen.getByText("Worker paused")).toBeInTheDocument();
            expect(
                screen.getByText(
                    "New executions remain queued. Any running execution is allowed to finish."
                )
            ).toBeInTheDocument();
        });
        await userEvent.click(
            screen.getByRole("button", {
                name: "Resume worker claims",
            })
        );
        await waitFor(() => {
            expect(claimsPaused).toBe(false);
            expect(screen.getByText("Worker idle")).toBeInTheDocument();
        });
        failNextClaimsUpdate = true;
        await userEvent.click(
            screen.getByRole("button", {
                name: "Pause worker claims",
            })
        );
        expect(await screen.findByText("HTTP 500")).toBeInTheDocument();
        expect(claimsPaused).toBe(false);
        await userEvent.click(
            screen.getByRole("button", {
                name: "Cancel Host backup",
            })
        );
        await waitFor(() => {
            expect(executionStatus).toBe("cancelled");
            expect(
                screen.queryByRole("button", {
                    name: "Cancel Host backup",
                })
            ).not.toBeInTheDocument();
            expect(screen.getByText("Recent executions")).toBeInTheDocument();
            expect(screen.getByText("cancelled")).toBeInTheDocument();
            expect(
                screen.getByText("No queued or running jobs.").parentElement
            ).toHaveClass("text-center");
        });
        queryClient.clear();
    });
    it("marks unavailable Git repositories as missing instead of clean", async () => {
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(() =>
                Promise.try(() =>
                    Response.json({
                        consecutiveFailures: 0,
                        data: {
                            checkedAt: "2026-07-13T10:00:00.000Z",
                            dirtyCount: 0,
                            dirtyRepos: [],
                            missingRepos: ["workspace"],
                            repos: [
                                {
                                    branch: "stale/missing-checkout",
                                    category: "workspace",
                                    dirty: false,
                                    exists: false,
                                    key: "workspace",
                                    name: "Mira Workspace",
                                    path: "/home/ubuntu/.openclaw",
                                    remote: undefined,
                                    statusSummary: {
                                        conflicted: 0,
                                        deleted: 0,
                                        modified: 0,
                                        renamed: 0,
                                        staged: 0,
                                        total: 0,
                                        untracked: 0,
                                    },
                                },
                                {
                                    branch: "feature/legacy-cache",
                                    category: "project",
                                    checkedAt: "2026-07-13T10:00:00.000Z",
                                    dirty: false,
                                    exists: true,
                                    key: "legacy",
                                    name: "Legacy Cache Repo",
                                    path: "/home/ubuntu/projects/legacy-cache",
                                    remote: undefined,
                                    statusSummary: {
                                        conflicted: 0,
                                        deleted: 0,
                                        modified: 0,
                                        renamed: 0,
                                        staged: 0,
                                        total: 0,
                                        untracked: 0,
                                    },
                                },
                            ],
                        },
                        errorCode: null,
                        errorMessage: null,
                        expiresAt: null,
                        key: "git.workspace",
                        lastAttemptAt: null,
                        meta: {},
                        source: "backend",
                        status: "fresh",
                        updatedAt: "2026-07-13T10:00:00.000Z",
                    })
                )
            ),
            writable: true,
        });
        const view = renderWithQueryClient(<GitOverviewCard />);
        expect(await screen.findByText("Mira Workspace")).toBeInTheDocument();
        expect(screen.getByText("Missing")).toBeInTheDocument();
        expect(screen.getByText("repository unavailable")).toBeInTheDocument();
        expect(screen.getByText("Legacy Cache Repo")).toBeInTheDocument();
        expect(screen.getByText("feature/legacy-cache · no changes")).toBeInTheDocument();
        expect(screen.getByText("Off main")).toBeInTheDocument();
        expect(screen.getByText("Missing repos").nextElementSibling).toHaveTextContent(
            "1"
        );
        expect(screen.getByText("Repos off main").nextElementSibling).toHaveTextContent(
            "1"
        );
        expect(screen.getByText("Clean")).toBeInTheDocument();
        view.unmount();
        view.queryClient.clear();
    });
    it("shows Git cache unavailable for an empty cache payload", async () => {
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(() =>
                Promise.try(() =>
                    Response.json({
                        data: "",
                        key: "git.workspace",
                        source: "backend",
                        status: "error",
                    })
                )
            ),
            writable: true,
        });
        const view = renderWithQueryClient(<GitOverviewCard />);
        expect(await screen.findByText("Git cache unavailable.")).toBeInTheDocument();
        view.unmount();
        view.queryClient.clear();
    });
    it("drives dashboard cards, file tree/config branches, and session action hook", async () => {
        const user = userEvent.setup();
        let realRunRequests = 0;
        const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                if (url === "/api/sessions/agent%3Amain%3Amain/action") {
                    const body = JSON.parse(requestBodyText(init?.body)) as {
                        action: "compact" | "reset" | "stop";
                    };
                    expect(body).toEqual({
                        action: expect.stringMatching(/^(compact|reset|stop)$/),
                    });
                    return Response.json({
                        action: body.action,
                        isSuccess: true,
                    });
                }
                const method = init?.method ?? "GET";
                if (url === "/api/sessions/agent%3Amain%3Amain" && method === "DELETE") {
                    return Response.json({
                        isSuccess: true,
                        result: {},
                    });
                }
                if (url === "/api/ops/log-rotation/status") {
                    return Response.json({
                        isSuccess: true,
                        lastRun: {
                            checkedFiles: 3,
                            checkedGroups: 1,
                            compressedFiles: 1,
                            deletedArchives: 0,
                            errors: [],
                            finishedAt: "2026-06-24T10:00:00.000Z",
                            groups: [],
                            isDryRun: false,
                            isOk: true,
                            rotatedFiles: 2,
                            skippedFiles: 0,
                            startedAt: "2026-06-24T09:59:00.000Z",
                            warnings: [],
                        },
                    });
                }
                if (url === "/api/jobs") {
                    return Response.json({
                        jobs: [
                            {
                                actionKey: "ops.logRotation",
                                actionPayload: {},
                                createdAt: "2026-06-24T08:00:00.000Z",
                                description: "Rotate logs",
                                enabled: true,
                                id: "ops.log-rotation",
                                intervalSeconds: 86_400,
                                isQueued: false,
                                isRunning: false,
                                lastRun: {
                                    cancellable: false,
                                    id: 1,
                                    jobId: "ops.log-rotation",
                                    queuedAt: "2026-06-24T09:59:00.000Z",
                                    resourceClass: "light",
                                    status: "success",
                                    triggerType: "schedule",
                                    startedAt: "2026-06-24T09:59:00.000Z",
                                    finishedAt: "2026-06-24T10:00:00.000Z",
                                    output: {},
                                },
                                name: "Log rotation",
                                nextRunAt: "2026-06-24T22:30:00.000Z",
                                resourceClass: "light",
                                scheduleType: "cron",
                                cronExpression: "30 22 * * *",
                                timeoutMs: 300_000,
                                updatedAt: "2026-06-24T08:00:00.000Z",
                            },
                        ],
                    });
                }
                if (url === "/api/reports") {
                    return Response.json({
                        items: [
                            {
                                bodyMd: "Heartbeat looks good.",
                                createdAt: "2026-06-24T10:05:00.000Z",
                                dedupeKey: "heartbeat:ok",
                                id: 1,
                                metadata: {},
                                occurredAt: "2026-06-24T10:05:00.000Z",
                                source: "openclaw",
                                sourceJobId: "heartbeat",
                                status: "ok",
                                summary: "Heartbeat looks good.",
                                title: "Heartbeat report",
                                type: "heartbeat",
                                updatedAt: "2026-06-24T10:05:00.000Z",
                            },
                        ],
                    });
                }
                if (url === "/api/cron/jobs") {
                    return Response.json({
                        jobs: [
                            {
                                enabled: true,
                                id: "heartbeat",
                                name: "Heartbeat",
                                state: {
                                    lastRunAtMs: 1_719_216_000_000,
                                    lastRunStatus: "success",
                                    nextRunAtMs: 1_719_219_600_000,
                                },
                            },
                            {
                                enabled: false,
                                id: "cleanup",
                                name: "Cleanup",
                                state: {},
                            },
                        ],
                    });
                }
                if (url === "/api/ops/log-rotation/dry-run") {
                    return Response.json({
                        isSuccess: true,
                        result: {
                            checkedFiles: 1,
                            checkedGroups: 1,
                            compressedFiles: 0,
                            deletedArchives: 0,
                            errors: [],
                            finishedAt: "2026-06-24T10:01:00.000Z",
                            groups: [],
                            isDryRun: true,
                            isOk: true,
                            rotatedFiles: 0,
                            skippedFiles: 0,
                            startedAt: "2026-06-24T10:00:00.000Z",
                            warnings: [],
                        },
                        stderr: "",
                    });
                }
                if (url === "/api/jobs/ops.log-rotation/run") {
                    realRunRequests += 1;
                    if (realRunRequests === 1) {
                        return Response.json(
                            {
                                error: {
                                    code: "conflict",
                                    message: "Scheduled job is already running",
                                    requestId: "scheduled-job-conflict",
                                },
                            },
                            {
                                status: 409,
                            }
                        );
                    }
                    return Response.json({
                        isOk: true,
                        run: {
                            cancellable: false,
                            id: 2,
                            jobId: "ops.log-rotation",
                            queuedAt: "2026-06-24T10:00:00.000Z",
                            resourceClass: "light",
                            status: "failed",
                            triggerType: "manual",
                            startedAt: "2026-06-24T10:00:00.000Z",
                            finishedAt: "2026-06-24T10:01:00.000Z",
                            message: "Log file changed during rotation",
                            output: {
                                logRotation: {
                                    result: {
                                        errors: ["Jackett log changed"],
                                        isOk: false,
                                    },
                                    stderr: "rotation stderr",
                                },
                            },
                        },
                    });
                }
                throw new Error(`Unexpected dashboard card fetch: ${method} ${url}`);
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const queryClient = createQueryClient();
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        );
        const { result, unmount } = renderHook(() => useSessionActions(), {
            wrapper,
        });
        act(() => {
            result.current.stop("agent:main:main");
            result.current.compact("agent:main:main");
            result.current.reset("agent:main:main");
        });
        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/sessions/agent%3Amain%3Amain/action",
                expect.objectContaining({
                    body: JSON.stringify({
                        action: "stop",
                    }),
                    method: "POST",
                })
            );
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/sessions/agent%3Amain%3Amain/action",
            expect.objectContaining({
                body: JSON.stringify({
                    action: "reset",
                }),
                method: "POST",
            })
        );
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/sessions/agent%3Amain%3Amain/action",
            expect.objectContaining({
                body: JSON.stringify({
                    action: "compact",
                }),
                method: "POST",
            })
        );
        await act(async () => {
            await result.current.remove("agent:main:main");
        });
        const onConfigSelect = jest.fn();
        const onTreeSelect = jest.fn();
        const onTreeToggle = jest.fn();
        render(
            <QueryClientProvider client={queryClient}>
                <LogRotationCard />
                <JobsOverviewCard />
                <ReportsOverviewCard />
                <QuotaOverviewCard
                    quotas={{
                        cacheAgeMs: 0,
                        checkedAt: 1_719_216_000_000,
                        elevenlabs: {
                            percentUsed: 96,
                            remaining: 4,
                            resetAt: "13:45 on 25 Jun",
                            tier: "creator",
                            total: 100,
                            used: 96,
                        },
                        openai: {
                            account: "raymond",
                            fiveHourLeftPercent: undefined,
                            fiveHourReset: "13:45",
                            model: "codex",
                            percentUsed: 88,
                            resetAt: "13:45",
                            weeklyLeftPercent: 30,
                            weeklyReset: "2026-06-25T10:00:00.000Z",
                        },
                        openrouter: {
                            percentUsed: 40,
                            remaining: 6,
                            totalCredits: 10,
                            limit: 10,
                            limitRemaining: 6,
                            limitReset: "monthly",
                            usage: 4,
                            usageMonthly: 4,
                        },
                        synthetic: {
                            rollingFiveHourLimit: {
                                limited: false,
                                max: 100,
                                nextTickAt: "2026-06-24T11:00:00.000Z",
                                percentUsed: 97,
                                remaining: 3,
                                tickPercent: 0.25,
                            },
                            searchHourly: {
                                limit: 100,
                                percentUsed: 10,
                                remaining: 90,
                                renewsAt: "2026-06-24T11:00:00.000Z",
                                requests: 10,
                            },
                            subscription: {
                                limit: 100,
                                percentUsed: 10,
                                remaining: 90,
                                renewsAt: "2026-06-25T10:00:00.000Z",
                                requests: 10,
                            },
                            weeklyTokenLimit: {
                                nextRegenAt: "bad-date",
                                nextRegenCredits: "50",
                                percentRemaining: 10,
                            },
                        },
                    }}
                />
                <QuotaOverviewCard
                    quotas={{
                        cacheAgeMs: 0,
                        checkedAt: 1_719_216_000_000,
                        elevenlabs: {
                            note: "usage unavailable",
                            status: "error",
                        },
                        openai: {
                            note: "not signed in",
                            status: "not_configured",
                        },
                        openrouter: {
                            note: "offline",
                            status: "error",
                        },
                        synthetic: {
                            note: "unknown",
                            status: "error",
                        },
                    }}
                />
                <ConfigSection
                    selectedPath="config:openclaw.json"
                    onSelect={onConfigSelect}
                />
                <FileTreeItem
                    node={{
                        children: [
                            {
                                name: "b.ts",
                                path: "src/b.ts",
                                size: 1,
                                type: "file",
                            },
                            {
                                children: [],
                                loaded: true,
                                name: "nested",
                                path: "src/nested",
                                type: "directory",
                            },
                            {
                                name: "image.png",
                                path: "src/image.png",
                                size: 1,
                                type: "file",
                            },
                        ],
                        loaded: true,
                        name: "src",
                        path: "src",
                        type: "directory",
                    }}
                    selectedPath="src/b.ts"
                    expandedPaths={new Set(["src"])}
                    onSelect={onTreeSelect}
                    onToggle={onTreeToggle}
                />
                <FileTreeItem
                    node={{
                        children: [],
                        loaded: false,
                        name: "loading",
                        path: "loading",
                        type: "directory",
                    }}
                    selectedPath={undefined}
                    expandedPaths={new Set(["loading"])}
                    onSelect={onTreeSelect}
                    onToggle={onTreeToggle}
                />
            </QueryClientProvider>
        );
        await waitFor(() => {
            expect(screen.getByText("Log rotation")).toBeInTheDocument();
            expect(screen.getByText("Jobs")).toBeInTheDocument();
            expect(screen.getByText("OpenClaw cron")).toBeInTheDocument();
            expect(screen.getByText("Reports")).toBeInTheDocument();
            expect(
                screen.getByText(/5h unlimited · weekly 30% left/i)
            ).toBeInTheDocument();
            expect(screen.getByText(/Resets weekly/i)).toBeInTheDocument();
        });
        await user.click(
            screen.getByRole("button", {
                name: "hooks",
            })
        );
        await user.click(
            screen.getByRole("button", {
                name: "agentmail.ts",
            })
        );
        await user.click(
            screen.getByRole("button", {
                name: "openclaw.json",
            })
        );
        await user.click(
            screen.getByRole("button", {
                name: "src",
            })
        );
        await user.click(
            screen.getByRole("button", {
                name: "b.ts",
            })
        );
        await user.click(
            screen.getByRole("button", {
                name: "Run dry-run now",
            })
        );
        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/ops/log-rotation/dry-run",
                expect.objectContaining({
                    method: "POST",
                })
            );
        });
        await user.click(
            screen.getByRole("button", {
                name: "Run real now",
            })
        );
        await waitFor(() => {
            expect(
                screen.getByText("Scheduled job is already running", {
                    exact: false,
                })
            ).toBeInTheDocument();
        });
        await user.click(
            screen.getByRole("button", {
                name: "Run real now",
            })
        );
        await waitFor(() => {
            expect(onConfigSelect).toHaveBeenCalledWith(
                "config:hooks/transforms/agentmail.ts"
            );
            expect(onTreeToggle).toHaveBeenCalledWith("src");
            expect(onTreeSelect).toHaveBeenCalledWith("src/b.ts");
            expect(
                screen.getAllByText(/unavailable|rate limited|unknown/).length
            ).toBeGreaterThan(0);
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/jobs/ops.log-rotation/run",
                expect.objectContaining({
                    method: "POST",
                })
            );
            expect(
                screen.getByText("Log file changed during rotation", {
                    exact: false,
                })
            ).toBeInTheDocument();
            expect(
                screen.getByText("Jackett log changed", {
                    exact: false,
                })
            ).toBeInTheDocument();
            expect(
                screen.getByText("rotation stderr", {
                    exact: false,
                })
            ).toBeInTheDocument();
        });
        expect(onConfigSelect).toHaveBeenCalledWith("config:openclaw.json");
        unmount();
        queryClient.clear();
    });
});
