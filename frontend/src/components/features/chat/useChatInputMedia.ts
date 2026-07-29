import {
    type Dispatch,
    type SetStateAction,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react";

import { parseSpeechTranscriptionResponse } from "../../../../../contracts/stt";
import { apiErrorFromResponse } from "../../../lib/apiError";
import { messageFromError } from "../../../lib/errorMessage";
import { formatSize } from "../../../utils/format";
import { supportedAudioRecordingMimeType } from "./chatPageUtilities";
import {
    attachmentKind,
    type ChatAttachmentError,
    type ChatAttachmentInputSource,
    type ChatSendAttachment,
} from "./chatTypes";
import {
    dataUrlToBase64,
    displayMimeType,
    isSupportedChatAttachment,
    isVideoAttachment,
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENTS,
    readFileAsDataUrl,
} from "./chatUtilities";

interface ChatInputMediaOptions {
    onError: (error?: string) => void;
    sessionKey: string;
    setDraft: Dispatch<SetStateAction<string>>;
}

/**
 * Owns attachments, voice recording and transcription for the composer.
 * @returns Chat input media state and actions.
 */
export function useChatInputMedia({
    onError,
    sessionKey,
    setDraft,
}: ChatInputMediaOptions) {
    const fileInputRef = useRef<HTMLInputElement | undefined>(undefined);
    const voiceFileInputRef = useRef<HTMLInputElement | undefined>(undefined);
    const mediaRecorderRef = useRef<MediaRecorder | undefined>(undefined);
    const recordingChunksRef = useRef<Blob[]>([]);
    const attachmentsRef = useRef<ChatSendAttachment[]>([]);
    const mediaEpochRef = useRef(0);
    const attachmentRestoreEpochRef = useRef(0);
    const pendingAttachmentSlotsRef = useRef(0);
    const recordingStartEpochRef = useRef<number | undefined>(undefined);
    const sessionKeyRef = useRef(sessionKey);
    const transcriptionCountRef = useRef(0);
    const [attachmentError, setAttachmentError] = useState<
        ChatAttachmentError | undefined
    >();
    const [attachments, setAttachments] = useState<ChatSendAttachment[]>([]);
    const [isRecording, setIsRecording] = useState(false);
    const [isTranscribing, setIsTranscribing] = useState(false);

    const invalidateMedia = (shouldUpdateState = true): number => {
        mediaEpochRef.current += 1;
        attachmentRestoreEpochRef.current += 1;
        const attachmentRestoreEpoch = attachmentRestoreEpochRef.current;
        pendingAttachmentSlotsRef.current = 0;
        recordingStartEpochRef.current = undefined;
        transcriptionCountRef.current = 0;
        recordingChunksRef.current = [];
        attachmentsRef.current = [];
        if (fileInputRef.current) {
            fileInputRef.current.value = "";
        }
        if (voiceFileInputRef.current) {
            voiceFileInputRef.current.value = "";
        }

        const recorder = mediaRecorderRef.current;
        mediaRecorderRef.current = undefined;
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
            setAttachmentError(undefined);
            setAttachments([]);
            setIsRecording(false);
            setIsTranscribing(false);
        }
        return attachmentRestoreEpoch;
    };

    const clearAttachments = () => invalidateMedia();

    const restoreAttachments = (
        restored: ChatSendAttachment[],
        expectedAttachmentRestoreEpoch: number
    ) => {
        if (
            attachmentRestoreEpochRef.current !== expectedAttachmentRestoreEpoch ||
            attachmentsRef.current.length > 0
        ) {
            return false;
        }
        if (restored.length > 0) {
            attachmentsRef.current = restored;
            setAttachments(restored);
        }
        return true;
    };

    const clearAttachmentError = (source?: ChatAttachmentInputSource) => {
        setAttachmentError((current) =>
            !source || current?.source === source ? undefined : current
        );
    };

    const handleFilesSelected = async (
        files: FileList | undefined,
        source: ChatAttachmentInputSource = "composer"
    ) => {
        if (!files || files.length === 0) {
            return;
        }
        onError();
        setAttachmentError(undefined);
        const unsupportedFiles: File[] = [];
        const unsupportedVideos: File[] = [];
        const supportedFiles: File[] = [];
        for (const file of files) {
            if (isVideoAttachment(file)) {
                unsupportedVideos.push(file);
            } else if (isSupportedChatAttachment(file)) {
                supportedFiles.push(file);
            } else {
                unsupportedFiles.push(file);
            }
        }
        const selectionErrors: string[] = [];
        if (unsupportedVideos.length > 0) {
            selectionErrors.push(
                `Skipped video files: ${unsupportedVideos.map((file) => file.name).join(", ")}. Choose images, audio, PDFs, text, ZIP, or Office documents.`
            );
        }
        if (unsupportedFiles.length > 0) {
            selectionErrors.push(
                `Skipped unsupported files: ${unsupportedFiles.map((file) => file.name).join(", ")}. Choose images, audio, PDFs, text, ZIP, or Office documents.`
            );
        }
        if (supportedFiles.length === 0) {
            setAttachmentError({ message: selectionErrors.join(" "), source });
            if (fileInputRef.current) {
                fileInputRef.current.value = "";
            }
            return;
        }
        attachmentRestoreEpochRef.current += 1;
        const operationEpoch = mediaEpochRef.current;
        const remainingSlots = Math.max(
            0,
            MAX_ATTACHMENTS -
                attachmentsRef.current.length -
                pendingAttachmentSlotsRef.current
        );
        const selectedFiles = supportedFiles.slice(0, remainingSlots);
        pendingAttachmentSlotsRef.current += selectedFiles.length;
        if (supportedFiles.length > remainingSlots) {
            selectionErrors.push(
                `Only ${MAX_ATTACHMENTS} attachments can be sent at once.`
            );
        }
        if (selectionErrors.length > 0) {
            setAttachmentError({ message: selectionErrors.join(" "), source });
        }

        try {
            const nextAttachments = await Promise.all(
                selectedFiles.map(async (file) => {
                    if (file.size > MAX_ATTACHMENT_BYTES) {
                        throw new Error(
                            `${file.name} is too large (${formatSize(file.size)}). Max is ${formatSize(MAX_ATTACHMENT_BYTES)}.`
                        );
                    }
                    const readDataUrl = await readFileAsDataUrl(file);
                    const mimeType = displayMimeType(file);
                    const contentBase64 = dataUrlToBase64(readDataUrl);
                    return {
                        id: `${file.name}-${file.lastModified}-${file.size}-${Math.random().toString(36).slice(2, 8)}`,
                        file,
                        fileName: file.name,
                        mimeType,
                        sizeBytes: file.size,
                        contentBase64,
                        dataUrl: `data:${mimeType};base64,${contentBase64}`,
                        kind: attachmentKind(mimeType),
                    } satisfies ChatSendAttachment;
                })
            );
            if (mediaEpochRef.current !== operationEpoch) {
                return;
            }
            setAttachments((previous) => {
                const next = [...previous, ...nextAttachments].slice(0, MAX_ATTACHMENTS);
                attachmentsRef.current = next;
                return next;
            });
        } catch (error) {
            if (mediaEpochRef.current === operationEpoch) {
                setAttachmentError({
                    message: messageFromError(error, "Failed to read attachment"),
                    source,
                });
            }
        } finally {
            if (mediaEpochRef.current === operationEpoch) {
                pendingAttachmentSlotsRef.current = Math.max(
                    0,
                    pendingAttachmentSlotsRef.current - selectedFiles.length
                );
            }
            if (mediaEpochRef.current === operationEpoch && fileInputRef.current) {
                fileInputRef.current.value = "";
            }
        }
    };

    const removeAttachment = (attachmentId: string) => {
        setAttachments((previous) => {
            const next = previous.filter((attachment) => attachment.id !== attachmentId);
            attachmentsRef.current = next;
            return next;
        });
    };

    const transcribeRecording = async (
        audioBlob: Blob,
        operationEpoch = mediaEpochRef.current
    ) => {
        if (mediaEpochRef.current !== operationEpoch) {
            return;
        }
        if (audioBlob.size === 0) {
            onError("No audio was recorded.");
            return;
        }
        transcriptionCountRef.current += 1;
        setIsTranscribing(true);
        onError();

        try {
            const response = await fetch("/api/stt/transcribe", {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": audioBlob.type || "audio/webm" },
                body: audioBlob,
            });
            if (mediaEpochRef.current !== operationEpoch) {
                return;
            }
            if (!response.ok) {
                throw await apiErrorFromResponse(response, "Failed to transcribe audio");
            }

            const result = parseSpeechTranscriptionResponse(await response.json());
            if (mediaEpochRef.current !== operationEpoch) {
                return;
            }
            const text = result.text.trim();
            if (!text) {
                onError("Whisper did not detect any speech.");
                return;
            }
            setDraft((previous) => {
                const trimmed = previous.trimEnd();
                return trimmed ? `${trimmed}\n${text}` : text;
            });
        } catch (error) {
            if (mediaEpochRef.current === operationEpoch) {
                onError(messageFromError(error, "Failed to transcribe audio"));
            }
        } finally {
            if (mediaEpochRef.current === operationEpoch) {
                transcriptionCountRef.current = Math.max(
                    0,
                    transcriptionCountRef.current - 1
                );
                setIsTranscribing(transcriptionCountRef.current > 0);
            }
        }
    };

    const handleVoiceFileSelected = async (files: FileList | undefined) => {
        const file = files?.[0];
        if (!file) {
            return;
        }
        attachmentRestoreEpochRef.current += 1;
        const operationEpoch = mediaEpochRef.current;
        try {
            if (file.size > MAX_ATTACHMENT_BYTES) {
                throw new Error(
                    `${file.name} is too large (${formatSize(file.size)}). Max is ${formatSize(MAX_ATTACHMENT_BYTES)}.`
                );
            }
            await transcribeRecording(file, operationEpoch);
        } catch (error) {
            if (mediaEpochRef.current === operationEpoch) {
                onError(messageFromError(error, "Failed to read audio file"));
            }
        } finally {
            if (mediaEpochRef.current === operationEpoch && voiceFileInputRef.current) {
                voiceFileInputRef.current.value = "";
            }
        }
    };

    const handleToggleRecording = async () => {
        const activeRecorder = mediaRecorderRef.current;
        if (activeRecorder) {
            try {
                if (activeRecorder.state === "inactive") {
                    return;
                }
                activeRecorder.stop();
            } catch (error) {
                mediaRecorderRef.current = undefined;
                recordingChunksRef.current = [];
                for (const track of activeRecorder.stream.getTracks()) {
                    track.stop();
                }
                setIsRecording(false);
                onError(messageFromError(error, "Failed to stop recording"));
            }
            return;
        }
        if (recordingStartEpochRef.current !== undefined) {
            return;
        }
        attachmentRestoreEpochRef.current += 1;
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
            voiceFileInputRef.current?.click();
            return;
        }

        let stream: MediaStream | undefined;
        const operationEpoch = mediaEpochRef.current;
        recordingStartEpochRef.current = operationEpoch;
        try {
            onError();
            stream = await mediaDevices.getUserMedia({ audio: true });
            if (mediaEpochRef.current !== operationEpoch) {
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
            recordingChunksRef.current = [];
            mediaRecorderRef.current = recorder;
            recorder.addEventListener("dataavailable", (event) => {
                if (
                    mediaEpochRef.current === operationEpoch &&
                    mediaRecorderRef.current === recorder &&
                    event.data.size > 0
                ) {
                    recordingChunksRef.current.push(event.data);
                }
            });
            recorder.addEventListener("stop", () => {
                if (mediaEpochRef.current !== operationEpoch) {
                    return;
                }
                for (const track of recordingStream.getTracks()) {
                    track.stop();
                }
                if (mediaRecorderRef.current === recorder) {
                    mediaRecorderRef.current = undefined;
                }
                const blob = new Blob(recordingChunksRef.current, {
                    type: recorder.mimeType || "audio/webm",
                });
                recordingChunksRef.current = [];
                setIsRecording(false);
                void transcribeRecording(blob, operationEpoch);
            });
            recorder.start();
            setIsRecording(true);
        } catch (error) {
            mediaRecorderRef.current = undefined;
            recordingChunksRef.current = [];
            const tracks = stream?.getTracks() || [];
            for (const track of tracks) {
                track.stop();
            }
            if (mediaEpochRef.current === operationEpoch) {
                onError(messageFromError(error, "Failed to start recording"));
            }
        } finally {
            if (recordingStartEpochRef.current === operationEpoch) {
                recordingStartEpochRef.current = undefined;
            }
        }
    };

    useLayoutEffect(() => {
        if (sessionKeyRef.current === sessionKey) {
            return;
        }
        sessionKeyRef.current = sessionKey;
        invalidateMedia();
    }, [sessionKey]);

    useEffect(
        () => () => {
            invalidateMedia(false);
        },
        []
    );

    return {
        attachmentError,
        attachments,
        attachmentsRef: attachmentsRef,
        clearAttachmentError,
        clearAttachments,
        fileInputRef: fileInputRef,
        handleFilesSelected,
        handleToggleRecording,
        handleVoiceFileSelected,
        isRecording,
        isTranscribing,
        removeAttachment,
        restoreAttachments,
        voiceFileInputRef: voiceFileInputRef,
    };
}
