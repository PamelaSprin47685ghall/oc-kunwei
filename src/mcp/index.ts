import type { LocalMcpConfig, McpConfig, RemoteMcpConfig } from './types.js';

export { type LocalMcpConfig, type McpConfig, type RemoteMcpConfig } from './types.js';

const STEALTH_BROWSER_MCP_REPO = 'https://github.com/vibheksoni/stealth-browser-mcp.git';
const STEALTH_BROWSER_MCP_REF = process.env.STEALTH_BROWSER_MCP_REF ?? 'master';

export const stealthBrowserMcp: LocalMcpConfig = {
  type: 'local',
  command: [
    'uvx',
    '--python',
    '3.13',
    '--from',
    `git+${STEALTH_BROWSER_MCP_REPO}@${STEALTH_BROWSER_MCP_REF}`,
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
