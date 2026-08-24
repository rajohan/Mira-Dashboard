import { describe, expect, test } from "bun:test";

import {
    chatAgentIdFromSessionKey,
    chatAgentOptions,
    chatSessionLabelForAgent,
    chatSessionsForAgent,
} from "./chatSessionPicker.ts";
import type { ChatSessionOption } from "./chatTypes.ts";

function session(
    key: string,
    overrides: Partial<ChatSessionOption> = {}
): ChatSessionOption {
    return {
        activeRunCount: 0,
        displayName: key,
        isDefault: false,
        key,
        modelOptions: [],
        speed: "standard",
        thinking: "default",
        thinkingOptions: [],
        totalTokensFresh: false,
        ...overrides,
    };
}

describe("chat session picker", () => {
    test("derives explicit normalized agent scopes without guessing malformed keys", () => {
        expect(chatAgentIdFromSessionKey("agent:Ops:main")).toBe("ops");
        expect(chatAgentIdFromSessionKey("cron:ops:main")).toBe("unknown");
        expect(chatAgentIdFromSessionKey("agent::main")).toBe("unknown");
    });

    test("keeps agents unique and sessions restricted and ordered within the selection", () => {
        const sessions = [
            session("agent:ops:older", { updatedAtMs: 1 }),
            session("agent:coder:main"),
            session("agent:main:main", { isDefault: true }),
            session("agent:ops:main", { updatedAtMs: 1 }),
            session("agent:ops:active", { activeRunCount: 1, updatedAtMs: 2 }),
            session("cron:reviewed:row"),
        ];
        expect(chatAgentOptions(sessions)).toEqual([
            { description: "1 session", label: "main", value: "main" },
            { description: "1 session", label: "coder", value: "coder" },
            { description: "3 sessions", label: "ops", value: "ops" },
            {
                description: "1 session",
                label: "Other / unknown",
                value: "unknown",
            },
        ]);
        expect(chatSessionsForAgent(sessions, "ops").map(({ key }) => key)).toEqual([
            "agent:ops:main",
            "agent:ops:active",
            "agent:ops:older",
        ]);
    });

    test("labels exact agent sessions relative to the selected agent", () => {
        expect(
            chatSessionLabelForAgent(
                session("agent:main:main", { displayName: "Mira main" }),
                "main"
            )
        ).toBe("main");
        expect(
            chatSessionLabelForAgent(
                session("agent:ops:thread:release", {
                    displayName: "Release thread",
                }),
                "ops"
            )
        ).toBe("thread:release");
        expect(
            chatSessionLabelForAgent(
                session("legacy-session", { displayName: "Malformed row" }),
                "unknown"
            )
        ).toBe("Malformed row");
    });
});
