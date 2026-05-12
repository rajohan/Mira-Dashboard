import { QueryClient } from "@tanstack/react-query";

export const AUTO_REFRESH_MS = 5_000;

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
