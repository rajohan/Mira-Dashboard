import * as v from "valibot";

/** Stable, secret-free partial-success reasons retained across Delivery releases. */
export const deliveryOperationWarningCodes = Object.freeze([
    "branch-cleanup-unconfirmed",
    "branch-retained",
    "comment-failed",
    "deployment-failed",
    "deployment-outcome-unknown",
    "main-sync-failed",
    "preview-cleanup-failed",
] as const);

export type DeliveryOperationWarningCode = (typeof deliveryOperationWarningCodes)[number];

export function deliveryOperationWarningsAreCanonical(
    warnings: DeliveryOperationWarningCode[]
): boolean {
    return (
        warnings.length > 0 &&
        new Set(warnings).size === warnings.length &&
        warnings.every((warning, index) => index === 0 || warnings[index - 1]! < warning)
    );
}

export function deliveryOperationWarningsSchema(
    message: string
): v.GenericSchema<DeliveryOperationWarningCode[], DeliveryOperationWarningCode[]> {
    return v.pipe(
        v.array(v.picklist(deliveryOperationWarningCodes, message), message),
        v.maxLength(deliveryOperationWarningCodes.length, message),
        v.check(deliveryOperationWarningsAreCanonical, message)
    );
}

export function canonicalDeliveryOperationWarnings(
    warnings: readonly DeliveryOperationWarningCode[]
): DeliveryOperationWarningCode[] {
    return [...new Set(warnings)].toSorted();
}
