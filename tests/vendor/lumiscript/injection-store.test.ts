import { describe, test, expect, beforeEach } from 'bun:test';
import {
  addInjection,
  removeInjection,
  clearByScriptId,
  clearEphemeral,
  clearAll,
  listAll,
  listByMode,
  listByScriptId,
  type InjectionEntry,
} from '../../../src/vendor/lumiscript/injection-store.js';

// clearAll is also called by setup.ts preload, but explicit for clarity
beforeEach(() => clearAll());

/** Helper to create an InjectionEntry with defaults. */
function entry(overrides?: Partial<InjectionEntry>): InjectionEntry {
  return {
    id: 'inj-1',
    content: 'test content',
    mode: 'intercept',
    role: 'system',
    depth: 0,
    ephemeral: false,
    scriptId: 'script-1',
    ...overrides,
  };
}

// ─── addInjection ────────────────────────────────────────────────────────────

describe('addInjection', () => {
  test('stores an entry that is retrievable via listAll()', () => {
    addInjection(entry());
    expect(listAll()).toHaveLength(1);
    expect(listAll()[0]!.id).toBe('inj-1');
  });

  test('overwrites an existing entry with the same id (size does not grow)', () => {
    addInjection(entry({ content: 'v1' }));
    addInjection(entry({ content: 'v2' }));
    expect(listAll()).toHaveLength(1);
    expect(listAll()[0]!.content).toBe('v2');
  });

  test('throws when content exceeds 32 KB character limit', () => {
    const big = entry({ content: 'x'.repeat(32 * 1024 + 1) });
    expect(() => addInjection(big)).toThrow('content too large');
  });

  test('throws when adding a 51st unique entry', () => {
    for (let i = 0; i < 50; i++) {
      addInjection(entry({ id: `inj-${i}` }));
    }
    expect(() => addInjection(entry({ id: 'inj-50' }))).toThrow('limit reached');
  });

  test('allows overwriting at the 50-entry limit', () => {
    for (let i = 0; i < 50; i++) {
      addInjection(entry({ id: `inj-${i}` }));
    }
    // Overwriting an existing entry should NOT throw
    expect(() => addInjection(entry({ id: 'inj-0', content: 'updated' }))).not.toThrow();
    expect(listAll()).toHaveLength(50);
  });
});

// ─── removeInjection ─────────────────────────────────────────────────────────

describe('removeInjection', () => {
  test('removes an injection by id', () => {
    addInjection(entry());
    removeInjection('inj-1');
    expect(listAll()).toHaveLength(0);
  });

  test('is a no-op for a non-existent id', () => {
    addInjection(entry());
    removeInjection('nonexistent');
    expect(listAll()).toHaveLength(1);
  });
});

// ─── clearByScriptId ─────────────────────────────────────────────────────────

describe('clearByScriptId', () => {
  test('removes all injections with a matching scriptId', () => {
    addInjection(entry({ id: 'a', scriptId: 'script-1' }));
    addInjection(entry({ id: 'b', scriptId: 'script-1' }));
    addInjection(entry({ id: 'c', scriptId: 'script-2' }));

    clearByScriptId('script-1');

    expect(listAll()).toHaveLength(1);
    expect(listAll()[0]!.scriptId).toBe('script-2');
  });

  test('does not remove injections belonging to a different scriptId', () => {
    addInjection(entry({ id: 'a', scriptId: 'script-2' }));
    clearByScriptId('script-1');
    expect(listAll()).toHaveLength(1);
  });

  test('is a safe no-op for an unknown scriptId', () => {
    addInjection(entry());
    expect(() => clearByScriptId('unknown')).not.toThrow();
    expect(listAll()).toHaveLength(1);
  });
});

// ─── clearEphemeral ──────────────────────────────────────────────────────────

describe('clearEphemeral', () => {
  test('removes ephemeral injections of the specified mode', () => {
    addInjection(entry({ id: 'a', mode: 'intercept', ephemeral: true }));
    addInjection(entry({ id: 'b', mode: 'intercept', ephemeral: false }));
    addInjection(entry({ id: 'c', mode: 'context', ephemeral: true }));

    clearEphemeral('intercept');

    expect(listAll()).toHaveLength(2);
    expect(listAll().find(e => e.id === 'a')).toBeUndefined(); // removed
    expect(listAll().find(e => e.id === 'b')).toBeDefined();   // non-ephemeral kept
    expect(listAll().find(e => e.id === 'c')).toBeDefined();   // different mode kept
  });

  test('does not remove non-ephemeral injections', () => {
    addInjection(entry({ id: 'a', mode: 'intercept', ephemeral: false }));
    clearEphemeral('intercept');
    expect(listAll()).toHaveLength(1);
  });

  test('does not remove ephemeral injections of a different mode', () => {
    addInjection(entry({ id: 'a', mode: 'context', ephemeral: true }));
    clearEphemeral('intercept');
    expect(listAll()).toHaveLength(1);
  });
});

// ─── clearAll ────────────────────────────────────────────────────────────────

describe('clearAll', () => {
  test('removes every injection', () => {
    addInjection(entry({ id: 'a', scriptId: 'script-1' }));
    addInjection(entry({ id: 'b', scriptId: 'script-2', mode: 'context', ephemeral: true }));
    clearAll();
    expect(listAll()).toHaveLength(0);
  });
});

// ─── listAll ─────────────────────────────────────────────────────────────────

describe('listAll', () => {
  test('returns a snapshot array of all entries', () => {
    addInjection(entry({ id: 'a' }));
    addInjection(entry({ id: 'b' }));
    const all = listAll();
    expect(all).toHaveLength(2);
  });

  test('returns an empty array when the store is empty', () => {
    expect(listAll()).toEqual([]);
  });
});

// ─── listByMode ──────────────────────────────────────────────────────────────

describe('listByMode', () => {
  test('returns only entries with the specified mode', () => {
    addInjection(entry({ id: 'a', mode: 'intercept' }));
    addInjection(entry({ id: 'b', mode: 'context' }));
    addInjection(entry({ id: 'c', mode: 'intercept' }));

    const intercepts = listByMode('intercept');
    expect(intercepts).toHaveLength(2);
    expect(intercepts.every(e => e.mode === 'intercept')).toBe(true);
  });

  test('returns empty array when no entries match', () => {
    addInjection(entry({ mode: 'intercept' }));
    expect(listByMode('context')).toEqual([]);
  });
});

// ─── listByScriptId ──────────────────────────────────────────────────────────

describe('listByScriptId', () => {
  test('returns only entries belonging to the given scriptId', () => {
    addInjection(entry({ id: 'a', scriptId: 'script-1' }));
    addInjection(entry({ id: 'b', scriptId: 'script-2' }));
    addInjection(entry({ id: 'c', scriptId: 'script-1' }));

    const results = listByScriptId('script-1');
    expect(results).toHaveLength(2);
    expect(results.every(e => e.scriptId === 'script-1')).toBe(true);
  });

  test('returns empty array for an unknown scriptId', () => {
    addInjection(entry());
    expect(listByScriptId('unknown')).toEqual([]);
  });
});
