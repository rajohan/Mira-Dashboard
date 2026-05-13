import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatHistoryMessage } from "./chatTypes";
import {
    base64ToText,
    dataUrlToBase64,
    dedupeMessages,
    displayMimeType,
    mergeWithRecentOptimisticMessages,
    messageDeleteKey,
    messageIdentity,
    readFileAsDataUrl,
} from "./chatUtils";

function message(overrides: Partial<ChatHistoryMessage>): ChatHistoryMessage {
    return {
        role: "assistant",
        content: overrides.text || "",
        text: "",
        ...overrides,
    };
}

describe("chat utils", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("converts data URLs and base64 text", () => {
        expect(dataUrlToBase64("data:text/plain;base64,aGVsbG8=")).toBe("aGVsbG8=");
        expect(dataUrlToBase64("raw-base64")).toBe("raw-base64");
        expect(base64ToText("aGVsbG8=")).toBe("hello");
    });

    it("builds stable message identity and delete keys", () => {
        const item = message({
            role: "Assistant",
            text: "  hello  ",
            timestamp: "2026-05-10T10:00:00.000Z",
            runId: "run-1",
        });

        expect(messageIdentity(item)).toBe("assistant::hello");
        expect(messageDeleteKey(item)).toBe(
            "assistant::2026-05-10T10:00:00.000Z::run-1::hello"
        );
        expect(messageDeleteKey(message({ role: "user", text: "hi" }))).toBe(
            "user::no-time::no-run::hi"
        );
    });

    it("dedupes messages from the newest duplicate while retaining empty text rows", () => {
        const first = message({ role: "assistant", text: "same", timestamp: "1" });
        const newer = message({ role: "assistant", text: "same", timestamp: "2" });
        const empty = message({ role: "assistant", text: "" });

        expect(dedupeMessages([first, undefined, empty, newer] as never)).toEqual([
            empty,
            newer,
        ]);
    });

    it("covers merge edge cases and timestamp ordering", () => {
        vi.spyOn(Date, "now").mockReturnValue(
            new Date("2026-05-10T10:02:00.000Z").getTime()
        );

        const previous = [
            message({ role: "assistant", text: "" }),
            message({ role: "tool", text: "tool output" }),
            message({ role: "user", text: "timeless" }),
            message({
                role: "user",
                text: "later",
                timestamp: "2026-05-10T10:01:50.000Z",
            }),
            message({
                role: "user",
                text: "earlier",
                timestamp: "2026-05-10T10:01:10.000Z",
            }),
            message({ role: "system", text: "local", local: true }),
        ];
        const next = [
            message({
                role: "assistant",
                text: "middle",
                timestamp: "2026-05-10T10:01:30.000Z",
            }),
        ];

        expect(mergeWithRecentOptimisticMessages([], next)).toEqual(next);
        expect(mergeWithRecentOptimisticMessages(previous, [])).toEqual(previous);
        expect(
            mergeWithRecentOptimisticMessages(previous, next).map((item) => item.text)
        ).toEqual(["earlier", "middle", "later", "local"]);
    });

    it("retains recent optimistic and local messages missing from refreshed history", () => {
        vi.spyOn(Date, "now").mockReturnValue(
            new Date("2026-05-10T10:02:00.000Z").getTime()
        );

        const previous = [
            message({
                role: "user",
                text: "recent local send",
                timestamp: "2026-05-10T10:01:30.000Z",
            }),
            message({
                role: "user",
                text: "old send",
                timestamp: "2026-05-10T09:00:00.000Z",
            }),
            message({ role: "system", text: "local notice", local: true }),
        ];
        const next = [
            message({
                role: "assistant",
                text: "server reply",
                timestamp: "2026-05-10T10:01:45.000Z",
            }),
        ];

        expect(
            mergeWithRecentOptimisticMessages(previous, next).map((item) => item.text)
        ).toEqual(["recent local send", "server reply", "local notice"]);
    });

    it("does not retain optimistic assistant text recovered in refreshed history", () => {
        vi.spyOn(Date, "now").mockReturnValue(
            new Date("2026-05-10T10:02:00.000Z").getTime()
        );

        const previous = [
            message({
                role: "assistant",
                text: "This response is still streaming from the assistant",
                timestamp: "2026-05-10T10:01:30.000Z",
            }),
            message({
                role: "assistant",
                text: "exact recovered text",
                timestamp: "2026-05-10T10:01:31.000Z",
            }),
            message({
                role: "assistant",
                text: "short",
                timestamp: "2026-05-10T10:01:32.000Z",
            }),
        ];
        const next = [
            message({ role: "assistant", text: "response is still streaming" }),
            message({ role: "assistant", text: "exact recovered text" }),
        ];

        expect(
            mergeWithRecentOptimisticMessages(previous, next).map((item) => item.text)
        ).toEqual(["response is still streaming", "exact recovered text", "short"]);
    });

    it("rejects unreadable file results", async () => {
        const OriginalFileReader = globalThis.FileReader;
        try {
            class NonStringFileReader extends EventTarget {
                result: ArrayBuffer | null = new ArrayBuffer(0);
                error: Error | null = null;
                readAsDataURL() {
                    this.dispatchEvent(new Event("load"));
                }
            }
            class ErrorFileReader extends EventTarget {
                result: string | null = null;
                error: Error | null = new Error("reader failed");
                readAsDataURL() {
                    this.dispatchEvent(new Event("error"));
                }
            }

            vi.stubGlobal("FileReader", NonStringFileReader);
            await expect(readFileAsDataUrl(new File(["x"], "bad.bin"))).rejects.toThrow(
                "Could not read bad.bin"
            );

            vi.stubGlobal("FileReader", ErrorFileReader);
            await expect(readFileAsDataUrl(new File(["x"], "bad.bin"))).rejects.toThrow(
                "reader failed"
            );
        } finally {
            vi.stubGlobal("FileReader", OriginalFileReader);
        }
    });

    it("reads file metadata and file contents for attachments", async () => {
        const file = new File(["hello"], "note.txt", { type: "text/plain" });
        const unknownType = new File(["{}"], "data.bin");

        await expect(readFileAsDataUrl(file)).resolves.toMatch(
            /^data:text\/plain;base64,aGVsbG8=/
        );
        expect(displayMimeType(file)).toBe("text/plain");
        expect(displayMimeType(unknownType)).toBe("application/octet-stream");
    });
});
