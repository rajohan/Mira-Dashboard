import { QueryClient } from "@tanstack/react-query";

import { refreshPolicy } from "./refreshPolicy";

/** Defines auto refresh milliseconds. */
export const AUTO_REFRESH_MS = refreshPolicy.active;

/** Defines query client. */
export const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            retry: 1,
            refetchOnWindowFocus: false,
            refetchOnReconnect: true,
            refetchIntervalInBackground: false,
        },
    },
});
