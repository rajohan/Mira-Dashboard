import { cn } from "../lib/classNames.ts";
import { SyntaxHighlightedSource } from "../ui/SyntaxHighlightedSource.tsx";
import { Virtualizer } from "../ui/Virtualizer.tsx";
import type {
    ChatToolDiff as ChatToolDiffModel,
    ChatToolDiffLine,
} from "./chatToolDiff.ts";
import { ToolScrollRegion } from "./ToolScrollRegion.tsx";

const diffInitialRect = Object.freeze({ height: 480, width: 640 });

function lineMarker(line: ChatToolDiffLine): string {
    if (line.kind === "add") return "+";
    if (line.kind === "delete") return "-";
    return "";
}

function estimateDiffLineSize(index: number, lines: readonly ChatToolDiffLine[]): number {
    return lines[index]?.kind === "file" ? 22 : 18;
}

function estimatedDiffStart(index: number, lines: readonly ChatToolDiffLine[]): number {
    let offset = 0;
    for (let lineIndex = 0; lineIndex < index; lineIndex += 1) {
        offset += estimateDiffLineSize(lineIndex, lines);
    }
    return offset;
}

function DiffSource({ line }: Readonly<{ line: ChatToolDiffLine }>) {
    const content = line.text === "" ? " " : line.text;
    const highlighted =
        line.language !== undefined &&
        (line.kind === "add" || line.kind === "context" || line.kind === "delete");
    return highlighted ? (
        <div className="min-w-0 pr-2 wrap-anywhere whitespace-pre-wrap [&_.source-viewer-line]:min-w-0 [&_.source-viewer-line]:wrap-anywhere [&_.source-viewer-line]:whitespace-pre-wrap [&_.source-viewer-lines]:min-w-0">
            <SyntaxHighlightedSource
                content={content}
                language={line.language}
                numbered={false}
            />
        </div>
    ) : (
        <code
            className={cn(
                "text-primary-100 min-w-0 pr-2 wrap-anywhere whitespace-pre-wrap",
                line.kind === "delete" && "text-primary-300",
                line.kind === "file" && "text-primary-200 font-semibold",
                line.kind === "skip" && "text-primary-500"
            )}
        >
            {content}
        </code>
    );
}

function DiffLine({ line }: Readonly<{ line: ChatToolDiffLine }>) {
    return (
        <div
            className={cn(
                "grid min-w-0 grid-cols-[2.5rem_1rem_minmax(0,1fr)] items-start",
                line.kind === "add" && "bg-emerald-500/10",
                line.kind === "delete" && "bg-red-500/10",
                line.kind === "file" &&
                    "border-primary-700/70 bg-primary-800/90 border-y py-0.5 first:border-t-0",
                line.kind === "skip" && "text-primary-500 select-none"
            )}
            data-diff-line={line.kind}
        >
            <span className="text-primary-400 pr-2 text-right select-none">
                {line.lineNumber}
            </span>
            <span
                className={cn(
                    "text-center font-semibold select-none",
                    line.kind === "add" && "text-emerald-300",
                    line.kind === "delete" && "text-red-300"
                )}
            >
                {lineMarker(line)}
            </span>
            <DiffSource line={line} />
        </div>
    );
}

interface ChatToolDiffProps {
    readonly diff: ChatToolDiffModel;
    readonly label: string;
    readonly status: "completed" | "failed" | "running";
}

/**
 * Renders an accessible, virtualized apply-patch diff inspired by OpenClaw Control UI.
 * @param props Parsed diff and provider lifecycle presentation.
 * @returns Diff figure with file metadata, line numbers, syntax, and change colors.
 */
export function ChatToolDiff({ diff, label, status }: ChatToolDiffProps) {
    return (
        <figure
            aria-label={`${label} ${status === "completed" ? "file changes" : "attempted file changes"}`}
            className="border-primary-700/80 bg-primary-950/55 overflow-hidden rounded-md border"
            data-tool-diff
        >
            <figcaption className="border-primary-700/80 bg-primary-950/75 flex min-w-0 items-center gap-2 border-b px-2 py-1.5 font-mono text-[11px]">
                <span className="text-primary-200 min-w-0 flex-1 truncate font-semibold">
                    {diff.files.length === 1
                        ? diff.files[0]
                        : `${diff.files.length} files changed`}
                </span>
                <span className="flex shrink-0 items-center gap-1.5 font-semibold">
                    {diff.added > 0 && (
                        <span className="text-emerald-300">+{diff.added}</span>
                    )}
                    {diff.removed > 0 && (
                        <span className="text-red-300">-{diff.removed}</span>
                    )}
                </span>
            </figcaption>
            <Virtualizer<HTMLDivElement>
                count={diff.lines.length}
                estimateSize={(index) => estimateDiffLineSize(index, diff.lines)}
                getItemKey={(index) => `${index}:${diff.lines[index]?.kind ?? "line"}`}
                initialRect={diffInitialRect}
                overscan={12}
            >
                {({ measureElement, scrollContainerRef, totalSize, virtualItems }) => {
                    const estimatedTotalSize = estimatedDiffStart(
                        diff.lines.length,
                        diff.lines
                    );
                    const visibleLines =
                        virtualItems.length > 0
                            ? virtualItems
                            : diff.lines.slice(0, 32).map((_, index) => ({
                                  index,
                                  key: `initial:${index}`,
                                  start: estimatedDiffStart(index, diff.lines),
                              }));
                    const sourceHeight =
                        virtualItems.length === 0 ? estimatedTotalSize : totalSize;
                    return (
                        <ToolScrollRegion
                            ariaLabel={`${label} diff source`}
                            className="max-h-[min(30rem,55vh)] overflow-x-hidden overflow-y-auto font-mono text-[11px] leading-[1.55]"
                            scrollContainerRef={scrollContainerRef}
                        >
                            <div
                                className="relative min-w-0"
                                style={{ height: `${sourceHeight}px` }}
                            >
                                {visibleLines.map((virtualLine) => {
                                    const line = diff.lines[virtualLine.index];
                                    return line === undefined ? null : (
                                        <div
                                            data-index={virtualLine.index}
                                            key={virtualLine.key}
                                            ref={measureElement}
                                            style={{
                                                left: 0,
                                                position: "absolute",
                                                top: 0,
                                                transform: `translateY(${virtualLine.start}px)`,
                                                width: "100%",
                                            }}
                                        >
                                            <DiffLine line={line} />
                                        </div>
                                    );
                                })}
                            </div>
                        </ToolScrollRegion>
                    );
                }}
            </Virtualizer>
        </figure>
    );
}
