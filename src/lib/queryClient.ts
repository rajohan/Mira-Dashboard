import { QueryClient } from "@tanstack/react-query";

/** Defines auto refresh milliseconds. */
export const AUTO_REFRESH_MS = 5_000;

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
