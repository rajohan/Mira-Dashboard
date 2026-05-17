import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Docker } from "./Docker";

const docker = vi.hoisted(() => ({
    action: vi.fn(),
    deleteImage: vi.fn(),
    deleteVolume: vi.fn(),
    manualUpdate: vi.fn(),
    prune: vi.fn(),
    runUpdater: vi.fn(),
    startExec: vi.fn(),
    stopExec: vi.fn(),
    useDeleteDockerImage: vi.fn(),
    useDeleteDockerVolume: vi.fn(),
    useDockerAction: vi.fn(),
    useDockerContainer: vi.fn(),
    useDockerContainerLogs: vi.fn(),
    useDockerContainers: vi.fn(),
    useDockerExecJob: vi.fn(),
    useDockerImages: vi.fn(),
    useDockerManualUpdate: vi.fn(),
    useDockerPrune: vi.fn(),
    useDockerUpdaterEvents: vi.fn(),
    useDockerUpdaterServices: vi.fn(),
    useDockerVolumes: vi.fn(),
    useRunDockerUpdater: vi.fn(),
}));

vi.mock("../hooks/useDocker", () => ({
    startDockerExec: docker.startExec,
    stopDockerExec: docker.stopExec,
    useDeleteDockerImage: docker.useDeleteDockerImage,
    useDeleteDockerVolume: docker.useDeleteDockerVolume,
    useDockerAction: docker.useDockerAction,
    useDockerContainer: docker.useDockerContainer,
    useDockerContainerLogs: docker.useDockerContainerLogs,
    useDockerContainers: docker.useDockerContainers,
    useDockerExecJob: docker.useDockerExecJob,
    useDockerImages: docker.useDockerImages,
    useDockerManualUpdate: docker.useDockerManualUpdate,
    useDockerPrune: docker.useDockerPrune,
    useDockerUpdaterEvents: docker.useDockerUpdaterEvents,
    useDockerUpdaterServices: docker.useDockerUpdaterServices,
    useDockerVolumes: docker.useDockerVolumes,
    useRunDockerUpdater: docker.useRunDockerUpdater,
}));

vi.mock("../components/ui/ConfirmModal", () => ({
    ConfirmModal: ({
        confirmLabel,
        isOpen,
        message,
        onCancel,
        onConfirm,
        title,
    }: {
        confirmLabel: string;
        isOpen: boolean;
        message: string;
        onCancel: () => void;
        onConfirm: () => void;
        title: string;
    }) =>
        isOpen ? (
            <section data-testid="confirm-modal">
                <h2>{title}</h2>
                <p>{message}</p>
                <button type="button" onClick={onCancel}>
                    Cancel
                </button>
                <button type="button" onClick={onConfirm}>
                    {confirmLabel}
                </button>
            </section>
        ) : null,
}));

vi.mock("../components/ui/Modal", () => ({
    Modal: ({
        children,
        isOpen,
        onClose,
        title,
    }: {
        children: React.ReactNode;
        isOpen: boolean;
        onClose: () => void;
        title: string;
    }) =>
        isOpen ? (
            <section data-testid="modal">
                <h2>{title}</h2>
                <button type="button" onClick={onClose}>
                    Close {title}
                </button>
                {children}
            </section>
        ) : null,
}));

vi.mock("../components/ui/Select", () => ({
    Select: ({
        onChange,
        options,
        value,
    }: {
        onChange: (value: string) => void;
        options: Array<{ label: string; value: string }>;
        value: string;
    }) => (
        <select
            aria-label="select"
            value={value}
            onChange={(event) => onChange(event.target.value)}
        >
            {options.map((option) => (
                <option key={option.value} value={option.value}>
                    {option.label}
                </option>
            ))}
        </select>
    ),
}));

vi.mock("../components/features/docker/DockerContainersTable", () => ({
    DockerContainersTable: ({
        containers,
        onConsole,
        onDetails,
        onLogs,
        onRestart,
        onRestartStack,
    }: {
        containers: Array<{ id: string; name: string }>;
        onConsole: (id: string) => void;
        onDetails: (id: string) => void;
        onLogs: (id: string) => void;
        onRestart: (id: string) => void;
        onRestartStack: () => void;
    }) => (
        <section data-testid="containers-table">
            containers: {containers.length}
            {containers.map((container) => (
                <div key={container.id}>
                    <span>{container.name}</span>
                    <button type="button" onClick={() => onDetails(container.id)}>
                        Details {container.name}
                    </button>
                    <button type="button" onClick={() => onLogs(container.id)}>
                        Logs {container.name}
                    </button>
                    <button type="button" onClick={() => onConsole(container.id)}>
                        Console {container.name}
                    </button>
                    <button type="button" onClick={() => onRestart(container.id)}>
                        Restart {container.name}
                    </button>
                </div>
            ))}
            <button type="button" onClick={onRestartStack}>
                Restart stack
            </button>
        </section>
    ),
}));

vi.mock("../components/features/docker/DockerImagesTable", () => ({
    DockerImagesTable: ({
        images,
        onDelete,
        onPruneUnused,
    }: {
        images: Array<{ id: string; repository: string; tag: string }>;
        onDelete: (id: string, label: string) => void;
        onPruneUnused: () => void;
    }) => (
        <section data-testid="images-table">
            images: {images.length}
            {images.map((image) => (
                <button
                    key={image.id}
                    type="button"
                    onClick={() => onDelete(image.id, `${image.repository}:${image.tag}`)}
                >
                    Delete image {image.repository}
                </button>
            ))}
            <button type="button" onClick={onPruneUnused}>
                Prune images
            </button>
        </section>
    ),
}));

vi.mock("../components/features/docker/DockerVolumesTable", () => ({
    DockerVolumesTable: ({
        onDelete,
        onPruneUnused,
        volumes,
    }: {
        onDelete: (name: string) => void;
        onPruneUnused: () => void;
        volumes: Array<{ name: string }>;
    }) => (
        <section data-testid="volumes-table">
            volumes: {volumes.length}
            {volumes.map((volume) => (
                <button
                    key={volume.name}
                    type="button"
                    onClick={() => onDelete(volume.name)}
                >
                    Delete volume {volume.name}
                </button>
            ))}
            <button type="button" onClick={onPruneUnused}>
                Prune volumes
            </button>
        </section>
    ),
}));

const containers = [
    {
        health: "healthy",
        id: "c1",
        image: "nginx:latest",
        name: "web",
        service: "web",
        state: "running",
        status: "Up",
    },
    {
        health: "unhealthy",
        id: "c2",
        image: "worker:latest",
        name: "worker",
        service: null,
        state: "exited",
        status: "Exited",
    },
];

function mockDocker(overrides = {}) {
    docker.useDockerContainers.mockReturnValue({
        data: containers,
        error: null,
        isError: false,
        isLoading: false,
    });
    docker.useDockerImages.mockReturnValue({
        data: [{ id: "img-1", repository: "nginx", size: 1024, tag: "latest" }],
        isLoading: false,
    });
    docker.useDockerVolumes.mockReturnValue({
        data: [{ driver: "local", mountpoint: "/data", name: "app-data" }],
        isLoading: false,
    });
    docker.useDockerContainer.mockReturnValue({
        data: {
            ...containers[0],
            createdAt: "2026-05-11T00:00:00.000Z",
            mounts: [
                {
                    destination: "/app/data",
                    mode: "rw",
                    readOnly: false,
                    source: "/data",
                    type: "bind",
                },
            ],
            networks: [
                {
                    gateway: "172.18.0.1",
                    ipAddress: "172.18.0.2",
                    macAddress: "aa:bb",
                    name: "app-net",
                },
            ],
            startedAt: "2026-05-11T00:01:00.000Z",
            stats: {
                blockIO: "0B / 0B",
                cpu: "1%",
                memory: "512MiB / 1GiB",
                netIO: "1kB",
            },
        },
        isLoading: false,
    });
    docker.useDockerContainerLogs.mockReturnValue({
        data: "container log line",
        isFetching: false,
        refetch: vi.fn(),
    });
    docker.useDockerExecJob.mockReturnValue({
        data: { status: "running", stderr: "", stdout: "exec output" },
    });
    docker.useDockerUpdaterServices.mockReturnValue({
        data: {
            services: [
                {
                    currentDigest: "sha256:old",
                    currentTag: "1.0.0",
                    id: 7,
                    imageRepo: "nginx",
                    lastCheckedAt: "2026-05-11T00:00:00.000Z",
                    lastStatus: "candidate",
                    latestDigest: "sha256:new",
                    latestTag: "1.1.0",
                    policy: "auto",
                    serviceName: "web",
                    updateAvailable: true,
                },
            ],
            summary: {
                autoPolicy: 1,
                failed: 0,
                notifyPolicy: 0,
                total: 1,
                updateAvailable: 1,
            },
        },
        isLoading: false,
    });
    docker.useDockerUpdaterEvents.mockReturnValue({
        data: [
            {
                createdAt: "2026-05-11T00:02:00.000Z",
                eventType: "update_available",
                fromDigest: "sha256:old",
                fromTag: "1.0.0",
                id: 1,
                serviceName: "web",
                toDigest: "sha256:new",
                toTag: "1.1.0",
            },
        ],
        isLoading: false,
    });
    docker.useDockerAction.mockReturnValue({ mutateAsync: docker.action });
    docker.useDeleteDockerImage.mockReturnValue({
        isPending: false,
        mutateAsync: docker.deleteImage,
    });
    docker.useDeleteDockerVolume.mockReturnValue({
        isPending: false,
        mutateAsync: docker.deleteVolume,
    });
    docker.useDockerPrune.mockReturnValue({
        isPending: false,
        mutateAsync: docker.prune,
    });
    docker.useDockerManualUpdate.mockReturnValue({
        isPending: false,
        mutateAsync: docker.manualUpdate,
    });
    docker.useRunDockerUpdater.mockReturnValue({
        data: null,
        isPending: false,
        mutateAsync: docker.runUpdater,
    });

    for (const [key, value] of Object.entries(overrides)) {
        if (key === "containers") docker.useDockerContainers.mockReturnValue(value);
        if (key === "images") docker.useDockerImages.mockReturnValue(value);
        if (key === "volumes") docker.useDockerVolumes.mockReturnValue(value);
        if (key === "container") docker.useDockerContainer.mockReturnValue(value);
        if (key === "updaterServices")
            docker.useDockerUpdaterServices.mockReturnValue(value);
        if (key === "updaterEvents") docker.useDockerUpdaterEvents.mockReturnValue(value);
    }
}

describe("Docker page", () => {
    beforeEach(() => {
        docker.action.mockResolvedValue({ output: "container restarted" });
        docker.deleteImage.mockResolvedValue(Promise.resolve());
        docker.deleteVolume.mockResolvedValue(Promise.resolve());
        docker.manualUpdate.mockResolvedValue({
            result: { summary: { failed: 0, updated: 1 } },
            stderr: "",
        });
        docker.prune.mockResolvedValue({ output: "pruned" });
        docker.runUpdater.mockResolvedValue({ ok: true });
        docker.startExec.mockResolvedValue({ jobId: "job-1" });
        docker.stopExec.mockResolvedValue(Promise.resolve());
        for (const value of Object.values(docker)) {
            if (typeof value === "function" && "mockClear" in value) value.mockClear();
        }
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                json: async () => ({ output: "stack restarted" }),
                ok: true,
            })
        );
        Element.prototype.scrollIntoView = vi.fn();
        mockDocker();
    });

    it("renders loading, summary cards, updater data, and resource tables", () => {
        const { rerender } = render(<Docker />);

        expect(screen.getByText("Running containers")).toBeInTheDocument();
        expect(screen.getByText("Unhealthy")).toBeInTheDocument();
        expect(screen.getByText("Tracked services")).toBeInTheDocument();
        expect(screen.getAllByText("web").length).toBeGreaterThan(0);
        expect(screen.getByTestId("containers-table")).toHaveTextContent("containers: 2");
        expect(screen.getByTestId("images-table")).toHaveTextContent("images: 1");
        expect(screen.getByTestId("volumes-table")).toHaveTextContent("volumes: 1");

        mockDocker({
            containers: { data: [], error: null, isError: false, isLoading: true },
        });
        rerender(<Docker />);
        expect(screen.getByText("Loading Docker overview...")).toBeInTheDocument();
    });

    it("shows container error and empty states", () => {
        const { rerender } = render(<Docker />);

        mockDocker({
            containers: {
                data: [],
                error: new Error("Docker unavailable"),
                isError: true,
                isLoading: false,
            },
        });
        rerender(<Docker />);
        expect(
            screen.getByText("Failed to load containers. Try refresh.")
        ).toBeInTheDocument();
        expect(screen.getByText("Docker unavailable")).toBeInTheDocument();

        mockDocker({
            containers: { data: [], error: null, isError: false, isLoading: false },
        });
        rerender(<Docker />);
        expect(screen.getByText("No containers found.")).toBeInTheDocument();
    });

    it("runs container, stack, updater, prune, and delete actions", async () => {
        const user = userEvent.setup();

        render(<Docker />);

        await user.click(screen.getByRole("button", { name: "Restart web" }));
        expect(docker.action).toHaveBeenCalledWith({
            action: "restart",
            containerId: "c1",
        });
        expect(await screen.findByText("container restarted")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Restart stack" }));
        expect(fetch).toHaveBeenCalledWith(
            "/api/docker/stack/action",
            expect.objectContaining({ method: "POST" })
        );
        expect(await screen.findByText("stack restarted")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Run updater now" }));
        expect(docker.runUpdater).toHaveBeenCalledTimes(1);
        expect(await screen.findByText(/"ok": true/)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Update now" }));
        expect(screen.getByTestId("confirm-modal")).toHaveTextContent("Update web");
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByTestId("confirm-modal")).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Update now" }));
        await user.click(screen.getAllByRole("button", { name: "Update now" }).at(-1)!);
        expect(docker.manualUpdate).toHaveBeenCalledWith(7);
        expect(await screen.findByText(/updated=1 failed=0/)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Prune images" }));
        expect(docker.prune).toHaveBeenCalledWith("images");

        await user.click(screen.getByRole("button", { name: "Delete image nginx" }));
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByTestId("confirm-modal")).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Delete image nginx" }));
        await user.click(screen.getByRole("button", { name: "Delete" }));
        expect(docker.deleteImage).toHaveBeenCalledWith("img-1");

        await user.click(screen.getByRole("button", { name: "Delete volume app-data" }));
        await user.click(screen.getByRole("button", { name: "Delete" }));
        expect(docker.deleteVolume).toHaveBeenCalledWith("app-data");
    });

    it("opens details, logs, and console modals", async () => {
        const user = userEvent.setup();
        const refetchLogs = vi.fn();
        docker.useDockerContainerLogs.mockReturnValue({
            data: "container log line",
            isFetching: false,
            refetch: refetchLogs,
        });

        render(<Docker />);

        await user.click(screen.getByRole("button", { name: "Details web" }));
        expect(screen.getByTestId("modal")).toHaveTextContent("web");
        expect(screen.getByText("Runtime")).toBeInTheDocument();
        expect(screen.getByText("app-net")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Logs web" }));
        expect(screen.getByText("container log line")).toBeInTheDocument();
        await user.selectOptions(screen.getByLabelText("select"), "500");
        expect(screen.getByLabelText("select")).toHaveValue("500");
        await user.click(screen.getByRole("button", { name: "Refresh" }));
        expect(refetchLogs).toHaveBeenCalledTimes(1);

        await user.click(screen.getByRole("button", { name: "Console web" }));
        await user.type(
            screen.getByPlaceholderText("Command to run inside container"),
            "printenv"
        );
        await user.click(screen.getByRole("button", { name: "Run" }));
        expect(docker.startExec).toHaveBeenCalledWith("c1", "printenv");
        expect(screen.getByText("exec output")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Stop" }));
        expect(docker.stopExec).toHaveBeenCalledWith("job-1");
    });

    it("renders updater loading and empty branches", () => {
        mockDocker({
            updaterEvents: { data: [], isLoading: true },
            updaterServices: {
                data: { services: [], summary: undefined },
                isLoading: true,
            },
        });

        const { rerender } = render(<Docker />);
        expect(screen.getByText("Loading updater services...")).toBeInTheDocument();
        expect(screen.getByText("Loading updater history...")).toBeInTheDocument();

        mockDocker({
            updaterEvents: { data: [], isLoading: false },
            updaterServices: {
                data: { services: [], summary: undefined },
                isLoading: false,
            },
        });
        rerender(<Docker />);
        expect(
            screen.getByText("No pending updater candidates right now.")
        ).toBeInTheDocument();
        expect(screen.getByText("No updater events yet.")).toBeInTheDocument();
        expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    });

    it("renders fallback details, logs, and console states", async () => {
        const user = userEvent.setup();
        mockDocker({
            container: { data: null, isLoading: true },
        });

        const { rerender } = render(<Docker />);
        await user.click(screen.getByRole("button", { name: "Details web" }));
        expect(screen.getByText("Loading container details...")).toBeInTheDocument();

        mockDocker({
            container: { data: null, isLoading: false },
        });
        rerender(<Docker />);
        expect(screen.getByText("Failed to load container details.")).toBeInTheDocument();

        docker.useDockerContainerLogs.mockReturnValue({
            data: "",
            isFetching: true,
            refetch: vi.fn(),
        });
        rerender(<Docker />);
        await user.click(screen.getByRole("button", { name: "Logs web" }));
        expect(screen.getByText("No logs")).toBeInTheDocument();
    });

    it("reports action failures", async () => {
        const user = userEvent.setup();
        docker.action.mockRejectedValueOnce(new Error("restart failed"));

        render(<Docker />);

        await user.click(screen.getByRole("button", { name: "Restart web" }));
        expect(
            await screen.findByText(/Failed to restart container/)
        ).toBeInTheDocument();
        expect(screen.getByText(/restart failed/)).toBeInTheDocument();
    });

    it("covers fallback action output, persisted updater data, and modal close handlers", async () => {
        const user = userEvent.setup();
        docker.action.mockResolvedValueOnce({ output: "" });
        docker.manualUpdate.mockResolvedValueOnce({ stderr: "manual warning" });
        docker.prune.mockResolvedValueOnce({});
        docker.useRunDockerUpdater.mockReturnValue({
            data: { last: true },
            isPending: true,
            mutateAsync: docker.runUpdater,
        });

        render(<Docker />);

        expect(screen.getByText(/"last": true/)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Running..." })).toBeDisabled();

        await user.click(screen.getByRole("button", { name: "Restart web" }));
        expect(await screen.findByText("restart completed.")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Dismiss" }));
        expect(screen.queryByText("restart completed.")).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Update now" }));
        await user.click(screen.getAllByRole("button", { name: "Update now" }).at(-1)!);
        expect(await screen.findByText(/updated=0 failed=0/)).toBeInTheDocument();
        expect(screen.getByText(/manual warning/)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Prune images" }));
        expect(
            await screen.findByText("Unused Docker images removed.")
        ).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Details web" }));
        await user.click(screen.getByRole("button", { name: "Close web" }));
        expect(screen.queryByText("Runtime")).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Logs web" }));
        await user.click(screen.getByRole("button", { name: "Close web logs" }));
        expect(screen.queryByText("container log line")).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Console web" }));
        await user.click(screen.getByRole("button", { name: "Close web console" }));
        expect(
            screen.queryByPlaceholderText("Command to run inside container")
        ).not.toBeInTheDocument();
    });

    it("covers default data, unknown errors, pending confirmation guards, and sparse details", async () => {
        const user = userEvent.setup();
        const sparseContainer = {
            ...containers[0],
            createdAt: null,
            mounts: [
                {
                    destination: "/readonly",
                    mode: "",
                    readOnly: true,
                    source: "/host",
                    type: "volume",
                },
            ],
            networks: [
                {
                    gateway: "",
                    ipAddress: "",
                    macAddress: "",
                    name: "empty-net",
                },
            ],
            startedAt: null,
            stats: {},
        };
        mockDocker({
            container: { data: sparseContainer, isLoading: false },
            containers: {
                data: undefined,
                error: "plain error",
                isError: true,
                isLoading: false,
            },
            images: { data: undefined, isLoading: false },
            updaterEvents: { data: undefined, isLoading: false },
            updaterServices: { data: undefined, isLoading: false },
            volumes: { data: undefined, isLoading: false },
        });

        const { rerender } = render(<Docker />);
        expect(screen.getByText("Unknown container query error")).toBeInTheDocument();
        expect(screen.getAllByText("—").length).toBeGreaterThan(0);

        mockDocker({
            container: { data: sparseContainer, isLoading: false },
        });
        docker.useDeleteDockerImage.mockReturnValue({
            isPending: true,
            mutateAsync: docker.deleteImage,
        });
        docker.useDockerManualUpdate.mockReturnValue({
            isPending: true,
            mutateAsync: docker.manualUpdate,
        });
        rerender(<Docker />);

        await user.click(screen.getByRole("button", { name: "Details web" }));
        expect(screen.getByText("empty-net")).toBeInTheDocument();
        expect(screen.getByText(/volume · default · ro/)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Delete image nginx" }));
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.getByTestId("confirm-modal")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Delete" }));
        expect(docker.deleteImage).not.toHaveBeenCalled();

        await user.click(screen.getByRole("button", { name: "Update now" }));
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.getByTestId("confirm-modal")).toBeInTheDocument();
        await user.click(screen.getAllByRole("button", { name: "Update now" }).at(-1)!);
        expect(docker.manualUpdate).not.toHaveBeenCalled();
    });

    it("reports stack, updater, manual update, prune, and delete failures", async () => {
        const user = userEvent.setup();
        vi.mocked(fetch).mockResolvedValueOnce({
            json: async () => ({ error: "compose failed" }),
            ok: false,
        } as Response);
        docker.runUpdater.mockRejectedValueOnce("updater boom");
        docker.manualUpdate.mockRejectedValueOnce(new Error("manual failed"));
        docker.prune.mockRejectedValueOnce(new Error("prune failed"));
        docker.deleteImage.mockRejectedValueOnce(new Error("delete failed"));

        render(<Docker />);

        await user.click(screen.getByRole("button", { name: "Restart stack" }));
        expect(
            await screen.findByText(/Failed to restart Docker stack/)
        ).toBeInTheDocument();
        expect(screen.getByText(/compose failed/)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Run updater now" }));
        expect(await screen.findByText(/Docker updater failed/)).toBeInTheDocument();
        expect(screen.getByText(/updater boom/)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Update now" }));
        await user.click(screen.getAllByRole("button", { name: "Update now" }).at(-1)!);
        expect(await screen.findByText(/Manual update failed/)).toBeInTheDocument();
        expect(screen.getByText(/manual failed/)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Prune volumes" }));
        expect(
            await screen.findByText(/Failed to remove unused Docker volumes/)
        ).toBeInTheDocument();
        expect(screen.getByText(/prune failed/)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Delete image nginx" }));
        await user.click(screen.getByRole("button", { name: "Delete" }));
        expect(
            await screen.findByText(/Failed to delete Docker image/)
        ).toBeInTheDocument();
        expect(screen.getByText(/delete failed/)).toBeInTheDocument();
    });
});
