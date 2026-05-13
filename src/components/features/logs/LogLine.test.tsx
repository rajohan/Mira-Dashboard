import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { LogEntry } from "../../../types/log";
import { LogLine } from "./LogLine";

describe("LogLine", () => {
    it("renders timestamp, level, subsystem, and message", () => {
        const log: LogEntry = {
            id: "1",
            ts: "2026-05-10T10:00:00.000Z",
            level: "warn",
            subsystem: "gateway",
            msg: "Slow response",
            raw: "raw",
        };

        render(<LogLine log={log} />);

        expect(screen.getByText("WARN")).toBeInTheDocument();
        expect(screen.getByText("[gateway]")).toBeInTheDocument();
        expect(screen.getByText("Slow response")).toBeInTheDocument();
    });

    it("falls back to raw text when message is not a string", () => {
        render(
            <LogLine
                log={
                    {
                        id: "2",
                        level: null,
                        subsystem: null,
                        msg: { structured: true },
                        raw: "fallback raw",
                    } as unknown as LogEntry
                }
            />
        );

        expect(screen.queryByText("WARN")).not.toBeInTheDocument();
        expect(screen.getByText("fallback raw")).toBeInTheDocument();
    });

    it("renders an empty message fallback when raw text is missing", () => {
        const { container } = render(
            <LogLine
                log={
                    {
                        id: "3",
                        msg: { structured: true },
                    } as unknown as LogEntry
                }
            />
        );

        const message = container.querySelector("span.text-primary-200");

        expect(message).toBeTruthy();
        expect(message?.textContent).toBe("");
    });
});
