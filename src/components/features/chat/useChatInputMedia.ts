import {
    type Dispatch,
    type SetStateAction,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react";

import { formatSize } from "../../../utils/format";
import { supportedAudioRecordingMimeType } from "./chatPageUtilities";
import { attachmentKind, type ChatSendAttachment } from "./chatTypes";
import {
    chatErrorMessage,
    dataUrlToBase64,
    displayMimeType,
    isVideoAttachment,
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENTS,
    readFileAsDataUrl,
} from "./chatUtilities";

interface ChatInputMediaOptions {
    onError(error?: string): void;
    sessionKey: string;
    setDraft: Dispatch<SetStateAction<string>>;
}

/** Owns attachments, voice recording and transcription for the composer. */
export function useChatInputMedia({
    onError,
    sessionKey,
    setDraft,
}: ChatInputMediaOptions) {
    const fileInputReference = useRef<HTMLInputElement | undefined>(undefined);
    const voiceFileInputReference = useRef<HTMLInputElement | undefined>(undefined);
    const mediaRecorderReference = useRef<MediaRecorder | undefined>(undefined);
    const recordingChunksReference = useRef<Blob[]>([]);
    const attachmentsReference = useRef<ChatSendAttachment[]>([]);
    const mediaEpochReference = useRef(0);
    const pendingAttachmentSlotsReference = useRef(0);
    const recordingStartEpochReference = useRef<number | undefined>(undefined);
    const sessionKeyReference = useRef(sessionKey);
    const transcriptionCountReference = useRef(0);
    const [attachments, setAttachments] = useState<ChatSendAttachment[]>([]);
    const [isRecording, setIsRecording] = useState(false);
    const [isTranscribing, setIsTranscribing] = useState(false);

    attachmentsReference.current = attachments;

    const invalidateMedia = (shouldUpdateState = true) => {
        mediaEpochReference.current += 1;
        pendingAttachmentSlotsReference.current = 0;
        recordingStartEpochReference.current = undefined;
        transcriptionCountReference.current = 0;
        recordingChunksReference.current = [];
        attachmentsReference.current = [];
        if (fileInputReference.current) {
            fileInputReference.current.value = "";
        }
        if (voiceFileInputReference.current) {
            voiceFileInputReference.current.value = "";
        }

        const recorder = mediaRecorderReference.current;
        mediaRecorderReference.current = undefined;
        if (recorder) {
            try {
                if (recorder.state !== "inactive") {
                    recorder.stop();
                }
            } catch {
                // Tracks are released below even if the recorder is already stopped.
            }
            for (const track of recorder.stream.getTracks()) {
                track.stop();
            }
        }
        if (shouldUpdateState) {
            setAttachments([]);
            setIsRecording(false);
            setIsTranscribing(false);
        }
    };

    const clearAttachments = () => invalidateMedia();

    const handleFilesSelected = async (files: FileList | undefined) => {
        if (!files || files.length === 0) {
            return;
        }
        onError(undefined);
        const unsupportedVideo = [...files].find((file) => isVideoAttachment(file));
        if (unsupportedVideo) {
            onError(
                `${unsupportedVideo.name} is a video. OpenClaw chat supports images and non-video files.`
            );
            if (fileInputReference.current) {
                fileInputReference.current.value = "";
            }
            return;
        }
        const operationEpoch = mediaEpochReference.current;
        const remainingSlots = Math.max(
            0,
            MAX_ATTACHMENTS -
                attachmentsReference.current.length -
                pendingAttachmentSlotsReference.current
        );
        const selectedFiles = [...files].slice(0, remainingSlots);
        pendingAttachmentSlotsReference.current += selectedFiles.length;
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
            if (mediaEpochReference.current !== operationEpoch) {
                return;
            }
            setAttachments((previous) => {
                const next = [...previous, ...nextAttachments].slice(0, MAX_ATTACHMENTS);
                attachmentsReference.current = next;
                return next;
            });
        } catch (error) {
            if (mediaEpochReference.current === operationEpoch) {
                onError(chatErrorMessage(error, "Failed to read attachment"));
            }
        } finally {
            if (mediaEpochReference.current === operationEpoch) {
                pendingAttachmentSlotsReference.current = Math.max(
                    0,
                    pendingAttachmentSlotsReference.current - selectedFiles.length
                );
            }
            if (
                mediaEpochReference.current === operationEpoch &&
                fileInputReference.current
            ) {
                fileInputReference.current.value = "";
            }
        }
    };

    const removeAttachment = (attachmentId: string) => {
        setAttachments((previous) => {
            const next = previous.filter((attachment) => attachment.id !== attachmentId);
            attachmentsReference.current = next;
            return next;
        });
    };

    const transcribeRecording = async (
        audioBlob: Blob,
        operationEpoch = mediaEpochReference.current
    ) => {
        if (mediaEpochReference.current !== operationEpoch) {
            return;
        }
        if (audioBlob.size === 0) {
            onError("No audio was recorded.");
            return;
        }
        transcriptionCountReference.current += 1;
        setIsTranscribing(true);
        onError(undefined);

        try {
            const response = await fetch("/api/stt/transcribe", {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": audioBlob.type || "audio/webm" },
                body: audioBlob,
            });
            if (mediaEpochReference.current !== operationEpoch) {
                return;
            }
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
            if (mediaEpochReference.current !== operationEpoch) {
                return;
            }
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
            if (mediaEpochReference.current === operationEpoch) {
                onError(chatErrorMessage(error, "Failed to transcribe audio"));
            }
        } finally {
            if (mediaEpochReference.current === operationEpoch) {
                transcriptionCountReference.current = Math.max(
                    0,
                    transcriptionCountReference.current - 1
                );
                setIsTranscribing(transcriptionCountReference.current > 0);
            }
        }
    };

    const handleVoiceFileSelected = async (files: FileList | undefined) => {
        const file = files?.[0];
        if (!file) {
            return;
        }
        const operationEpoch = mediaEpochReference.current;
        try {
            if (file.size > MAX_ATTACHMENT_BYTES) {
                throw new Error(
                    `${file.name} is too large (${formatSize(file.size)}). Max is ${formatSize(MAX_ATTACHMENT_BYTES)}.`
                );
            }
            await transcribeRecording(file, operationEpoch);
        } catch (error) {
            if (mediaEpochReference.current === operationEpoch) {
                onError(chatErrorMessage(error, "Failed to read audio file"));
            }
        } finally {
            if (
                mediaEpochReference.current === operationEpoch &&
                voiceFileInputReference.current
            ) {
                voiceFileInputReference.current.value = "";
            }
        }
    };

    const handleToggleRecording = async () => {
        const activeRecorder = mediaRecorderReference.current;
        if (activeRecorder) {
            try {
                if (activeRecorder.state === "inactive") {
                    return;
                }
                activeRecorder.stop();
            } catch (error) {
                mediaRecorderReference.current = undefined;
                recordingChunksReference.current = [];
                for (const track of activeRecorder.stream.getTracks()) {
                    track.stop();
                }
                setIsRecording(false);
                onError(chatErrorMessage(error, "Failed to stop recording"));
            }
            return;
        }
        if (recordingStartEpochReference.current !== undefined) {
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
        const operationEpoch = mediaEpochReference.current;
        recordingStartEpochReference.current = operationEpoch;
        try {
            onError(undefined);
            stream = await mediaDevices!.getUserMedia({ audio: true });
            if (mediaEpochReference.current !== operationEpoch) {
                for (const track of stream.getTracks()) {
                    track.stop();
                }
                return;
            }
            const recordingStream = stream;
            const mimeType = supportedAudioRecordingMimeType();
            const recorder = mimeType
                ? new MediaRecorder(recordingStream, { mimeType })
                : new MediaRecorder(recordingStream);
            recordingChunksReference.current = [];
            mediaRecorderReference.current = recorder;
            recorder.addEventListener("dataavailable", (event) => {
                if (
                    mediaEpochReference.current === operationEpoch &&
                    mediaRecorderReference.current === recorder &&
                    event.data.size > 0
                ) {
                    recordingChunksReference.current.push(event.data);
                }
            });
            recorder.addEventListener("stop", () => {
                if (mediaEpochReference.current !== operationEpoch) {
                    return;
                }
                for (const track of recordingStream.getTracks()) {
                    track.stop();
                }
                if (mediaRecorderReference.current === recorder) {
                    mediaRecorderReference.current = undefined;
                }
                const blob = new Blob(recordingChunksReference.current, {
                    type: recorder.mimeType || "audio/webm",
                });
                recordingChunksReference.current = [];
                setIsRecording(false);
                void transcribeRecording(blob, operationEpoch);
            });
            recorder.start();
            setIsRecording(true);
        } catch (error) {
            mediaRecorderReference.current = undefined;
            recordingChunksReference.current = [];
            const tracks = stream?.getTracks() || [];
            for (const track of tracks) {
                track.stop();
            }
            if (mediaEpochReference.current === operationEpoch) {
                onError(chatErrorMessage(error, "Failed to start recording"));
            }
        } finally {
            if (recordingStartEpochReference.current === operationEpoch) {
                recordingStartEpochReference.current = undefined;
            }
        }
    };

    useLayoutEffect(() => {
        if (sessionKeyReference.current === sessionKey) {
            return;
        }
        sessionKeyReference.current = sessionKey;
        invalidateMedia();
    }, [sessionKey]);

    useEffect(
        () => () => {
            invalidateMedia(false);
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
