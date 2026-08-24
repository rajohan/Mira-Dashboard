import * as v from "valibot";

import { jobActionKeySchema } from "../../../contracts/jobModel.ts";
import {
    automationPrincipalIdSchema,
    securityRecordIdSchema,
} from "../../../contracts/security.ts";

/**
 * Validates one persisted durable-job actor identity against its principal kind.
 * @param kind Durable actor principal kind.
 * @param id Persisted actor identifier.
 * @returns Whether the identifier is canonical for that principal kind.
 */
export function jobActorIdentityIsValid(
    kind: "automation" | "system" | "user",
    id: string
): boolean {
    if (kind === "automation") {
        return v.safeParse(automationPrincipalIdSchema, id).success;
    }
    if (kind === "user") return v.safeParse(securityRecordIdSchema, id).success;
    // System actor ids intentionally share the bounded lowercase action-key shape.
    if (kind === "system") return v.safeParse(jobActionKeySchema, id).success;
    return false;
}
