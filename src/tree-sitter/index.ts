/**
 * Tree-sitter syntax check hook — appends diagnostics to file edit/write
 * tool output. Works alongside LSP diagnostics for real-time syntax
 * verification.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { PluginInput } from '@opencode-ai/plugin';
import {
  checkSyntax,
  extractFilePath,
  formatSyntaxDiagnostics,
  hasSyntaxCheckMarker,
  isFileEditTool,
  type SyntaxCheckOk,
} from 'engine/tree-sitter';

interface ToolExecuteAfterInput {
  tool: string;
  args?: {
    path?: string;
    file_path?: string;
    filePath?: string;
    [key: string]: unknown;
  };
}

interface ToolExecuteAfterOutput {
  output?: unknown;
}

export function createSyntaxCheckHook(ctx: PluginInput) {
  return {
    'tool.execute.after': async (
      input: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput,
    ): Promise<void> => {
      if (!isFileEditTool(input.tool)) return;
      const current = output.output;
      if (typeof current !== 'string') return;
      if (hasSyntaxCheckMarker(current)) return;

      const filePath = extractFilePath(input.args);
      if (!filePath) return;

      let content: string;
      try {
        content = await fs.readFile(path.resolve(ctx.directory, filePath), 'utf-8');
      } catch {
        return;
      }

      const result = await checkSyntax(content, filePath);
      if (!result.ok || result.errors.length === 0) return;

      output.output = current + formatSyntaxDiagnostics(
        filePath,
        result as SyntaxCheckOk,
      );
    },
  };
}

export type { SyntaxCheckResult, SyntaxError } from 'engine/tree-sitter';
export { checkSyntax } from 'engine/tree-sitter';
