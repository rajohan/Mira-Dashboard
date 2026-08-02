import { useLocation, useNavigate } from "@tanstack/react-router";

import { AccountSecuritySection } from "../components/features/settings/AccountSecuritySection";
import { OpenClawSettingsSection } from "../components/features/settings/OpenClawSettingsSection";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";

type SettingsView = "dashboard" | "openclaw";

export function Settings() {
    const navigate = useNavigate();
    const search = useLocation({ select: (location_) => location_.search });
    const view: SettingsView = search.view === "openclaw" ? "openclaw" : "dashboard";

    function setView(nextView: SettingsView): void {
        void navigate({ replace: true, search: { view: nextView }, to: "/settings" });
    }

    return (
        <div className="space-y-3 p-3 sm:space-y-4 sm:p-4 lg:p-6">
            <Card className="p-2" variant="bordered">
                <div className="grid grid-cols-2 gap-2">
                    <Button
                        aria-pressed={view === "dashboard"}
                        className="justify-center"
                        onClick={() => setView("dashboard")}
                        variant={view === "dashboard" ? "primary" : "secondary"}
                    >
                        Dashboard settings
                    </Button>
                    <Button
                        aria-pressed={view === "openclaw"}
                        className="justify-center"
                        onClick={() => setView("openclaw")}
                        variant={view === "openclaw" ? "primary" : "secondary"}
                    >
                        OpenClaw settings
                    </Button>
                </div>
            </Card>

            {view === "dashboard" ? (
                <AccountSecuritySection />
            ) : (
                <OpenClawSettingsSection />
            )}
        </div>
    );
}
