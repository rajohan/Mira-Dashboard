import { useState } from "react";

import generatedDocuments from "../../../docs/generated/browser-reference.json";
import { cn } from "../lib/classNames.ts";
import { Card } from "../ui/Card.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { SearchInput } from "../ui/SearchInput.tsx";
import { SourceViewer } from "../ui/SourceViewer.tsx";
import { Text } from "../ui/Text.tsx";

interface GeneratedDocument {
    readonly content?: string;
    readonly kind: "json" | "markdown" | "schema";
    readonly path: string;
}

const documents = generatedDocuments as readonly GeneratedDocument[];
const initialDocumentPath = "README.md";
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
    const [query, setQuery] = useState("");
    const [selectedPath, setSelectedPath] = useState(initialDocumentPath);
    const normalizedQuery = query.trim().toLowerCase();
    const matches = documents.filter(
        (document) =>
            normalizedQuery.length === 0 ||
            document.path.toLowerCase().includes(normalizedQuery) ||
            documentContent(document).toLowerCase().includes(normalizedQuery)
    );
    const selected =
        documents.find(({ path }) => path === selectedPath) ??
        matches[0] ??
        documents.find(({ path }) => path === initialDocumentPath)!;

    return (
        <div className="space-y-6">
            <PageHeader
                description="Search the generated API, schema, database, configuration, runtime, package, and browser-route reference shipped with this release."
                eyebrow="Reference"
                title="Documentation"
            />
            <SearchInput
                label="Search documentation"
                onChange={setQuery}
                placeholder="Search paths and contents…"
                value={query}
            />
            <div className="grid min-h-[36rem] gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
                <Card
                    className="max-h-[70vh] overflow-y-auto p-2"
                    aria-label="Documentation pages"
                >
                    <Text className="px-3 py-2" size="sm" tone="muted">
                        {matches.length} of {documents.length} documents
                    </Text>
                    <nav aria-label="Generated documentation">
                        {matches.map((document) => (
                            <button
                                className={cn(
                                    "hover:bg-primary-700 focus-visible:ring-accent-400 block w-full rounded-lg px-3 py-2 text-left text-sm transition focus-visible:ring-2 focus-visible:outline-none",
                                    document.path === selected.path
                                        ? "bg-primary-700 text-primary-50"
                                        : "text-primary-300"
                                )}
                                key={document.path}
                                onClick={() => setSelectedPath(document.path)}
                                type="button"
                            >
                                <span className="block truncate font-medium">
                                    {documentLabel(document.path)}
                                </span>
                                <span className="text-primary-400 block truncate text-xs">
                                    {document.path}
                                </span>
                            </button>
                        ))}
                    </nav>
                    {matches.length === 0 && (
                        <Text className="px-3 py-6 text-center" tone="muted">
                            No documentation matches this search.
                        </Text>
                    )}
                </Card>
                <Card className="min-w-0 overflow-hidden">
                    <Text className="mb-4 font-mono" size="sm" tone="muted">
                        {selected.path}
                    </Text>
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
                                                setSelectedPath(target!);
                                            }}
                                        >
                                            {children}
                                        </a>
                                    ) : (
                                        <span>{children}</span>
                                    );
                                },
                            }}
                            source={documentContent(selected)}
                        />
                    ) : (
                        <SourceViewer
                            ariaLabel={`${selected.path} source`}
                            content={documentContent(selected)}
                            copyLabel={`Copy ${selected.path}`}
                            language="json"
                            languageLabel="JSON"
                        />
                    )}
                </Card>
            </div>
        </div>
    );
}
