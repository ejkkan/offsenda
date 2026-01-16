import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export type DevMode = 'k8s' | 'docker' | 'simple';

export interface Tool {
  name: string;
  command: string;
  installCmd: string;
}

export interface DockerContainer {
  name: string;
  status: string;
  ports: string;
  image: string;
}

export interface K8sPod {
  name: string;
  status: string;
  namespace: string;
}

const REQUIRED_K8S_TOOLS: Tool[] = [
  {
    name: 'kubectl',
    command: 'kubectl version --client',
    installCmd: 'brew install kubectl',
  },
  {
    name: 'k3d',
    command: 'k3d version',
    installCmd: 'brew install k3d',
  },
  {
    name: 'skaffold',
    command: 'skaffold version',
    installCmd: 'brew install skaffold',
  },
];

/**
 * Check if a command exists
 */
async function commandExists(command: string): Promise<boolean> {
  try {
    await execAsync(`command -v ${command}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a tool is installed
 */
async function isToolInstalled(tool: Tool): Promise<boolean> {
  try {
    await execAsync(tool.command);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect if K8s tools are available
 */
export async function detectK8sTools(): Promise<{
  available: boolean;
  missing: Tool[];
}> {
  const results = await Promise.all(
    REQUIRED_K8S_TOOLS.map(async (tool) => ({
      tool,
      installed: await isToolInstalled(tool),
    }))
  );

  const missing = results.filter((r) => !r.installed).map((r) => r.tool);

  return {
    available: missing.length === 0,
    missing,
  };
}

/**
 * Get list of running Docker containers
 */
export async function getDockerContainers(): Promise<DockerContainer[]> {
  try {
    const { stdout } = await execAsync(
      'docker ps --format "{{.Names}}|{{.Status}}|{{.Ports}}|{{.Image}}"'
    );

    return stdout
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name, status, ports, image] = line.split('|');
        return { name, status, ports, image };
      });
  } catch {
    return [];
  }
}

/**
 * Check if Docker is running
 */
export async function isDockerRunning(): Promise<boolean> {
  try {
    await execAsync('docker info');
    return true;
  } catch {
    return false;
  }
}

/**
 * Start Docker Compose services
 */
export async function startDockerCompose(
  composeFile: string = 'docker-compose.local.yml',
  services: string[] = []
): Promise<void> {
  const serviceArgs = services.length > 0 ? services.join(' ') : '';
  await execAsync(`docker compose -f ${composeFile} up -d ${serviceArgs}`);
}

/**
 * Stop Docker Compose services
 */
export async function stopDockerCompose(
  composeFile: string = 'docker-compose.local.yml'
): Promise<void> {
  await execAsync(`docker compose -f ${composeFile} down --remove-orphans`);
}

/**
 * Check if k3d cluster exists
 */
export async function k3dClusterExists(name: string = 'batchsender'): Promise<boolean> {
  try {
    const { stdout } = await execAsync('k3d cluster list');
    return stdout.includes(name);
  } catch {
    return false;
  }
}

/**
 * Get K8s pods in namespace
 */
export async function getK8sPods(namespace: string = 'batchsender'): Promise<K8sPod[]> {
  try {
    const { stdout } = await execAsync(
      `kubectl get pods -n ${namespace} -o custom-columns=NAME:.metadata.name,STATUS:.status.phase --no-headers`
    );

    return stdout
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name, status] = line.trim().split(/\s+/);
        return { name, status, namespace };
      });
  } catch {
    return [];
  }
}

/**
 * Check if kubectl can connect to a cluster
 */
export async function canConnectToK8s(): Promise<boolean> {
  try {
    await execAsync('kubectl cluster-info');
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect current development mode
 */
export async function detectMode(): Promise<DevMode> {
  // Check if K8s cluster is running
  const k8sAvailable = await canConnectToK8s();
  if (k8sAvailable) {
    return 'k8s';
  }

  // Don't auto-choose k8s mode just because tools are installed
  // Only use k8s if cluster is already running
  // Otherwise default to Docker mode which is simpler

  // Fall back to Docker mode
  const dockerAvailable = await isDockerRunning();
  if (dockerAvailable) {
    return 'docker';
  }

  // Fall back to simple mode
  return 'simple';
}

/**
 * Get BatchSender-related Docker containers
 */
export async function getBatchSenderContainers(): Promise<DockerContainer[]> {
  const containers = await getDockerContainers();
  return containers.filter(
    (c) =>
      c.name.includes('batchsender') ||
      c.name.includes('nats') ||
      c.name.includes('clickhouse') ||
      c.name.includes('postgres') ||
      c.name.includes('dragonfly') ||
      c.name.includes('grafana') ||
      c.name.includes('prometheus')
  );
}

/**
 * Stop all BatchSender services (Docker and K8s)
 */
export async function stopAllServices(): Promise<void> {
  // Stop Docker Compose services
  try {
    await stopDockerCompose('docker-compose.local.yml');
  } catch {
    // Ignore errors
  }

  try {
    await stopDockerCompose('docker-compose.monitoring.yml');
  } catch {
    // Ignore errors
  }

  // If K8s cluster exists, optionally delete it (commented out for safety)
  // const clusterExists = await k3dClusterExists();
  // if (clusterExists) {
  //   await execAsync('k3d cluster delete batchsender');
  // }
}
