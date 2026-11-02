import { describe, test, expect } from 'bun:test';
import {
  applyLumiScriptInjections,
  type PipelineMessage,
} from '../../../src/vendor/lumiscript/interceptor-pipeline.js';
import type { InjectionEntry } from '../../../src/vendor/lumiscript/injection-store.js';

// ─── Test fixtures ──────────────────────────────────────────────────────────

/** Tiny base array used as the host-assembled prompt in most tests. */
const BASE: PipelineMessage[] = [
  { role: 'system',    content: 'system prompt' },
  { role: 'user',      content: 'hello' },
  { role: 'assistant', content: 'hi there' },
  { role: 'user',      content: 'how are you?' },
];

/** Resolver used by tests: pretend-name = scriptId uppercased, except
 *  `unknown-script` which falls through to itself (matches the
 *  production fallback when `scriptStorage.getScript` returns null). */
function mockResolver(scriptId: string): string {
  if (scriptId === 'unknown-script') return scriptId;
  return scriptId.toUpperCase();
}

/** Build a context-mode injection entry. */
function ctxEntry(over: Partial<InjectionEntry> = {}): InjectionEntry {
  return {
    id:        'ctx-1',
    content:   '[context injection]',
    role:      'system',
    mode:      'context',
    depth:     0,
    ephemeral: false,
    scriptId:  'script-a',
    ...over,
  };
}

/** Build an intercept-mode injection entry. */
function intEntry(over: Partial<InjectionEntry> = {}): InjectionEntry {
  return {
    id:        'int-1',
    content:   '[intercept injection]',
    role:      'system',
    mode:      'intercept',
    depth:     1,
    ephemeral: false,
    scriptId:  'script-a',
    ...over,
  };
}

// ─── No-op (no injections) ──────────────────────────────────────────────────

describe('applyLumiScriptInjections — no injections', () => {
  test('returns the base messages unchanged when both lists are empty', () => {
    const out = applyLumiScriptInjections(BASE, [], [], mockResolver);
    expect(out.messages).toEqual(BASE);
    expect(out.breakdown).toEqual([]);
  });

  test('does not mutate the input array', () => {
    const base: PipelineMessage[] = [{ role: 'system', content: 'x' }];
    const baseCopy = base.map(m => ({ ...m }));
    applyLumiScriptInjections(base, [], [], mockResolver);
    expect(base).toEqual(baseCopy);
  });

  test('returned messages array is a fresh copy (caller can mutate safely)', () => {
    const out = applyLumiScriptInjections(BASE, [], [], mockResolver);
    expect(out.messages).not.toBe(BASE);
  });
});

// ─── Context-mode (prepend at index 0..N-1) ─────────────────────────────────

describe('applyLumiScriptInjections — context-mode', () => {
  test('prepends a single context entry at index 0', () => {
    const out = applyLumiScriptInjections(BASE, [ctxEntry()], [], mockResolver);
    expect(out.messages).toHaveLength(BASE.length + 1);
    expect(out.messages[0]).toEqual({ role: 'system', content: '[context injection]' });
    // Base messages shifted right by 1.
    expect(out.messages.slice(1)).toEqual(BASE);
  });

  test('emits a single breakdown entry pointing at index 0 with <scriptName>: <injectionId> label', () => {
    const out = applyLumiScriptInjections(BASE, [ctxEntry()], [], mockResolver);
    expect(out.breakdown).toEqual([{ messageIndex: 0, name: 'SCRIPT-A: ctx-1' }]);
  });

  test('multiple context entries prepend in input order at indices 0..N-1', () => {
    const entries = [
      ctxEntry({ id: 'ctx-1', content: 'first',  scriptId: 'script-a' }),
      ctxEntry({ id: 'ctx-2', content: 'second', scriptId: 'script-b' }),
      ctxEntry({ id: 'ctx-3', content: 'third',  scriptId: 'script-a' }),
    ];
    const out = applyLumiScriptInjections(BASE, entries, [], mockResolver);
    expect(out.messages.slice(0, 3).map(m => m.content)).toEqual(['first', 'second', 'third']);
    expect(out.breakdown).toEqual([
      { messageIndex: 0, name: 'SCRIPT-A: ctx-1' },
      { messageIndex: 1, name: 'SCRIPT-B: ctx-2' },
      { messageIndex: 2, name: 'SCRIPT-A: ctx-3' },
    ]);
  });

  test('context entries preserve their declared role', () => {
    const out = applyLumiScriptInjections(
      BASE,
      [
        ctxEntry({ id: 'a', role: 'system' }),
        ctxEntry({ id: 'b', role: 'user' }),
        ctxEntry({ id: 'c', role: 'assistant' }),
      ],
      [],
      mockResolver,
    );
    expect(out.messages.slice(0, 3).map(m => m.role)).toEqual(['system', 'user', 'assistant']);
  });
});

// ─── Intercept-mode (splice at depth from end) ──────────────────────────────

describe('applyLumiScriptInjections — intercept-mode', () => {
  test('splices a single entry at depth 1 (immediately before the last message)', () => {
    const out = applyLumiScriptInjections(BASE, [], [intEntry({ depth: 1 })], mockResolver);
    // Original [s, u, a, u] → splice at length-1=3 → [s, u, a, INJ, u]
    expect(out.messages.map(m => m.content)).toEqual([
      'system prompt', 'hello', 'hi there', '[intercept injection]', 'how are you?',
    ]);
    expect(out.breakdown).toEqual([{ messageIndex: 3, name: 'SCRIPT-A: int-1' }]);
  });

  test('splices at depth 0 (appends at the very end)', () => {
    const out = applyLumiScriptInjections(BASE, [], [intEntry({ depth: 0 })], mockResolver);
    expect(out.messages).toHaveLength(BASE.length + 1);
    expect(out.messages[out.messages.length - 1]!.content).toBe('[intercept injection]');
    expect(out.breakdown).toEqual([{ messageIndex: BASE.length, name: 'SCRIPT-A: int-1' }]);
  });

  test('depth larger than array length clamps to index 0 (prepends)', () => {
    const out = applyLumiScriptInjections(BASE, [], [intEntry({ depth: 999 })], mockResolver);
    expect(out.messages[0]!.content).toBe('[intercept injection]');
    expect(out.breakdown).toEqual([{ messageIndex: 0, name: 'SCRIPT-A: int-1' }]);
  });

  test('multiple intercept entries: later splice can shift earlier ones — breakdown reflects FINAL positions', () => {
    // Two intercept entries: depth=1 first, then depth=4.
    //
    // Step 1: BASE has length 4. depth=1 → splice at index 3 →
    //   [s, u, a, A, u]      (A = first injection, length 5)
    //
    // Step 2: length is now 5. depth=4 → splice at index 1 →
    //   [s, B, u, a, A, u]   (B = second injection, length 6)
    //
    // Critical: the FIRST injection moved from index 3 to index 4 due
    // to step 2's earlier splice. Walk-the-final-array index
    // computation must reflect that.
    const a = intEntry({ id: 'int-A', content: 'A', depth: 1, scriptId: 'script-a' });
    const b = intEntry({ id: 'int-B', content: 'B', depth: 4, scriptId: 'script-b' });
    const out = applyLumiScriptInjections(BASE, [], [a, b], mockResolver);

    expect(out.messages.map(m => m.content)).toEqual([
      'system prompt', 'B', 'hello', 'hi there', 'A', 'how are you?',
    ]);
    // Sort breakdown by messageIndex for deterministic comparison —
    // emission order follows array walk order (low → high index).
    expect(out.breakdown).toEqual([
      { messageIndex: 1, name: 'SCRIPT-B: int-B' },
      { messageIndex: 4, name: 'SCRIPT-A: int-A' },
    ]);
  });

  test('intercept entries preserve their declared role', () => {
    const out = applyLumiScriptInjections(
      BASE,
      [],
      [
        intEntry({ id: 'a', role: 'user',      depth: 0 }),
        intEntry({ id: 'b', role: 'assistant', depth: 0 }),
      ],
      mockResolver,
    );
    // Both spliced at depth=0 → second one ends up after the first.
    const tail = out.messages.slice(BASE.length);
    expect(tail.map(m => m.role)).toEqual(['user', 'assistant']);
  });
});

// ─── Mixed (context + intercept) ────────────────────────────────────────────

describe('applyLumiScriptInjections — mixed modes', () => {
  test('context entries always lead intercept entries in the breakdown', () => {
    const out = applyLumiScriptInjections(
      BASE,
      [ctxEntry({ id: 'c1', scriptId: 'script-a' })],
      [intEntry({ id: 'i1', depth: 1, scriptId: 'script-b' })],
      mockResolver,
    );
    // Final: [CTX, system, user, assistant, INT, user] — length 6
    //                                       ↑
    //                        intercept at length-1=4 (post context-prepend)
    expect(out.messages).toHaveLength(BASE.length + 2);
    expect(out.messages[0]!.content).toBe('[context injection]');
    expect(out.messages[4]!.content).toBe('[intercept injection]');
    expect(out.breakdown).toEqual([
      { messageIndex: 0, name: 'SCRIPT-A: c1' },
      { messageIndex: 4, name: 'SCRIPT-B: i1' },
    ]);
  });

  test('intercept depth is computed AFTER context-mode prepend (post-shift array length)', () => {
    // BASE length 4, then context prepends 1 → length 5; intercept
    // depth=1 splices at index 5-1=4 (NOT 4-1=3 as it would be without
    // the prepend). Sanity check that ordering matches the docstring.
    const out = applyLumiScriptInjections(
      BASE,
      [ctxEntry()],
      [intEntry({ depth: 1 })],
      mockResolver,
    );
    expect(out.messages.map(m => m.content)).toEqual([
      '[context injection]', 'system prompt', 'hello', 'hi there',
      '[intercept injection]', 'how are you?',
    ]);
  });
});

// ─── resolveScriptName fallback ─────────────────────────────────────────────

describe('applyLumiScriptInjections — script-name resolution', () => {
  test('falls back to the resolver\'s output for deleted scripts', () => {
    // Production resolver is `id => scriptStorage.getScript(id)?.name ?? id` —
    // mockResolver mimics this by returning the bare scriptId for
    // 'unknown-script' (simulating a script that's been deleted between
    // injection and interceptor run).
    const out = applyLumiScriptInjections(
      BASE,
      [],
      [intEntry({ id: 'orphan', scriptId: 'unknown-script', depth: 0 })],
      mockResolver,
    );
    expect(out.breakdown).toEqual([
      { messageIndex: BASE.length, name: 'unknown-script: orphan' },
    ]);
  });

  test('resolver is called once per injection, not per emitted breakdown row', () => {
    // Resolver may be expensive (storage hit) — assert each entry triggers
    // exactly one resolver invocation, no cache miss on the post-splice walk.
    const calls: string[] = [];
    const resolver = (id: string): string => {
      calls.push(id);
      return id.toUpperCase();
    };
    applyLumiScriptInjections(
      BASE,
      [
        ctxEntry({ id: 'a', scriptId: 'script-a' }),
        ctxEntry({ id: 'b', scriptId: 'script-b' }),
      ],
      [intEntry({ id: 'c', scriptId: 'script-c', depth: 0 })],
      resolver,
    );
    // Three injections → three resolver calls. The post-splice walk
    // reads the cached label from the WeakMap, not the resolver.
    expect(calls).toHaveLength(3);
    expect(calls.sort()).toEqual(['script-a', 'script-b', 'script-c']);
  });
});
