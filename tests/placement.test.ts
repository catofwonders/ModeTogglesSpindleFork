// Tests for Mode Toggles' own placement glue, run through LumiScript's
// pipeline exactly as the backend does.
import { describe, test, expect } from 'bun:test';
import { buildModesEntries, historyStartIndex } from '../src/placement';
import { applyLumiScriptInjections } from '../src/vendor/lumiscript/interceptor-pipeline';

const PROMPT = [
  { role: 'system' as const, content: 'CONTRACT' },
  { role: 'system' as const, content: 'PERSONA' },
  { role: 'assistant' as const, content: 'old reply', __isChatHistory: true },
  { role: 'user' as const, content: 'my message', __isChatHistory: true },
];

function place(placement: any, depth = 2, prompt: any[] = PROMPT) {
  const e = buildModesEntries(prompt, placement, depth, 'MODES');
  return applyLumiScriptInjections(prompt, e.context, e.intercept, () => 'Mode Toggles');
}
const contents = (r: { messages: any[] }) => r.messages.map((m) => m.content);

describe('buildModesEntries + LumiScript pipeline', () => {
  test('macro placement injects nothing', () => {
    const r = place('macro');
    expect(contents(r)).toEqual(['CONTRACT', 'PERSONA', 'old reply', 'my message']);
    expect(r.breakdown).toEqual([]);
  });

  test('empty content injects nothing', () => {
    const e = buildModesEntries(PROMPT, 'top', 2, '   ');
    expect(e.context.length + e.intercept.length).toBe(0);
  });

  test('top goes first, with a breakdown row', () => {
    const r = place('top');
    expect(contents(r)).toEqual(['MODES', 'CONTRACT', 'PERSONA', 'old reply', 'my message']);
    expect(r.breakdown).toEqual([{ messageIndex: 0, name: 'Mode Toggles: modes' }]);
  });

  test('before_history goes right before the first history message', () => {
    const r = place('before_history');
    expect(contents(r)).toEqual(['CONTRACT', 'PERSONA', 'MODES', 'old reply', 'my message']);
    expect(r.breakdown[0].messageIndex).toBe(2);
  });

  test('before_history without tagged history goes after the opening system block', () => {
    const untagged = PROMPT.map(({ role, content }) => ({ role, content }));
    expect(historyStartIndex(untagged)).toBe(2);
    expect(contents(place('before_history', 2, untagged))).toEqual(['CONTRACT', 'PERSONA', 'MODES', 'old reply', 'my message']);
  });

  test('before_history with only system messages goes at the end', () => {
    const sys = PROMPT.slice(0, 2);
    expect(contents(place('before_history', 2, sys))).toEqual(['CONTRACT', 'PERSONA', 'MODES']);
  });

  test('depth 0 appends after everything', () => {
    expect(contents(place('depth', 0)).at(-1)).toBe('MODES');
  });

  test('depth 2 lands two messages from the end', () => {
    expect(contents(place('depth', 2))).toEqual(['CONTRACT', 'PERSONA', 'MODES', 'old reply', 'my message']);
  });

  test('a depth past the start clamps to the top', () => {
    expect(contents(place('depth', 99))[0]).toBe('MODES');
  });

  test('original messages keep their history flags and are not mutated', () => {
    const r = place('top');
    expect((r.messages[3] as any).__isChatHistory).toBe(true);
    expect(PROMPT.length).toBe(4);
  });
});
