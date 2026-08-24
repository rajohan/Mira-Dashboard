import type { ScheduleSummary } from "../../../contracts/jobModel.ts";
import { ScheduleDetail } from "../ScheduleDetail.tsx";

const { render } = await import("@testing-library/react");

export const scheduleId = "system.worker-smoke";
export const timestampMs = 1_800_000_000_000;

/** @returns One enabled ScheduleDetail fixture with no active run. */
export function enabledSchedule(): ScheduleSummary {
    return {
        actionKey: scheduleId,
        attemptLimit: 3,
        cancellationPolicy: "cooperative",
        createdAtMs: timestampMs - 10_000,
        description: "Checks the worker without host mutation.",
        enabled: true,
        id: scheduleId,
        name: "Worker smoke",
        nextRunAtMs: timestampMs + 60_000,
        priority: 0,
        resourceClass: "light",
        resourceKeys: ["database"],
        retrySafe: true,
        schedule: { intervalMs: 60_000, kind: "interval" },
        timeoutMs: 30_000,
        updatedAtMs: timestampMs,
        version: 1,
    };
}

/**
 * Creates a disabled schedule fixture.
 * @param expiresAtMs Exact active-intent expiry.
 * @returns One disabled schedule with a durable intent.
 */
export function disabledSchedule(expiresAtMs: number): ScheduleSummary {
    return {
        actionKey: scheduleId,
        activeDisableIntent: {
            createdAtMs: timestampMs,
            expiresAtMs,
            id: "019fdf80-0000-7000-8000-000000000001",
            reason: "Planned maintenance",
        },
        attemptLimit: 3,
        cancellationPolicy: "cooperative",
        createdAtMs: timestampMs - 10_000,
        description: "Checks the worker without host mutation.",
        enabled: false,
        id: scheduleId,
        name: "Worker smoke",
        priority: 0,
        resourceClass: "light",
        resourceKeys: ["database"],
        retrySafe: true,
        schedule: { intervalMs: 60_000, kind: "interval" },
        timeoutMs: 30_000,
        updatedAtMs: timestampMs,
        version: 2,
    };
}

interface RenderScheduleDetailOptions {
    readonly disableError?: string;
    readonly error?: string;
    readonly onDisable?: (
        draft: {
            readonly expiresAtMs?: number;
            readonly reason: string;
        },
        expectedVersion: number
    ) => Promise<void>;
    readonly onOpenDisable?: () => void;
    readonly onRun?: () => Promise<void>;
    readonly runReplayAvailable?: boolean;
    readonly schedule?: ScheduleSummary;
}

/**
 * Renders ScheduleDetail with inert defaults around the behavior under test.
 * @param options Optional schedule and callback overrides.
 * @returns Testing Library render controls.
 */
export function renderScheduleDetail({
    disableError,
    error,
    onDisable = async () => {},
    onOpenDisable = () => {},
    onRun = async () => {},
    runReplayAvailable,
    schedule = enabledSchedule(),
}: RenderScheduleDetailOptions = {}) {
    return render(
        <ScheduleDetail
            disableError={disableError}
            error={error}
            history={<p>Run history</p>}
            onDisable={onDisable}
            onEnable={async () => {}}
            onOpenDisable={onOpenDisable}
            onRun={onRun}
            onSaveConfiguration={async () => {}}
            runBusy={false}
            runReplayAvailable={runReplayAvailable}
            schedule={schedule}
            updateBusy={false}
        />
    );
}
