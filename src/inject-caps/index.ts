import fs from 'node:fs/promises';
import path from 'node:path';

const CAPS_FILE_RE = /^[A-Z][A-Z0-9_]*\.md$/;
const CAPS_DIR_RE = /^[A-Z][A-Z0-9_]*$/;
const EXCLUDED_FILE_NAMES = new Set(['AGENTS.md', 'CLAUDE.md', 'README.md']);
const EXCLUDED_DIR_NAMES = new Set(['AGENTS', 'CLAUDE', 'NODE_MODULES']);
const MAX_FILE_SIZE = 1_048_576;

export interface CapsFileInfo {
  filePath: string;
  label: string;
  content: string;
}

export async function findCapsFiles(
  projectRoot: string,
): Promise<CapsFileInfo[]> {
  const results: CapsFileInfo[] = [];

  let rootEntries: import('node:fs').Dirent[];
  try {
    rootEntries = await fs.readdir(projectRoot, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of rootEntries) {
    const fullPath = path.join(projectRoot, entry.name);

    if (
      entry.isFile() &&
      CAPS_FILE_RE.test(entry.name) &&
      !EXCLUDED_FILE_NAMES.has(entry.name)
    ) {
      const info = await tryReadFile(fullPath, entry.name);
      if (info) results.push(info);
    }

    if (
      entry.isDirectory() &&
      CAPS_DIR_RE.test(entry.name) &&
      !EXCLUDED_DIR_NAMES.has(entry.name)
    ) {
      const dirFiles = await discoverFilesInDir(fullPath);
      for (const filePath of dirFiles) {
        const info = await tryReadFile(
          filePath,
          path.relative(projectRoot, filePath),
        );
        if (info) results.push(info);
      }
    }
  }

  results.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return results;
}

async function tryReadFile(
  filePath: string,
  label: string,
): Promise<CapsFileInfo | undefined> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return undefined;
    if (stat.size > MAX_FILE_SIZE) return undefined;
    const content = await fs.readFile(filePath, 'utf-8');
    if (!content.trim()) return undefined;
    return { filePath, label, content };
  } catch {
    return undefined;
  }
}

async function discoverFilesInDir(dirPath: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isFile()) {
        files.push(fullPath);
      } else if (entry.isDirectory()) {
        files.push(...(await discoverFilesInDir(fullPath)));
      }
    }
  } catch {
    // skip unreadable directories
  }
  return files;
}

export async function buildCapitalsContext(
  projectRoot: string,
): Promise<string> {
  const files = await findCapsFiles(projectRoot);
  if (files.length === 0) return '';

  const parts: string[] = [];
  for (const file of files) {
    parts.push(
      `<caps-context file="${escapeXmlAttribute(file.label)}">\n${file.content}\n</caps-context>`,
    );
  }
  return parts.join('\n\n');
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export interface CapitalsContextHook {
  handleSystemTransform: (
    input: { sessionID?: string },
    output: { system: string[] },
  ) => Promise<void>;
}

export function createCapitalsContextHook(
  projectRoot: string,
): CapitalsContextHook {
  let cachedPromise: Promise<string> | null = null;

  return {
    async handleSystemTransform(
      _input: { sessionID?: string },
      output: { system: string[] },
    ): Promise<void> {
      if (cachedPromise === null) {
        cachedPromise = buildCapitalsContext(projectRoot);
      }
      const context = await cachedPromise;
      if (!context) return;

      const marker = '<caps-context';
      if (
        output.system.some((s) => typeof s === 'string' && s.includes(marker))
      )
        return;

      output.system.unshift(context);
    },
  };
}
