import {
    ChevronRight,
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
import { interactiveTapClassName } from "../ui/interactionStyles.ts";
import { LoadingDots } from "../ui/LoadingDots.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import { ProgressBar } from "../ui/ProgressBar.tsx";
import { SyntaxHighlightedSource } from "../ui/SyntaxHighlightedSource.tsx";
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
import { chatToolDiff } from "./chatToolDiff.ts";
import { ChatToolDiff } from "./ChatToolDiff.tsx";
import { toolDescription, toolDisplayName } from "./chatToolPresentation.ts";
import { type ChatToolSourceDetail, chatToolSourceDetails } from "./chatToolSource.ts";
import type {
    ChatDisplayMessage,
    ChatDisplaySettings,
    ChatMessageAttachment,
    ChatReadAloudView,
    ChatControlPart,
    ChatToolPart,
} from "./chatTypes.ts";
import { ToolScrollRegion } from "./ToolScrollRegion.tsx";

const managedChatMediaUrlPattern =
    /^\/api\/chat\/media\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\?disposition=(?:preview|download)$/u;
const toolSyntaxHighlightMaximumLength = 256 * 1024;

function ToolDetailSection({
    children,
    label,
    tone,
}: Readonly<{
    children: ReactNode;
    label: string;
    tone: "danger" | "warning";
}>) {
    return (
        <section
            className={cn(
                "rounded-md border px-2 py-1.5",
                tone === "danger"
                    ? "border-red-400/20 bg-black/15"
                    : "border-amber-400/20 bg-black/15"
            )}
        >
            <p
                className={cn(
                    "mb-1 text-[10px] font-medium tracking-wide uppercase opacity-70",
                    tone === "danger" ? "text-red-100" : "text-amber-100"
                )}
            >
                {label}
            </p>
            {children}
        </section>
    );
}

interface ToolSourceRegionProps {
    readonly ariaLabel: string;
    readonly details: readonly ChatToolSourceDetail[];
}

function ToolSourceRegion({ ariaLabel, details }: ToolSourceRegionProps) {
    return (
        <ToolScrollRegion
            ariaLabel={ariaLabel}
            className="max-h-64 overflow-auto text-[11px] leading-normal"
            contentRevision={details
                .map(
                    (detail) =>
                        `${detail.language}:${detail.content.length}:${detail.content.slice(-16)}`
                )
                .join("|")}
        >
            {details.map((detail, index) => (
                <div
                    className={cn(index > 0 && "mt-2 border-t border-current/15 pt-2")}
                    key={`${detail.language}:${index}`}
                >
                    {detail.label !== undefined && (
                        <p className="text-primary-300 mb-1 truncate font-sans text-[10px] font-medium">
                            {detail.label}
                        </p>
                    )}
                    <pre className="font-mono wrap-anywhere whitespace-pre-wrap [&_.source-viewer-line]:wrap-anywhere [&_.source-viewer-line]:whitespace-pre-wrap">
                        {detail.language !== "plaintext" &&
                        detail.content.length <= toolSyntaxHighlightMaximumLength ? (
                            <SyntaxHighlightedSource
                                content={detail.content}
                                language={detail.language}
                                numbered={false}
                            />
                        ) : (
                            <code data-language="plaintext">{detail.content}</code>
                        )}
                    </pre>
                </div>
            ))}
        </ToolScrollRegion>
    );
}

interface ToolPartProps {
    readonly expanded: boolean;
    readonly part: ChatToolPart;
}

function toolPartDescription(
    part: ChatToolPart,
    diff: ReturnType<typeof chatToolDiff>
): string | undefined {
    const description = toolDescription(part);
    if (description !== undefined || diff === undefined) return description;
    return diff.files.length === 1 ? diff.files[0] : `${diff.files.length} files changed`;
}

function ToolPart({ expanded, part }: ToolPartProps) {
    const defaultOpen = expanded;
    const [override, setOverride] =
        useState<Readonly<{ basis: boolean; value: boolean }>>();
    const open = override?.basis === defaultOpen ? override.value : defaultOpen;
    const diff = chatToolDiff(part);
    const detailDescription = toolDescription(part);
    const description = toolPartDescription(part, diff);
    const label = toolDisplayName(part.name);
    const inputDetails = chatToolSourceDetails(part.input, {
        input: part.input,
        name: part.name,
        placement: "input",
    });
    const outputDetails = [part.output, part.error]
        .flatMap((value) =>
            chatToolSourceDetails(value, {
                input: part.input,
                name: part.name,
                placement: "output",
            })
        )
        .filter(
            (value, index, values) =>
                values.findIndex(
                    (candidate) =>
                        candidate.content === value.content &&
                        candidate.language === value.language
                ) === index
        );
    const tone = part.status === "failed" ? "danger" : "warning";
    return (
        <section
            aria-label={`${label}, ${part.status}`}
            className={cn(
                "overflow-hidden rounded-lg border text-xs",
                tone === "danger"
                    ? "border-red-500/30 bg-red-500/10 text-red-100"
                    : "border-amber-500/30 bg-amber-500/10 text-amber-100"
            )}
        >
            <Button
                aria-expanded={open}
                className={cn(
                    "flex w-full min-w-0 items-start gap-1.5 px-2 py-1.5 text-left text-xs focus-visible:ring-inset",
                    tone === "danger" ? "hover:bg-red-500/10" : "hover:bg-amber-500/10"
                )}
                onClick={() => setOverride({ basis: defaultOpen, value: !open })}
                type="button"
                variant="unstyled"
            >
                <Icon
                    className={cn(
                        "shrink-0 transition-transform motion-reduce:transition-none",
                        open && "rotate-90"
                    )}
                    icon={ChevronRight}
                    size="sm"
                    tone="inherit"
                />
                <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium tracking-wide uppercase opacity-80">
                        {label}
                    </span>
                    {!open && description !== undefined && (
                        <span className="mt-1 block truncate text-[11px] font-normal opacity-75">
                            {description}
                        </span>
                    )}
                </span>
                <span
                    className="mt-0.5 shrink-0 text-[10px] tracking-wide uppercase opacity-70"
                    data-tool-status={part.status}
                >
                    {part.status}
                </span>
            </Button>
            {open && (
                <div
                    className={cn(
                        "space-y-1.5 border-t px-2 py-1.5",
                        tone === "danger" ? "border-red-400/20" : "border-amber-400/20"
                    )}
                >
                    {detailDescription !== undefined && (
                        <ToolDetailSection label="Description" tone={tone}>
                            <p className="text-xs wrap-break-word">{detailDescription}</p>
                        </ToolDetailSection>
                    )}
                    {diff === undefined ? (
                        <ToolDetailSection label="Tool input" tone={tone}>
                            {inputDetails.length === 0 ? (
                                <p className="text-xs opacity-70">No input.</p>
                            ) : (
                                <ToolSourceRegion
                                    ariaLabel={`${label} tool input`}
                                    details={inputDetails}
                                />
                            )}
                        </ToolDetailSection>
                    ) : (
                        <ChatToolDiff diff={diff} label={label} status={part.status} />
                    )}
                    {(part.status !== "running" ||
                        part.output !== undefined ||
                        part.error !== undefined) && (
                        <ToolDetailSection label="Tool output" tone={tone}>
                            {outputDetails.length === 0 ? (
                                <p className="text-xs opacity-70">No output.</p>
                            ) : (
                                <ToolSourceRegion
                                    ariaLabel={`${label} tool output`}
                                    details={outputDetails}
                                />
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
        <a className={interactiveTapClassName} href={link.href} {...externalProperties}>
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
                    className={cn(
                        interactiveTapClassName,
                        "focus-visible:ring-accent-400 block rounded-lg outline-none focus-visible:ring-2"
                    )}
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
                            className={cn(
                                interactiveTapClassName,
                                "text-accent-300 focus-visible:ring-accent-400 block max-w-72 truncate rounded outline-none focus-visible:ring-2"
                            )}
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
                <ProgressBar
                    className="w-full rounded-none"
                    label={`Upload progress for ${attachment.name}`}
                    size="sm"
                    tone="accent"
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
    const showsThinkingLabel = visibleParts.some((part) => part.kind === "thinking");
    const showsTool = visibleParts.some((part) => part.kind === "tool");
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
            !activeRunIds.includes(message.clientRunId)) &&
        (message.providerRunId === undefined ||
            !activeRunIds.includes(message.providerRunId));
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
                        !isUser && showsTool && "w-full",
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
                        <span className={showsThinkingLabel ? "normal-case" : undefined}>
                            {author}
                            {showsThinkingLabel && " (thinking)"}
                        </span>
                        {message.delivery !== undefined &&
                            message.delivery !== "sent" && (
                                <span className="capitalize">
                                    · {deliveryLabel(message.delivery)}
                                </span>
                            )}
                        {onHide !== undefined && (
                            <IconOnlyButton
                                className="ml-auto min-h-7 px-1.5"
                                icon={EyeOff}
                                label="Hide message from this browser"
                                onClick={() => setHideConfirmationOpen(true)}
                                size="sm"
                                title="Hide locally"
                                variant="ghost"
                            />
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
                                        className="border-primary-700 bg-primary-800 text-primary-200 rounded-lg border p-2.5"
                                        key={`thinking:${index}`}
                                    >
                                        <Markdown
                                            components={{
                                                a: SafeMarkdownAnchor,
                                                img: BlockedMarkdownImage,
                                            }}
                                            className="prose-p:text-primary-200 prose-headings:text-primary-100 prose-code:text-primary-100"
                                            source={part.text}
                                        />
                                    </aside>
                                );
                            }
                            if (part.kind === "control") {
                                if (part.activity !== undefined) {
                                    return (
                                        <output
                                            aria-label={part.text}
                                            className="bg-primary-800 text-primary-100 block rounded-lg px-3 py-2.5 text-sm font-medium [&_.loading-state-dots]:ml-0.5 [&_.loading-state-dots]:text-lg [&_.loading-state-dots]:leading-none"
                                            key={`control:${index}`}
                                        >
                                            {part.activity === "running" ? (
                                                <LoadingDots label={part.text} />
                                            ) : (
                                                part.text
                                            )}
                                        </output>
                                    );
                                }
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
