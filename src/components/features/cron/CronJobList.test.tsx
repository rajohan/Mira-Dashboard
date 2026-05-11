import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { CronJob } from "../../../hooks";
import { CronJobList } from "./CronJobList";

const jobs = [
    {
        jobId: "job-1",
        name: "Morning dashboard autopilot",
        enabled: true,
        state: {
            lastRunAtMs: new Date("2026-05-10T07:30:00.000Z").getTime(),
            nextRunAtMs: new Date("2026-05-10T16:30:00.000Z").getTime(),
        },
    },
    {
        id: "job-2",
        name: "Disabled cleanup",
        enabled: false,
        state: {},
    },
] satisfies CronJob[];

describe("CronJobList", () => {
    it("renders job status, identifiers, and run timestamps", () => {
        render(
            <CronJobList
                jobs={jobs}
                selectedId="job-1"
                currentJobId=""
                onSelect={vi.fn()}
            />
        );

        expect(screen.getByText("Cron jobs")).toBeInTheDocument();
        expect(screen.getByText("Morning dashboard autopilot")).toBeInTheDocument();
        expect(screen.getByText("Disabled cleanup")).toBeInTheDocument();
        expect(screen.getByText("job-1")).toBeInTheDocument();
        expect(screen.getByText("job-2")).toBeInTheDocument();
        expect(screen.getByText("Enabled")).toBeInTheDocument();
        expect(screen.getByText("Disabled")).toBeInTheDocument();
        expect(screen.getAllByText(/Last:/)).toHaveLength(2);
        expect(screen.getAllByText(/Next:/)).toHaveLength(2);
    });

    it("selects jobs by resolved id", async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();

        render(
            <CronJobList
                jobs={jobs}
                selectedId=""
                currentJobId="job-1"
                onSelect={onSelect}
            />
        );

        await user.click(screen.getByRole("button", { name: /Disabled cleanup/ }));

        expect(onSelect).toHaveBeenCalledWith("job-2");
    });
});
