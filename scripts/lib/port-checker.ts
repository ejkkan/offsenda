import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface ServicePort {
  port: number;
  service: string;
  required: boolean;
}

export interface PortCheckResult {
  port: number;
  service: string;
  available: boolean;
  processInfo?: string;
}

export const DEFAULT_PORTS: ServicePort[] = [
  { port: 5455, service: 'PostgreSQL', required: false },
  { port: 4222, service: 'NATS', required: true },
  { port: 8123, service: 'ClickHouse HTTP', required: true },
  { port: 9000, service: 'ClickHouse Native', required: true },
  { port: 6379, service: 'DragonflyDB/Redis', required: false },
  { port: 9095, service: 'Prometheus', required: false },
  { port: 3003, service: 'Grafana', required: false },
  { port: 6001, service: 'Worker API', required: true },
  { port: 5001, service: 'Web App', required: true },
  { port: 3000, service: 'Web Dashboard (alt)', required: false },
];

/**
 * Check if a specific port is available
 */
export async function isPortAvailable(port: number): Promise<boolean> {
  try {
    // Use lsof to check if port is in use (works on macOS and Linux)
    await execAsync(`lsof -i :${port}`);
    return false; // If lsof succeeds, port is in use
  } catch {
    return true; // If lsof fails, port is available
  }
}

/**
 * Get information about what process is using a port
 */
export async function getPortProcessInfo(port: number): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync(`lsof -i :${port} | grep LISTEN | head -1`);
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/**
 * Check a single port and return detailed result
 */
export async function checkPort(port: number, service: string): Promise<PortCheckResult> {
  const available = await isPortAvailable(port);
  const processInfo = available ? undefined : await getPortProcessInfo(port);

  return {
    port,
    service,
    available,
    processInfo,
  };
}

/**
 * Check multiple ports concurrently
 */
export async function checkPorts(ports: ServicePort[]): Promise<PortCheckResult[]> {
  return Promise.all(ports.map((p) => checkPort(p.port, p.service)));
}

/**
 * Check if all required ports are available
 */
export async function areRequiredPortsAvailable(
  ports: ServicePort[] = DEFAULT_PORTS
): Promise<{ available: boolean; conflicts: PortCheckResult[] }> {
  const results = await checkPorts(ports);
  const requiredPorts = ports.filter((p) => p.required);
  const conflicts = results.filter(
    (r) => !r.available && requiredPorts.some((p) => p.port === r.port)
  );

  return {
    available: conflicts.length === 0,
    conflicts,
  };
}
