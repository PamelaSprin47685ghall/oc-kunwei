import type { LocalMcpConfig, McpConfig, RemoteMcpConfig } from './types.js';

export { type LocalMcpConfig, type McpConfig, type RemoteMcpConfig } from './types.js';

export const stealthBrowserMcp: LocalMcpConfig = {
  type: 'local',
  command: [
    'uvx',
    '--python',
    '3.13',
    '--from',
    'git+https://github.com/vibheksoni/stealth-browser-mcp.git',
    'python',
    '-m',
    'server',
  ],
};

export function getMcpConfig(): Record<string, McpConfig> {
  return {
    'stealth-browser-mcp': stealthBrowserMcp,
  };
}
