import * as v from "valibot";

import { authPendingLoginSelectSchema } from "../../../database/validation/authPendingLogins.ts";
import { userRecoveryCodeSelectSchema } from "../../../database/validation/userRecoveryCodes.ts";
import { userTotpFactorSelectSchema } from "../../../database/validation/userTotpFactors.ts";
import type {
    MfaPendingLoginRecord,
    MfaRecoveryCodeRecord,
    MfaTotpFactorRecord,
} from "./lifecycleRepositoryTypes.ts";

export function requiredMfaRow<T>(row: T | undefined, operation: string): T {
    if (row === undefined) {
        throw new Error(`MFA repository ${operation} returned no row`);
    }
    return row;
}

export function checkedMfaListLimit(limit: number): number {
    if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new RangeError("MFA repository list limit is invalid");
    }
    return limit;
}

export function checkedMfaCount(row: { readonly count: number } | undefined): number {
    const count = requiredMfaRow(row, "count").count;
    if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error("MFA repository returned an invalid count");
    }
    return count;
}

export function parsePendingLogin(row: unknown): MfaPendingLoginRecord {
    return v.parse(authPendingLoginSelectSchema, row);
}

export function parseTotpFactor(row: unknown): MfaTotpFactorRecord {
    return v.parse(userTotpFactorSelectSchema, row);
}

export function parseRecoveryCode(row: unknown): MfaRecoveryCodeRecord {
    return v.parse(userRecoveryCodeSelectSchema, row);
}
