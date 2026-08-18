import { GatewaySessionsBrowser } from "./GatewaySessionsBrowser.tsx";
import { useGatewaySessionRealtimeInvalidation } from "./useGatewaySessionRealtimeInvalidation.ts";

/** @returns Bounded current OpenClaw sessions with recently authenticated controls. */
export function GatewaySessionsRoute() {
    useGatewaySessionRealtimeInvalidation();
    return (
        <div>
            <h1 className="sr-only">Sessions</h1>
            <GatewaySessionsBrowser />
        </div>
    );
}
