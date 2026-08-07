import { TRPCError } from "@trpc/server";

import { appendClearedDashboardSessionCookie } from "../../../rawHttp/sessionCookie.ts";
import type { RequestContext } from "../../../trpc/context.ts";
import { authenticationPolicyError } from "../../../trpc/trpc.ts";

export function sessionChanged(context: RequestContext): never {
    appendClearedDashboardSessionCookie(context.responseHeaders);
    throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Authentication state changed; sign in again",
    });
}

export function stateChanged(message: string): never {
    throw new TRPCError({ code: "CONFLICT", message });
}

export function enrollmentRequired(): never {
    throw authenticationPolicyError(
        "mfa_enrollment_required",
        "Multi-factor authentication enrollment is required"
    );
}

export function stepUpRequired(): never {
    throw authenticationPolicyError(
        "step_up_required",
        "Recent authentication is required"
    );
}
