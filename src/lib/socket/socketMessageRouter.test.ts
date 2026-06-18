import { beforeEach, describe, expect, it, jest, mock } from "bun:test";

import { mocked } from "../../test/testUtils";

mock.module("../../collections/agents", () => ({
    writeAgentsFromWebSocket: jest.fn(),
}));

mock.module("../../collections/logs", () => ({
    writeLogFromWebSocket: jest.fn(),
}));

mock.module("../../collections/sessions", () => ({
    replaceSessionsFromWebSocket: jest.fn(),
}));

import { writeAgentsFromWebSocket } from "../../collections/agents";
import { writeLogFromWebSocket } from "../../collections/logs";
import { replaceSessionsFromWebSocket } from "../../collections/sessions";
import { handleSocketMessage } from "./socketMessageRouter";

describe("socketMessageRouter", () => {
    beforeEach(() => {
        mocked(writeAgentsFromWebSocket).mockClear();
        mocked(writeLogFromWebSocket).mockClear();
        mocked(replaceSessionsFromWebSocket).mockClear();
    });

    it("returns null for invalid envelope", () => {
        expect(handleSocketMessage("not-an-object")).toBeNull();
        expect(handleSocketMessage(null)).toBeNull();
    });

    it("returns connection state for state type", () => {
        expect(handleSocketMessage({ type: "state", gatewayConnected: true })).toBe(true);
        expect(handleSocketMessage({ type: "state", gatewayConnected: false })).toBe(
            false
        );
        expect(handleSocketMessage({ type: "state" })).toBe(true);
    });

    it("returns true for connected type", () => {
        expect(handleSocketMessage({ type: "connected" })).toBe(true);
        expect(handleSocketMessage({ type: "connected", gatewayConnected: false })).toBe(
            false
        );
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
        expect(mocked(writeAgentsFromWebSocket)).toHaveBeenCalledWith([{ id: "1" }]);
    });

    it("handles agents.list event", () => {
        handleSocketMessage({
            type: "event",
            event: "agents.list",
            payload: [{ id: "a" }],
        });
        expect(mocked(writeAgentsFromWebSocket)).toHaveBeenCalledWith([{ id: "a" }]);
    });

    it("ignores agents event with non-array payload", () => {
        handleSocketMessage({ type: "event", event: "agents", payload: { id: "a" } });
        expect(mocked(writeAgentsFromWebSocket)).not.toHaveBeenCalled();
    });

    it("handles log type", () => {
        handleSocketMessage({ type: "log", line: '{"level":"info","0":"hello"}' });
        expect(mocked(writeLogFromWebSocket)).toHaveBeenCalledWith(
            '{"level":"info","0":"hello"}'
        );
    });

    it("ignores log type without line", () => {
        handleSocketMessage({ type: "log" });
        expect(mocked(writeLogFromWebSocket)).not.toHaveBeenCalled();
    });

    it("handles state type with sessions", () => {
        handleSocketMessage({
            type: "state",
            sessions: [{ key: "s1", id: "s1" }],
        });
        expect(mocked(replaceSessionsFromWebSocket)).toHaveBeenCalledWith([
            { key: "s1", id: "s1" },
        ]);
    });

    it("handles sessions type with sessions", () => {
        handleSocketMessage({
            type: "sessions",
            sessions: [{ key: "s2", id: "s2" }],
        });
        expect(mocked(replaceSessionsFromWebSocket)).toHaveBeenCalledWith([
            { key: "s2", id: "s2" },
        ]);
    });

    it("handles res payload as a raw sessions array", () => {
        handleSocketMessage({
            type: "res",
            id: "1",
            ok: true,
            payload: [{ key: "s3", id: "s3" }],
        });
        expect(mocked(replaceSessionsFromWebSocket)).toHaveBeenCalledWith([
            { key: "s3", id: "s3" },
        ]);
    });

    it("handles res payload with sessions object", () => {
        handleSocketMessage({
            type: "res",
            id: "1",
            ok: true,
            payload: { sessions: [{ key: "s4", id: "s4" }] },
        });
        expect(mocked(replaceSessionsFromWebSocket)).toHaveBeenCalledWith([
            { key: "s4", id: "s4" },
        ]);
    });

    it("handles res payload with nested result/data sessions", () => {
        handleSocketMessage({
            type: "res",
            id: "1",
            ok: true,
            payload: { result: { sessions: [{ key: "s5", id: "s5" }] } },
        });
        handleSocketMessage({
            type: "res",
            id: "2",
            ok: true,
            payload: { data: { sessions: [{ key: "s6", id: "s6" }] } },
        });
        expect(mocked(replaceSessionsFromWebSocket)).toHaveBeenCalledTimes(2);
    });

    it("ignores res payloads without sessions", () => {
        handleSocketMessage({ type: "res", id: "1", ok: true, payload: { ok: true } });
        expect(mocked(replaceSessionsFromWebSocket)).not.toHaveBeenCalled();
    });

    it("ignores primitive res payloads", () => {
        handleSocketMessage({ type: "res", id: "1", ok: true, payload: "ok" });
        expect(mocked(replaceSessionsFromWebSocket)).not.toHaveBeenCalled();
    });
});
