import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, jest } from "bun:test";

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
        lastRunAtMs: Date.parse("2026-05-10T07:30:00.000Z"),
        nextRunAtMs: Date.parse("2026-05-10T16:30:00.000Z"),
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
        deletePending: false,
        onToggle: jest.fn(),
        onRunNow: jest.fn(),
        onDelete: jest.fn(),
        isEditMode: false,
        onEditModeChange: jest.fn(),
        nameDraft: "Dashboard autopilot",
        onNameDraftChange: jest.fn(),
        scheduleDraft: JSON.stringify(job.schedule, null, 2),
        onScheduleDraftChange: jest.fn(),
        payloadDraft: JSON.stringify(job.payload, null, 2),
        onPayloadDraftChange: jest.fn(),
        deliveryDraft: JSON.stringify(job.delivery, null, 2),
        onDeliveryDraftChange: jest.fn(),
        scheduleValidation: { valid: true, error: null },
        payloadValidation: { valid: true, error: null },
        deliveryValidation: { valid: true, error: null },
        hasInvalidJson: false,
        editError: null,
        onSave: jest.fn(),
        formatDate: (value: number) => {
            const date = new Date(value);
            return date.toISOString();
        },
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
            lastTriggeredAt: Date.parse("2026-05-10T12:00:00.000Z"),
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
        const onToggle = jest.fn();
        const onRunNow = jest.fn();
        const onDelete = jest.fn();
        const onEditModeChange = jest.fn();

        renderDetails({ onToggle, onRunNow, onDelete, onEditModeChange });

        await user.click(screen.getByRole("switch", { name: "Enabled" }));
        await user.click(screen.getByRole("button", { name: /Trigger now/ }));
        await user.click(screen.getByRole("button", { name: "Delete" }));
        await user.click(screen.getByRole("button", { name: "Edit" }));

        expect(onToggle).toHaveBeenCalledWith(job, false);
        expect(onRunNow).toHaveBeenCalledWith(job);
        expect(onDelete).toHaveBeenCalledWith(job);
        expect(onEditModeChange).toHaveBeenCalledWith(true);
    });

    it("renders edit validation and saves valid edits", async () => {
        const user = userEvent.setup();
        const onSave = jest.fn();
        const onNameDraftChange = jest.fn();
        const onScheduleDraftChange = jest.fn();
        const onPayloadDraftChange = jest.fn();
        const onDeliveryDraftChange = jest.fn();

        renderDetails({
            isEditMode: true,
            editError: "Update failed",
            onSave,
            onNameDraftChange,
            onScheduleDraftChange,
            onPayloadDraftChange,
            onDeliveryDraftChange,
        });

        expect(screen.getByText("Update failed")).toBeInTheDocument();
        expect(screen.getAllByText("Valid JSON")).toHaveLength(3);

        await user.clear(screen.getByLabelText("Name"));
        await user.type(screen.getByLabelText("Name"), "Updated autopilot");
        await user.type(screen.getByLabelText("Schedule (JSON)"), " ");
        await user.type(screen.getByLabelText("Payload (JSON)"), " ");
        await user.type(screen.getByLabelText("Delivery (JSON)"), " ");
        await user.click(screen.getByRole("button", { name: "Save edits" }));

        expect(onNameDraftChange).toHaveBeenCalled();
        expect(onScheduleDraftChange).toHaveBeenCalled();
        expect(onPayloadDraftChange).toHaveBeenCalled();
        expect(onDeliveryDraftChange).toHaveBeenCalled();
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

    it("renders pending and disabled states", async () => {
        const user = userEvent.setup();
        const onEditModeChange = jest.fn();

        renderDetails({
            job: { ...job, enabled: false },
            isEditMode: true,
            runPending: true,
            togglePending: true,
            updatePending: true,
            deletePending: true,
            hasInvalidJson: true,
            payloadValidation: { valid: false, error: null },
            deliveryValidation: { valid: false, error: "missing mode" },
            onEditModeChange,
        });

        expect(screen.getByText("Disabled")).toBeInTheDocument();
        expect(screen.getByRole("switch", { name: "Enabled" })).toBeDisabled();
        expect(screen.getByRole("button", { name: /Triggering/ })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Deleting..." })).toBeDisabled();
        expect(screen.getByText("Running job...")).toBeInTheDocument();
        expect(screen.getByText("Invalid JSON: parse error")).toBeInTheDocument();
        expect(screen.getByText("Invalid JSON: missing mode")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(onEditModeChange).toHaveBeenCalledWith(false);
    });

    it("renders parse-error fallbacks and empty read-only config", () => {
        const emptyConfigJob = {
            ...job,
            delivery: undefined,
            payload: undefined,
            schedule: undefined,
        } as CronJob;
        const { container, rerender, props } = renderDetails({
            job: emptyConfigJob,
        });

        expect(container).toHaveTextContent("{}");

        rerender(
            <CronJobDetails
                {...props}
                job={emptyConfigJob}
                isEditMode
                deliveryValidation={{ valid: false, error: null }}
                scheduleValidation={{ valid: false, error: null }}
            />
        );

        expect(screen.getAllByText("Invalid JSON: parse error")).toHaveLength(2);
    });
});
