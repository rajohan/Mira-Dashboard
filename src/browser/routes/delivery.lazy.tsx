import { createLazyRoute } from "@tanstack/react-router";

import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { AuthenticationBoundary } from "../auth/AuthenticationBoundary.tsx";
import { deliveryClient, DeliveryRoute } from "../delivery/index.ts";

export const Route = createLazyRoute("/delivery")({
    component: function DeliveryRouteBoundary() {
        const client = useDashboardTrpcClient();
        return (
            <AuthenticationBoundary>
                <DeliveryRoute client={deliveryClient(client)} />
            </AuthenticationBoundary>
        );
    },
});
