import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, jest } from "bun:test";
import type { SetStateAction } from "react";

import {
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENTS,
} from "../components/features/chat/chatUtilities";
import { useChatInputMedia } from "../components/features/chat/useChatInputMedia";

function fileList(files: File[]): FileList {
    return files as unknown as FileList;
}

function fakeLargeFile(name: string): File {
    return {
        lastModified: 0,
        name,
        size: MAX_ATTACHMENT_BYTES + 1,
        type: "application/octet-stream",
    } as File;
}

function defineFetch(value: typeof fetch): void {
    Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value,
        writable: true,
    });
}

describe("chat input media", () => {
    it("loads, limits, removes and rejects oversized attachments", async () => {
        const onError = jest.fn();
        const { result } = renderHook(() =>
            useChatInputMedia({ onError, sessionKey: "session-a", setDraft: jest.fn() })
        );
        const input = document.createElement("input");
        result.current.fileInputReference.current = input;
        const files = Array.from(
            { length: MAX_ATTACHMENTS + 1 },
            (_, index) =>
                new File([`file-${index}`], `file-${index}.txt`, {
                    type: "text/plain",
                })
        );

        await act(async () => {
            await result.current.handleFilesSelected(fileList(files));
        });
        expect(result.current.attachments).toHaveLength(MAX_ATTACHMENTS);
        expect(result.current.attachments[0]).toMatchObject({
            contentBase64: "ZmlsZS0w",
            fileName: "file-0.txt",
            kind: "text",
        });
        expect(result.current.attachmentError).toEqual({
            message: `Only ${MAX_ATTACHMENTS} attachments can be sent at once.`,
            source: "composer",
        });
        expect(input.value).toBe("");

        act(() => {
            result.current.removeAttachment(result.current.attachments[0]!.id);
        });
        expect(result.current.attachments).toHaveLength(MAX_ATTACHMENTS - 1);
        act(() => result.current.clearAttachments());
        expect(result.current.attachments).toEqual([]);

        await act(async () => {
            await result.current.handleFilesSelected(
                fileList([fakeLargeFile("large.txt")])
            );
        });
        expect(result.current.attachments).toEqual([]);
        expect(result.current.attachmentError).toEqual({
            message: expect.stringContaining("large.txt is too large"),
            source: "composer",
        });
    });

    it("reserves attachment capacity across concurrent selections", async () => {
        const { result } = renderHook(() =>
            useChatInputMedia({
                onError: jest.fn(),
                sessionKey: "session-a",
                setDraft: jest.fn(),
            })
        );
        const firstFiles = Array.from(
            { length: 6 },
            (_, index) => new File(["a"], `first-${index}.txt`)
        );
        const secondFiles = Array.from(
            { length: 6 },
            (_, index) => new File(["b"], `second-${index}.txt`)
        );

        await act(async () => {
            const first = result.current.handleFilesSelected(fileList(firstFiles));
            const second = result.current.handleFilesSelected(fileList(secondFiles));
            await Promise.all([first, second]);
        });

        expect(result.current.attachments).toHaveLength(MAX_ATTACHMENTS);
        expect(
            result.current.attachments.filter((attachment) =>
                attachment.fileName.startsWith("second-")
            )
        ).toHaveLength(4);
    });

    it("skips video files while preserving valid attachments", async () => {
        const onError = jest.fn();
        const { result } = renderHook(() =>
            useChatInputMedia({ onError, sessionKey: "session-a", setDraft: jest.fn() })
        );
        const input = document.createElement("input");
        input.value = "pending-video";
        result.current.fileInputReference.current = input;

        await act(async () => {
            await result.current.handleFilesSelected(
                fileList([
                    new File(["video"], "clip.mp4", { type: "video/mp4" }),
                    new File(["video"], "movie.webm", { type: "video/webm" }),
                    new File(["audio"], "voice.webm", { type: "audio/webm" }),
                    new File(["notes"], "notes.txt", { type: "text/plain" }),
                ])
            );
        });

        expect(result.current.attachments.map(({ fileName }) => fileName)).toEqual([
            "voice.webm",
            "notes.txt",
        ]);
        expect(result.current.attachmentError).toEqual({
            message:
                "Skipped video files: clip.mp4, movie.webm. Choose images, audio, PDFs, text, ZIP, or Office documents.",
            source: "composer",
        });
        expect(input.value).toBe("");

        act(() => result.current.clearAttachments());
        await act(async () => {
            await result.current.handleFilesSelected(
                fileList([new File(["video"], "only-video.mov")])
            );
        });
        expect(result.current.attachments).toEqual([]);
        expect(result.current.attachmentError).toEqual({
            message:
                "Skipped video files: only-video.mov. Choose images, audio, PDFs, text, ZIP, or Office documents.",
            source: "composer",
        });
    });

    it("rejects dropped file types outside the attachment picker policy", async () => {
        const onError = jest.fn();
        const { result } = renderHook(() =>
            useChatInputMedia({ onError, sessionKey: "session-a", setDraft: jest.fn() })
        );

        await act(async () => {
            await result.current.handleFilesSelected(
                fileList([
                    new File(["app"], "installer.exe", {
                        type: "application/x-msdownload",
                    }),
                    new File(["data"], "payload.bin", {
                        type: "application/octet-stream",
                    }),
                    new File(["report"], "report.pdf", {
                        type: "application/pdf",
                    }),
                    new File(["image"], "photo.png"),
                    new File(["vector"], "diagram.svg"),
                    new File(["audio"], "clip.mp3"),
                    new File(["pdf"], "scan.pdf"),
                ])
            );
        });

        expect(
            result.current.attachments.map(({ fileName, kind, mimeType }) => ({
                fileName,
                kind,
                mimeType,
            }))
        ).toEqual([
            { fileName: "report.pdf", kind: "file", mimeType: "application/pdf" },
            { fileName: "photo.png", kind: "image", mimeType: "image/png" },
            { fileName: "diagram.svg", kind: "image", mimeType: "image/svg+xml" },
            { fileName: "clip.mp3", kind: "file", mimeType: "audio/mpeg" },
            { fileName: "scan.pdf", kind: "file", mimeType: "application/pdf" },
        ]);
        const errorMessage =
            "Skipped unsupported files: installer.exe, payload.bin. Choose images, audio, PDFs, text, ZIP, or Office documents.";
        expect(result.current.attachmentError).toEqual({
            message: errorMessage,
            source: "composer",
        });
        expect(onError).not.toHaveBeenCalledWith(errorMessage);

        await act(async () => {
            await result.current.handleFilesSelected(
                fileList([
                    new File(["app"], "modal-installer.exe", {
                        type: "application/x-msdownload",
                    }),
                ]),
                "picker"
            );
        });
        expect(result.current.attachmentError).toEqual({
            message:
                "Skipped unsupported files: modal-installer.exe. Choose images, audio, PDFs, text, ZIP, or Office documents.",
            source: "picker",
        });

        act(() => result.current.clearAttachmentError("composer"));
        expect(result.current.attachmentError?.source).toBe("picker");
        act(() => result.current.clearAttachmentError("picker"));
        expect(result.current.attachmentError).toBeUndefined();
    });

    it("transcribes voice files and reports provider and input failures", async () => {
        const originalFetch = fetch;
        const onError = jest.fn();
        let draft = "Existing ";
        const setDraft = jest.fn((update: SetStateAction<string>) => {
            draft = typeof update === "function" ? update(draft) : update;
        });
        const { result } = renderHook(() =>
            useChatInputMedia({ onError, sessionKey: "session-a", setDraft })
        );
        const input = document.createElement("input");
        result.current.voiceFileInputReference.current = input;

        try {
            defineFetch(
                jest.fn(async () =>
                    Response.json({ text: " transcript " })
                ) as unknown as typeof fetch
            );
            await act(async () => {
                await result.current.handleVoiceFileSelected(
                    fileList([new File(["voice"], "voice.webm", { type: "audio/webm" })])
                );
            });
            expect(draft).toBe("Existing\ntranscript");
            expect(result.current.isTranscribing).toBe(false);
            expect(input.value).toBe("");

            defineFetch(
                jest.fn(
                    async () => new Response("not json", { status: 500 })
                ) as unknown as typeof fetch
            );
            await act(async () => {
                await result.current.handleVoiceFileSelected(
                    fileList([new File(["voice"], "failed.webm")])
                );
            });
            expect(onError.mock.calls.at(-1)?.[0]).toBe("Failed to transcribe audio");

            defineFetch(
                jest.fn(async () =>
                    Response.json({ text: "  " })
                ) as unknown as typeof fetch
            );
            await act(async () => {
                await result.current.handleVoiceFileSelected(
                    fileList([new File(["voice"], "silent.webm")])
                );
            });
            expect(onError.mock.calls.at(-1)?.[0]).toBe(
                "Whisper did not detect any speech."
            );

            await act(async () => {
                await result.current.handleVoiceFileSelected(
                    fileList([new File([], "empty.webm")])
                );
            });
            expect(onError.mock.calls.at(-1)?.[0]).toBe("No audio was recorded.");

            await act(async () => {
                await result.current.handleVoiceFileSelected(
                    fileList([fakeLargeFile("large.webm")])
                );
            });
            expect(onError.mock.calls.at(-1)?.[0]).toContain("large.webm is too large");
        } finally {
            defineFetch(originalFetch);
        }
    });

    it("ignores a transcription that completes after the session changes", async () => {
        const originalFetch = fetch;
        const response = Promise.withResolvers<Response>();
        let draft = "";
        const setDraft = (update: SetStateAction<string>) => {
            draft = typeof update === "function" ? update(draft) : update;
        };
        const onError = jest.fn();
        const { result, rerender } = renderHook(
            ({ sessionKey }) => useChatInputMedia({ onError, sessionKey, setDraft }),
            { initialProps: { sessionKey: "session-a" } }
        );
        const attachmentInput = document.createElement("input");
        const voiceInput = document.createElement("input");
        attachmentInput.value = "pending-attachment";
        voiceInput.value = "pending-voice";
        result.current.fileInputReference.current = attachmentInput;
        result.current.voiceFileInputReference.current = voiceInput;

        try {
            defineFetch(jest.fn(() => response.promise) as unknown as typeof fetch);
            let transcription: Promise<void> | undefined;
            act(() => {
                transcription = result.current.handleVoiceFileSelected(
                    fileList([new File(["voice"], "voice.webm", { type: "audio/webm" })])
                );
            });
            await waitFor(() => expect(result.current.isTranscribing).toBe(true));

            rerender({ sessionKey: "session-b" });
            await waitFor(() => expect(result.current.isTranscribing).toBe(false));
            expect(attachmentInput.value).toBe("");
            expect(voiceInput.value).toBe("");
            await act(async () => {
                response.resolve(Response.json({ text: "stale transcript" }));
                await transcription;
            });

            expect(draft).toBe("");
            expect(onError).not.toHaveBeenCalledWith(expect.stringContaining("stale"));
        } finally {
            defineFetch(originalFetch);
        }
    });

    it("falls back to the voice file picker when direct recording is unavailable", async () => {
        const mediaRecorderDescriptor = Object.getOwnPropertyDescriptor(
            globalThis,
            "MediaRecorder"
        );
        const mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(
            navigator,
            "mediaDevices"
        );
        const onError = jest.fn();
        const { result } = renderHook(() =>
            useChatInputMedia({ onError, sessionKey: "session-a", setDraft: jest.fn() })
        );
        const click = jest.fn();
        result.current.voiceFileInputReference.current = {
            click,
        } as unknown as HTMLInputElement;

        try {
            Object.defineProperty(globalThis, "MediaRecorder", {
                configurable: true,
                value: undefined,
            });
            Object.defineProperty(navigator, "mediaDevices", {
                configurable: true,
                value: undefined,
            });
            await act(async () => {
                await result.current.handleToggleRecording();
            });
            expect(click).toHaveBeenCalledTimes(1);
            expect(onError.mock.calls.at(-1)?.[0]).toContain("voice recording");
        } finally {
            if (mediaRecorderDescriptor) {
                Object.defineProperty(
                    globalThis,
                    "MediaRecorder",
                    mediaRecorderDescriptor
                );
            } else {
                Reflect.deleteProperty(globalThis, "MediaRecorder");
            }
            if (mediaDevicesDescriptor) {
                Object.defineProperty(navigator, "mediaDevices", mediaDevicesDescriptor);
            } else {
                Reflect.deleteProperty(navigator, "mediaDevices");
            }
        }
    });

    it("records, stops, transcribes and releases microphone tracks", async () => {
        const originalFetch = fetch;
        const mediaRecorderDescriptor = Object.getOwnPropertyDescriptor(
            globalThis,
            "MediaRecorder"
        );
        const mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(
            navigator,
            "mediaDevices"
        );
        const trackStop = jest.fn();
        const stream = {
            getTracks: () => [{ stop: trackStop }],
        } as unknown as MediaStream;

        class FakeMediaRecorder {
            static latest: FakeMediaRecorder | undefined;
            static isTypeSupported = () => false;
            readonly listeners = new Map<string, (event: { data: Blob }) => void>();
            readonly mimeType = "audio/webm";
            readonly stream: MediaStream;

            constructor(recordingStream: MediaStream) {
                this.stream = recordingStream;
                FakeMediaRecorder.latest = this;
            }

            addEventListener(type: string, listener: (event: { data: Blob }) => void) {
                this.listeners.set(type, listener);
            }

            emitData(blob: Blob) {
                this.listeners.get("dataavailable")?.({ data: blob });
            }

            start() {}

            stop() {
                this.listeners.get("stop")?.({ data: new Blob() });
            }
        }

        let draft = "";
        const setDraft = (update: SetStateAction<string>) => {
            draft = typeof update === "function" ? update(draft) : update;
        };
        const onError = jest.fn();

        try {
            defineFetch(
                jest.fn(async () =>
                    Response.json({ text: "recorded" })
                ) as unknown as typeof fetch
            );
            Object.defineProperty(globalThis, "MediaRecorder", {
                configurable: true,
                value: FakeMediaRecorder,
            });
            const getUserMedia = jest.fn(async () => stream);
            Object.defineProperty(navigator, "mediaDevices", {
                configurable: true,
                value: { getUserMedia },
            });
            const { result, unmount } = renderHook(() =>
                useChatInputMedia({ onError, sessionKey: "session-a", setDraft })
            );

            await act(async () => {
                const first = result.current.handleToggleRecording();
                const second = result.current.handleToggleRecording();
                await Promise.all([first, second]);
            });
            expect(getUserMedia).toHaveBeenCalledTimes(1);
            expect(result.current.isRecording).toBe(true);
            FakeMediaRecorder.latest?.emitData(
                new Blob(["voice"], { type: "audio/webm" })
            );
            await act(async () => {
                await result.current.handleToggleRecording();
            });
            await waitFor(() => expect(draft).toBe("recorded"));
            expect(result.current.isRecording).toBe(false);
            expect(trackStop).toHaveBeenCalledTimes(1);

            await act(async () => {
                await result.current.handleToggleRecording();
            });
            unmount();
            expect(trackStop).toHaveBeenCalledTimes(2);
        } finally {
            defineFetch(originalFetch);
            if (mediaRecorderDescriptor) {
                Object.defineProperty(
                    globalThis,
                    "MediaRecorder",
                    mediaRecorderDescriptor
                );
            } else {
                Reflect.deleteProperty(globalThis, "MediaRecorder");
            }
            if (mediaDevicesDescriptor) {
                Object.defineProperty(navigator, "mediaDevices", mediaDevicesDescriptor);
            } else {
                Reflect.deleteProperty(navigator, "mediaDevices");
            }
        }
    });
});
