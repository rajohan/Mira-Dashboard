import { cn } from "../lib/classNames.ts";

export const sourceViewerLinesClassName =
    "source-viewer-lines block min-w-full text-[#f8f8f2] [counter-reset:source-viewer-line-number]";

const sourceViewerLineClassHook = "source-viewer-line";
const sourceViewerSourceClassHook = "source-viewer-source";
const sourceViewerWrappedClassHook = "source-viewer-source-wrapped";
const sourceViewerUnwrappedClassHook = "source-viewer-source-unwrapped";
export const sourceViewerNumberedLinesClassName = "source-viewer-lines-numbered";

/**
 * @param numbered Whether to render a generated line number before each source line.
 * @returns Shared source-line classes with optional generated line numbers.
 */
export function sourceViewerLineClassName(numbered: boolean): string {
    return cn(
        sourceViewerLineClassHook,
        "relative block min-h-lh [counter-increment:source-viewer-line-number]",
        numbered &&
            "before:bg-primary-950 pr-4 pl-20 before:sticky before:left-0 before:z-1 before:mr-4 before:-ml-20 before:box-border before:inline-block before:w-16 before:pr-4 before:text-right before:align-top before:text-[#858c99] before:content-[counter(source-viewer-line-number)] before:select-none"
    );
}

/**
 * @param wrapLongLines Whether long source lines should wrap within the viewport.
 * @returns Source-surface classes for wrapped or horizontally scrollable content.
 */
export function sourceViewerSurfaceClassName(wrapLongLines: boolean): string {
    return cn(
        sourceViewerSourceClassHook,
        "min-h-full min-w-full bg-transparent py-4 font-mono text-sm leading-6 tab-4 text-[#f8f8f2]",
        wrapLongLines
            ? cn(
                  sourceViewerWrappedClassHook,
                  "w-full wrap-anywhere whitespace-pre-wrap [&_.source-viewer-line]:wrap-anywhere [&_.source-viewer-line]:whitespace-pre-wrap"
              )
            : cn(
                  sourceViewerUnwrappedClassHook,
                  "w-max min-w-full whitespace-pre [&_.source-viewer-line]:w-max [&_.source-viewer-line]:min-w-full [&_.source-viewer-line]:whitespace-pre"
              )
    );
}
