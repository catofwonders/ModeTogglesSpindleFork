// ===== Direct placement: Mode Toggles' own glue =====
// The splicing itself is LumiScript's tested code (src/vendor/lumiscript,
// MIT). This file only decides WHERE the modes go, by turning the Mode Toggles
// placement setting into LumiScript injection entries:
//   'top'            -> a context-mode entry (LumiScript prepends these at 0)
//   'depth'          -> an intercept-mode entry at that depth from the end
//   'before_history' -> an intercept-mode entry whose depth lands it right
//                       before the first chat-history message
// Pure: no Spindle calls, so it can be tested without a mock host.

import type { InjectionEntry } from './vendor/lumiscript/injection-store';

export type Placement = 'macro' | 'top' | 'before_history' | 'depth';

export const MODES_INJECTION_ID = 'modes';
export const MODES_SOURCE_ID = 'mode-toggles';

export interface PlacementMessage {
  role: string;
  __isChatHistory?: boolean;
}

export interface ModesEntries {
  context: InjectionEntry[];
  intercept: InjectionEntry[];
}

/** Index of the first chat-history message, or where history would start. */
export function historyStartIndex(messages: ReadonlyArray<PlacementMessage>): number {
  const first = messages.findIndex((m) => m.__isChatHistory === true);
  if (first >= 0) return first;
  // No tagged history (e.g. before the first message): after the opening
  // system block.
  const firstNonSystem = messages.findIndex((m) => m.role !== 'system');
  return firstNonSystem >= 0 ? firstNonSystem : messages.length;
}

export function buildModesEntries(
  messages: ReadonlyArray<PlacementMessage>,
  placement: Placement,
  depth: number,
  content: string,
): ModesEntries {
  const none: ModesEntries = { context: [], intercept: [] };
  if (placement === 'macro' || !content.trim()) return none;

  const base = {
    id: MODES_INJECTION_ID,
    content,
    role: 'system',
    ephemeral: false,
    scriptId: MODES_SOURCE_ID,
  };

  switch (placement) {
    case 'top':
      return { context: [{ ...base, mode: 'context', depth: 0 }], intercept: [] };
    case 'before_history':
      return {
        context: [],
        intercept: [{ ...base, mode: 'intercept', depth: messages.length - historyStartIndex(messages) }],
      };
    case 'depth':
      return { context: [], intercept: [{ ...base, mode: 'intercept', depth: Math.max(0, depth) }] };
    default:
      return none;
  }
}
