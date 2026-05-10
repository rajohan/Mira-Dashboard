import { describe, expect, it } from "vitest";

import type { Session } from "../types/session";
import {
    formatSessionType,
    getTypeSortOrder,
    sortSessionsByTypeAndActivity,
} from "./sessionUtils";

function session(overrides: Partial<Session>): Session {
    return {
        key: "session",
        title: "Session",
        type: "MAIN",
        updatedAt: 0,
        ...overrides,
    } as Session;
}

describe("session utils", () => {
    it("formats session types", () => {
        expect(formatSessionType(session({ type: "MAIN" }))).toBe("MAIN");
        expect(formatSessionType(session({ type: "SUBAGENT", agentType: "coder" }))).toBe(
            "CODER"
        );
        expect(formatSessionType(session({ type: undefined }))).toBe("UNKNOWN");
    });

    it("orders known types before unknown types", () => {
        expect(getTypeSortOrder("MAIN")).toBe(0);
        expect(getTypeSortOrder("SUBAGENT")).toBe(1);
        expect(getTypeSortOrder("HOOK")).toBe(2);
        expect(getTypeSortOrder("CRON")).toBe(3);
        expect(getTypeSortOrder("OTHER")).toBe(4);
        expect(getTypeSortOrder(null)).toBe(4);
    });

    it("sorts default chat first, then type, then recent activity", () => {
        const sessions = [
            session({ key: "cron", type: "CRON", updatedAt: 100 }),
            session({ key: "main-old", type: "MAIN", updatedAt: 100 }),
            session({ key: "main-new", type: "MAIN", updatedAt: 200 }),
            session({ key: "agent:main:main", type: "MAIN", updatedAt: 1 }),
        ];

        expect(sortSessionsByTypeAndActivity(sessions).map((item) => item.key)).toEqual([
            "agent:main:main",
            "main-new",
            "main-old",
            "cron",
        ]);
        expect(sessions.map((item) => item.key)).toEqual([
            "cron",
            "main-old",
            "main-new",
            "agent:main:main",
        ]);
    });

    it("treats missing activity timestamps as oldest", () => {
        const sessions = [
            session({ key: "missing", type: "MAIN", updatedAt: undefined }),
            session({ key: "recent", type: "MAIN", updatedAt: 10 }),
        ];

        expect(sortSessionsByTypeAndActivity(sessions).map((item) => item.key)).toEqual([
            "recent",
            "missing",
        ]);
        expect(
            sortSessionsByTypeAndActivity([
                session({ key: "first-missing", type: "MAIN", updatedAt: undefined }),
                session({ key: "second-missing", type: "MAIN", updatedAt: undefined }),
            ]).map((item) => item.key)
        ).toEqual(["first-missing", "second-missing"]);
    });
});
