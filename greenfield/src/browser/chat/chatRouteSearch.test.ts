import { describe, expect, test } from "bun:test";

import { parseChatRouteSearch, resolveChatSessionKey } from "./chatRouteSearch.ts";

describe("chat route search", () => {
    test("keeps one exact bounded URL-selected session", () => {
        expect(
            parseChatRouteSearch({ session: "agent:main:main", ignored: true })
        ).toEqual({
            session: "agent:main:main",
        });
    });

    test("drops malformed external search without throwing", () => {
        expect(parseChatRouteSearch(null)).toEqual({});
        expect(parseChatRouteSearch(["agent:main:main"])).toEqual({});
        expect(parseChatRouteSearch({ session: 1 })).toEqual({});
        expect(parseChatRouteSearch({ session: " leading" })).toEqual({});
        expect(parseChatRouteSearch({ session: "trailing " })).toEqual({});
        expect(parseChatRouteSearch({ session: "line\nbreak" })).toEqual({});
        expect(parseChatRouteSearch({ session: "x".repeat(513) })).toEqual({});
    });

    test("retains a valid request and otherwise chooses a stable provider default", () => {
        const sessions = [
            { isDefault: false, key: "agent:coder:main" },
            { isDefault: true, key: "agent:main:main" },
        ];
        expect(resolveChatSessionKey("agent:coder:main", sessions, true)).toBe(
            "agent:coder:main"
        );
        expect(resolveChatSessionKey("missing", sessions, true)).toBe("agent:main:main");
        expect(resolveChatSessionKey(undefined, sessions, true)).toBe("agent:main:main");
        expect(resolveChatSessionKey(undefined, [], true)).toBe("");
    });

    test("keeps an absent explicit request unresolved until inventory absence is authoritative", () => {
        const sessions = [
            { isDefault: true, key: "agent:main:main" },
            { isDefault: false, key: "agent:coder:main" },
        ];
        expect(resolveChatSessionKey("agent:missing:main", sessions, false)).toBe("");
        expect(resolveChatSessionKey("agent:coder:main", sessions, false)).toBe(
            "agent:coder:main"
        );
    });
});
