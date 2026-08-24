import { createContext, use } from "react";

export type SecurityActionNoticeChannel = "account-email" | "password";

interface SecurityActionNoticeStore {
    readonly dismiss: (channel: SecurityActionNoticeChannel) => void;
    readonly notice: (channel: SecurityActionNoticeChannel) => string | undefined;
    readonly present: (channel: SecurityActionNoticeChannel, message: string) => void;
}

export interface SecurityActionNotice {
    readonly dismiss: () => void;
    readonly notice: string | undefined;
    readonly present: (message: string) => void;
}

export const securityActionNoticeContext =
    createContext<SecurityActionNoticeStore | null>(null);

/**
 * Returns one document-owned security-action notice channel.
 * @param channel Independent action surface that owns the message.
 * @returns A same-user-session-stable notice presenter.
 */
export function useSecurityActionNotice(
    channel: SecurityActionNoticeChannel
): SecurityActionNotice {
    const store = use(securityActionNoticeContext);
    if (store === null) throw new TypeError("Security action notice is unavailable");
    return {
        dismiss: () => store.dismiss(channel),
        notice: store.notice(channel),
        present: (message) => store.present(channel, message),
    };
}
