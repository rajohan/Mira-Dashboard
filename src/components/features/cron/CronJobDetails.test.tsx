import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { CronJob } from "../../../hooks";
import { CronJobDetails } from "./CronJobDetails";

const job = {
    jobId: "dashboard-autopilot",
    name: "Dashboard autopilot",
    enabled: true,
    schedule: { kind: "cron", expr: "30 9,18 * * *", tz: "Europe/Oslo" },
    payload: { kind: "agentTurn", message: "Improve the dashboard" },
    delivery: { mode: "none" },
    state: {
        lastRunAtMs: new Date("2026-05-10T07:30:00.000Z").getTime(),
        nextRunAtMs: new Date("2026-05-10T16:30:00.000Z").getTime(),
        lastRunStatus: "success",
    },
} satisfies CronJob;

function renderDetails(
    overrides: Partial<React.ComponentProps<typeof CronJobDetails>> = {}
) {
    const props = {
        job,
        togglePending: false,
        runPending: false,
        updatePending: false,
        onToggle: vi.fn(),
        onRunNow: vi.fn(),
        isEditMode: false,
        onEditModeChange: vi.fn(),
        nameDraft: "Dashboard autopilot",
        onNameDraftChange: vi.fn(),
        scheduleDraft: JSON.stringify(job.schedule, null, 2),
        onScheduleDraftChange: vi.fn(),
        payloadDraft: JSON.stringify(job.payload, null, 2),
        onPayloadDraftChange: vi.fn(),
        deliveryDraft: JSON.stringify(job.delivery, null, 2),
        onDeliveryDraftChange: vi.fn(),
        scheduleValidation: { valid: true, error: null },
        payloadValidation: { valid: true, error: null },
        deliveryValidation: { valid: true, error: null },
        hasInvalidJson: false,
        editError: null,
        onSave: vi.fn(),
        formatDate: (value: number) => new Date(value).toISOString(),
        ...overrides,
    } satisfies React.ComponentProps<typeof CronJobDetails>;

    return {
        ...render(<CronJobDetails {...props} />),
        props,
    };
}

describe("CronJobDetails", () => {
    it("renders controls, run state, and read-only JSON config", () => {
        renderDetails({
            lastTriggeredAt: new Date("2026-05-10T12:00:00.000Z").getTime(),
        });

        expect(screen.getByText("Dashboard autopilot")).toBeInTheDocument();
        expect(screen.getByText("dashboard-autopilot")).toBeInTheDocument();
        expect(screen.getAllByText("Enabled").length).toBeGreaterThan(0);
        expect(screen.getByRole("button", { name: /Trigger now/ })).toBeEnabled();
        expect(
            screen.getByText(/Triggered 2026-05-10T12:00:00.000Z/)
        ).toBeInTheDocument();
        expect(screen.getByText("SUCCESS")).toBeInTheDocument();
        expect(screen.getByText(/30 9,18 \* \* \*/)).toBeInTheDocument();
        expect(screen.getByText(/Improve the dashboard/)).toBeInTheDocument();
        expect(screen.getByText(/"mode": "none"/)).toBeInTheDocument();
    });

    it("dispatches toggle, run, and edit actions", async () => {
        const user = userEvent.setup();
        const onToggle = vi.fn();
        const onRunNow = vi.fn();
        const onEditModeChange = vi.fn();

        renderDetails({ onToggle, onRunNow, onEditModeChange });

        await user.click(screen.getByRole("switch", { name: "Enabled" }));
        await user.click(screen.getByRole("button", { name: /Trigger now/ }));
        await user.click(screen.getByRole("button", { name: "Edit" }));

        expect(onToggle).toHaveBeenCalledWith(job, false);
        expect(onRunNow).toHaveBeenCalledWith(job);
        expect(onEditModeChange).toHaveBeenCalledWith(true);
    });

    it("renders edit validation and saves valid edits", async () => {
        const user = userEvent.setup();
        const onSave = vi.fn();
        const onNameDraftChange = vi.fn();
        const onScheduleDraftChange = vi.fn();

        renderDetails({
            isEditMode: true,
            editError: "Update failed",
            onSave,
            onNameDraftChange,
            onScheduleDraftChange,
        });

        expect(screen.getByText("Update failed")).toBeInTheDocument();
        expect(screen.getAllByText("Valid JSON")).toHaveLength(3);

        await user.clear(screen.getByPlaceholderText("Job name"));
        await user.type(screen.getByPlaceholderText("Job name"), "Updated autopilot");
        await user.type(screen.getByDisplayValue(/30 9,18/), " ");
        await user.click(screen.getByRole("button", { name: "Save edits" }));

        expect(onNameDraftChange).toHaveBeenCalled();
        expect(onScheduleDraftChange).toHaveBeenCalled();
        expect(onSave).toHaveBeenCalledWith(job);
    });

    it("disables save while edit JSON is invalid", () => {
        renderDetails({
            isEditMode: true,
            hasInvalidJson: true,
            scheduleValidation: { valid: false, error: "Unexpected token" },
        });

        expect(screen.getByText("Invalid JSON: Unexpected token")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Save edits" })).toBeDisabled();
    });
});
