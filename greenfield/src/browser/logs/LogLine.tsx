import { Disclosure, DisclosureButton, DisclosurePanel } from "@headlessui/react";
import { ChevronDown } from "lucide-react";
import type { CSSProperties, Ref } from "react";

import type { LogLine as LogLineContract } from "../../contracts/logs.ts";
import { cn } from "../lib/classNames.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import {
    presentRedactedLogLine,
    type RedactedLogLinePresentation,
    type StructuredLogDetail,
} from "./logLinePresentation.ts";
import { logSeverityVariant } from "./logPresentation.ts";

interface LogLineProps {
    readonly dataIndex?: number;
    readonly entry: LogLineContract;
    readonly measureElement?: Ref<HTMLLIElement>;
    readonly presentation?: RedactedLogLinePresentation;
    readonly style?: CSSProperties;
}

const sourceColorClasses: Readonly<Record<string, string>> = Object.freeze({
    agent: "text-purple-300",
    auth: "text-rose-300",
    cron: "text-pink-300",
    exec: "text-emerald-300",
    gateway: "text-cyan-300",
    http: "text-teal-300",
    kernel: "text-lime-300",
    memory: "text-green-300",
    session: "text-indigo-300",
    system: "text-sky-300",
    tools: "text-orange-300",
    ws: "text-amber-300",
});

function sourcePartColor(part: string): string {
    return sourceColorClasses[part.toLowerCase()] ?? "text-violet-300";
}

function LogSourceToken({ source }: Readonly<{ source: string }>) {
    const parts = source.split(/([/.:])/u);
    return (
        <span
            aria-label={`Source ${source}`}
            className="border-primary-600 bg-primary-900/80 inline-flex max-w-52 min-w-0 shrink-0 items-center overflow-hidden rounded border px-1.5 py-0.5 font-medium"
            data-log-source-token=""
            role="note"
            title={source}
        >
            <span aria-hidden="true" className="text-primary-500">
                [
            </span>
            {parts.map((part, index) =>
                part === "/" || part === "." || part === ":" ? (
                    <span
                        aria-hidden="true"
                        className="text-primary-500"
                        key={`${part}:${index}`}
                    >
                        {part}
                    </span>
                ) : (
                    <span
                        aria-hidden="true"
                        className={cn("truncate", sourcePartColor(part))}
                        key={`${part}:${index}`}
                    >
                        {part}
                    </span>
                )
            )}
            <span aria-hidden="true" className="text-primary-500">
                ]
            </span>
        </span>
    );
}

function StructuredDetails({
    details,
}: Readonly<{ readonly details: readonly StructuredLogDetail[] }>) {
    if (details.length === 0) return null;
    return (
        <dl
            aria-label="Structured log fields"
            className="mt-2 flex flex-wrap gap-1.5 sm:ml-[11.75rem]"
        >
            {details.map(({ key, value }) => (
                <div
                    className="border-primary-700 bg-primary-900/70 flex max-w-full min-w-0 rounded border px-2 py-1"
                    key={key}
                >
                    <dt className="text-primary-400 shrink-0">{key}=</dt>
                    <dd className="text-primary-300 min-w-0 break-all whitespace-pre-wrap">
                        {value}
                    </dd>
                </div>
            ))}
        </dl>
    );
}

/**
 * Renders one server-redacted log line with bounded structured metadata.
 * React text nodes keep both parsed values and the raw fallback inert.
 * @returns Accessible log-line presentation.
 */
export function LogLine({
    dataIndex,
    entry,
    measureElement,
    presentation = presentRedactedLogLine(entry),
    style,
}: LogLineProps) {
    const timestampLabel =
        presentation.timestampMs === undefined
            ? undefined
            : formatDashboardDateTime(presentation.timestampMs);
    return (
        <li
            className="border-primary-800 hover:bg-primary-900/70 border-b px-3 py-2.5"
            data-index={dataIndex}
            ref={measureElement}
            style={style}
        >
            <div className="flex flex-wrap items-start gap-x-2 gap-y-1.5 sm:flex-nowrap">
                {presentation.timestampMs === undefined ? (
                    <span
                        aria-label="No timestamp"
                        className="text-primary-400 w-[11rem] shrink-0 whitespace-nowrap"
                    >
                        --.--.---- · --:--:--
                    </span>
                ) : (
                    <time
                        className="text-primary-400 w-[11rem] shrink-0 whitespace-nowrap"
                        dateTime={new Date(presentation.timestampMs).toISOString()}
                        title={timestampLabel}
                    >
                        {timestampLabel}
                    </time>
                )}
                <Badge
                    aria-label={`Level ${presentation.level}`}
                    className="shrink-0 uppercase"
                    variant={logSeverityVariant(presentation.level)}
                >
                    {presentation.level}
                </Badge>
                {presentation.source !== undefined && (
                    <LogSourceToken source={presentation.source} />
                )}
                {presentation.facility !== undefined &&
                    presentation.facility !== presentation.source && (
                        <Badge
                            aria-label={`Facility ${presentation.facility}`}
                            className="shrink-0"
                        >
                            {presentation.facility}
                        </Badge>
                    )}
                {presentation.kind === "raw" && (
                    <Badge aria-label="Plain text log line" className="shrink-0">
                        text
                    </Badge>
                )}
                <code className="text-primary-100 min-w-full flex-1 break-all whitespace-pre-wrap sm:min-w-0">
                    {presentation.message}
                </code>
            </div>

            <StructuredDetails details={presentation.details} />
            {(presentation.detailsTruncated || presentation.omittedFieldCount > 0) && (
                <p className="text-primary-400 mt-1.5 text-[0.6875rem] sm:ml-[11.75rem]">
                    {presentation.omittedFieldCount > 0
                        ? `${presentation.omittedFieldCount} additional ${
                              presentation.omittedFieldCount === 1 ? "field" : "fields"
                          } available in the original line with sensitive values removed.`
                        : "A structured value was shortened for display."}
                </p>
            )}

            {(presentation.kind === "structured" ||
                presentation.message !== presentation.raw) && (
                <Disclosure as="div" className="mt-1.5 min-w-0 sm:ml-[11.75rem]">
                    <DisclosureButton
                        as={Button}
                        className="text-primary-400 hover:text-primary-200 group focus-visible:ring-accent-400 flex items-center gap-1 rounded text-[0.6875rem]"
                        variant="unstyled"
                    >
                        <Icon
                            className="transition-transform group-data-open:rotate-180"
                            icon={ChevronDown}
                            size="sm"
                        />
                        Original line (sensitive values removed)
                    </DisclosureButton>
                    <DisclosurePanel className="border-primary-700 bg-primary-950/80 mt-1.5 min-w-0 rounded border p-2">
                        <code className="text-primary-400 block break-all whitespace-pre-wrap">
                            {presentation.raw}
                        </code>
                    </DisclosurePanel>
                </Disclosure>
            )}
        </li>
    );
}
