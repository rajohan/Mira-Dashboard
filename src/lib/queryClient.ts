import { QueryClient } from "@tanstack/react-query";

/** Stores auto refresh ms. */
export const AUTO_REFRESH_MS = 5_000;

/** Stores query client. */
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
