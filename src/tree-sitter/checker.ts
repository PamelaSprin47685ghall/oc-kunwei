import { createRequire } from 'node:module';
import { extname } from 'node:path';

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

let wasmPack: any = null;

async function ensureWasmPack() {
  if (wasmPack) return wasmPack;

  const require = createRequire(import.meta.url);
  const Module = require('node:module');
  const originalRequire = Module.prototype.require;

  const memoryHolder = { buffer: new ArrayBuffer(0) };
  const getMemoryView = () => new Uint8Array(memoryHolder.buffer);

  const envMock = {
    strcmp: (str1Ptr: number, str2Ptr: number) => {
      const mem = getMemoryView();
      let i = 0;
      while (true) {
        const char1 = mem[str1Ptr + i];
        const char2 = mem[str2Ptr + i];
        if (char1 !== char2) return char1 - char2;
        if (char1 === 0) return 0;
        i++;
      }
    },
    memchr: (ptr: number, character: number, num: number) => {
      const mem = getMemoryView();
      const target = character & 0xff;
      for (let i = 0; i < num; i++) {
        if (mem[ptr + i] === target) return ptr + i;
      }
      return 0;
    },
    iswlower: (wc: number) => {
      try {
        const char = String.fromCodePoint(wc);
        return char === char.toLowerCase() && char !== char.toUpperCase() ? 1 : 0;
      } catch {
        return 0;
      }
    },
    iswupper: (wc: number) => {
      try {
        const char = String.fromCodePoint(wc);
        return char === char.toUpperCase() && char !== char.toLowerCase() ? 1 : 0;
      } catch {
        return 0;
      }
    },
    iswxdigit: (wc: number) => {
      return (wc >= 48 && wc <= 57) || (wc >= 97 && wc <= 102) || (wc >= 65 && wc <= 70) ? 1 : 0;
    },
    towlower: (wc: number) => {
      try {
        const char = String.fromCodePoint(wc);
        return char.toLowerCase().codePointAt(0) || wc;
      } catch {
        return wc;
      }
    }
  };

  // Intercept import of 'env'
  Module.prototype.require = function(id: string) {
    if (id === 'env') {
      return envMock;
    }
    return originalRequire.apply(this, arguments);
  };

  const OriginalInstance = WebAssembly.Instance;
  // @ts-ignore
  WebAssembly.Instance = function (module, importObject) {
    const instance = new OriginalInstance(module, importObject);
    if (instance.exports && instance.exports.memory) {
      memoryHolder.buffer = (instance.exports.memory as WebAssembly.Memory).buffer;
    }
    return instance;
  };

  try {
    wasmPack = await import('@kreuzberg/tree-sitter-language-pack-wasm');
  } finally {
    // Restore original Node API to avoid pollution
    Module.prototype.require = originalRequire;
    WebAssembly.Instance = OriginalInstance;
  }

  return wasmPack;
}

export async function checkSyntax(
  content: string,
  filePath: string,
): Promise<SyntaxCheckResult> {
  try {
    const pack = await ensureWasmPack();
    const lang = pack.detectLanguageFromPath(filePath);
    if (!lang) {
      return { ok: false, reason: `unsupported language: ${filePath}` };
    }

    const parser = pack.WasmParser.default();
    parser.setLanguage(lang);

    const tree = parser.parse(content);
    if (!tree) {
      return { ok: false, reason: 'failed to parse tree content' };
    }

    function findErrors(node: any): any[] {
      const list: any[] = [];
      if (node.isError() || node.isMissing()) {
        list.push(node);
      }
      const count = node.childCount();
      for (let i = 0; i < count; i++) {
        const child = node.child(i);
        if (child) {
          list.push(...findErrors(child));
        }
      }
      return list;
    }

    const errorNodes = findErrors(tree.rootNode());

    const errors: SyntaxError[] = errorNodes.map((node) => {
      let message = 'Syntax error';
      if (node.isMissing()) {
        message = `Missing: ${node.kind()}`;
      }
      const start = node.startPosition();
      const end = node.endPosition();
      return {
        line: start.row + 1,
        column: start.column + 1,
        endLine: end.row + 1,
        endColumn: end.column + 1,
        severity: 'error',
        message,
      };
    });

    return {
      ok: true,
      lang,
      errors,
    };
  } catch (err) {
    return {
      ok: false,
      reason: `parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
