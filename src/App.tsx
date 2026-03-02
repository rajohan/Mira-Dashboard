import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Layout } from "./components/layout/Layout";
import { Dashboard } from "./pages/Dashboard";
import { Sessions } from "./pages/Sessions";
import { Logs } from "./pages/Logs";
import { Metrics } from "./pages/Metrics";
import { Tasks } from "./pages/Tasks";
import { Files } from "./pages/Files";
import { Login } from "./pages/Login";
import { Moltbook } from "./pages/Moltbook";
import { Settings } from "./pages/Settings";
import { useAuthStore } from "./stores/authStore";

const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

function PrivateRoute({ children }: { children: React.ReactNode }) {
    const { isAuthenticated } = useAuthStore();
    return isAuthenticated ? <>{children}</> : <Navigate to="/login" />;
}

function App() {
    return (
        <QueryClientProvider client={queryClient}>
            <BrowserRouter>
                <Routes>
                    <Route path="/login" element={<Login />} />
                    <Route
                        path="/*"
                        element={
                            <PrivateRoute>
                                <Layout>
                                    <Routes>
                                        <Route path="/" element={<Dashboard />} />
                                        <Route path="/tasks" element={<Tasks />} />
                                        <Route path="/sessions" element={<Sessions />} />
                                        <Route path="/logs" element={<Logs />} />
                                        <Route path="/files" element={<Files />} />
                                        <Route path="/metrics" element={<Metrics />} />
                                        <Route path="/moltbook" element={<Moltbook />} />
                                        <Route path="/settings" element={<Settings />} />
                                    </Routes>
                                </Layout>
                            </PrivateRoute>
                        }
                    />
                </Routes>
            </BrowserRouter>
        </QueryClientProvider>
    );
}

export default App;
