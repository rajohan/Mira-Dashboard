import { describe, expect, it, vi } from "vitest";

vi.mock("../../collections/agents", () => ({
    writeAgentsFromWebSocket: vi.fn(),
}));

vi.mock("../../collections/logs", () => ({
    writeLogFromWebSocket: vi.fn(),
}));

vi.mock("../../collections/sessions", () => ({
    replaceSessionsFromWebSocket: vi.fn(),
}));

import { writeAgentsFromWebSocket } from "../../collections/agents";
import { writeLogFromWebSocket } from "../../collections/logs";
import { replaceSessionsFromWebSocket } from "../../collections/sessions";
import { handleSocketMessage } from "./socketMessageRouter";

describe("socketMessageRouter", () => {
    it("returns null for invalid envelope", () => {
        expect(handleSocketMessage("not-an-object")).toBeNull();
        expect(handleSocketMessage(null)).toBeNull();
    });

    it("returns connection state for state type", () => {
        expect(handleSocketMessage({ type: "state", gatewayConnected: true })).toBe(true);
        expect(handleSocketMessage({ type: "state", gatewayConnected: false })).toBe(
            false
        );
    });

    it("returns true for connected type", () => {
        expect(handleSocketMessage({ type: "connected" })).toBe(true);
    });

    it("returns false for disconnected type", () => {
        expect(handleSocketMessage({ type: "disconnected" })).toBe(false);
    });

    it("returns null for event types without connection state", () => {
        expect(
            handleSocketMessage({ type: "event", event: "other", payload: [] })
        ).toBeNull();
    });

    it("handles agents event", () => {
        handleSocketMessage({ type: "event", event: "agents", payload: [{ id: "1" }] });
        expect(vi.mocked(writeAgentsFromWebSocket)).toHaveBeenCalledWith([{ id: "1" }]);
    });

    it("handles agents.list event", () => {
        handleSocketMessage({
            type: "event",
            event: "agents.list",
            payload: [{ id: "a" }],
        });
        expect(vi.mocked(writeAgentsFromWebSocket)).toHaveBeenCalled();
    });

    it("handles log type", () => {
        handleSocketMessage({ type: "log", line: '{"level":"info","0":"hello"}' });
        expect(vi.mocked(writeLogFromWebSocket)).toHaveBeenCalledWith(
            '{"level":"info","0":"hello"}'
        );
    });

    it("handles state type with sessions", () => {
        handleSocketMessage({
            type: "state",
            sessions: [{ key: "s1", id: "s1" }],
        });
        expect(vi.mocked(replaceSessionsFromWebSocket)).toHaveBeenCalled();
    });

    it("handles sessions type with sessions", () => {
        handleSocketMessage({
            type: "sessions",
            sessions: [{ key: "s2", id: "s2" }],
        });
        expect(vi.mocked(replaceSessionsFromWebSocket)).toHaveBeenCalled();
    });
});
