import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';

/** Where the agent actually executes: on the host machine or inside a container. */
export type ExecutionMode = 'host' | 'container';

export interface WorkspaceConfig {
  mode: ExecutionMode;
  /** Workspace path as seen by the host machine. Null when running in container mode. */
  hostPath: string | null;
  /** Workspace path inside the container. */
  containerPath: string;
  /** Working directory that is actually in effect for the current mode. */
  activePath: string;
}

export const DEFAULT_CONTAINER_WORKSPACE = '/workspace';

/** Whether the workspace directory that is actually in effect exists. */
export function workspaceExists(workspace: WorkspaceConfig): boolean {
  try {
    return statSync(workspace.activePath).isDirectory();
  } catch {
    return false;
  }
}

/** Best-effort detection of a container runtime (Docker creates `/.dockerenv`). */
export function isContainerRuntime(): boolean {
  return existsSync('/.dockerenv');
}

export function resolveExecutionMode(env: NodeJS.ProcessEnv = process.env): ExecutionMode {
  const raw = env['AGENT_EXEC_MODE']?.trim().toLowerCase();
  if (raw === 'host' || raw === 'container') return raw;
  return isContainerRuntime() ? 'container' : 'host';
}

/**
 * Resolves the workspace from the environment.
 * - `AGENT_EXEC_MODE`: `host` | `container`, auto-detected when unset
 * - `AGENT_WORKSPACE_HOST`: host-side workspace path (used for path mapping)
 * - `AGENT_WORKSPACE_CONTAINER`: container-side workspace path, defaults to `/workspace`
 * - `AGENT_CWD`: explicit working directory, wins over the mode default
 */
export function resolveWorkspace(
  env: NodeJS.ProcessEnv = process.env,
  fallbackCwd: string = process.cwd(),
): WorkspaceConfig {
  const mode = resolveExecutionMode(env);
  const containerPath = env['AGENT_WORKSPACE_CONTAINER']?.trim() || DEFAULT_CONTAINER_WORKSPACE;
  const explicitCwd = env['AGENT_CWD']?.trim();
  const hostPath = env['AGENT_WORKSPACE_HOST']?.trim() || null;

  const activePath =
    explicitCwd ||
    (mode === 'container' ? containerPath : (hostPath ?? fallbackCwd));

  return {
    mode,
    hostPath: hostPath ?? (mode === 'host' ? (explicitCwd ?? fallbackCwd) : null),
    containerPath,
    activePath,
  };
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

function isSubPath(parent: string, child: string): boolean {
  const normalizedParent = toPosix(parent).replace(/\/+$/, '').toLowerCase();
  const normalizedChild = toPosix(child).toLowerCase();
  return (
    normalizedChild === normalizedParent ||
    normalizedChild.startsWith(`${normalizedParent}/`)
  );
}

/**
 * Translates a requested working directory into the path space of the active mode.
 * Host paths are mapped into the container (and vice versa) when they fall inside
 * the workspace; anything else is passed through untouched.
 */
export function mapWorkspacePath(target: string, workspace: WorkspaceConfig): string {
  const containerSide = workspace.mode === 'container';
  // Cross-mode mapping runs before the absolute check: a `D:/...` host path is not
  // absolute inside a Linux container, but still belongs to the workspace.
  if (containerSide && workspace.hostPath && isSubPath(workspace.hostPath, target)) {
    const rest = posix.relative(toPosix(workspace.hostPath), toPosix(target));
    return posix.join(toPosix(workspace.containerPath), rest);
  }

  if (!containerSide && workspace.hostPath && isSubPath(workspace.containerPath, target)) {
    return join(workspace.hostPath, relative(workspace.containerPath, target));
  }

  if (!isAbsolute(target)) {
    return containerSide
      ? posix.join(toPosix(workspace.activePath), toPosix(target))
      : resolve(workspace.activePath, target);
  }

  return target;
}

/** Tool loadout per execution mode: containers get `bash`, Windows hosts get `powershell`. */
export function defaultToolsForMode(
  mode: ExecutionMode,
  platform: string = process.platform,
): string[] {
  const fromEnv = process.env['AGENT_TOOLS'];
  if (fromEnv) {
    const tools = fromEnv
      .split(',')
      .map((tool) => tool.trim())
      .filter((tool) => tool.length > 0);
    if (tools.length > 0) return tools;
  }
  return mode === 'container' || platform !== 'win32'
    ? ['read', 'bash', 'edit', 'write']
    : ['read', 'powershell', 'edit', 'write'];
}
