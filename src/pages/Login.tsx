import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "../components/ui/Button";
import { Card, CardTitle } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { useAuthStore } from "../stores/authStore";

export function Login() {
    const [token, setToken] = useState("");
    const navigate = useNavigate();
    const { login } = useAuthStore();

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (token.trim()) {
            login(token.trim());
            navigate({ to: "/" });
        }
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-primary-900 p-4">
            <Card className="w-full max-w-md" variant="bordered">
                <div className="mb-4 text-center">
                    <div className="mb-2 text-4xl">👩‍💻</div>
                    <CardTitle className="text-center">Mira Dashboard</CardTitle>
                    <p className="mt-2 text-primary-400">
                        Enter your OpenClaw token to continue
                    </p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <Input
                        type="password"
                        label="OpenClaw Token"
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                        placeholder="Enter your token..."
                    />
                    <Button type="submit" className="w-full" disabled={!token.trim()}>
                        Connect
                    </Button>
                </form>

                <p className="mt-4 text-center text-xs text-primary-500">
                    Token can be found in your OpenClaw gateway URL
                </p>
            </Card>
        </div>
    );
}
