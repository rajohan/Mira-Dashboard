import { afterEach, describe, expect, jest, test } from "bun:test";

import { useState } from "react";

import { chatSpeechLimits } from "../../contracts/chatSpeech.ts";
import { chunkChatSpeechText, useChatSpeech } from "./useChatSpeech.ts";

const { act, render, screen, waitFor } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

function requestUrl(input: RequestInfo | URL): string {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return input.url;
}

type RecorderListener = (event: Event & Readonly<{ data: Blob }>) => void;

class FakeMediaRecorder {
    static instances: FakeMediaRecorder[] = [];

    static isTypeSupported(mimeType: string): boolean {
        return mimeType === "audio/webm;codecs=opus";
    }

    readonly listeners = new Map<string, RecorderListener[]>();
    readonly options?: MediaRecorderOptions;
    readonly stream: MediaStream;
    state: RecordingState = "inactive";

    constructor(stream: MediaStream, options?: MediaRecorderOptions) {
        this.stream = stream;
        this.options = options;
        FakeMediaRecorder.instances.push(this);
    }

    addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        const callback =
            typeof listener === "function"
                ? (listener as RecorderListener)
                : (((event: Event) => listener.handleEvent(event)) as RecorderListener);
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
    }

    emitData(data: Blob): void {
        this.emit("dataavailable", data);
    }

    start(): void {
        this.state = "recording";
    }

    stop(): void {
        if (this.state === "inactive") return;
        this.state = "inactive";
        this.emit("stop", new Blob());
    }

    private emit(type: string, data: Blob): void {
        const event = Object.assign(new Event(type), { data });
        for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
}

const originalFetch = globalThis.fetch;
const originalMediaRecorder = globalThis.MediaRecorder;
const originalMediaDevices = navigator.mediaDevices;

function installRecorder(): void {
    FakeMediaRecorder.instances = [];
    Object.defineProperty(globalThis, "MediaRecorder", {
        configurable: true,
        value: FakeMediaRecorder,
    });
    Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
            getUserMedia: jest.fn(() =>
                Promise.resolve({
                    getTracks: () => [{ stop: jest.fn() }],
                } as unknown as MediaStream)
            ),
        },
    });
}

function SpeechHarness() {
    const [draft, setDraft] = useState("Initial draft");
    const speech = useChatSpeech({
        draft,
        onChangeDraft: setDraft,
        sessionKey: "agent:main:main",
    });
    return (
        <div>
            <output aria-label="Draft">{draft}</output>
            <output aria-label="Voice availability">
                {speech.voiceInput.available ? "available" : "unavailable"}
            </output>
            <output aria-label="Voice phase">{speech.voiceInput.phase}</output>
            {speech.voiceInput.error !== undefined && <p>{speech.voiceInput.error}</p>}
            <button onClick={speech.startVoiceInput} type="button">
                Start
            </button>
            <button onClick={speech.stopVoiceInput} type="button">
                Stop
            </button>
            <button onClick={() => setDraft("Edited while transcribing")} type="button">
                Edit draft
            </button>
        </div>
    );
}

afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "MediaRecorder", {
        configurable: true,
        value: originalMediaRecorder,
    });
    Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: originalMediaDevices,
    });
});

describe("chat speech", () => {
    test("chunks TTS prose within both character and UTF-8 budgets", () => {
        const chunks = chunkChatSpeechText("🙂".repeat(9000));
        expect(chunks.length).toBeGreaterThan(2);
        for (const chunk of chunks) {
            expect(chunk.length).toBeLessThanOrEqual(
                chatSpeechLimits.maximumSynthesisTextCharacters
            );
            expect(new TextEncoder().encode(chunk).byteLength).toBeLessThanOrEqual(
                chatSpeechLimits.maximumSynthesisTextUtf8Bytes
            );
        }
    });

    test("fences an overflow stop event without dispatching stale transcription", async () => {
        installRecorder();
        const fetchMock = jest.fn((input: RequestInfo | URL) => {
            if (requestUrl(input).endsWith("/capabilities")) {
                return Promise.resolve(
                    Response.json({ speechToText: true, textToSpeech: false })
                );
            }
            return Promise.resolve(Response.json({ transcript: "must not apply" }));
        });
        globalThis.fetch = fetchMock;
        const user = userEvent.setup();
        render(<SpeechHarness />);
        await waitFor(() =>
            expect(screen.getByLabelText("Voice availability")).toHaveTextContent(
                "available"
            )
        );
        await user.click(screen.getByRole("button", { name: "Start" }));
        await waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1));
        act(() => {
            FakeMediaRecorder.instances[0]!.emitData(
                new Blob([new Uint8Array(chatSpeechLimits.maximumRecordingBytes + 1)])
            );
        });
        await waitFor(() =>
            expect(screen.getByText(/recording exceeded the audio limit/iu)).toBeVisible()
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(screen.getByLabelText("Draft")).toHaveTextContent("Initial draft");
    });

    test("appends a transcript to the latest draft after intervening edits", async () => {
        installRecorder();
        const transcription = Promise.withResolvers<Response>();
        const fetchMock = jest.fn((input: RequestInfo | URL) => {
            if (requestUrl(input).endsWith("/capabilities")) {
                return Promise.resolve(
                    Response.json({ speechToText: true, textToSpeech: false })
                );
            }
            return transcription.promise;
        });
        globalThis.fetch = fetchMock;
        const user = userEvent.setup();
        render(<SpeechHarness />);
        await waitFor(() =>
            expect(screen.getByLabelText("Voice availability")).toHaveTextContent(
                "available"
            )
        );
        await user.click(screen.getByRole("button", { name: "Start" }));
        await waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1));
        act(() => {
            FakeMediaRecorder.instances[0]!.emitData(
                new Blob([new Uint8Array([1, 2, 3])])
            );
        });
        await user.click(screen.getByRole("button", { name: "Stop" }));
        expect(screen.getByLabelText("Voice phase")).toHaveTextContent("transcribing");
        await user.click(screen.getByRole("button", { name: "Edit draft" }));
        transcription.resolve(Response.json({ transcript: "spoken addition" }));
        await waitFor(() =>
            expect(screen.getByLabelText("Draft")).toHaveTextContent(
                "Edited while transcribing spoken addition"
            )
        );
    });
});
