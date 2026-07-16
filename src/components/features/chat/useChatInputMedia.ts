import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";

import { formatSize } from "../../../utils/format";
import { supportedAudioRecordingMimeType } from "./chatPageUtilities";
import { attachmentKind, type ChatSendAttachment } from "./chatTypes";
import {
    dataUrlToBase64,
    displayMimeType,
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENTS,
    readFileAsDataUrl,
} from "./chatUtilities";
import { chatErrorMessage } from "./chatUtilities";

interface ChatInputMediaOptions {
    onError(error?: string): void;
    setDraft: Dispatch<SetStateAction<string>>;
}

/** Owns attachments, voice recording and transcription for the composer. */
export function useChatInputMedia({ onError, setDraft }: ChatInputMediaOptions) {
    const fileInputReference = useRef<HTMLInputElement | undefined>(undefined);
    const voiceFileInputReference = useRef<HTMLInputElement | undefined>(undefined);
    const mediaRecorderReference = useRef<MediaRecorder | undefined>(undefined);
    const recordingChunksReference = useRef<Blob[]>([]);
    const attachmentsReference = useRef<ChatSendAttachment[]>([]);
    const [attachments, setAttachments] = useState<ChatSendAttachment[]>([]);
    const [isRecording, setIsRecording] = useState(false);
    const [isTranscribing, setIsTranscribing] = useState(false);

    attachmentsReference.current = attachments;

    const clearAttachments = () => setAttachments([]);

    const handleFilesSelected = async (files: FileList | undefined) => {
        if (!files || files.length === 0) {
            return;
        }
        onError(undefined);
        const remainingSlots = MAX_ATTACHMENTS - attachmentsReference.current.length;
        const selectedFiles = [...files].slice(0, remainingSlots);
        if (files.length > remainingSlots) {
            onError(`Only ${MAX_ATTACHMENTS} attachments can be sent at once.`);
        }

        try {
            const nextAttachments = await Promise.all(
                selectedFiles.map(async (file) => {
                    if (file.size > MAX_ATTACHMENT_BYTES) {
                        throw new Error(
                            `${file.name} is too large (${formatSize(file.size)}). Max is ${formatSize(MAX_ATTACHMENT_BYTES)}.`
                        );
                    }
                    const dataUrl = await readFileAsDataUrl(file);
                    const mimeType = displayMimeType(file);
                    return {
                        id: `${file.name}-${file.lastModified}-${file.size}-${Math.random().toString(36).slice(2, 8)}`,
                        file,
                        fileName: file.name,
                        mimeType,
                        sizeBytes: file.size,
                        contentBase64: dataUrlToBase64(dataUrl),
                        dataUrl,
                        kind: attachmentKind(mimeType),
                    } satisfies ChatSendAttachment;
                })
            );
            setAttachments((previous) => [...previous, ...nextAttachments]);
        } catch (error) {
            onError(chatErrorMessage(error, "Failed to read attachment"));
        } finally {
            if (fileInputReference.current) {
                fileInputReference.current.value = "";
            }
        }
    };

    const removeAttachment = (attachmentId: string) => {
        setAttachments((previous) =>
            previous.filter((attachment) => attachment.id !== attachmentId)
        );
    };

    const transcribeRecording = async (audioBlob: Blob) => {
        if (audioBlob.size === 0) {
            onError("No audio was recorded.");
            return;
        }
        setIsTranscribing(true);
        onError(undefined);

        try {
            const response = await fetch("/api/stt/transcribe", {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": audioBlob.type || "audio/webm" },
                body: audioBlob,
            });
            if (!response.ok) {
                let error: { error?: string };
                try {
                    error = (await response.json()) as { error?: string };
                } catch {
                    error = { error: "Failed to transcribe audio" };
                }
                throw new Error(error.error || `HTTP ${response.status}`);
            }

            const result = (await response.json()) as { text?: string };
            const text = result.text?.trim();
            if (!text) {
                onError("Whisper did not detect any speech.");
                return;
            }
            setDraft((previous) => {
                const trimmed = previous.trimEnd();
                return trimmed ? `${trimmed}\n${text}` : text;
            });
        } catch (error) {
            onError(chatErrorMessage(error, "Failed to transcribe audio"));
        } finally {
            setIsTranscribing(false);
        }
    };

    const handleVoiceFileSelected = async (files: FileList | undefined) => {
        const file = files?.[0];
        if (!file) {
            return;
        }
        try {
            if (file.size > MAX_ATTACHMENT_BYTES) {
                throw new Error(
                    `${file.name} is too large (${formatSize(file.size)}). Max is ${formatSize(MAX_ATTACHMENT_BYTES)}.`
                );
            }
            await transcribeRecording(file);
        } catch (error) {
            onError(chatErrorMessage(error, "Failed to read audio file"));
        } finally {
            if (voiceFileInputReference.current) {
                voiceFileInputReference.current.value = "";
            }
        }
    };

    const handleToggleRecording = async () => {
        if (isRecording) {
            mediaRecorderReference.current?.stop();
            return;
        }
        const mediaDevices = navigator.mediaDevices as MediaDevices | undefined;
        const canRecord =
            Boolean(mediaDevices) &&
            typeof mediaDevices?.getUserMedia === "function" &&
            typeof MediaRecorder !== "undefined";
        if (!canRecord) {
            onError(
                globalThis.isSecureContext
                    ? "Direct voice recording is not supported here. Choose or record an audio file instead."
                    : "Direct voice recording requires HTTPS or localhost. Choose or record an audio file instead."
            );
            voiceFileInputReference.current?.click();
            return;
        }

        let stream: MediaStream | undefined;
        try {
            onError(undefined);
            stream = await mediaDevices!.getUserMedia({ audio: true });
            const recordingStream = stream;
            const mimeType = supportedAudioRecordingMimeType();
            const recorder = mimeType
                ? new MediaRecorder(recordingStream, { mimeType })
                : new MediaRecorder(recordingStream);
            recordingChunksReference.current = [];
            mediaRecorderReference.current = recorder;
            recorder.addEventListener("dataavailable", (event) => {
                if (event.data.size > 0) {
                    recordingChunksReference.current.push(event.data);
                }
            });
            recorder.addEventListener("stop", () => {
                for (const track of recordingStream.getTracks()) {
                    track.stop();
                }
                setIsRecording(false);
                mediaRecorderReference.current = undefined;
                const blob = new Blob(recordingChunksReference.current, {
                    type: recorder.mimeType || "audio/webm",
                });
                recordingChunksReference.current = [];
                void transcribeRecording(blob);
            });
            recorder.start();
            setIsRecording(true);
        } catch (error) {
            const tracks = stream?.getTracks() || [];
            for (const track of tracks) {
                track.stop();
            }
            onError(chatErrorMessage(error, "Failed to start recording"));
        }
    };

    useEffect(
        () => () => {
            const tracks = mediaRecorderReference.current?.stream.getTracks() || [];
            for (const track of tracks) {
                track.stop();
            }
        },
        []
    );

    return {
        attachments,
        attachmentsReference,
        clearAttachments,
        fileInputReference,
        handleFilesSelected,
        handleToggleRecording,
        handleVoiceFileSelected,
        isRecording,
        isTranscribing,
        removeAttachment,
        voiceFileInputReference,
    };
}
