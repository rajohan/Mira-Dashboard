import { useQueryClient } from "@tanstack/react-query";
import { MailCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { Text } from "../ui/Text.tsx";
import { publishAuthenticationStatus } from "./authQueries.ts";
import { LoginPanel } from "./LoginPanel.tsx";

interface EmailVerificationFormProps {
    readonly onBack: () => void;
    readonly token: string;
}

/**
 * Consumes one email-verification link and reports its durable result.
 * @returns Verification progress, success, or failure content.
 */
export function EmailVerificationForm({ onBack, token }: EmailVerificationFormProps) {
    const client = useDashboardTrpcClient();
    const queryClient = useQueryClient();
    const { busy, error, run } = useExclusiveDashboardAction();
    const started = useRef(false);
    const [verifiedEmail, setVerifiedEmail] = useState<string>();

    useEffect(() => {
        if (started.current) return;
        started.current = true;
        void run(async () => {
            const result = await client.mutation("auth.verifyEmail", { token });
            setVerifiedEmail(result.email);
            try {
                const status = await client.query("auth.status", {});
                await publishAuthenticationStatus(queryClient, status);
            } catch {
                // The single-use mutation succeeded. Keep its durable success visible;
                // the next authenticated navigation will refresh status normally.
            }
        });
    }, [client, queryClient, run, token]);

    return (
        <LoginPanel
            description="Confirming the address used for account recovery"
            footer="Verification links expire after 15 minutes and can only be used once."
            icon={MailCheck}
            title="Verify email"
        >
            <Alert
                message={
                    verifiedEmail === undefined
                        ? error
                        : `${verifiedEmail} is now verified.`
                }
                variant={verifiedEmail === undefined ? "error" : "success"}
            />
            {busy ? (
                <Text size="sm" tone="muted">
                    Verifying…
                </Text>
            ) : null}
            <Button className="mt-5" fullWidth onClick={onBack}>
                Continue
            </Button>
        </LoginPanel>
    );
}
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
