export interface SyntaxError {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: string;
  message: string;
}

export interface SyntaxCheckOk {
  ok: true;
  lang: string;
  errors: SyntaxError[];
}

export interface SyntaxCheckFail {
  ok: false;
  reason: string;
}

export type SyntaxCheckResult = SyntaxCheckOk | SyntaxCheckFail;

interface WasmTree {
  rootNode(): WasmNode;
}

interface WasmNode {
  isError(): boolean;
  isMissing(): boolean;
  kind(): string;
  startPosition(): { row: number; column: number };
  endPosition(): { row: number; column: number };
  childCount(): number;
  child(index: number): WasmNode | null;
}

interface WasmParser {
  setLanguage(name: string): void;
  parse(source: string): WasmTree | undefined;
}

interface WasmPack {
  detectLanguageFromPath(path: string): string | undefined;
  getParser(name: string): WasmParser;
}

interface ShimMemory {
  buffer: ArrayBuffer;
}

const shimMemory: ShimMemory = { buffer: new ArrayBuffer(0) };

function memU8(): Uint8Array {
  return new Uint8Array(shimMemory.buffer);
}

function memView(): DataView {
  return new DataView(shimMemory.buffer);
}

function readCString(ptr: number): string {
  const u8 = memU8();
  let end = ptr;
  while (u8[end] !== 0) end++;
  return new TextDecoder().decode(u8.subarray(ptr, end));
}

const envShim = {
  strcmp(a: number, b: number): number {
    const u8 = memU8();
    let i = 0;
    while (true) {
      const ca = u8[a + i];
      const cb = u8[b + i];
      if (ca !== cb) return ca - cb;
      if (ca === 0) return 0;
      i++;
    }
  },
  memchr(ptr: number, value: number, num: number): number {
    const u8 = memU8();
    const target = value & 0xff;
    for (let i = 0; i < num; i++) {
      if (u8[ptr + i] === target) return ptr + i;
    }
    return 0;
  },
  memcpy(dest: number, src: number, num: number): number {
    const u8 = memU8();
    u8.copyWithin(dest, src, src + num);
    return dest;
  },
  memmove(dest: number, src: number, num: number): number {
    const u8 = memU8();
    const tmp = u8.subarray(src, src + num);
    u8.set(tmp, dest);
    return dest;
  },
  memset(ptr: number, value: number, num: number): number {
    const u8 = memU8();
    u8.fill(value & 0xff, ptr, ptr + num);
    return ptr;
  },
  strlen(ptr: number): number {
    const u8 = memU8();
    let len = 0;
    while (u8[ptr + len] !== 0) len++;
    return len;
  },
  iswlower(wc: number): number {
    try {
      const c = String.fromCodePoint(wc);
      return c === c.toLowerCase() && c !== c.toUpperCase() ? 1 : 0;
    } catch {
      return 0;
    }
  },
  iswupper(wc: number): number {
    try {
      const c = String.fromCodePoint(wc);
      return c === c.toUpperCase() && c !== c.toLowerCase() ? 1 : 0;
    } catch {
      return 0;
    }
  },
  iswxdigit(wc: number): number {
    return (wc >= 48 && wc <= 57) || (wc >= 97 && wc <= 102) || (wc >= 65 && wc <= 70) ? 1 : 0;
  },
  towlower(wc: number): number {
    try {
      return String.fromCodePoint(wc).toLowerCase().codePointAt(0) ?? wc;
    } catch {
      return wc;
    }
  },
  emscripten_notify_memory_growth(_index: number): void {},
  __indirect_function_table: new WebAssembly.Table({
    initial: 0,
    element: 'anyfunc',
  }),
};

let packPromise: Promise<WasmPack> | null = null;

async function loadPackWithShim(): Promise<WasmPack> {
  const { createRequire } = await import('node:module');
  const Module = createRequire(import.meta.url)('node:module') as {
    prototype: { require: (id: string) => unknown };
  };
  const originalRequire = Module.prototype.require;
  const originalInstance = WebAssembly.Instance;

  Module.prototype.require = function (id: string) {
    if (id === 'env') return envShim;
    return originalRequire.call(this, id);
  };

  WebAssembly.Instance = function (
    module: WebAssembly.Module,
    importObject?: WebAssembly.Imports,
  ) {
    const instance = new originalInstance(module, importObject);
    const memory = (instance.exports as { memory?: WebAssembly.Memory }).memory;
    const isTarget = importObject &&
      (importObject.env === envShim ||
       (importObject.env && (importObject.env as any).strcmp === envShim.strcmp));
    if (memory && isTarget) shimMemory.buffer = memory.buffer;
    return instance;
  } as unknown as typeof WebAssembly.Instance;

  try {
    const mod = (await import(
      '@kreuzberg/tree-sitter-language-pack-wasm'
    )) as unknown as WasmPack;
    return mod;
  } finally {
    Module.prototype.require = originalRequire;
    WebAssembly.Instance = originalInstance;
  }
}

async function getPack(): Promise<WasmPack> {
  if (!packPromise) packPromise = loadPackWithShim();
  return packPromise;
}

function findErrorNodes(node: WasmNode): WasmNode[] {
  const out: WasmNode[] = [];
  if (node.isError() || node.isMissing()) {
    out.push(node);
    return out;
  }
  const count = node.childCount();
  for (let i = 0; i < count; i++) {
    const child = node.child(i);
    if (child) out.push(...findErrorNodes(child));
  }
  return out;
}

export async function checkSyntax(
  content: string,
  filePath: string,
): Promise<SyntaxCheckResult> {
  let pack: WasmPack;
  try {
    pack = await getPack();
  } catch (err) {
    return {
      ok: false,
      reason: `failed to load wasm pack: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const lang = pack.detectLanguageFromPath(filePath);
  if (!lang) return { ok: false, reason: `unsupported language: ${filePath}` };

  const parser = pack.getParser(lang);
  try {
    parser.setLanguage(lang);
  } catch (err) {
    return {
      ok: false,
      reason: `setLanguage failed for ${lang}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const tree = parser.parse(content);
    if (!tree) return { ok: false, reason: 'parser returned undefined tree' };

    const errors: SyntaxError[] = findErrorNodes(tree.rootNode()).map(
      (node) => {
        const start = node.startPosition();
        const end = node.endPosition();
        return {
          line: start.row + 1,
          column: start.column + 1,
          endLine: end.row + 1,
          endColumn: end.column + 1,
          severity: 'error',
          message: node.isMissing() ? `Missing: ${node.kind()}` : node.kind(),
        };
      },
    );

    return { ok: true, lang, errors };
  } catch (err) {
    return {
      ok: false,
      reason: `parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
