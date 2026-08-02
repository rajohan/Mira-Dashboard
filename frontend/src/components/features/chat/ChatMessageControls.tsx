import { CircleCheck, Loader2, Square, Trash2, Volume2 } from "lucide-react";

export function DeleteMessageButton({
    deleteKeys,
    messageKey,
    onDelete,
}: {
    deleteKeys?: readonly string[];
    messageKey: string;
    onDelete: (messageKey: string, deleteKeys?: readonly string[]) => void;
}) {
    return (
        <button
            type="button"
            onClick={() => onDelete(messageKey, deleteKeys)}
            className="rounded p-1 text-white/80 opacity-75 transition hover:bg-white/20 hover:text-white hover:opacity-100"
            title="Delete message from this chat view"
            aria-label="Delete your message"
        >
            <Trash2 className="size-3.5" />
        </button>
    );
}

/**
 * Renders the tts button UI.
 * @returns Rendered the tts button UI.
 */
export function TtsButton({
    text,
    messageKey,
    playingMessageKey,
    loadingMessageKey,
    onSpeak,
}: {
    text: string;
    messageKey: string;
    playingMessageKey: string | undefined;
    loadingMessageKey: string | undefined;
    onSpeak: (messageKey: string, text: string) => Promise<void> | void;
}) {
    if (!text.trim()) {
        return;
    }

    const isLoading = loadingMessageKey === messageKey;
    const isPlaying = playingMessageKey === messageKey;
    let icon = <Volume2 className="size-3.5" />;
    if (isPlaying) {
        icon = <Square className="size-3.5" />;
    }
    if (isLoading) {
        icon = <Loader2 className="size-3.5 animate-spin" />;
    }

    return (
        <button
            type="button"
            onClick={() => {
                void onSpeak(messageKey, text);
            }}
            disabled={isLoading}
            className="rounded p-1 text-primary-300 opacity-75 transition hover:bg-primary-700 hover:text-primary-100 hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-50"
            title={isPlaying ? "Stop reading aloud" : "Read aloud"}
            aria-label={isPlaying ? "Stop reading aloud" : "Read assistant message aloud"}
        >
            {icon}
        </button>
    );
}

/**
 * Renders the typing indicator UI.
 * @returns Rendered the typing indicator UI.
 */
export function ActivityIndicator({
    active = true,
    text = "Thinking",
}: {
    active?: boolean;
    text?: string;
}) {
    return (
        <div className="flex max-w-full min-w-0 justify-start pb-3">
            <div className="max-w-full min-w-0 rounded-2xl border border-primary-700 bg-primary-800 px-3 py-2 text-sm text-primary-100 shadow-sm">
                <div className="mb-0.5 text-[11px] tracking-wide uppercase opacity-70">
                    assistant
                </div>
                <div className="flex min-w-0 items-center gap-2 text-primary-300">
                    <span className="min-w-0 flex-1 wrap-break-word">
                        {text || "Thinking"}
                    </span>
                    {active ? (
                        <span
                            className="flex shrink-0 gap-1"
                            aria-label="Assistant is working"
                        >
                            <span className="size-1.5 animate-bounce rounded-full bg-primary-300 [animation-delay:-0.24s]" />
                            <span className="size-1.5 animate-bounce rounded-full bg-primary-300 [animation-delay:-0.12s]" />
                            <span className="size-1.5 animate-bounce rounded-full bg-primary-300" />
                        </span>
                    ) : (
                        <CircleCheck
                            className="size-4 shrink-0 text-emerald-400"
                            aria-label="Operation complete"
                        />
                    )}
                </div>
            </div>
        </div>
    );
}

/** Stops active TTS playback and releases the object URL. */
