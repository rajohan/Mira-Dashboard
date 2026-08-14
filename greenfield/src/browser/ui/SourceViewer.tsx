import { type ReactElement, useState } from "react";

import { Badge } from "./Badge.tsx";
import { CopyTextButton } from "./CopyTextButton.tsx";
import { Switch } from "./Switch.tsx";
import { SyntaxHighlightedSource } from "./SyntaxHighlightedSource.tsx";
import { supportsSyntaxHighlightedSourceLanguage } from "./syntaxHighlightedSourceLanguage.ts";
import { Text } from "./Text.tsx";

const sourceViewerLineNumberMaximum = 20_000;
const sourceViewerHighlightByteMaximum = 256 * 1024;

interface SourceViewerProps {
    readonly ariaLabel: string;
    readonly content: string;
    readonly copyLabel: string;
    readonly language: string;
    readonly languageLabel: string;
}

interface SourceSurfaceProps {
    readonly ariaLabel: string;
    readonly content: string;
    readonly highlight?: boolean;
    readonly language: string;
    readonly wrapLongLines: boolean;
}

interface SourceSurfaceFrameProps {
    readonly ariaLabel: string;
    readonly source: ReactElement;
    readonly wrapLongLines: boolean;
}

function sourceLineCount(content: string): number {
    let lineCount = 1;
    for (let index = 0; index < content.length; index += 1) {
        if (content.codePointAt(index) === 10) lineCount += 1;
    }
    return lineCount;
}

interface PlainSourceProps {
    readonly content: string;
    readonly language: string;
    readonly numbered: boolean;
}

function PlainSource({ content, language, numbered }: PlainSourceProps) {
    if (!numbered) {
        return <code data-language={language}>{content}</code>;
    }

    const lines = content.split("\n");
    return (
        <code
            className="source-viewer-lines source-viewer-lines-numbered"
            data-language={language}
        >
            {lines.map((line, index) => (
                <span className="source-viewer-line" key={`source-line-${index + 1}`}>
                    {line}
                    {index < lines.length - 1 ? "\n" : null}
                </span>
            ))}
        </code>
    );
}

function sourceCode(
    content: string,
    highlighted: boolean,
    language: string,
    numbered: boolean
): ReactElement {
    return highlighted && supportsSyntaxHighlightedSourceLanguage(language) ? (
        <SyntaxHighlightedSource
            content={content}
            language={language}
            numbered={numbered}
        />
    ) : (
        <PlainSource content={content} language={language} numbered={numbered} />
    );
}

/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- The bounded source viewport must be keyboard-focusable when either axis scrolls. */
function SourceSurfaceFrame({
    ariaLabel,
    source,
    wrapLongLines,
}: SourceSurfaceFrameProps) {
    return (
        <section
            aria-label={ariaLabel}
            className="focus-visible:ring-accent-300 min-h-0 min-w-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset"
            tabIndex={0}
        >
            <pre
                className={`source-viewer-source min-h-full min-w-full bg-transparent py-4 font-mono text-sm leading-6 tab-4 ${
                    wrapLongLines
                        ? "source-viewer-source-wrapped"
                        : "source-viewer-source-unwrapped"
                }`}
                data-testid="source-viewer-source"
            >
                {source}
            </pre>
        </section>
    );
}

/**
 * Renders the shared line-numbered source surface without adding a toolbar.
 * @returns A CSP-safe, optionally highlighted source viewport.
 */
export function SourceSurface({
    ariaLabel,
    content,
    highlight,
    language,
    wrapLongLines,
}: SourceSurfaceProps) {
    const lineCount = sourceLineCount(content);
    const numbered = lineCount <= sourceViewerLineNumberMaximum;
    const highlighted =
        highlight ??
        (content.length <= sourceViewerHighlightByteMaximum &&
            supportsSyntaxHighlightedSourceLanguage(language));

    return (
        <SourceSurfaceFrame
            ariaLabel={ariaLabel}
            source={sourceCode(content, highlighted, language, numbered)}
            wrapLongLines={wrapLongLines}
        />
    );
}

interface InteractiveSourceViewerProps {
    readonly ariaLabel: string;
    readonly content: string;
    readonly copyLabel: string;
    readonly languageLabel: string;
    readonly lineSummary: string;
    readonly numbered: boolean;
    readonly source: ReactElement;
}

function InteractiveSourceViewer({
    ariaLabel,
    content,
    copyLabel,
    languageLabel,
    lineSummary,
    numbered,
    source,
}: InteractiveSourceViewerProps) {
    const [wrapLongLines, setWrapLongLines] = useState(true);

    return (
        <div className="flex min-h-full min-w-0 flex-col">
            <div
                className="border-primary-700 bg-primary-900/80 flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2"
                data-testid="source-viewer-toolbar"
            >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Badge variant="info">{languageLabel}</Badge>
                    <Text size="sm" tone="muted">
                        {numbered ? lineSummary : `${lineSummary} · line numbers hidden`}
                    </Text>
                </div>
                <div className="flex items-center gap-3">
                    <Switch
                        checked={wrapLongLines}
                        label="Wrap lines"
                        onChange={setWrapLongLines}
                    />
                    <CopyTextButton label={copyLabel} text={content} />
                </div>
            </div>
            <SourceSurfaceFrame
                ariaLabel={ariaLabel}
                source={source}
                wrapLongLines={wrapLongLines}
            />
        </div>
    );
}

/**
 * Renders bounded source text without parsing or executing its contents.
 * @returns A reusable language-labelled, copyable, line-numbered source surface.
 */
export function SourceViewer({
    ariaLabel,
    content,
    copyLabel,
    language,
    languageLabel,
}: SourceViewerProps) {
    const lineCount = sourceLineCount(content);
    const numbered = lineCount <= sourceViewerLineNumberMaximum;
    const highlighted =
        content.length <= sourceViewerHighlightByteMaximum &&
        supportsSyntaxHighlightedSourceLanguage(language);
    const lineSummary = `${lineCount.toLocaleString("en-US")} ${lineCount === 1 ? "line" : "lines"}`;

    return (
        <InteractiveSourceViewer
            ariaLabel={ariaLabel}
            content={content}
            copyLabel={copyLabel}
            languageLabel={languageLabel}
            lineSummary={lineSummary}
            numbered={numbered}
            source={sourceCode(content, highlighted, language, numbered)}
        />
    );
}
/* oxlint-enable jsx-a11y/no-noninteractive-tabindex */
