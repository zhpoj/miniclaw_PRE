import { ModelRuntime, VERSION } from '@earendil-works/pi-coding-agent';

import {
  AgentEngineError,
  AgentRun,
  type AgentRunDefaults,
  type AgentRunRequest,
} from './run.js';

export const ENGINE_NAME = '@earendil-works/pi-coding-agent';

export interface AgentEngineOptions {
  /** Working directory used by runs that do not specify one. */
  cwd?: string;
  /** pi agent config directory (defaults to `~/.pi/agent`). */
  agentDir?: string;
  /** Tool allowlist used when a run does not specify one. */
  defaultTools?: string[];
  /** Persist pi sessions to disk instead of memory. */
  persistSessions?: boolean;
  /** Allow the model runtime to refresh catalogs over the network. */
  allowModelNetwork?: boolean;
}

export interface AgentEngineInfo {
  engine: string;
  version: string;
  cwd: string;
  defaultTools: string[];
  persistSessions: boolean;
  activeRuns: number;
  totalRuns: number;
}

/** Tool loadout used when none is requested: native shell per platform. */
export function defaultToolsForPlatform(platform: string = process.platform): string[] {
  const fromEnv = process.env['AGENT_TOOLS'];
  if (fromEnv) {
    const tools = fromEnv
      .split(',')
      .map((tool) => tool.trim())
      .filter((tool) => tool.length > 0);
    if (tools.length > 0) return tools;
  }
  return platform === 'win32'
    ? ['read', 'powershell', 'edit', 'write']
    : ['read', 'bash', 'edit', 'write'];
}

/**
 * Owns the shared pi `ModelRuntime` and the registry of active agent runs.
 */
export class AgentEngine {
  private readonly runs = new Map<string, AgentRun>();
  private readonly defaults: AgentRunDefaults;
  private readonly allowModelNetwork: boolean;
  private runtimePromise: Promise<ModelRuntime> | undefined;

  constructor(options: AgentEngineOptions = {}) {
    this.defaults = {
      cwd: options.cwd ?? process.cwd(),
      agentDir: options.agentDir,
      tools: options.defaultTools ?? defaultToolsForPlatform(),
      persistSessions: options.persistSessions ?? false,
    };
    this.allowModelNetwork = options.allowModelNetwork ?? false;
  }

  /** Lazily created, process-wide model/auth runtime. */
  getModelRuntime(): Promise<ModelRuntime> {
    this.runtimePromise ??= ModelRuntime.create(
      this.allowModelNetwork ? { allowModelNetwork: true } : {},
    );
    return this.runtimePromise;
  }

  getDefaults(): AgentRunDefaults {
    return { ...this.defaults };
  }

  async createRun(request: AgentRunRequest = {}): Promise<AgentRun> {
    const modelRuntime = await this.getModelRuntime();
    const run = await AgentRun.create(modelRuntime, request, this.defaults);
    this.runs.set(run.id, run);
    return run;
  }

  getRun(id: string): AgentRun | undefined {
    return this.runs.get(id);
  }

  requireRun(id: string): AgentRun {
    const run = this.runs.get(id);
    if (!run) {
      throw new AgentEngineError('run_not_found', `Unknown agent run: ${id}`, 404);
    }
    return run;
  }

  listRuns(): AgentRun[] {
    return [...this.runs.values()];
  }

  async closeRun(id: string): Promise<AgentRun | undefined> {
    const run = this.runs.get(id);
    if (!run) return undefined;
    this.runs.delete(id);
    run.close();
    return run;
  }

  async closeAll(): Promise<void> {
    const runs = [...this.runs.values()];
    this.runs.clear();
    for (const run of runs) {
      run.close();
    }
  }

  describe(): AgentEngineInfo {
    return {
      engine: ENGINE_NAME,
      version: VERSION,
      cwd: this.defaults.cwd,
      defaultTools: [...this.defaults.tools],
      persistSessions: this.defaults.persistSessions,
      activeRuns: [...this.runs.values()].filter((run) => run.isBusy).length,
      totalRuns: this.runs.size,
    };
  }
}

/** Engine configured from environment variables. */
export function createEngineFromEnv(): AgentEngine {
  const options: AgentEngineOptions = {
    allowModelNetwork: process.env['AGENT_ALLOW_MODEL_NETWORK'] === '1',
    persistSessions: process.env['AGENT_PERSIST_SESSIONS'] === '1',
  };
  const cwd = process.env['AGENT_CWD'];
  if (cwd) options.cwd = cwd;
  const agentDir = process.env['AGENT_DIR'];
  if (agentDir) options.agentDir = agentDir;
  return new AgentEngine(options);
}
