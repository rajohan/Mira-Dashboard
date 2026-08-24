import { describe, expect, jest, test } from "bun:test";

import {
    chatAttachmentUploadTimeoutMs,
    chatAttachmentMediaType,
    createChatDraftAttachments,
    prepareAndUploadChatAttachments,
    validateChatAttachmentFiles,
    type ChatUploadRequestFactory,
} from "./chatAttachments.ts";

const sessionKey = "agent:main:main";
const ticketId = "019fe633-9133-4ba0-8b80-809dd80dfb39";
const attachmentId = "019fe633-9133-4ba0-8b80-809dd80dfb40";
const idempotencyKey = "0123456789abcdef0123456789abcdef";

function file(name = "note.txt", size = 5, type = "text/plain") {
    return new File([new Uint8Array(size)], name, { type });
}

describe("chat attachments", () => {
    test("reports count, per-file, aggregate, empty, and name failures together", () => {
        const oversized = file("large.bin", 16 * 1024 * 1024 + 1, "");
        const empty = file(" bad\n", 0);
        const result = validateChatAttachmentFiles([
            oversized,
            empty,
            ...Array.from({ length: 9 }, (_, index) => file(`${index}.txt`, 128 * 1024)),
        ]);
        expect(result.files).toEqual([]);
        expect(result.message).toContain("at most 10 files");
        expect(result.message).toContain("large.bin exceeds 16 MiB");
        expect(result.message).toContain("is empty");
        expect(result.message).toContain("invalid file name");
        expect(result.message).toContain("16 MiB total limit");
        expect(result.message).toContain("unsupported file type");
        expect(chatAttachmentMediaType(oversized)).toBe("");
        expect(chatAttachmentMediaType(file("notes.txt", 5, ""))).toBe("text/plain");
        expect(chatAttachmentMediaType(file("report.docx", 5, "application/zip"))).toBe(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        );
        expect(
            validateChatAttachmentFiles([file("clip.mp4", 5, "video/mp4")]).message
        ).toContain("Video attachments are not supported");
        expect(
            validateChatAttachmentFiles([file("safe\u202Efile.txt", 5)]).message
        ).toContain("invalid file name");
    });

    test("uploads an exact prepared slot and reports byte progress", async () => {
        const listeners = new Map<string, (event: Event) => void>();
        const uploadListeners = new Map<string, (event: ProgressEvent) => void>();
        let requestStatus = 204;
        const open = jest.fn();
        const setRequestHeader = jest.fn();
        const send = jest.fn(() => {
            uploadListeners.get("progress")?.({
                lengthComputable: true,
                loaded: 3,
                total: 5,
            } as ProgressEvent);
            listeners.get("load")?.(new Event("load"));
        });
        const requestFactory: ChatUploadRequestFactory = () => ({
            abort: jest.fn(),
            addEventListener: ((
                type: string,
                listener: EventListenerOrEventListenerObject
            ) => {
                if (typeof listener === "function") listeners.set(type, listener);
            }) as XMLHttpRequest["addEventListener"],
            open,
            send,
            setRequestHeader,
            get status() {
                return requestStatus;
            },
            timeout: 0,
            upload: {
                addEventListener: ((
                    type: string,
                    listener: EventListenerOrEventListenerObject
                ) => {
                    if (typeof listener === "function") {
                        uploadListeners.set(type, listener);
                    }
                }) as XMLHttpRequestUpload["addEventListener"],
            },
            withCredentials: false,
        });
        const attachments = createChatDraftAttachments([file()]);
        const progress = jest.fn();
        const client = {
            mutation: jest.fn(() =>
                Promise.resolve({
                    expiresAtMs: Date.now() + 60_000,
                    ticketId,
                    uploads: [
                        {
                            attachmentId,
                            uploadUrl: `/api/chat/attachments/${ticketId}/${attachmentId}`,
                        },
                    ],
                })
            ),
        };

        const result = await prepareAndUploadChatAttachments(
            client,
            sessionKey,
            attachments,
            idempotencyKey,
            new AbortController().signal,
            progress,
            requestFactory
        );
        expect(result.ticketId).toBe(ticketId);
        expect(client.mutation).toHaveBeenCalledWith(
            "chat.prepareAttachmentTicket",
            expect.objectContaining({
                files: [{ fileName: "note.txt", mimeType: "text/plain", sizeBytes: 5 }],
                idempotencyKey,
                sessionKey,
            }),
            expect.objectContaining({ signal: expect.any(AbortSignal) })
        );
        expect(open).toHaveBeenCalledWith(
            "PUT",
            `/api/chat/attachments/${ticketId}/${attachmentId}`,
            true
        );
        expect(setRequestHeader).toHaveBeenCalledWith("Content-Type", "text/plain");
        expect(send).toHaveBeenCalledWith(attachments[0]?.file);
        expect(progress).toHaveBeenNthCalledWith(1, attachments[0]?.id, 0, "uploading");
        expect(progress).toHaveBeenNthCalledWith(2, attachments[0]?.id, 60, "uploading");
        expect(progress).toHaveBeenNthCalledWith(3, attachments[0]?.id, 100, "ready");
        requestStatus = 500;
    });

    test("rejects expired tickets before opening a raw upload", async () => {
        const attachments = createChatDraftAttachments([file()]);
        const requestFactory = jest.fn();
        let failure: unknown;
        try {
            await prepareAndUploadChatAttachments(
                {
                    mutation: () =>
                        Promise.resolve({
                            expiresAtMs: Date.now() - 1,
                            ticketId,
                            uploads: [
                                {
                                    attachmentId,
                                    uploadUrl: `/api/chat/attachments/${ticketId}/${attachmentId}`,
                                },
                            ],
                        }),
                },
                sessionKey,
                attachments,
                idempotencyKey,
                new AbortController().signal,
                jest.fn(),
                requestFactory
            );
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe("Attachment ticket is unavailable");
        expect(requestFactory).not.toHaveBeenCalled();
    });

    test("sets and enforces a bounded upload timeout", async () => {
        jest.useFakeTimers();
        try {
            const listeners = new Map<string, (event: Event) => void>();
            let configuredTimeout = 0;
            const requestFactory: ChatUploadRequestFactory = () => ({
                abort: jest.fn(),
                addEventListener: ((type: string, listener: EventListener) => {
                    listeners.set(type, listener);
                }) as XMLHttpRequest["addEventListener"],
                open: jest.fn(),
                send: jest.fn(),
                setRequestHeader: jest.fn(),
                status: 0,
                set timeout(value: number) {
                    configuredTimeout = value;
                    setTimeout(
                        () => listeners.get("timeout")?.(new Event("timeout")),
                        value
                    );
                },
                get timeout() {
                    return configuredTimeout;
                },
                upload: {
                    addEventListener: jest.fn(),
                },
                withCredentials: false,
            });
            const pending = prepareAndUploadChatAttachments(
                {
                    mutation: () =>
                        Promise.resolve({
                            expiresAtMs: Date.now() + 120_000,
                            ticketId,
                            uploads: [
                                {
                                    attachmentId,
                                    uploadUrl: `/api/chat/attachments/${ticketId}/${attachmentId}`,
                                },
                            ],
                        }),
                },
                sessionKey,
                createChatDraftAttachments([file()]),
                idempotencyKey,
                new AbortController().signal,
                jest.fn(),
                requestFactory
            );
            await Promise.resolve();
            expect(configuredTimeout).toBe(chatAttachmentUploadTimeoutMs);
            jest.advanceTimersByTime(chatAttachmentUploadTimeoutMs);
            const failure = await pending.catch((error: unknown) => error);
            expect(failure).toBeInstanceOf(Error);
            expect((failure as Error).message).toContain("Attachment upload timed out");
        } finally {
            jest.useRealTimers();
        }
    });

    test("aborts sibling uploads after the first partial failure", async () => {
        const requests: Array<{
            abort: ReturnType<typeof jest.fn>;
            listeners: Map<string, (event: Event) => void>;
        }> = [];
        const requestFactory: ChatUploadRequestFactory = () => {
            const listeners = new Map<string, (event: Event) => void>();
            const abort = jest.fn(() => {
                listeners.get("abort")?.(new Event("abort"));
            });
            requests.push({ abort, listeners });
            return {
                abort,
                addEventListener: ((type: string, listener: EventListener) => {
                    listeners.set(type, listener);
                }) as XMLHttpRequest["addEventListener"],
                open: jest.fn(),
                send: jest.fn(),
                setRequestHeader: jest.fn(),
                status: 0,
                timeout: 0,
                upload: { addEventListener: jest.fn() },
                withCredentials: false,
            };
        };
        const attachments = createChatDraftAttachments([
            file("first.txt"),
            file("second.txt"),
        ]);
        const pending = prepareAndUploadChatAttachments(
            {
                mutation: () =>
                    Promise.resolve({
                        expiresAtMs: Date.now() + 60_000,
                        ticketId,
                        uploads: [
                            {
                                attachmentId,
                                uploadUrl: `/api/chat/attachments/${ticketId}/${attachmentId}`,
                            },
                            {
                                attachmentId: "019fe633-9133-4ba0-8b80-809dd80dfb41",
                                uploadUrl: `/api/chat/attachments/${ticketId}/019fe633-9133-4ba0-8b80-809dd80dfb41`,
                            },
                        ],
                    }),
            },
            sessionKey,
            attachments,
            idempotencyKey,
            new AbortController().signal,
            jest.fn(),
            requestFactory
        );
        await Promise.resolve();
        expect(requests).toHaveLength(2);
        requests[0]?.listeners.get("error")?.(new Event("error"));
        const failure = await pending.catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain("Attachment upload failed");
        expect(requests[1]?.abort).toHaveBeenCalledTimes(1);
    });
});
