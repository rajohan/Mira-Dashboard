import { isIP } from "node:net";

import { sha256Hex } from "../shared/crypto.ts";

export interface AuthenticationClientSourceResolver {
    resolve(request: Request, peerAddress: string | undefined): string;
}

function canonicalIpAddress(value: string): string | undefined {
    const candidate = value.trim().toLowerCase();
    const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(candidate)?.[1];
    if (mappedIpv4 !== undefined && isIP(mappedIpv4) === 4) return mappedIpv4;
    const version = isIP(candidate);
    if (version === 4) return candidate;
    if (version !== 6) return undefined;
    try {
        const hostname = new URL(`http://[${candidate}]/`).hostname;
        return hostname.slice(1, -1).toLowerCase();
    } catch {
        return undefined;
    }
}

function singleForwardedAddress(value: string | null): string | undefined {
    if (value === null || value.includes(",")) return undefined;
    return canonicalIpAddress(value);
}

function trustedForwardedAddress(request: Request): string | undefined {
    const hasRealIp = request.headers.has("x-real-ip");
    const hasForwardedFor = request.headers.has("x-forwarded-for");
    const realIp = singleForwardedAddress(request.headers.get("x-real-ip"));
    const forwardedFor = singleForwardedAddress(request.headers.get("x-forwarded-for"));
    if (
        (hasRealIp && realIp === undefined) ||
        (hasForwardedFor && forwardedFor === undefined)
    ) {
        return undefined;
    }
    if (realIp !== undefined && forwardedFor !== undefined && realIp !== forwardedFor) {
        return undefined;
    }
    return realIp ?? forwardedFor;
}

/**
 * Resolves an opaque authentication source from the direct peer and explicitly
 * trusted, proxy-owned forwarding headers. Raw network addresses never leave
 * this HTTP boundary.
 * @param options Explicit trusted proxy addresses.
 * @returns A resolver that emits opaque hashed source identifiers.
 */
export function createAuthenticationClientSourceResolver(
    options: {
        readonly trustedProxyAddresses?: readonly string[];
    } = {}
): AuthenticationClientSourceResolver {
    const trustedProxyAddresses = new Set(
        (options.trustedProxyAddresses ?? []).map((address) => {
            const canonical = canonicalIpAddress(address);
            if (canonical === undefined) {
                throw new TypeError("Trusted proxy address is invalid");
            }
            return canonical;
        })
    );

    return Object.freeze({
        resolve(request: Request, peerAddress: string | undefined): string {
            const peer =
                peerAddress === undefined ? undefined : canonicalIpAddress(peerAddress);
            const source =
                peer !== undefined && trustedProxyAddresses.has(peer)
                    ? (trustedForwardedAddress(request) ?? peer)
                    : (peer ?? "unknown-peer");
            return sha256Hex(`mira-dashboard:authentication-source:v1:${source}`);
        },
    });
}
