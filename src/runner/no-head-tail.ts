const HEAD_TAIL_PIPE_RE =
  /\s*\|\s*(head|tail)\s+(?:-n\s*|-)\d+(?=\s*(?:[;&\n#]|$))/g;

export interface StrippedPipe {
  pipe: string;
  name: string;
  count: number;
}

export interface StripResult {
  script: string;
  stripped: StrippedPipe[];
}

export function stripHeadTailPipes(script: string): StripResult {
  const stripped: StrippedPipe[] = [];
  let current = script;
  while (true) {
    let replaced = false;
    const next = current.replace(HEAD_TAIL_PIPE_RE, (match, name: string) => {
      const count = parseInt(/\d+/.exec(match)?.[0] ?? '0', 10);
      stripped.unshift({ pipe: match.trim(), name, count });
      replaced = true;
      return '';
    });
    if (!replaced) break;
    current = next;
  }
  return { script: current, stripped };
}
