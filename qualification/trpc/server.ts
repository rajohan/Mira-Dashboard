import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import type { QualificationEventFeed } from "../realtime/eventFeed.ts";
import { qualificationRouter } from "./router.ts";

const trpcEndpoint = "/trpc";

/**
 * Starts an ephemeral Bun HTTP server around the tRPC Fetch adapter.
 * @param eventFeed Event source supplied through tRPC context.
 * @returns A Bun server listening on an operating-system-assigned port.
 */
export function startQualificationServer(eventFeed: QualificationEventFeed) {
    return Bun.serve({
        fetch(request) {
            if (new URL(request.url).pathname.startsWith(trpcEndpoint)) {
                return fetchRequestHandler({
                    createContext: () => ({ eventFeed }),
                    endpoint: trpcEndpoint,
                    req: request,
                    router: qualificationRouter,
                });
            }
            return new Response("Not found", { status: 404 });
        },
        port: 0,
    });
}
