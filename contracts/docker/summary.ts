import * as v from "valibot";

import { parseContract } from "../runtime";
import {
    dockerContainerSchema,
    dockerImageSchema,
    dockerVolumeSchema,
} from "./inventory";
import {
    dockerUpdaterEventSchema,
    dockerUpdaterServiceSchema,
    dockerUpdaterSummarySchema,
} from "./updater";

const trimmedNonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());

export const dockerSummaryCacheSchema = v.strictObject({
    checkedAt: trimmedNonEmptyStringSchema,
    containers: v.array(dockerContainerSchema),
    images: v.array(dockerImageSchema),
    updaterEvents: v.array(dockerUpdaterEventSchema),
    updaterServices: v.array(dockerUpdaterServiceSchema),
    updaterSummary: dockerUpdaterSummarySchema,
    volumes: v.array(dockerVolumeSchema),
});

export type DockerSummaryCache = v.InferOutput<typeof dockerSummaryCacheSchema>;

export function parseDockerSummaryCache(
    value: unknown,
    path = "dockerSummary"
): DockerSummaryCache {
    return parseContract(dockerSummaryCacheSchema, value, path);
}
