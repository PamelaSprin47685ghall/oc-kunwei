export interface RemoteMcpConfig {
  type: 'remote';
  url: string;
  headers?: Record<string, string>;
  oauth?: false;
}

export interface LocalMcpConfig {
  type: 'local';
  command: string[];
  environment?: Record<string, string>;
}

export type McpConfig = RemoteMcpConfig | LocalMcpConfig;
