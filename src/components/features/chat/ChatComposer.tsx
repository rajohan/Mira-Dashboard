import { Paperclip, Send, X } from "lucide-react";
import type { RefObject } from "react";

import { formatSize } from "../../../utils/format";
import { Button } from "../../ui/Button";
import { Textarea } from "../../ui/Textarea";
import type { ChatPreviewItem, ChatSendAttachment } from "./chatTypes";
import { base64ToText } from "./chatUtils";
import type { SlashCommandSuggestion } from "./slashCommands";

interface ChatComposerProps {
    attachments: ChatSendAttachment[];
    canSend: boolean;
    draft: string;
    fileInputReference: RefObject<HTMLInputElement | null>;
    isConnected: boolean;
    isSending: boolean;
    selectedSessionKey: string;
    slashCommandSuggestions: SlashCommandSuggestion[];
    onApplySlashSuggestion: (value: string) => void;
    onAttachFiles: (files: FileList | null) => void;
    onChangeDraft: (value: string) => void;
    onPreview: (preview: ChatPreviewItem) => void;
    onRemoveAttachment: (attachmentId: string) => void;
    onSend: () => void;
}

export function ChatComposer({
    attachments,
    canSend,
    draft,
    fileInputReference,
    isConnected,
    isSending,
    selectedSessionKey,
    slashCommandSuggestions,
    onApplySlashSuggestion,
    onAttachFiles,
    onChangeDraft,
    onPreview,
    onRemoveAttachment,
    onSend,
}: ChatComposerProps) {
    return (
        <div className="mt-4 border-t border-primary-700 pt-4">
            {attachments.length > 0 ? (
                <div className="mb-3 flex flex-wrap gap-2">
                    {attachments.map((attachment) => (
                        <button
                            key={attachment.id}
                            type="button"
                            onClick={() =>
                                onPreview({
                                    title: attachment.fileName,
                                    mimeType: attachment.mimeType,
                                    kind: attachment.kind,
                                    url:
                                        attachment.dataUrl ||
                                        `data:${attachment.mimeType};base64,${attachment.contentBase64}`,
                                    text:
                                        attachment.kind === "text"
                                            ? base64ToText(attachment.contentBase64)
                                            : undefined,
                                    sizeBytes: attachment.sizeBytes,
                                })
                            }
                            className="group flex max-w-full items-center gap-2 rounded-lg border border-primary-700 bg-primary-800 px-2 py-1 text-left text-xs text-primary-100 hover:border-primary-500 hover:bg-primary-700"
                        >
                            {attachment.kind === "image" && attachment.dataUrl ? (
                                <img
                                    src={attachment.dataUrl}
                                    alt=""
                                    className="h-8 w-8 rounded object-cover"
                                />
                            ) : (
                                <Paperclip className="h-4 w-4 text-primary-400" />
                            )}
                            <div className="min-w-0">
                                <div className="truncate">{attachment.fileName}</div>
                                <div className="text-primary-400">
                                    {formatSize(attachment.sizeBytes)}
                                </div>
                            </div>
                            <span
                                role="button"
                                tabIndex={0}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onRemoveAttachment(attachment.id);
                                }}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter" || event.key === " ") {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        onRemoveAttachment(attachment.id);
                                    }
                                }}
                                className="rounded p-1 text-primary-400 hover:bg-primary-700 hover:text-primary-100"
                                aria-label={`Remove ${attachment.fileName}`}
                            >
                                <X className="h-3.5 w-3.5" />
                            </span>
                        </button>
                    ))}
                </div>
            ) : null}

            <div className="flex gap-3">
                <input
                    ref={fileInputReference}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(event) => onAttachFiles(event.target.files)}
                />
                <div className="relative flex-1">
                    {slashCommandSuggestions.length > 0 ? (
                        <div className="absolute bottom-full left-0 z-20 mb-2 w-full overflow-hidden rounded-xl border border-primary-700 bg-primary-900 shadow-2xl">
                            <div className="border-b border-primary-700 px-3 py-2 text-xs font-medium uppercase tracking-wide text-primary-400">
                                Slash commands
                            </div>
                            <div className="max-h-72 overflow-y-auto py-1">
                                {slashCommandSuggestions.map((suggestion) => (
                                    <button
                                        key={suggestion.value}
                                        type="button"
                                        onClick={() =>
                                            onApplySlashSuggestion(suggestion.value)
                                        }
                                        className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-primary-800 focus:bg-primary-800 focus:outline-none"
                                    >
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate font-mono text-sm text-primary-100">
                                                {suggestion.title}
                                            </span>
                                            <span className="mt-0.5 block truncate text-xs text-primary-400">
                                                {suggestion.description}
                                            </span>
                                        </span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    ) : null}
                    <Textarea
                        value={draft}
                        onChange={(event) => onChangeDraft(event.target.value)}
                        onKeyDown={(event) => {
                            if (
                                event.key === "Tab" &&
                                slashCommandSuggestions.length > 0
                            ) {
                                event.preventDefault();
                                onApplySlashSuggestion(
                                    slashCommandSuggestions[0]?.value || draft
                                );
                                return;
                            }

                            if (
                                event.key === "Enter" &&
                                !event.shiftKey &&
                                !event.nativeEvent.isComposing
                            ) {
                                event.preventDefault();
                                onSend();
                            }
                        }}
                        disabled={!selectedSessionKey || !isConnected || isSending}
                        placeholder={
                            selectedSessionKey
                                ? "Message, attach files, or use / commands (try /help)"
                                : "Choose a session first"
                        }
                        rows={5}
                    />
                </div>
                <div className="flex flex-col gap-2">
                    <Button
                        variant="secondary"
                        size="md"
                        onClick={() => fileInputReference.current?.click()}
                        disabled={
                            !isConnected ||
                            !selectedSessionKey ||
                            isSending ||
                            attachments.length >= 10
                        }
                        title="Attach files"
                    >
                        <Paperclip className="mr-2 h-4 w-4" /> Attach
                    </Button>
                    <Button
                        variant="primary"
                        size="md"
                        onClick={onSend}
                        disabled={!canSend}
                    >
                        <Send className="mr-2 h-4 w-4" /> Send
                    </Button>
                </div>
            </div>
        </div>
    );
}
