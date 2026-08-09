import { PageHeader } from "../ui/PageHeader.tsx";
import { GatewaySessionsBrowser } from "./GatewaySessionsBrowser.tsx";
import { useGatewaySessionRealtimeInvalidation } from "./useGatewaySessionRealtimeInvalidation.ts";

/** @returns Bounded current OpenClaw sessions with recently authenticated controls. */
export function GatewaySessionsRoute() {
    useGatewaySessionRealtimeInvalidation();
    return (
        <div>
            <PageHeader
                description="Current OpenClaw main, subagent, hook, and cron sessions with bounded statistics and recently authenticated controls."
                eyebrow="OpenClaw"
                title="Sessions"
            />
            <div className="mt-8">
                <GatewaySessionsBrowser />
            </div>
        </div>
    );
}
