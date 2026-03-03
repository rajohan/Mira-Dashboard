import { Shield } from "lucide-react";

import { ExpandableCard, ReadOnlyField } from "../../ui/ExpandableCard";

interface SecuritySectionProps {
    gatewayPort: number;
    gatewayMode: string;
    authEnabled: boolean;
    authType: string;
}

export function SecuritySection({ gatewayPort, gatewayMode, authEnabled, authType }: SecuritySectionProps) {
    return (
        <ExpandableCard title="Security" icon={Shield}>
            <div className="space-y-2">
                <ReadOnlyField label="Gateway Port" value={gatewayPort} />
                <ReadOnlyField label="Mode" value={gatewayMode} />
                <ReadOnlyField label="Authentication" value={authEnabled ? authType : "Disabled"} />
            </div>
        </ExpandableCard>
    );
}