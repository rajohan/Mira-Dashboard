import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAuthStore } from "../stores/authStore";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Card, CardTitle } from "../components/ui/Card";

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
        <div className="min-h-screen bg-primary-900 flex items-center justify-center p-4">
            <Card className="w-full max-w-md" variant="bordered">
                <div className="text-center mb-4">
                    <div className="text-4xl mb-2">👩‍💻</div>
                    <CardTitle className="text-center">Mira Dashboard</CardTitle>
                    <p className="text-primary-400 mt-2">Enter your OpenClaw token to continue</p>
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

                <p className="text-xs text-primary-500 mt-4 text-center">
                    Token can be found in your OpenClaw gateway URL
                </p>
            </Card>
        </div>
    );
}
