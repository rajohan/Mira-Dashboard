import { useEffect, useEffectEvent, useRef, useState } from "react";
import * as v from "valibot";

import {
    chatSpeechCapabilitiesOutputSchema,
    chatSpeechCapabilitiesPath,
    chatSpeechLimits,
    chatSpeechRecordingContentTypes,
    chatSpeechSynthesisPath,
    chatSpeechTranscriptionOutputSchema,
    chatSpeechTranscriptionPath,
} from "../../contracts/chatSpeech.ts";
import type { ChatReadAloudView, ChatVoiceInputView } from "./chatTypes.ts";

interface SpeechCapabilities {
    readonly speechToText: boolean;
    readonly textToSpeech: boolean;
}

interface VoiceState {
    readonly elapsedMs: number;
    readonly error?: string;
    readonly phase: ChatVoiceInputView["phase"];
    readonly sessionKey: string;
}

interface ReadAloudState extends ChatReadAloudView {
    readonly sessionKey: string;
}

interface UseChatSpeechOptions {
    readonly draft: string;
    readonly onChangeDraft: (draft: string) => void;
    readonly sessionKey: string;
}

interface ChatSpeechController {
    readonly dismissReadAloudError: () => void;
    readonly dismissVoiceInputError: () => void;
    readonly readAloud: ChatReadAloudView;
    readonly readAloudAvailable: boolean;
    readonly startReadAloud: (messageId: string, text: string) => void;
    readonly startVoiceInput: () => void;
    readonly stopReadAloud: () => void;
    readonly stopVoiceInput: () => void;
    readonly cancelVoiceInput: () => void;
    readonly voiceInput: ChatVoiceInputView;
}

/**
 * Chooses the first exact MediaRecorder type admitted by the speech boundary.
 * @returns Reviewed recorder MIME or no browser-supported option.
 */
export function chatSpeechRecorderMimeType(): string | undefined {
    if (typeof MediaRecorder === "undefined") return undefined;
    return chatSpeechRecordingContentTypes.find((mimeType) =>
        MediaRecorder.isTypeSupported(mimeType)
    );
}

/**
 * Splits final visible prose into the exact TTS character and UTF-8 budgets.
 * @param text Visible assistant prose.
 * @returns Non-empty ordered speech chunks.
 */
export function chunkChatSpeechText(text: string): readonly string[] {
    const normalized = text.trim();
    if (normalized === "") return [];
    const encoder = new TextEncoder();
    const chunks: string[] = [];
    let chunk = "";
    for (const character of normalized) {
        const candidate = chunk + character;
        if (
            candidate.length > chatSpeechLimits.maximumSynthesisTextCharacters ||
            encoder.encode(candidate).byteLength >
                chatSpeechLimits.maximumSynthesisTextUtf8Bytes
        ) {
            const bounded = chunk.trim();
            if (bounded !== "") chunks.push(bounded);
            chunk = character;
        } else {
            chunk = candidate;
        }
    }
    const remainder = chunk.trim();
    if (remainder !== "") chunks.push(remainder);
    return chunks;
}

function appendedTranscript(draft: string, transcript: string): string {
    if (draft === "") return transcript;
    return /\s$/u.test(draft) ? `${draft}${transcript}` : `${draft} ${transcript}`;
}

function initialVoiceState(): VoiceState {
    return { elapsedMs: 0, phase: "idle", sessionKey: "" };
}

function initialReadAloudState(): ReadAloudState {
    return { phase: "idle", sessionKey: "" };
}

/**
 * Owns browser recording, bounded speech calls, playback, and cleanup.
 * @returns Pure workspace state and transport-independent UI callbacks.
 */
export function useChatSpeech({
    draft,
    onChangeDraft,
    sessionKey,
}: UseChatSpeechOptions): ChatSpeechController {
    const [capabilities, setCapabilities] = useState<SpeechCapabilities>({
        speechToText: false,
        textToSpeech: false,
    });
    const [voiceState, setVoiceState] = useState<VoiceState>(initialVoiceState);
    const [readAloudState, setReadAloudState] =
        useState<ReadAloudState>(initialReadAloudState);
    const draftReference = useRef(draft);
    const onChangeDraftReference = useRef(onChangeDraft);
    const voiceGeneration = useRef(0);
    const voiceAbort = useRef<AbortController | null>(null);
    const recorder = useRef<MediaRecorder | null>(null);
    const recordingStream = useRef<MediaStream | null>(null);
    const recordingChunks = useRef<Blob[]>([]);
    const recordingBytes = useRef(0);
    const recordingStartedAt = useRef(0);
    const recordingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
    const readAloudGeneration = useRef(0);
    const readAloudAbort = useRef<AbortController | null>(null);
    const readAloudAudio = useRef<HTMLAudioElement | null>(null);
    const readAloudUrl = useRef<string | null>(null);

    useEffect(() => {
        draftReference.current = draft;
        onChangeDraftReference.current = onChangeDraft;
    }, [draft, onChangeDraft]);

    function clearRecordingResources(): void {
        if (recordingTimer.current !== null) {
            clearInterval(recordingTimer.current);
            recordingTimer.current = null;
        }
        for (const track of recordingStream.current?.getTracks() ?? []) track.stop();
        recordingStream.current = null;
        recorder.current = null;
        recordingChunks.current = [];
        recordingBytes.current = 0;
    }

    function clearReadAloudMedia(): void {
        readAloudAbort.current?.abort();
        readAloudAbort.current = null;
        readAloudAudio.current?.pause();
        if (readAloudAudio.current !== null) {
            readAloudAudio.current.removeAttribute("src");
            readAloudAudio.current.load();
        }
        readAloudAudio.current = null;
        if (readAloudUrl.current !== null) {
            URL.revokeObjectURL(readAloudUrl.current);
            readAloudUrl.current = null;
        }
    }

    useEffect(() => {
        const controller = new AbortController();
        void (async () => {
            try {
                const response = await fetch(chatSpeechCapabilitiesPath, {
                    credentials: "include",
                    signal: controller.signal,
                });
                if (!response.ok) return;
                const value: unknown = await response.json();
                const result = v.safeParse(chatSpeechCapabilitiesOutputSchema, value);
                if (!controller.signal.aborted && result.success) {
                    setCapabilities(result.output);
                }
            } catch {
                // Capability loss leaves both optional controls absent.
            }
        })();
        return () => controller.abort();
    }, []);

    const cleanupSpeech = useEffectEvent(() => {
        voiceGeneration.current += 1;
        voiceAbort.current?.abort();
        const currentRecorder = recorder.current;
        if (currentRecorder?.state !== "inactive") currentRecorder?.stop();
        clearRecordingResources();
        readAloudGeneration.current += 1;
        clearReadAloudMedia();
    });

    useEffect(() => () => cleanupSpeech(), [sessionKey]);

    function failVoiceInput(
        message: string,
        generation: number,
        ownerSessionKey: string
    ): void {
        if (generation !== voiceGeneration.current) return;
        voiceGeneration.current += 1;
        voiceAbort.current?.abort();
        const currentRecorder = recorder.current;
        if (currentRecorder?.state !== "inactive") currentRecorder?.stop();
        clearRecordingResources();
        setVoiceState({
            elapsedMs: 0,
            error: message,
            phase: "idle",
            sessionKey: ownerSessionKey,
        });
    }

    async function transcribe(
        chunks: readonly Blob[],
        mimeType: string,
        generation: number,
        ownerSessionKey: string
    ): Promise<void> {
        if (generation !== voiceGeneration.current) return;
        const body = new Blob([...chunks], { type: mimeType });
        if (body.size === 0 || body.size > chatSpeechLimits.maximumRecordingBytes) {
            failVoiceInput(
                "The recording could not be transcribed within the audio limit.",
                generation,
                ownerSessionKey
            );
            return;
        }
        const controller = new AbortController();
        voiceAbort.current = controller;
        try {
            const response = await fetch(chatSpeechTranscriptionPath, {
                body,
                credentials: "include",
                headers: { "Content-Type": mimeType },
                method: "POST",
                signal: controller.signal,
            });
            if (generation !== voiceGeneration.current) return;
            if (!response.ok) {
                if (response.status === 503) {
                    setCapabilities((current) => ({
                        ...current,
                        speechToText: false,
                    }));
                }
                failVoiceInput(
                    "Voice transcription is unavailable. Your draft was not changed.",
                    generation,
                    ownerSessionKey
                );
                return;
            }
            const value: unknown = await response.json();
            const result = v.safeParse(chatSpeechTranscriptionOutputSchema, value);
            const transcript = result.success ? result.output.transcript.trim() : "";
            if (transcript === "") {
                failVoiceInput(
                    "No speech was detected. Your draft was not changed.",
                    generation,
                    ownerSessionKey
                );
                return;
            }
            onChangeDraftReference.current(
                appendedTranscript(draftReference.current, transcript)
            );
            setVoiceState({
                elapsedMs: 0,
                phase: "idle",
                sessionKey: ownerSessionKey,
            });
        } catch {
            if (generation === voiceGeneration.current && !controller.signal.aborted) {
                failVoiceInput(
                    "Voice transcription failed. Your draft was not changed.",
                    generation,
                    ownerSessionKey
                );
            }
        } finally {
            if (voiceAbort.current === controller) voiceAbort.current = null;
        }
    }

    function startVoiceInput(): void {
        const mimeType = chatSpeechRecorderMimeType();
        if (
            !capabilities.speechToText ||
            mimeType === undefined ||
            navigator.mediaDevices?.getUserMedia === undefined
        ) {
            return;
        }
        const generation = voiceGeneration.current + 1;
        voiceGeneration.current = generation;
        const ownerSessionKey = sessionKey;
        setVoiceState({
            elapsedMs: 0,
            phase: "recording",
            sessionKey: ownerSessionKey,
        });
        void (async () => {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: true,
                });
                if (generation !== voiceGeneration.current) {
                    for (const track of stream.getTracks()) track.stop();
                    return;
                }
                recordingStream.current = stream;
                recordingChunks.current = [];
                recordingBytes.current = 0;
                recordingStartedAt.current = Date.now();
                const nextRecorder = new MediaRecorder(stream, { mimeType });
                recorder.current = nextRecorder;
                nextRecorder.addEventListener("dataavailable", (event) => {
                    if (generation !== voiceGeneration.current || event.data.size === 0) {
                        return;
                    }
                    recordingBytes.current += event.data.size;
                    if (recordingBytes.current > chatSpeechLimits.maximumRecordingBytes) {
                        failVoiceInput(
                            "The recording exceeded the audio limit. Your draft was not changed.",
                            generation,
                            ownerSessionKey
                        );
                        return;
                    }
                    recordingChunks.current.push(event.data);
                });
                nextRecorder.addEventListener("error", () => {
                    failVoiceInput(
                        "Voice recording failed. Your draft was not changed.",
                        generation,
                        ownerSessionKey
                    );
                });
                nextRecorder.addEventListener("stop", () => {
                    const chunks = recordingChunks.current;
                    clearRecordingResources();
                    if (generation !== voiceGeneration.current) return;
                    void transcribe(chunks, mimeType, generation, ownerSessionKey);
                });
                nextRecorder.start(1000);
                recordingTimer.current = setInterval(() => {
                    if (generation !== voiceGeneration.current) return;
                    const elapsedMs = Math.min(
                        chatSpeechLimits.maximumRecordingDurationMs,
                        Date.now() - recordingStartedAt.current
                    );
                    setVoiceState({
                        elapsedMs,
                        phase:
                            elapsedMs >= chatSpeechLimits.maximumRecordingDurationMs
                                ? "transcribing"
                                : "recording",
                        sessionKey: ownerSessionKey,
                    });
                    if (
                        elapsedMs >= chatSpeechLimits.maximumRecordingDurationMs &&
                        nextRecorder.state !== "inactive"
                    ) {
                        nextRecorder.stop();
                    }
                }, 250);
            } catch {
                failVoiceInput(
                    "Microphone access was not granted. Your draft was not changed.",
                    generation,
                    ownerSessionKey
                );
            }
        })();
    }

    function stopVoiceInput(): void {
        const currentRecorder = recorder.current;
        if (currentRecorder === null || currentRecorder.state === "inactive") return;
        if (recordingTimer.current !== null) {
            clearInterval(recordingTimer.current);
            recordingTimer.current = null;
        }
        setVoiceState({
            elapsedMs: Date.now() - recordingStartedAt.current,
            phase: "transcribing",
            sessionKey,
        });
        currentRecorder.stop();
    }

    function cancelVoiceInput(): void {
        voiceGeneration.current += 1;
        voiceAbort.current?.abort();
        const currentRecorder = recorder.current;
        if (currentRecorder?.state !== "inactive") currentRecorder?.stop();
        clearRecordingResources();
        setVoiceState({ elapsedMs: 0, phase: "idle", sessionKey });
    }

    function dismissVoiceInputError(): void {
        setVoiceState((current) =>
            current.sessionKey === sessionKey
                ? { elapsedMs: 0, phase: "idle", sessionKey }
                : current
        );
    }

    function stopReadAloud(): void {
        readAloudGeneration.current += 1;
        clearReadAloudMedia();
        setReadAloudState({ phase: "idle", sessionKey });
    }

    function startReadAloud(messageId: string, text: string): void {
        const chunks = chunkChatSpeechText(text);
        if (!capabilities.textToSpeech || chunks.length === 0) return;
        readAloudGeneration.current += 1;
        const generation = readAloudGeneration.current;
        clearReadAloudMedia();
        const ownerSessionKey = sessionKey;
        setReadAloudState({
            activeMessageId: messageId,
            phase: "loading",
            sessionKey: ownerSessionKey,
        });

        async function playChunk(index: number): Promise<void> {
            if (generation !== readAloudGeneration.current) return;
            const chunk = chunks[index];
            if (chunk === undefined) {
                setReadAloudState({ phase: "idle", sessionKey: ownerSessionKey });
                return;
            }
            const controller = new AbortController();
            readAloudAbort.current = controller;
            try {
                const response = await fetch(chatSpeechSynthesisPath, {
                    body: JSON.stringify({ text: chunk }),
                    credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    method: "POST",
                    signal: controller.signal,
                });
                if (generation !== readAloudGeneration.current) return;
                if (!response.ok) {
                    if (response.status === 503) {
                        setCapabilities((current) => ({
                            ...current,
                            textToSpeech: false,
                        }));
                    }
                    throw new Error("Speech synthesis unavailable");
                }
                const mediaType =
                    response.headers
                        .get("content-type")
                        ?.split(";", 1)[0]
                        ?.trim()
                        .toLowerCase() ?? "";
                const audioBody = await response.blob();
                if (
                    mediaType !== "audio/mpeg" ||
                    audioBody.size === 0 ||
                    audioBody.size > chatSpeechLimits.maximumGeneratedAudioBytes
                ) {
                    throw new Error("Speech synthesis response invalid");
                }
                const url = URL.createObjectURL(audioBody);
                readAloudUrl.current = url;
                const audio = new Audio(url);
                readAloudAudio.current = audio;
                audio.addEventListener(
                    "ended",
                    () => {
                        if (generation !== readAloudGeneration.current) return;
                        clearReadAloudMedia();
                        void playChunk(index + 1);
                    },
                    { once: true }
                );
                audio.addEventListener(
                    "error",
                    () => {
                        if (generation !== readAloudGeneration.current) return;
                        clearReadAloudMedia();
                        setReadAloudState({
                            error: "Read aloud playback failed.",
                            errorMessageId: messageId,
                            phase: "idle",
                            sessionKey: ownerSessionKey,
                        });
                    },
                    { once: true }
                );
                setReadAloudState({
                    activeMessageId: messageId,
                    phase: "playing",
                    sessionKey: ownerSessionKey,
                });
                await audio.play();
            } catch {
                if (
                    generation === readAloudGeneration.current &&
                    !controller.signal.aborted
                ) {
                    clearReadAloudMedia();
                    setReadAloudState({
                        error: "Read aloud is unavailable right now.",
                        errorMessageId: messageId,
                        phase: "idle",
                        sessionKey: ownerSessionKey,
                    });
                }
            } finally {
                if (readAloudAbort.current === controller) {
                    readAloudAbort.current = null;
                }
            }
        }

        void playChunk(0);
    }

    function dismissReadAloudError(): void {
        setReadAloudState((current) =>
            current.sessionKey === sessionKey ? { phase: "idle", sessionKey } : current
        );
    }

    const recorderAvailable =
        typeof navigator !== "undefined" &&
        navigator.mediaDevices?.getUserMedia !== undefined &&
        chatSpeechRecorderMimeType() !== undefined;
    const readAloudAvailable =
        capabilities.textToSpeech &&
        typeof Audio !== "undefined" &&
        typeof URL.createObjectURL === "function";
    const voiceInput: ChatVoiceInputView =
        voiceState.sessionKey === sessionKey
            ? {
                  available: capabilities.speechToText && recorderAvailable,
                  elapsedMs: voiceState.elapsedMs,
                  ...(voiceState.error === undefined ? {} : { error: voiceState.error }),
                  phase: voiceState.phase,
              }
            : {
                  available: capabilities.speechToText && recorderAvailable,
                  elapsedMs: 0,
                  phase: "idle",
              };
    const readAloud: ChatReadAloudView =
        readAloudState.sessionKey === sessionKey
            ? {
                  ...(readAloudState.activeMessageId === undefined
                      ? {}
                      : { activeMessageId: readAloudState.activeMessageId }),
                  ...(readAloudState.error === undefined
                      ? {}
                      : { error: readAloudState.error }),
                  ...(readAloudState.errorMessageId === undefined
                      ? {}
                      : { errorMessageId: readAloudState.errorMessageId }),
                  phase: readAloudState.phase,
              }
            : { phase: "idle" };

    return {
        cancelVoiceInput,
        dismissReadAloudError,
        dismissVoiceInputError,
        readAloud,
        readAloudAvailable,
        startReadAloud,
        startVoiceInput,
        stopReadAloud,
        stopVoiceInput,
        voiceInput,
    };
}
