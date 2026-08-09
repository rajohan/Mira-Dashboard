import { useNavigate, useSearch } from "@tanstack/react-router";

import { useGatewaySessionRealtimeInvalidation } from "../sessions/useGatewaySessionRealtimeInvalidation.ts";
import { ChatBrowser } from "./ChatBrowser.tsx";
import { parseChatRouteSearch } from "./chatRouteSearch.ts";

/**
 * URL-owned authenticated chat route with stable provider session selection.
 * @returns The authenticated chat route surface.
 */
export function ChatRoute() {
    useGatewaySessionRealtimeInvalidation();
    const navigate = useNavigate({ from: "/chat" });
    const search = parseChatRouteSearch(useSearch({ from: "/chat" }) as unknown);
    function selectSession(sessionKey: string): void {
        void navigate({
            replace: true,
            search: sessionKey === "" ? {} : { session: sessionKey },
        });
    }

    return (
        <div className="h-full min-h-0">
            <ChatBrowser
                onSelectedSessionChange={selectSession}
                requestedSessionKey={search.session}
            />
        </div>
    );
}
