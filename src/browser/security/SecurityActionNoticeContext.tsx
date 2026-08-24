import { type ReactNode, useState } from "react";

import type { AuthStatus } from "../../contracts/auth.ts";
import { useObservedQueryData } from "../api/useObservedQueryState.ts";
import { authStatusQueryKey } from "../auth/authQueries.ts";
import {
    type SecurityActionNoticeChannel,
    securityActionNoticeContext as SecurityActionNoticeContext,
} from "./securityActionNoticeContextValue.ts";

interface SecurityActionNoticeProviderProps {
    readonly children: ReactNode;
}

type SecurityActionNotices = Partial<
    Readonly<Record<SecurityActionNoticeChannel, string>>
>;

function SecurityActionNoticeOwner({ children }: SecurityActionNoticeProviderProps) {
    const [notices, setNotices] = useState<SecurityActionNotices>({});
    return (
        <SecurityActionNoticeContext
            value={{
                dismiss: (channel) =>
                    setNotices((current) => ({ ...current, [channel]: undefined })),
                notice: (channel) => notices[channel],
                present: (channel, message) =>
                    setNotices((current) => ({ ...current, [channel]: message })),
            }}
        >
            {children}
        </SecurityActionNoticeContext>
    );
}

/**
 * Owns transient security-action feedback outside authenticated cache remounts.
 * @returns A notice owner retained across same-user session rotations.
 */
export function SecurityActionNoticeProvider({
    children,
}: SecurityActionNoticeProviderProps) {
    const authentication = useObservedQueryData<AuthStatus>(authStatusQueryKey);
    const currentUserId =
        authentication?.state === "authenticated" ? authentication.user.id : undefined;
    return (
        <SecurityActionNoticeOwner key={currentUserId ?? "no-authenticated-user"}>
            {children}
        </SecurityActionNoticeOwner>
    );
}
