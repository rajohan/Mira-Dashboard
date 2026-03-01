import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Layout } from "./components/layout/Layout";
import { Dashboard } from "./pages/Dashboard";
import { Sessions } from "./pages/Sessions";
import { Login } from "./pages/Login";
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
                                        <Route path="/tasks" element={<div className="p-6"><h1 className="text-2xl font-bold">Tasks</h1><p className="text-primary-400 mt-2">Coming soon...</p></div>} />
                                        <Route path="/sessions" element={<Sessions />} />
                                        <Route path="/logs" element={<div className="p-6"><h1 className="text-2xl font-bold">Logs</h1><p className="text-primary-400 mt-2">Coming soon...</p></div>} />
                                        <Route path="/files" element={<div className="p-6"><h1 className="text-2xl font-bold">Files</h1><p className="text-primary-400 mt-2">Coming soon...</p></div>} />
                                        <Route path="/metrics" element={<div className="p-6"><h1 className="text-2xl font-bold">Metrics</h1><p className="text-primary-400 mt-2">Coming soon...</p></div>} />
                                        <Route path="/moltbook" element={<div className="p-6"><h1 className="text-2xl font-bold">Moltbook</h1><p className="text-primary-400 mt-2">Coming soon...</p></div>} />
                                        <Route path="/settings" element={<div className="p-6"><h1 className="text-2xl font-bold">Settings</h1><p className="text-primary-400 mt-2">Coming soon...</p></div>} />
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
