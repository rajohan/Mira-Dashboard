import { PageHeader } from "../ui/PageHeader.tsx";
import { GatewaySessionsBrowser } from "./GatewaySessionsBrowser.tsx";
import { useGatewaySessionRealtimeInvalidation } from "./useGatewaySessionRealtimeInvalidation.ts";

/** @returns Bounded current OpenClaw sessions with recently authenticated controls. */
export function GatewaySessionsRoute() {
    useGatewaySessionRealtimeInvalidation();
    return (
        <div>
            <PageHeader
                description="View current OpenClaw sessions and manage them. Sensitive actions require a recent multi-factor authentication check. This page updates automatically."
                eyebrow="OpenClaw"
                title="Sessions"
            />
            <div className="mt-8">
                <GatewaySessionsBrowser />
            </div>
        </div>
    );
}
