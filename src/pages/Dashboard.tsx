import { Card, CardTitle } from '../components/ui/Card';
import { Activity, Cpu, HardDrive, Users } from 'lucide-react';

export function Dashboard() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Card>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-green-500/20 rounded-lg">
              <Activity className="w-5 h-5 text-green-400" />
            </div>
            <div>
              <div className="text-sm text-primary-400">Status</div>
              <div className="text-lg font-semibold text-green-400">Online</div>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-500/20 rounded-lg">
              <Users className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <div className="text-sm text-primary-400">Sessions</div>
              <div className="text-lg font-semibold">0</div>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-purple-500/20 rounded-lg">
              <Cpu className="w-5 h-5 text-purple-400" />
            </div>
            <div>
              <div className="text-sm text-primary-400">CPU</div>
              <div className="text-lg font-semibold">--</div>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-orange-500/20 rounded-lg">
              <HardDrive className="w-5 h-5 text-orange-400" />
            </div>
            <div>
              <div className="text-sm text-primary-400">Memory</div>
              <div className="text-lg font-semibold">--</div>
            </div>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card variant="bordered">
          <CardTitle>Agent Info</CardTitle>
          <p className="text-primary-400 mt-2">Connect to OpenClaw to see status</p>
        </Card>

        <Card variant="bordered">
          <CardTitle>System Metrics</CardTitle>
          <p className="text-primary-400 mt-2">Connect to OpenClaw to see metrics</p>
        </Card>
      </div>
    </div>
  );
}
