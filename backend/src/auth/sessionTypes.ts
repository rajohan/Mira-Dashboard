import type { DashboardAuthMethod } from "../../../contracts/accountSecurity/methods.ts";
import type { DashboardUser } from "../../../contracts/auth.ts";

export interface SessionRow extends DashboardUser {
    auth_method: DashboardAuthMethod | null;
    authenticated_at: string | null;
    created_at: string;
    elevated_at: string | null;
    elevated_method: DashboardAuthMethod | null;
    expires_at: string;
    last_seen_at: string | null;
    mfa_enabled_at: string | null;
    mfa_verified_at: string | null;
    session_id: string;
    user_agent: string | null;
    validator_hash: string | null;
}

export interface AuthSession extends DashboardUser {
    authMethod: DashboardAuthMethod;
    authenticatedAt: string;
    createdAt: string;
    elevatedAt?: string;
    elevatedMethod?: DashboardAuthMethod;
    expiresAt: string;
    lastSeenAt: string;
    mfaEnabled: boolean;
    mfaVerifiedAt?: string;
    sessionId: string;
    userAgent?: string;
}

export interface CreateSessionOptions {
    authMethod?: DashboardAuthMethod;
    authenticatedAt?: string;
    elevatedAt?: string;
    elevatedMethod?: DashboardAuthMethod;
    mfaVerifiedAt?: string;
    now?: Date;
    userAgent?: string;
}
