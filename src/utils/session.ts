import type { PluginInput } from '@opencode-ai/plugin';

export async function extractSessionText(
  client: PluginInput['client'],
  sessionId: string,
): Promise<string> {
  const result = await client.session.messages({ path: { id: sessionId } });
  const messages = (result.data ?? []) as Array<{
    info?: { role?: string };
    parts?: Array<{ type?: string; text?: string }>;
  }>;
  const texts: string[] = [];
  for (const m of messages) {
    if (m.info?.role !== 'assistant') continue;
    for (const p of m.parts ?? []) {
      if (p.type === 'text' && p.text) texts.push(p.text);
    }
  }
  return texts.join('\n\n');
}
