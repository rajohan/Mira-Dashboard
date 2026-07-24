import type { AuthenticationResponseJSON } from "@simplewebauthn/server";

import { json } from "../http.ts";
import {
    type AuthenticationThrottleKind,
    authenticationThrottleStatus,
} from "./authenticationThrottle.ts";

/** Normalizes a Dashboard login username. */
export function normalizeLoginUsername(username: unknown): string | undefined {
    if (typeof username !== "string") {
        return undefined;
    }
    const normalized = username.trim().toLowerCase();
    return /^[a-z0-9._-]{3,32}$/u.test(normalized) ? normalized : undefined;
}

/** Applies the shared Dashboard password input policy. */
export function normalizeLoginPassword(password: unknown): string | undefined {
    return typeof password === "string" && password.length >= 8 && password.length <= 256
        ? password
        : undefined;
}

/** Normalizes a bounded TOTP or recovery-code input. */
export function normalizeSecondFactorCode(code: unknown): string | undefined {
    if (typeof code !== "string") {
        return undefined;
    }
    const normalized = code.trim();
    return normalized.length > 0 && normalized.length <= 128 ? normalized : undefined;
}

/** Parses the minimum browser WebAuthn assertion response shape. */
export function parseAuthenticationResponse(
    value: unknown
): AuthenticationResponseJSON | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const candidate = value as Partial<AuthenticationResponseJSON>;
    return typeof candidate.id === "string" &&
        typeof candidate.rawId === "string" &&
        candidate.type === "public-key" &&
        candidate.response &&
        typeof candidate.response === "object"
        ? (candidate as AuthenticationResponseJSON)
        : undefined;
}

/** Returns a consistent retry response when a persisted auth bucket is blocked. */
export function authenticationThrottleResponse(
    kind: AuthenticationThrottleKind,
    subject: number | string
): Response | undefined {
    const status = authenticationThrottleStatus(kind, subject);
    return status.allowed
        ? undefined
        : json(
              {
                  error: "Too many authentication attempts, please try again later",
              },
              {
                  headers: {
                      "Retry-After": String(status.retryAfterSeconds ?? 1),
                  },
                  status: 429,
              }
          );
}
