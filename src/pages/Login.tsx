import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Card, CardTitle } from '../components/ui/Card';

export function Login() {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { login } = useAuthStore();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await fetch(
        `${import.meta.env.VITE_OPENCLAW_URL || ''}/api/v1/status`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (response.ok) {
        login(token);
        navigate('/');
      } else {
        setError('Invalid token. Please check and try again.');
      }
    } catch {
      setError('Failed to connect to OpenClaw.');
    } finally {
      setLoading(false);
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
            error={error}
          />
          <Button type="submit" className="w-full" disabled={!token || loading}>
            {loading ? 'Connecting...' : 'Connect'}
          </Button>
        </form>

        <p className="text-xs text-primary-500 mt-4 text-center">
          Token can be found in your OpenClaw gateway URL
        </p>
      </Card>
    </div>
  );
}
