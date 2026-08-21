import { ChevronDown, ChevronUp } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import {
    Children,
    cloneElement,
    isValidElement,
    useLayoutEffect,
    useRef,
    useState,
} from "react";

import generatedDocuments from "../../../docs/generated/browser-reference.json";
import { cn } from "../lib/classNames.ts";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { ExpandableCard } from "../ui/ExpandableCard.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import { SearchInput } from "../ui/SearchInput.tsx";
import { SourceViewer } from "../ui/SourceViewer.tsx";
import { Text } from "../ui/Text.tsx";

interface GeneratedDocument {
    readonly content?: string;
    readonly kind: "json" | "markdown" | "schema";
    readonly path: string;
}

interface DocumentGroup {
    readonly documents: readonly GeneratedDocument[];
    readonly id: string;
    readonly label: string;
}

const documents = generatedDocuments as readonly GeneratedDocument[];
const initialDocumentPath = "README.md";
const visibleScrollbarClassName =
    "[scrollbar-gutter:stable] [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-primary-950 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-primary-500 [&::-webkit-scrollbar-thumb:hover]:bg-primary-400";
const openApiDocument = JSON.parse(
    documents.find(({ path }) => path === "openapi.raw-http.json")?.content ?? "{}"
) as { readonly components?: { readonly schemas?: Readonly<Record<string, unknown>> } };

function documentContent(document: GeneratedDocument): string {
    if (document.kind !== "schema") return document.content ?? "";
    const schemaId = document.path
        .replace(/^schemas\//u, "")
        .replace(/\.schema\.json$/u, "");
    return `${JSON.stringify(openApiDocument.components?.schemas?.[schemaId] ?? {}, null, 2)}\n`;
}

function documentLabel(path: string): string {
    return path
        .replace(/^schemas\//u, "")
        .replace(/\.(?:md|json)$/u, "")
        .replaceAll("-", " ");
}

function titleCase(value: string): string {
    return value.replaceAll(/(^|\s)\S/gu, (character) => character.toUpperCase());
}

function documentGroupId(document: GeneratedDocument): string {
    if (document.kind !== "schema") return "reference";
    return document.path.replace(/^schemas\//u, "").split(".")[0] ?? "other";
}

function groupDocuments(source: readonly GeneratedDocument[]): readonly DocumentGroup[] {
    const grouped = new Map<string, GeneratedDocument[]>();
    for (const document of source) {
        const id = documentGroupId(document);
        const group = grouped.get(id) ?? [];
        group.push(document);
        grouped.set(id, group);
    }
    return [...grouped].map(([id, groupedDocuments]) => ({
        documents: groupedDocuments,
        id,
        label:
            id === "reference"
                ? "Reference"
                : titleCase(
                      id.replaceAll(/([a-z])([A-Z])/gu, "$1 $2").replaceAll("-", " ")
                  ),
    }));
}

function highlightedText(value: string, query: string): ReactNode {
    if (query.length === 0) return value;
    const normalizedValue = value.toLowerCase();
    const parts: ReactNode[] = [];
    let cursor = 0;
    let match = normalizedValue.indexOf(query);
    while (match >= 0) {
        if (match > cursor) parts.push(value.slice(cursor, match));
        parts.push(
            <mark
                className="bg-accent-400/30 data-[active=true]:bg-accent-300 data-[active=true]:text-primary-950 data-[active=true]:outline-accent-200 rounded-sm px-0.5 text-inherit data-[active=true]:outline-2 data-[active=true]:outline-offset-2"
                key={`${match}:${value.slice(match, match + query.length)}`}
            >
                {value.slice(match, match + query.length)}
            </mark>
        );
        cursor = match + query.length;
        match = normalizedValue.indexOf(query, cursor);
    }
    parts.push(value.slice(cursor));
    return parts;
}

function occurrenceCount(value: string, query: string): number {
    if (query.length === 0) return 0;
    const normalizedValue = value.toLowerCase();
    let count = 0;
    let cursor = normalizedValue.indexOf(query);
    while (cursor >= 0) {
        count += 1;
        cursor = normalizedValue.indexOf(query, cursor + query.length);
    }
    return count;
}

function HighlightedText({
    children,
    query,
}: {
    readonly children: ReactNode;
    readonly query: string;
}) {
    const highlightNode = (node: ReactNode): ReactNode => {
        if (typeof node === "string") return highlightedText(node, query);
        if (!isValidElement<{ readonly children?: ReactNode }>(node)) return node;
        if (node.props.children === undefined) return node;
        return cloneElement(
            node as ReactElement<{ readonly children?: ReactNode }>,
            undefined,
            Children.map(node.props.children, highlightNode)
        );
    };
    return Children.map(children, highlightNode);
}

function documentationLinkPath(currentPath: string, href: string | undefined) {
    if (href === undefined || /^(?:[a-z]+:|#|\/)/iu.test(href)) return null;
    const currentDirectory = currentPath.includes("/")
        ? currentPath.slice(0, currentPath.lastIndexOf("/") + 1)
        : "";
    const segments = `${currentDirectory}${href.replace(/^\.\//u, "")}`.split("/");
    const resolved: string[] = [];
    for (const segment of segments) {
        if (segment === "..") resolved.pop();
        else if (segment !== "." && segment !== "") resolved.push(segment);
    }
    return resolved.join("/");
}

/**
 * Renders the complete checked-in generated reference without runtime filesystem access.
 * @returns Searchable release documentation with Markdown and JSON viewers.
 */
export function DocsRoute() {
    const viewer = useRef<HTMLDivElement>(null);
    const [activeMatch, setActiveMatch] = useState(0);
    const [query, setQuery] = useState("");
    const [selectedPath, setSelectedPath] = useState(initialDocumentPath);
    const normalizedQuery = query.trim().toLowerCase();
    const matches = documents.filter(
        (document) =>
            normalizedQuery.length === 0 ||
            document.path.toLowerCase().includes(normalizedQuery) ||
            documentContent(document).toLowerCase().includes(normalizedQuery)
    );
    const groups = groupDocuments(matches);
    const selected =
        matches.find(({ path }) => path === selectedPath) ??
        matches[0] ??
        documents.find(({ path }) => path === initialDocumentPath)!;
    const matchCount = occurrenceCount(documentContent(selected), normalizedQuery);

    const jumpToMatch = (requestedIndex: number) => {
        if (matchCount === 0) return;
        setActiveMatch((requestedIndex + matchCount) % matchCount);
    };

    useLayoutEffect(() => {
        if (normalizedQuery.length === 0) return;
        const highlights = viewer.current?.querySelectorAll<HTMLElement>("mark") ?? [];
        if (highlights.length === 0) return;
        const index = activeMatch % highlights.length;
        for (const [highlightIndex, highlight] of highlights.entries()) {
            if (highlightIndex === index) highlight.dataset.active = "true";
            else delete highlight.dataset.active;
        }
        highlights[index]?.scrollIntoView?.({ block: "center" });
    }, [activeMatch, normalizedQuery, selected.path]);

    return (
        <div className="space-y-4">
            <SearchInput
                label="Search documentation"
                onChange={(value) => {
                    setActiveMatch(0);
                    setQuery(value);
                }}
                placeholder="Search paths and contents…"
                value={query}
            />
            <div className="grid min-h-[36rem] gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
                <Card
                    className={cn(
                        "h-[78vh] overflow-y-auto p-2",
                        visibleScrollbarClassName
                    )}
                    aria-label="Documentation pages"
                >
                    <Text className="px-3 py-2" size="sm" tone="muted">
                        {matches.length} of {documents.length} documents
                    </Text>
                    <nav aria-label="Generated documentation">
                        <div className="space-y-1">
                            {groups.map((group) => (
                                <ExpandableCard
                                    className="rounded-none border-0 bg-transparent shadow-none"
                                    compact
                                    defaultOpen={
                                        normalizedQuery.length > 0 ||
                                        group.id === documentGroupId(selected)
                                    }
                                    key={`${normalizedQuery}:${group.id}:${documentGroupId(selected)}`}
                                    panelClassName="border-primary-700 ml-3 border-t-0 border-l p-0 pl-2"
                                    title={group.label}
                                    trailing={
                                        <span className="text-primary-400 text-xs tabular-nums">
                                            {group.documents.length}
                                        </span>
                                    }
                                    triggerClassName="hover:bg-primary-700 data-open:bg-transparent data-open:hover:bg-primary-700 rounded-lg px-3 py-2"
                                >
                                    {group.documents.map((document) => (
                                        <button
                                            className={cn(
                                                "hover:bg-primary-700 focus-visible:ring-accent-400 block w-full rounded-lg px-3 py-2 text-left text-sm transition focus-visible:ring-2 focus-visible:outline-none",
                                                document.path === selected.path
                                                    ? "bg-primary-700 text-primary-50"
                                                    : "text-primary-300"
                                            )}
                                            key={document.path}
                                            onClick={() => {
                                                setActiveMatch(0);
                                                setSelectedPath(document.path);
                                            }}
                                            type="button"
                                        >
                                            <span className="block truncate font-medium">
                                                {highlightedText(
                                                    documentLabel(document.path),
                                                    normalizedQuery
                                                )}
                                            </span>
                                            <span className="text-primary-400 block truncate text-xs">
                                                {highlightedText(
                                                    document.path,
                                                    normalizedQuery
                                                )}
                                            </span>
                                        </button>
                                    ))}
                                </ExpandableCard>
                            ))}
                        </div>
                    </nav>
                    {matches.length === 0 && (
                        <Text className="px-3 py-6 text-center" tone="muted">
                            No documentation matches this search.
                        </Text>
                    )}
                </Card>
                <Card className="flex h-[78vh] min-w-0 flex-col overflow-hidden">
                    <div className="mb-4 flex shrink-0 items-center justify-between gap-3">
                        <Text
                            className="min-w-0 truncate font-mono"
                            size="sm"
                            tone="muted"
                        >
                            {selected.path}
                        </Text>
                        {normalizedQuery.length > 0 && (
                            <div className="flex shrink-0 items-center gap-1.5">
                                <Text size="sm" tone="muted">
                                    {matchCount === 0
                                        ? "No matches"
                                        : `${activeMatch + 1} of ${matchCount} matches`}
                                </Text>
                                <Button
                                    aria-label="Previous match"
                                    className="size-8 justify-center p-0"
                                    disabled={matchCount <= 1}
                                    onClick={() => jumpToMatch(activeMatch - 1)}
                                    size="sm"
                                    variant="ghost"
                                >
                                    <Icon icon={ChevronUp} size="sm" />
                                </Button>
                                <Button
                                    aria-label="Next match"
                                    className="size-8 justify-center p-0"
                                    disabled={matchCount <= 1}
                                    onClick={() => jumpToMatch(activeMatch + 1)}
                                    size="sm"
                                    variant="ghost"
                                >
                                    <Icon icon={ChevronDown} size="sm" />
                                </Button>
                            </div>
                        )}
                    </div>
                    <div
                        className={cn(
                            "min-h-0 flex-1 overflow-auto overscroll-contain",
                            visibleScrollbarClassName
                        )}
                        ref={viewer}
                    >
                        {selected.kind === "markdown" ? (
                            <Markdown
                                components={{
                                    a: ({ children, href }) => {
                                        const target = documentationLinkPath(
                                            selected.path,
                                            href
                                        );
                                        const available = documents.some(
                                            ({ path }) => path === target
                                        );
                                        return available ? (
                                            <a
                                                href={`#${target}`}
                                                onClick={(event) => {
                                                    event.preventDefault();
                                                    setActiveMatch(0);
                                                    setSelectedPath(target!);
                                                }}
                                            >
                                                <HighlightedText query={normalizedQuery}>
                                                    {children}
                                                </HighlightedText>
                                            </a>
                                        ) : (
                                            <span>
                                                <HighlightedText query={normalizedQuery}>
                                                    {children}
                                                </HighlightedText>
                                            </span>
                                        );
                                    },
                                    h1: ({ children }) => (
                                        <h1>
                                            <HighlightedText query={normalizedQuery}>
                                                {children}
                                            </HighlightedText>
                                        </h1>
                                    ),
                                    h2: ({ children }) => (
                                        <h2>
                                            <HighlightedText query={normalizedQuery}>
                                                {children}
                                            </HighlightedText>
                                        </h2>
                                    ),
                                    h3: ({ children }) => (
                                        <h3>
                                            <HighlightedText query={normalizedQuery}>
                                                {children}
                                            </HighlightedText>
                                        </h3>
                                    ),
                                    h4: ({ children }) => (
                                        <h4>
                                            <HighlightedText query={normalizedQuery}>
                                                {children}
                                            </HighlightedText>
                                        </h4>
                                    ),
                                    li: ({ children }) => (
                                        <li>
                                            <HighlightedText query={normalizedQuery}>
                                                {children}
                                            </HighlightedText>
                                        </li>
                                    ),
                                    p: ({ children }) => (
                                        <p>
                                            <HighlightedText query={normalizedQuery}>
                                                {children}
                                            </HighlightedText>
                                        </p>
                                    ),
                                    td: ({ children }) => (
                                        <td>
                                            <HighlightedText query={normalizedQuery}>
                                                {children}
                                            </HighlightedText>
                                        </td>
                                    ),
                                    th: ({ children }) => (
                                        <th>
                                            <HighlightedText query={normalizedQuery}>
                                                {children}
                                            </HighlightedText>
                                        </th>
                                    ),
                                }}
                                source={documentContent(selected)}
                            />
                        ) : (
                            <SourceViewer
                                ariaLabel={`${selected.path} source`}
                                content={documentContent(selected)}
                                copyLabel={`Copy ${selected.path}`}
                                highlightQuery={normalizedQuery}
                                language="json"
                                languageLabel="JSON"
                            />
                        )}
                    </div>
                </Card>
            </div>
        </div>
    );
}
