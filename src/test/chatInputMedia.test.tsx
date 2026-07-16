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

describe("chat input media", () => {
    it("loads, limits, removes and rejects oversized attachments", async () => {
        const onError = jest.fn();
        const { result } = renderHook(() =>
            useChatInputMedia({ onError, setDraft: jest.fn() })
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
        expect(onError).toHaveBeenCalledWith(
            `Only ${MAX_ATTACHMENTS} attachments can be sent at once.`
        );
        expect(input.value).toBe("");

        act(() => {
            result.current.removeAttachment(result.current.attachments[0]!.id);
        });
        expect(result.current.attachments).toHaveLength(MAX_ATTACHMENTS - 1);
        act(() => result.current.clearAttachments());
        expect(result.current.attachments).toEqual([]);

        await act(async () => {
            await result.current.handleFilesSelected(
                fileList([fakeLargeFile("large.bin")])
            );
        });
        expect(result.current.attachments).toEqual([]);
        expect(onError.mock.calls.at(-1)?.[0]).toContain("large.bin is too large");
    });

    it("transcribes voice files and reports provider and input failures", async () => {
        const originalFetch = globalThis.fetch;
        const onError = jest.fn();
        let draft = "Existing ";
        const setDraft = jest.fn((update: SetStateAction<string>) => {
            draft = typeof update === "function" ? update(draft) : update;
        });
        const { result } = renderHook(() => useChatInputMedia({ onError, setDraft }));
        const input = document.createElement("input");
        result.current.voiceFileInputReference.current = input;

        try {
            globalThis.fetch = jest.fn(async () =>
                Response.json({ text: " transcript " })
            ) as unknown as typeof fetch;
            await act(async () => {
                await result.current.handleVoiceFileSelected(
                    fileList([new File(["voice"], "voice.webm", { type: "audio/webm" })])
                );
            });
            expect(draft).toBe("Existing\ntranscript");
            expect(result.current.isTranscribing).toBe(false);
            expect(input.value).toBe("");

            globalThis.fetch = jest.fn(
                async () => new Response("not json", { status: 500 })
            ) as unknown as typeof fetch;
            await act(async () => {
                await result.current.handleVoiceFileSelected(
                    fileList([new File(["voice"], "failed.webm")])
                );
            });
            expect(onError.mock.calls.at(-1)?.[0]).toBe("Failed to transcribe audio");

            globalThis.fetch = jest.fn(async () =>
                Response.json({ text: "  " })
            ) as unknown as typeof fetch;
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
            globalThis.fetch = originalFetch;
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
            useChatInputMedia({ onError, setDraft: jest.fn() })
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
        const originalFetch = globalThis.fetch;
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
            globalThis.fetch = jest.fn(async () =>
                Response.json({ text: "recorded" })
            ) as unknown as typeof fetch;
            Object.defineProperty(globalThis, "MediaRecorder", {
                configurable: true,
                value: FakeMediaRecorder,
            });
            Object.defineProperty(navigator, "mediaDevices", {
                configurable: true,
                value: { getUserMedia: jest.fn(async () => stream) },
            });
            const { result, unmount } = renderHook(() =>
                useChatInputMedia({ onError, setDraft })
            );

            await act(async () => {
                await result.current.handleToggleRecording();
            });
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
            globalThis.fetch = originalFetch;
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
