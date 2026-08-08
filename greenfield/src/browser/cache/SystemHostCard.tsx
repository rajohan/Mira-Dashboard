import * as v from "valibot";

import { type CacheEntry, systemHostCachePayloadSchema } from "../../contracts/cache.ts";
import { Badge } from "../ui/Badge.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Text } from "../ui/Text.tsx";
import {
    cacheAttemptVariant,
    cacheFreshnessVariant,
    formatCacheBytes,
    formatCacheUptime,
} from "./cachePresentation.ts";

interface CapacityMeterProps {
    readonly freeBytes: number;
    readonly label: string;
    readonly totalBytes: number;
}

function CapacityMeter({ freeBytes, label, totalBytes }: CapacityMeterProps) {
    const usedBytes = totalBytes - freeBytes;
    const usedPercent = totalBytes === 0 ? 0 : Math.round((usedBytes / totalBytes) * 100);
    return (
        <div>
            <div className="flex items-center justify-between gap-3 text-sm">
                <span className="text-primary-200 font-medium">{label}</span>
                <span className="text-primary-300 tabular-nums">
                    {formatCacheBytes(usedBytes)} / {formatCacheBytes(totalBytes)}
                </span>
            </div>
            <progress
                aria-label={`${label} used`}
                className="mt-2 h-2 w-full accent-emerald-400"
                max={Math.max(1, totalBytes)}
                value={usedBytes}
            />
            <Text className="mt-1" size="sm" tone="muted">
                {usedPercent}% used · {formatCacheBytes(freeBytes)} free
            </Text>
        </div>
    );
}

interface SystemHostCardProps {
    readonly entry: CacheEntry;
}

/** @returns Reviewed system.host fields, or a fixed schema warning for invalid payloads. */
export function SystemHostCard({ entry }: SystemHostCardProps) {
    const parsed = v.safeParse(systemHostCachePayloadSchema, entry.payload);
    if (
        entry.key !== "system.host" ||
        entry.schemaId !== "system.host.v1" ||
        entry.source !== "system.host" ||
        !parsed.success
    ) {
        return (
            <Card aria-labelledby="system-host-heading" className="border-amber-900/60">
                <Heading id="system-host-heading" level={3}>
                    Host projection unavailable
                </Heading>
                <Text className="mt-2" tone="warning">
                    The cached host payload does not match the reviewed system.host
                    schema.
                </Text>
            </Card>
        );
    }
    const host = parsed.output;
    return (
        <Card aria-labelledby="system-host-heading">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                    <Text size="sm" tone="muted">
                        Host projection
                    </Text>
                    <Heading
                        className="mt-1 wrap-break-word"
                        id="system-host-heading"
                        level={3}
                    >
                        {host.hostname}
                    </Heading>
                    <Text className="mt-1 wrap-break-word" tone="muted">
                        {host.platform} {host.release} · {host.architecture}
                    </Text>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Badge variant={cacheFreshnessVariant(entry.freshness)}>
                        {entry.freshness}
                    </Badge>
                    <Badge variant={cacheAttemptVariant(entry.lastAttemptStatus)}>
                        last attempt {entry.lastAttemptStatus}
                    </Badge>
                </div>
            </div>
            <div className="mt-5 grid gap-5 md:grid-cols-2">
                <CapacityMeter label="Memory" {...host.memory} />
                <CapacityMeter label={`Disk ${host.disk.path}`} {...host.disk} />
            </div>
            <Text className="border-primary-700 mt-5 border-t pt-4" tone="muted">
                Uptime {formatCacheUptime(host.uptimeSeconds)}
            </Text>
        </Card>
    );
}
