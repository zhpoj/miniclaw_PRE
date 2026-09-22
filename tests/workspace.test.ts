import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  defaultToolsForMode,
  mapWorkspacePath,
  resolveWorkspace,
  workspaceExists,
  type WorkspaceConfig,
} from '../src/agent/workspace.js';

const HOST_WORKSPACE = 'D:/code/my-project';

const containerWorkspace: WorkspaceConfig = {
  mode: 'container',
  hostPath: HOST_WORKSPACE,
  containerPath: '/workspace',
  activePath: '/workspace',
};

const hostWorkspace: WorkspaceConfig = {
  mode: 'host',
  hostPath: HOST_WORKSPACE,
  containerPath: '/workspace',
  activePath: HOST_WORKSPACE,
};

afterEach(() => {
  delete process.env['AGENT_EXEC_MODE'];
  delete process.env['AGENT_WORKSPACE_HOST'];
  delete process.env['AGENT_WORKSPACE_CONTAINER'];
  delete process.env['AGENT_CWD'];
  delete process.env['AGENT_TOOLS'];
});

describe('resolveWorkspace', () => {
  it('defaults to host mode using the process cwd', () => {
    const workspace = resolveWorkspace({}, '/repo');

    expect(workspace.mode).toBe('host');
    expect(workspace.activePath).toBe('/repo');
    expect(workspace.hostPath).toBe('/repo');
  });

  it('uses the container workspace in container mode', () => {
    const workspace = resolveWorkspace({ AGENT_EXEC_MODE: 'container' }, '/app');

    expect(workspace.mode).toBe('container');
    expect(workspace.activePath).toBe('/workspace');
    expect(workspace.containerPath).toBe('/workspace');
  });

  it('keeps both sides of the mapping available', () => {
    const workspace = resolveWorkspace(
      {
        AGENT_EXEC_MODE: 'container',
        AGENT_WORKSPACE_HOST: HOST_WORKSPACE,
        AGENT_WORKSPACE_CONTAINER: '/srv',
      },
      '/app',
    );

    expect(workspace).toEqual({
      mode: 'container',
      hostPath: HOST_WORKSPACE,
      containerPath: '/srv',
      activePath: '/srv',
    });
  });

  it('lets AGENT_CWD win over the mode default', () => {
    const workspace = resolveWorkspace({ AGENT_CWD: '/tmp/x' }, '/repo');

    expect(workspace.activePath).toBe('/tmp/x');
  });
});

describe('mapWorkspacePath', () => {
  it('maps a host path into the container', () => {
    expect(mapWorkspacePath(`${HOST_WORKSPACE}/packages/app`, containerWorkspace)).toBe(
      '/workspace/packages/app',
    );
  });

  it('maps a host path even when it is not absolute in the container', () => {
    expect(mapWorkspacePath(`${HOST_WORKSPACE}/packages/app`, containerWorkspace)).toBe(
      '/workspace/packages/app',
    );
  });

  it('leaves host paths untouched in host mode', () => {
    expect(mapWorkspacePath(`${HOST_WORKSPACE}/packages/app`, hostWorkspace)).toBe(
      `${HOST_WORKSPACE}/packages/app`,
    );
  });

  it('leaves container paths untouched in container mode', () => {
    expect(mapWorkspacePath('/workspace/packages/app', containerWorkspace)).toBe(
      '/workspace/packages/app',
    );
  });

  it('maps a container path back onto the host', () => {
    expect(mapWorkspacePath('/workspace/packages/app', hostWorkspace)).toBe(
      join(HOST_WORKSPACE, 'packages', 'app'),
    );
  });

  it('resolves relative paths against the active path', () => {
    expect(mapWorkspacePath('packages/app', containerWorkspace)).toBe('/workspace/packages/app');
  });
});

describe('workspaceExists', () => {
  it('reports whether the active workspace directory exists', () => {
    expect(workspaceExists({ ...hostWorkspace, activePath: process.cwd() })).toBe(true);
    expect(workspaceExists({ ...hostWorkspace, activePath: '/definitely/not/here' })).toBe(false);
  });
});

describe('defaultToolsForMode', () => {
  it('uses bash in container mode', () => {
    expect(defaultToolsForMode('container', 'win32')).toEqual(['read', 'bash', 'edit', 'write']);
  });

  it('uses the platform shell in host mode', () => {
    expect(defaultToolsForMode('host', 'win32')).toEqual(['read', 'powershell', 'edit', 'write']);
    expect(defaultToolsForMode('host', 'linux')).toEqual(['read', 'bash', 'edit', 'write']);
  });

  it('respects an explicit AGENT_TOOLS override', () => {
    process.env['AGENT_TOOLS'] = 'read,grep';

    expect(defaultToolsForMode('container', 'linux')).toEqual(['read', 'grep']);
  });
});
