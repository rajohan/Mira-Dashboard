import { type RefObject, useEffect, useRef, useState } from "react";

import type { TextToSpeechRequest } from "../../../../../contracts/tts";
import { apiErrorFromResponse } from "../../../lib/apiError";
import { messageFromError } from "../../../lib/errorMessage";

function stopAudioPlayback(
    audioRef: RefObject<HTMLAudioElement | undefined>,
    audioUrlRef: RefObject<string | undefined>,
    setPlayingMessageKey: (messageKey: string | undefined) => void
): void {
    audioRef.current?.pause();
    audioRef.current = undefined;
    if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = undefined;
    }
    setPlayingMessageKey(undefined);
}

export function useChatTextToSpeech(onError: (error: string) => void) {
    const audioRef = useRef<HTMLAudioElement | undefined>(undefined);
    const audioUrlRef = useRef<string | undefined>(undefined);
    const speakRequestRef = useRef(0);
    const abortControllerRef = useRef<AbortController | undefined>(undefined);
    const [playingMessageKey, setPlayingMessageKey] = useState<string>();
    const [loadingMessageKey, setLoadingMessageKey] = useState<string>();

    const stopAudio = () =>
        stopAudioPlayback(audioRef, audioUrlRef, setPlayingMessageKey);

    useEffect(
        () => () => {
            abortControllerRef.current?.abort();
            abortControllerRef.current = undefined;
            stopAudioPlayback(audioRef, audioUrlRef, setPlayingMessageKey);
        },
        []
    );

    async function speakMessage(messageKey: string, text: string): Promise<void> {
        if (playingMessageKey === messageKey) {
            speakRequestRef.current += 1;
            stopAudio();
            return;
        }

        speakRequestRef.current += 1;
        const requestToken = speakRequestRef.current;
        const isLatestRequest = () => speakRequestRef.current === requestToken;

        stopAudio();
        abortControllerRef.current?.abort();
        const abortController = new AbortController();
        abortControllerRef.current = abortController;
        setLoadingMessageKey(messageKey);
        onError("");

        try {
            const response = await fetch("/api/tts/speak", {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                signal: abortController.signal,
                body: JSON.stringify({ text } satisfies TextToSpeechRequest),
            });
            if (!response.ok) {
                throw await apiErrorFromResponse(response, "Failed to generate speech");
            }
            const audioBlob = await response.blob();
            if (!isLatestRequest()) return;

            const audioUrl = URL.createObjectURL(audioBlob);
            const audio = new Audio(audioUrl);
            audioRef.current = audio;
            audioUrlRef.current = audioUrl;
            audio.addEventListener(
                "ended",
                () => {
                    if (isLatestRequest()) stopAudio();
                },
                { once: true }
            );
            audio.addEventListener(
                "error",
                () => {
                    if (!isLatestRequest()) return;
                    onError("Failed to play generated speech.");
                    stopAudio();
                },
                { once: true }
            );
            setPlayingMessageKey(messageKey);
            await audio.play();
        } catch (error_) {
            if (!isLatestRequest()) return;
            stopAudio();
            onError(messageFromError(error_, "Failed to read message aloud"));
        } finally {
            if (isLatestRequest()) {
                setLoadingMessageKey(undefined);
                if (abortControllerRef.current === abortController) {
                    abortControllerRef.current = undefined;
                }
            }
        }
    }

    return { loadingMessageKey, playingMessageKey, speakMessage };
}

export type ChatTextToSpeechController = ReturnType<typeof useChatTextToSpeech>;
