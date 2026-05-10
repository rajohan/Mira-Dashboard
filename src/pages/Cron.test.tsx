import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Cron } from "./Cron";

const hooks = vi.hoisted(() => ({
    refetch: vi.fn(),
    runNow: vi.fn(),
    toggleJob: vi.fn(),
    updateJob: vi.fn(),
    useCronJobs: vi.fn(),
    useRunCronJobNow: vi.fn(),
    useToggleCronJob: vi.fn(),
    useUpdateCronJob: vi.fn(),
}));

interface MockCronJob {
    id?: string;
    jobId?: string;
    name?: string;
    schedule?: unknown;
    payload?: unknown;
    delivery?: unknown;
    enabled?: boolean;
}

vi.mock("../hooks", () => ({
    useCronJobs: hooks.useCronJobs,
    useRunCronJobNow: hooks.useRunCronJobNow,
    useToggleCronJob: hooks.useToggleCronJob,
    useUpdateCronJob: hooks.useUpdateCronJob,
}));

vi.mock("../components/features/cron", () => ({
    CronJobDetails: ({
        deliveryDraft,
        editError,
        hasInvalidJson,
        job,
        lastTriggeredAt,
        nameDraft,
        onDeliveryDraftChange,
        onEditModeChange,
        onNameDraftChange,
        onPayloadDraftChange,
        onRunNow,
        onSave,
        onScheduleDraftChange,
        onToggle,
        payloadDraft,
        scheduleDraft,
    }: {
        deliveryDraft: string;
        editError: string | null;
        hasInvalidJson: boolean;
        job: MockCronJob;
        lastTriggeredAt?: number;
        nameDraft: string;
        onDeliveryDraftChange: (value: string) => void;
        onEditModeChange: (value: boolean) => void;
        onNameDraftChange: (value: string) => void;
        onPayloadDraftChange: (value: string) => void;
        onRunNow: (job: MockCronJob) => void;
        onSave: (job: MockCronJob) => void;
        onScheduleDraftChange: (value: string) => void;
        onToggle: (job: MockCronJob, enabled: boolean) => void;
        payloadDraft: string;
        scheduleDraft: string;
    }) => (
        <section data-testid="cron-details">
            <div>job: {job.name}</div>
            <div>name draft: {nameDraft}</div>
            <div>schedule draft: {scheduleDraft}</div>
            <div>payload draft: {payloadDraft}</div>
            <div>delivery draft: {deliveryDraft}</div>
            <div>invalid: {String(hasInvalidJson)}</div>
            <div>last run: {lastTriggeredAt ? "set" : "unset"}</div>
            {editError ? <div>{editError}</div> : null}
            <button type="button" onClick={() => onEditModeChange(true)}>
                Edit
            </button>
            <button type="button" onClick={() => onNameDraftChange("Updated job")}>
                Rename
            </button>
            <button type="button" onClick={() => onScheduleDraftChange("not-json")}>
                Invalid schedule
            </button>
            <button
                type="button"
                onClick={() => onPayloadDraftChange('{"kind":"systemEvent"}')}
            >
                Update payload
            </button>
            <button type="button" onClick={() => onDeliveryDraftChange("{}")}>
                Update delivery
            </button>
            <button type="button" onClick={() => onToggle(job, false)}>
                Disable
            </button>
            <button type="button" onClick={() => onRunNow(job)}>
                Run now
            </button>
            <button type="button" onClick={() => onSave(job)}>
                Save
            </button>
        </section>
    ),
    CronJobList: ({
        currentJobId,
        jobs,
        onSelect,
        selectedId,
    }: {
        currentJobId: string;
        jobs: MockCronJob[];
        onSelect: (id: string) => void;
        selectedId: string;
    }) => (
        <aside data-testid="cron-list">
            <div>jobs: {jobs.length}</div>
            <div>current: {currentJobId}</div>
            <div>selected: {selectedId || "none"}</div>
            {jobs.map((job) => {
                const id = String(job.jobId || job.id || "");
                return (
                    <button key={id} type="button" onClick={() => onSelect(id)}>
                        Select {job.name}
                    </button>
                );
            })}
        </aside>
    ),
}));

function mockCronJobs(overrides = {}) {
    hooks.useCronJobs.mockReturnValue({
        data: [
            {
                delivery: { mode: "none" },
                enabled: true,
                id: "daily",
                name: "Daily summary",
                payload: { kind: "systemEvent", text: "hello" },
                schedule: { expr: "0 9 * * *", kind: "cron" },
            },
            {
                enabled: false,
                id: "cleanup",
                name: "Cleanup",
                payload: { kind: "systemEvent", text: "clean" },
                schedule: { everyMs: 60_000, kind: "every" },
            },
        ],
        error: null,
        isLoading: false,
        refetch: hooks.refetch,
        ...overrides,
    });
}

describe("Cron page", () => {
    beforeEach(() => {
        hooks.refetch.mockReset();
        hooks.runNow.mockResolvedValue(Promise.resolve({}));
        hooks.toggleJob.mockResolvedValue(Promise.resolve({}));
        hooks.updateJob.mockResolvedValue(Promise.resolve({}));
        hooks.useCronJobs.mockReset();
        hooks.useRunCronJobNow.mockReturnValue({
            isPending: false,
            mutateAsync: hooks.runNow,
        });
        hooks.useToggleCronJob.mockReturnValue({
            isPending: false,
            mutateAsync: hooks.toggleJob,
        });
        hooks.useUpdateCronJob.mockReturnValue({
            isPending: false,
            mutateAsync: hooks.updateJob,
        });
        mockCronJobs();
    });

    it("renders loading, error retry, and empty states", async () => {
        const user = userEvent.setup();
        const { container, rerender } = render(<Cron />);

        hooks.useCronJobs.mockReturnValue({
            data: [],
            error: null,
            isLoading: true,
            refetch: hooks.refetch,
        });
        rerender(<Cron />);
        expect(container.querySelector(".animate-spin")).toBeInTheDocument();

        hooks.useCronJobs.mockReturnValue({
            data: [],
            error: new Error("Cron unavailable"),
            isLoading: false,
            refetch: hooks.refetch,
        });
        rerender(<Cron />);
        expect(screen.getByText("Cron unavailable")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Retry" }));
        expect(hooks.refetch).toHaveBeenCalledTimes(1);

        hooks.useCronJobs.mockReturnValue({
            data: [],
            error: null,
            isLoading: false,
            refetch: hooks.refetch,
        });
        rerender(<Cron />);
        expect(screen.getByText("No cron jobs found")).toBeInTheDocument();
    });

    it("renders sorted jobs and selects a job", async () => {
        const user = userEvent.setup();

        render(<Cron />);

        expect(await screen.findByTestId("cron-list")).toHaveTextContent("jobs: 2");
        expect(screen.getByTestId("cron-list")).toHaveTextContent("current: daily");
        expect(screen.getByTestId("cron-details")).toHaveTextContent(
            "job: Daily summary"
        );

        await user.click(screen.getByRole("button", { name: "Select Cleanup" }));
        expect(screen.getByTestId("cron-list")).toHaveTextContent("selected: cleanup");
        expect(screen.getByTestId("cron-details")).toHaveTextContent("job: Cleanup");
    });

    it("runs, toggles, and saves the selected job", async () => {
        const user = userEvent.setup();

        render(<Cron />);

        await user.click(screen.getByRole("button", { name: "Disable" }));
        await user.click(screen.getByRole("button", { name: "Run now" }));
        await screen.findByText("last run: set");
        await user.click(screen.getByRole("button", { name: "Rename" }));
        await user.click(screen.getByRole("button", { name: "Update payload" }));
        await user.click(screen.getByRole("button", { name: "Update delivery" }));
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(hooks.toggleJob).toHaveBeenCalledWith({ id: "daily", enabled: false });
        expect(hooks.runNow).toHaveBeenCalledWith({ id: "daily" });
        expect(hooks.updateJob).toHaveBeenCalledWith({
            id: "daily",
            patch: expect.objectContaining({
                name: "Updated job",
                delivery: {},
                payload: { kind: "systemEvent" },
            }),
        });
    });

    it("surfaces invalid JSON save errors", async () => {
        const user = userEvent.setup();

        render(<Cron />);

        await user.click(screen.getByRole("button", { name: "Invalid schedule" }));
        expect(screen.getByText("invalid: true")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText(/Unexpected token/)).toBeInTheDocument();
    });
});
