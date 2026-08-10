import {
    ChevronDown,
    CircleAlert,
    CircleCheck,
    Eye,
    EyeOff,
    LoaderCircle,
    Square,
    Volume2,
    X,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "../lib/classNames.ts";
import { Button } from "../ui/Button.tsx";
import { ConfirmModal } from "../ui/ConfirmModal.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconOnlyButton } from "../ui/IconOnlyButton.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import {
    chatAttachmentTypeLabel,
    formatChatAttachmentSize,
} from "./chatAttachmentPresentation.ts";
import { ChatAttachmentPreview } from "./ChatAttachmentPreview.tsx";
import { safeChatMarkdownLink } from "./chatMarkdownPolicy.ts";
import {
    chatMessageHasVisibleContent,
    visibleChatMessageParts,
} from "./chatMessageVisibility.ts";
import type {
    ChatDisplayMessage,
    ChatDisplaySettings,
    ChatMessageAttachment,
    ChatReadAloudView,
    ChatControlPart,
    ChatToolPart,
} from "./chatTypes.ts";

const managedChatMediaUrlPattern =
    /^\/api\/chat\/media\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\?disposition=(?:preview|download)$/u;

function safeDetail(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value, undefined, 2);
    } catch {
        return "Detail could not be displayed.";
    }
}

function toolDisplayName(name: string): string {
    const unqualified = name.startsWith("functions.")
        ? name.slice("functions.".length)
        : name;
    const normalized = ["bash", "exec", "exec_command"].includes(unqualified)
        ? "bash"
        : unqualified;
    const words = normalized.replaceAll(/[_-]/gu, " ").replaceAll(/\s+/gu, " ").trim();
    return words === "" ? "Tool" : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function toolDescription(part: ChatToolPart): string | undefined {
    let candidate = part.input;
    if (typeof candidate === "string") {
        try {
            candidate = JSON.parse(candidate) as unknown;
        } catch {
            return undefined;
        }
    }
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        return undefined;
    }
    const input = candidate as Readonly<Record<string, unknown>>;
    let command: string | undefined;
    if (typeof input.command === "string") command = input.command;
    else if (typeof input.cmd === "string") command = input.cmd;
    if (command !== undefined) {
        let workingDirectory: string | undefined;
        if (typeof input.workdir === "string") workingDirectory = input.workdir;
        else if (typeof input.cwd === "string") workingDirectory = input.cwd;
        const directoryName = workingDirectory?.split(/[\\/]/u).findLast(Boolean);
        return directoryName === undefined ? command : `${command} (${directoryName})`;
    }
    return typeof input.path === "string" ? input.path : undefined;
}

function ToolDetailSection({
    children,
    label,
}: Readonly<{ children: ReactNode; label: string }>) {
    return (
        <section className="border-primary-700 bg-primary-950/40 rounded-md border px-2 py-1.5">
            <p className="text-primary-400 mb-1 text-[10px] font-medium tracking-wide uppercase">
                {label}
            </p>
            {children}
        </section>
    );
}

interface ToolPartProps {
    readonly expanded: boolean;
    readonly part: ChatToolPart;
}

function toolStatusIcon(status: ChatToolPart["status"]) {
    if (status === "running") return LoaderCircle;
    if (status === "failed") return CircleAlert;
    return CircleCheck;
}

function ToolPart({ expanded, part }: ToolPartProps) {
    const forcedOpen = expanded || part.status === "failed";
    const [override, setOverride] =
        useState<Readonly<{ basis: boolean; value: boolean }>>();
    const open = override?.basis === forcedOpen ? override.value : forcedOpen;
    const description = toolDescription(part);
    const input = safeDetail(part.input);
    const output = safeDetail(part.output);
    const outputDetails = [...new Set([output, part.error])].filter(
        (value): value is string => value !== undefined
    );
    const label = toolDisplayName(part.name);
    return (
        <section
            aria-label={`${label}, ${part.status}`}
            className={cn(
                "bg-primary-800 overflow-hidden rounded-lg",
                part.status === "failed" && "border-red-800/70"
            )}
        >
            <button
                aria-expanded={open}
                className="hover:bg-primary-800 focus-visible:ring-accent-400 flex w-full items-center gap-2 px-3 py-2 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset"
                onClick={() => setOverride({ basis: forcedOpen, value: !open })}
                type="button"
            >
                <Icon
                    className={cn(
                        "shrink-0",
                        part.status === "running" &&
                            "animate-spin motion-reduce:animate-none"
                    )}
                    icon={toolStatusIcon(part.status)}
                    size="sm"
                    tone={part.status === "failed" ? "danger" : "inherit"}
                />
                <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
                <span className="text-primary-400 capitalize">{part.status}</span>
                <Icon
                    className={cn(
                        "transition-transform motion-reduce:transition-none",
                        open && "rotate-180"
                    )}
                    icon={ChevronDown}
                    size="sm"
                    tone="inherit"
                />
            </button>
            {open && (
                <div className="border-primary-700 space-y-2 border-t px-3 py-2">
                    {description !== undefined && (
                        <ToolDetailSection label="Description">
                            <p className="text-primary-200 text-xs wrap-break-word">
                                {description}
                            </p>
                        </ToolDetailSection>
                    )}
                    <ToolDetailSection label="Tool input">
                        {input === undefined ? (
                            <p className="text-primary-400 text-xs">No input.</p>
                        ) : (
                            <section
                                aria-label={`${label} tool input`}
                                className="text-primary-300 max-h-64 overflow-auto text-xs"
                                data-virtualizer-scroll-region
                                // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Bounded tool input must remain keyboard-scrollable.
                                tabIndex={0}
                            >
                                <pre className="wrap-break-word whitespace-pre-wrap">
                                    {input}
                                </pre>
                            </section>
                        )}
                    </ToolDetailSection>
                    {(part.status !== "running" ||
                        output !== undefined ||
                        part.error !== undefined) && (
                        <ToolDetailSection label="Tool output">
                            {outputDetails.length === 0 ? (
                                <p className="text-primary-400 text-xs">No output.</p>
                            ) : (
                                <section
                                    aria-label={`${label} tool output`}
                                    className="text-primary-300 max-h-64 overflow-auto text-xs"
                                    data-virtualizer-scroll-region
                                    // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Bounded tool output must remain keyboard-scrollable.
                                    tabIndex={0}
                                >
                                    <pre className="wrap-break-word whitespace-pre-wrap">
                                        {outputDetails.join("\n\n")}
                                    </pre>
                                </section>
                            )}
                        </ToolDetailSection>
                    )}
                </div>
            )}
        </section>
    );
}

interface ChatMessageBubbleProps {
    readonly activeRunIds?: readonly string[];
    readonly display: ChatDisplaySettings;
    readonly message: ChatDisplayMessage;
    readonly onDismissReadAloudError?: () => void;
    readonly onDynamicContentLoad?: () => void;
    readonly onHide?: (messageId: string) => void;
    readonly onHydrate?: (messageId: string) => void;
    readonly onReadAloud?: (messageId: string, text: string) => void;
    readonly onStopReadAloud?: () => void;
    readonly readAloud?: ChatReadAloudView;
}

function messageAuthor(role: ChatDisplayMessage["role"]): string {
    if (role === "user") return "You";
    if (role === "assistant") return "Mira";
    return "System";
}

function deliveryLabel(delivery: NonNullable<ChatDisplayMessage["delivery"]>): string {
    if (delivery === "queued" || delivery === "accepted") return "accepted";
    return delivery;
}

function controlToneClass(tone: ChatControlPart["tone"]): string {
    if (tone === "danger") return "border-red-700 text-red-300";
    if (tone === "warning") return "border-amber-700 text-amber-200";
    return "text-primary-400";
}

function SafeMarkdownAnchor({
    children,
    href,
}: Readonly<{ children?: ReactNode; href?: string }>) {
    const link = safeChatMarkdownLink(href);
    if (link === undefined) return <span>{children}</span>;
    const externalProperties = link.external
        ? { rel: "noopener noreferrer", target: "_blank" }
        : {};
    return (
        <a href={link.href} {...externalProperties}>
            {children}
        </a>
    );
}

function BlockedMarkdownImage({ alt }: Readonly<{ alt?: string }>) {
    const description = alt === undefined || alt === "" ? "" : `: ${alt}`;
    return <span role="note">[External image blocked{description}]</span>;
}

function MessageAttachment({
    attachment,
    onDynamicContentLoad,
    onPreview,
}: Readonly<{
    attachment: ChatMessageAttachment;
    onDynamicContentLoad?: () => void;
    onPreview: (attachmentId: string) => void;
}>) {
    const previewCandidate = attachment.previewUrl ?? attachment.downloadUrl;
    const managedPreviewUrl =
        previewCandidate !== undefined &&
        managedChatMediaUrlPattern.test(previewCandidate) &&
        previewCandidate.endsWith("?disposition=preview")
            ? previewCandidate
            : undefined;
    const managedDownloadUrl =
        attachment.downloadUrl !== undefined &&
        managedChatMediaUrlPattern.test(attachment.downloadUrl) &&
        attachment.downloadUrl.endsWith("?disposition=download")
            ? attachment.downloadUrl
            : undefined;
    const imageUrl =
        managedPreviewUrl !== undefined && attachment.renderPolicy === "inline-image"
            ? managedPreviewUrl
            : undefined;
    return (
        <li className="border-primary-600 bg-primary-800 max-w-full overflow-hidden rounded-lg border">
            {imageUrl !== undefined && (
                <a
                    className="focus-visible:ring-accent-400 block rounded-lg outline-none focus-visible:ring-2"
                    href={imageUrl}
                    rel="noopener noreferrer"
                    target="_blank"
                >
                    <img
                        alt={attachment.name}
                        className="max-h-56 max-w-full object-contain"
                        onError={onDynamicContentLoad}
                        onLoad={onDynamicContentLoad}
                        src={imageUrl}
                    />
                </a>
            )}
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 p-2">
                <span className="min-w-0">
                    {imageUrl === undefined && managedDownloadUrl !== undefined ? (
                        <a
                            className="text-accent-300 focus-visible:ring-accent-400 block max-w-72 truncate rounded outline-none focus-visible:ring-2"
                            download={attachment.name}
                            href={managedDownloadUrl}
                        >
                            {attachment.name}
                        </a>
                    ) : (
                        <span className="text-primary-100 block max-w-72 truncate">
                            {attachment.name}
                        </span>
                    )}
                    <span className="text-primary-400 mt-0.5 block text-xs">
                        {chatAttachmentTypeLabel(attachment.mediaType)} ·{" "}
                        {formatChatAttachmentSize(attachment.sizeBytes)}
                        {attachment.status === undefined ? "" : ` · ${attachment.status}`}
                    </span>
                </span>
                <IconOnlyButton
                    icon={Eye}
                    label={`Preview ${attachment.name}`}
                    onClick={() => onPreview(attachment.id)}
                    size="sm"
                    variant="ghost"
                />
            </div>
            {(attachment.status === "preparing" || attachment.status === "uploading") && (
                <progress
                    aria-label={`Upload progress for ${attachment.name}`}
                    className="accent-accent-400 block h-1.5 w-full"
                    max={100}
                    value={attachment.progress ?? 0}
                />
            )}
        </li>
    );
}

/**
 * Renders one fully hydrated canonical message in provider order.
 * @returns One safe message bubble.
 */
export function ChatMessageBubble({
    activeRunIds = [],
    display,
    message,
    onDismissReadAloudError,
    onDynamicContentLoad,
    onHide,
    onHydrate,
    onReadAloud,
    onStopReadAloud,
    readAloud,
}: ChatMessageBubbleProps) {
    const [hideConfirmationOpen, setHideConfirmationOpen] = useState(false);
    const [previewAttachmentId, setPreviewAttachmentId] = useState<string>();
    const isUser = message.role === "user";
    const author = messageAuthor(message.role);
    const hydrationLabel =
        message.hydration === "error" ? "Retry full message" : "Open full message";
    const visibleParts = visibleChatMessageParts(message, display);
    const previewAttachment = message.attachments.find(
        (attachment) => attachment.id === previewAttachmentId
    );
    if (!chatMessageHasVisibleContent(message, display, readAloud)) return null;
    const readableText = visibleParts
        .filter((part) => part.kind === "text")
        .map((part) => part.text.trim())
        .filter(Boolean)
        .join("\n\n");
    const messageFinished =
        !message.parts.some(
            (part) =>
                (part.kind === "thinking" && part.status === "running") ||
                (part.kind === "tool" && part.status === "running")
        ) &&
        (message.runId === undefined || !activeRunIds.includes(message.runId)) &&
        (message.clientRunId === undefined ||
            !activeRunIds.includes(message.clientRunId));
    const readAloudAvailable =
        message.role === "assistant" &&
        messageFinished &&
        readableText !== "" &&
        onReadAloud !== undefined &&
        onStopReadAloud !== undefined &&
        readAloud !== undefined;
    const readAloudActive = readAloud?.activeMessageId === message.id;
    let readAloudIcon = Volume2;
    let readAloudLabel = "Read Mira message aloud";
    if (readAloudActive && readAloud?.phase === "loading") {
        readAloudIcon = LoaderCircle;
        readAloudLabel = "Cancel read aloud";
    } else if (readAloudActive && readAloud?.phase === "playing") {
        readAloudIcon = Square;
        readAloudLabel = "Stop reading aloud";
    }
    return (
        <>
            <article
                aria-label={`${author} message`}
                className={cn("flex", isUser ? "justify-end" : "justify-start")}
                data-message-id={message.id}
            >
                <div
                    className={cn(
                        "max-w-[94%] min-w-0 rounded-2xl px-3 py-2 text-sm sm:max-w-[86%] lg:max-w-[80%]",
                        isUser
                            ? "bg-accent-500 text-primary-950"
                            : "bg-primary-950 text-primary-100"
                    )}
                    data-testid={`chat-message-surface-${message.role}`}
                >
                    <header
                        className={cn(
                            "mb-1 flex items-center gap-2 text-[11px] tracking-wide uppercase",
                            isUser ? "text-primary-950" : "text-primary-300"
                        )}
                    >
                        <span>{author}</span>
                        {message.delivery !== undefined &&
                            message.delivery !== "sent" && (
                                <span className="capitalize">
                                    · {deliveryLabel(message.delivery)}
                                </span>
                            )}
                        {onHide !== undefined && (
                            <Button
                                aria-label="Hide message from this browser"
                                className="ml-auto min-h-7 px-1.5"
                                onClick={() => setHideConfirmationOpen(true)}
                                size="sm"
                                title="Hide locally"
                                variant="ghost"
                            >
                                <Icon icon={EyeOff} size="sm" tone="inherit" />
                            </Button>
                        )}
                        {readAloudAvailable && (
                            <IconOnlyButton
                                aria-pressed={
                                    readAloudActive && readAloud.phase === "playing"
                                }
                                className={cn(
                                    "ml-auto min-h-8 min-w-8 px-0",
                                    onHide !== undefined && "ml-0",
                                    readAloudActive &&
                                        readAloud.phase === "loading" &&
                                        "animate-pulse motion-reduce:animate-none"
                                )}
                                icon={readAloudIcon}
                                label={readAloudLabel}
                                onClick={() => {
                                    if (readAloudActive && readAloud.phase !== "idle") {
                                        onStopReadAloud();
                                    } else {
                                        onReadAloud(message.id, readableText);
                                    }
                                }}
                                size="sm"
                                variant="ghost"
                            />
                        )}
                    </header>
                    {message.attachments.length > 0 && (
                        <ul
                            className="mb-2 flex flex-wrap gap-2"
                            aria-label="Attachments"
                        >
                            {message.attachments.map((attachment) => (
                                <MessageAttachment
                                    attachment={attachment}
                                    key={attachment.id}
                                    onDynamicContentLoad={onDynamicContentLoad}
                                    onPreview={setPreviewAttachmentId}
                                />
                            ))}
                        </ul>
                    )}
                    <div className="space-y-2">
                        {visibleParts.map((part, index) => {
                            if (part.kind === "text") {
                                return (
                                    <Markdown
                                        components={{
                                            a: SafeMarkdownAnchor,
                                            img: BlockedMarkdownImage,
                                        }}
                                        className={
                                            isUser
                                                ? "prose-a:text-primary-950 prose-blockquote:text-primary-950 prose-code:text-primary-950 prose-headings:text-primary-950 prose-li:text-primary-950 prose-p:text-primary-950 prose-strong:text-primary-950"
                                                : undefined
                                        }
                                        key={`text:${index}`}
                                        source={part.text}
                                    />
                                );
                            }
                            if (part.kind === "thinking") {
                                return (
                                    <aside
                                        className="bg-primary-800 text-primary-200 rounded-lg p-2.5 text-xs italic"
                                        key={`thinking:${index}`}
                                    >
                                        <p className="mb-1 font-medium not-italic">
                                            {part.status === "running"
                                                ? "Thinking…"
                                                : "Thinking"}
                                        </p>
                                        <p className="whitespace-pre-wrap">{part.text}</p>
                                    </aside>
                                );
                            }
                            if (part.kind === "control") {
                                return (
                                    <p
                                        className={cn(
                                            "bg-primary-800 rounded-lg p-2.5 text-xs",
                                            controlToneClass(part.tone)
                                        )}
                                        key={`control:${index}`}
                                    >
                                        {part.text}
                                    </p>
                                );
                            }
                            return (
                                <ToolPart
                                    expanded={display.toolsExpanded}
                                    key={`tool:${part.callId}`}
                                    part={part}
                                />
                            );
                        })}
                        {message.delivery === "sending" && visibleParts.length === 0 && (
                            <p className="text-primary-300 animate-pulse text-xs motion-reduce:animate-none">
                                Sending…
                            </p>
                        )}
                    </div>
                    {message.hydration !== undefined && onHydrate !== undefined && (
                        <div className="mt-2">
                            <Button
                                busy={message.hydration === "loading"}
                                busyLabel="Loading full message…"
                                onClick={() => onHydrate(message.id)}
                                size="sm"
                                variant="secondary"
                            >
                                {hydrationLabel}
                            </Button>
                        </div>
                    )}
                    {readAloud?.errorMessageId === message.id &&
                        readAloud.error !== undefined && (
                            <div
                                className="mt-2 flex min-w-0 items-start gap-2 text-xs text-red-300 normal-case"
                                role="alert"
                            >
                                <span className="min-w-0 flex-1 wrap-break-word">
                                    {readAloud.error}
                                </span>
                                {onDismissReadAloudError !== undefined && (
                                    <IconOnlyButton
                                        icon={X}
                                        label="Dismiss read aloud error"
                                        onClick={onDismissReadAloudError}
                                        size="sm"
                                        variant="ghost"
                                    />
                                )}
                            </div>
                        )}
                    {message.timestampMs !== undefined && (
                        <time
                            className={cn(
                                "mt-2 block text-[11px]",
                                isUser ? "text-primary-950" : "text-primary-400"
                            )}
                            dateTime={new Date(message.timestampMs).toISOString()}
                        >
                            {new Intl.DateTimeFormat("en-GB", {
                                hour: "2-digit",
                                minute: "2-digit",
                            }).format(message.timestampMs)}
                        </time>
                    )}
                </div>
            </article>
            {onHide !== undefined && (
                <ConfirmModal
                    confirmLabel="Hide message"
                    description="This hides the selected message only in this browser. It does not delete or change the OpenClaw chat history."
                    onCancel={() => setHideConfirmationOpen(false)}
                    onConfirm={() => {
                        onHide(message.id);
                        setHideConfirmationOpen(false);
                    }}
                    open={hideConfirmationOpen}
                    title="Hide this message locally?"
                />
            )}
            <ChatAttachmentPreview
                attachment={previewAttachment}
                key={previewAttachment?.id ?? "closed-preview"}
                onClose={() => setPreviewAttachmentId(undefined)}
            />
        </>
    );
}
