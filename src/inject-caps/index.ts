import { buildCapitalsContext, type CapsFileInfo, findCapsFiles } from 'engine/caps';

export { findCapsFiles, buildCapitalsContext, type CapsFileInfo };

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
