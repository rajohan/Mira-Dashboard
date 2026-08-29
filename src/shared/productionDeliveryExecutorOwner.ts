import * as v from "valibot";

import { fullCommitShaSchema, lowercaseUuidV7Schema } from "./validation.ts";

const invalidOwner = "Production Delivery executor owner is invalid";

export const productionDeliveryExecutorOwnerSchema = v.strictObject({
    formatVersion: v.literal(1, invalidOwner),
    releaseId: fullCommitShaSchema(invalidOwner),
    runtimeRevision: fullCommitShaSchema(invalidOwner),
    transitionId: lowercaseUuidV7Schema(invalidOwner),
});

export type ProductionDeliveryExecutorOwner = Readonly<
    v.InferOutput<typeof productionDeliveryExecutorOwnerSchema>
>;

export function parseProductionDeliveryExecutorOwner(
    input: unknown
): ProductionDeliveryExecutorOwner {
    const parsed = v.safeParse(productionDeliveryExecutorOwnerSchema, input, {
        abortEarly: true,
    });
    if (!parsed.success) throw new TypeError(invalidOwner);
    return Object.freeze(parsed.output);
}

export function serializeProductionDeliveryExecutorOwner(input: unknown): string {
    return `${JSON.stringify(parseProductionDeliveryExecutorOwner(input))}\n`;
}
