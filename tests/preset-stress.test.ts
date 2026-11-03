// Stress tests for editing a preset block: run against every kind of block
// and preset Lumiverse allows (src/types/preset.ts PromptBlock, and the marker
// sets in prompt-assembly.service.ts), not against one example preset.
import { describe, expect, test } from 'bun:test';
import {
  MAX_PRESET_ATTEMPTS, blockNotes, editBlockContent, hasModesTag, pickableBlocks,
  withModesTag, withoutAddedModesTag, type PresetIO,
} from '../src/preset-blocks';

// Lumiverse's marker sets (prompt-assembly.service.ts).
const STRUCTURAL = ['chat_history', 'world_info_before', 'world_info_after', 'char_description',
  'char_personality', 'persona_description', 'scenario', 'dialogue_examples'];
const CONTENT_BEARING = ['main_prompt', 'enhance_definitions', 'jailbreak', 'nsfw_prompt'];

// A block with every field PromptBlock can hold, plus one Lumiverse may add later.
function fullBlock(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, name: `Block ${id}`, content: `Text of ${id}. {{user}} {{if::x}}y{{/if}}`,
    role: 'system', enabled: true, position: 'pre_history', depth: 0, marker: null,
    isLocked: true, color: '#abcdef', injectionTrigger: ['normal'], characterTagTrigger: ['elf'],
    group: 'g', categoryMode: null,
    variables: [{ id: 'v1', name: 'mood', type: 'text', default: 'calm' }],
    placementBinding: { kind: 'anchor', target: 'x' },
    sealed: false, sealedKey: 'k', sealedSource: 'lumihub', sealedOriginPresetId: 'o',
    sealedOriginVersion: '1', sealedSha256: 'abc',
    futureField: { nested: [1, 2, 3] },
    ...extra,
  };
}

// Stand-in for spindle.presets.get/update with Lumiverse's semantics: stored
// as given, saved only at the expected cache_revision, revision +1 per save.
function fakePresets(order: Array<Record<string, unknown>>) {
  const state = { order: JSON.parse(JSON.stringify(order)), revision: 7, deleted: false, saves: 0 };
  const hooks: { beforeSave?: () => void } = {};
  const io: PresetIO = {
    async get() {
      if (state.deleted) return null;
      return { prompt_order: JSON.parse(JSON.stringify(state.order)), cache_revision: state.revision };
    },
    async save(_id, promptOrder, expected) {
      hooks.beforeSave?.();
      if (state.deleted) return 'gone';
      if (expected !== state.revision) return 'conflict';
      state.order = JSON.parse(JSON.stringify(promptOrder));
      state.revision++;
      state.saves++;
      return 'ok';
    },
  };
  return { state, io, hooks };
}

describe('which blocks can be picked, for every marker Lumiverse has', () => {
  for (const marker of STRUCTURAL) {
    test(`placeholder "${marker}" is never offered`, () => {
      expect(pickableBlocks([{ id: 'a', name: 'a', content: '', marker }])).toEqual([]);
    });
  }
  for (const marker of [...CONTENT_BEARING, 'category']) {
    test(`text-bearing "${marker}" is offered`, () => {
      expect(pickableBlocks([{ id: 'a', name: 'a', content: '', marker }]).length).toBe(1);
    });
  }
  test('a regular block (marker null or missing) is offered', () => {
    expect(pickableBlocks([
      { id: 'a', name: 'a', content: '', marker: null }, { id: 'b', name: 'b', content: '' },
    ]).length).toBe(2);
  });
  test('an unknown marker is not offered (only markers known to send their text are)', () => {
    expect(pickableBlocks([{ id: 'a', name: 'a', content: '', marker: 'some_future_marker' }])).toEqual([]);
  });
  test('sealed LumiHub blocks are offered (their text is stored and sent locally)', () => {
    expect(pickableBlocks([{ id: 'a', name: 'a', content: 'text', sealed: true }]).length).toBe(1);
  });
  test('editing a sealed block keeps its sealed fields', async () => {
    const f = fakePresets([fullBlock('s', { sealed: true })]);
    expect(await editBlockContent(f.io, 'p', 's', withModesTag)).toBe('ok');
    const b = f.state.order[0];
    expect([b.sealed, b.sealedKey, b.sealedSource, b.sealedOriginPresetId, b.sealedOriginVersion, b.sealedSha256])
      .toEqual([true, 'k', 'lumihub', 'o', '1', 'abc']);
  });
  test('stashed blocks (shared across presets) are not offered', () => {
    expect(pickableBlocks([{ id: 'a', name: 'a', content: '', stashId: 's1' }])).toEqual([]);
    expect(pickableBlocks([{ id: 'a', name: 'a', content: '', stashId: '  ' }]).length).toBe(1);
  });
  test('broken entries in a block list do not crash', () => {
    expect(pickableBlocks([null as any, {} as any, { id: 5 } as any, { id: 'ok', name: 'x', content: '' }])
      .map((b) => b.id)).toEqual(['ok']);
  });
});

describe('notes shown for where a block is sent', () => {
  test('a plain system block before the chat has no notes', () => {
    expect(blockNotes({ id: 'a', name: 'a', content: '', role: 'system', position: 'pre_history', enabled: true })).toEqual([]);
  });
  test('every condition that changes where or whether it is sent is named', () => {
    expect(blockNotes({
      id: 'a', name: 'a', content: '', enabled: false, position: 'in_history', role: 'user_append',
      injectionTrigger: ['continue'], characterTagTrigger: ['elf'],
    })).toEqual([
      'off', 'inside the chat history', 'added onto a chat message',
      'only for some kinds of generation', 'only for some characters',
    ]);
    expect(blockNotes({ id: 'a', name: 'a', content: '', position: 'post_history', role: 'assistant' }))
      .toEqual(['after the chat history', 'sent as an assistant message']);
  });
});

describe('editing one block leaves everything else exactly as stored', () => {
  const order = [
    fullBlock('a'),
    fullBlock('b', { marker: 'main_prompt' }),
    fullBlock('c', { sealed: true }),
    fullBlock('d', { stashId: 'shared-1' }),
    fullBlock('e', { marker: 'category', categoryMode: 'radio' }),
  ];

  test('only the edited block\'s content changes; every field of every block is kept', async () => {
    const f = fakePresets(order);
    expect(await editBlockContent(f.io, 'p', 'b', withModesTag)).toBe('ok');
    const after = f.state.order;
    expect(after.length).toBe(order.length);
    for (let i = 0; i < order.length; i++) {
      if (order[i].id === 'b') {
        expect({ ...after[i], content: order[i].content }).toEqual(order[i]);
        expect(after[i].content).toBe(`${order[i].content}\n\n{{modes}}`);
      } else {
        expect(after[i]).toEqual(order[i]);
      }
    }
  });

  test('adding then removing gives the original block back', async () => {
    const f = fakePresets(order);
    await editBlockContent(f.io, 'p', 'a', withModesTag);
    await editBlockContent(f.io, 'p', 'a', withoutAddedModesTag);
    expect(f.state.order).toEqual(order);
  });

  test('no save at all when nothing would change', async () => {
    const f = fakePresets([fullBlock('a', { content: 'x {{modes}}' })]);
    expect(await editBlockContent(f.io, 'p', 'a', withModesTag)).toBe('unchanged');
    expect(f.state.saves).toBe(0);
  });
});

describe('the preset changing or disappearing at the same time', () => {
  test('a save by someone else in between is kept, and ours lands on top', async () => {
    const f = fakePresets([fullBlock('a'), fullBlock('b')]);
    let once = true;
    f.hooks.beforeSave = () => {
      if (!once) return;
      once = false;
      f.state.order[1].content = 'Edited by the user meanwhile.';
      f.state.revision++;
    };
    expect(await editBlockContent(f.io, 'p', 'a', withModesTag)).toBe('ok');
    expect(f.state.order[1].content).toBe('Edited by the user meanwhile.');
    expect(hasModesTag(f.state.order[0].content)).toBe(true);
  });

  test('if it keeps changing, it gives up with an error and writes nothing', async () => {
    const f = fakePresets([fullBlock('a')]);
    f.hooks.beforeSave = () => { f.state.revision++; };
    await expect(editBlockContent(f.io, 'p', 'a', withModesTag)).rejects.toThrow('kept changing');
    expect(f.state.saves).toBe(0);
    expect(f.state.revision).toBe(7 + MAX_PRESET_ATTEMPTS);
  });

  test('preset deleted before the read', async () => {
    const f = fakePresets([fullBlock('a')]);
    f.state.deleted = true;
    expect(await editBlockContent(f.io, 'p', 'a', withModesTag)).toBe('gone');
  });

  test('preset deleted between the read and the save', async () => {
    const f = fakePresets([fullBlock('a')]);
    f.hooks.beforeSave = () => { f.state.deleted = true; };
    expect(await editBlockContent(f.io, 'p', 'a', withModesTag)).toBe('gone');
  });

  test('block removed from the preset', async () => {
    const f = fakePresets([fullBlock('a')]);
    expect(await editBlockContent(f.io, 'p', 'zzz', withModesTag)).toBe('missing');
    expect(f.state.saves).toBe(0);
  });

  test('a block with no content field gets {{modes}} as its content', async () => {
    const f = fakePresets([{ id: 'a', name: 'a' }]);
    expect(await editBlockContent(f.io, 'p', 'a', withModesTag)).toBe('ok');
    expect(f.state.order[0]).toEqual({ id: 'a', name: 'a', content: '{{modes}}' });
  });
});

describe('block text of every shape', () => {
  const cases: Array<[string, string, string]> = [
    ['empty', '', '{{modes}}'],
    ['only spaces', '   \n  ', '{{modes}}'],
    ['ends with a newline', 'Rules.\n', 'Rules.\n\n{{modes}}'],
    ['Windows line endings', 'Line 1\r\nLine 2\r\n', 'Line 1\r\nLine 2\n\n{{modes}}'],
    ['ends with a closed condition', '{{if::x}}a{{/if}}', '{{if::x}}a{{/if}}\n\n{{modes}}'],
    ['ends with an XML-style tag', '<rules>\nx\n</rules>', '<rules>\nx\n</rules>\n\n{{modes}}'],
    ['contains backticks and braces', 'Use `<voice>` and {single}', 'Use `<voice>` and {single}\n\n{{modes}}'],
  ];
  for (const [label, input, expected] of cases) {
    test(`${label}: {{modes}} goes at the end, nothing before it changes`, () => {
      expect(withModesTag(input)).toBe(expected);
      expect(withModesTag(input).startsWith(input.replace(/\s+$/, ''))).toBe(true);
    });
  }
  for (const present of ['{{modes}}', '{{ modes }}', '{{MODES}}', 'a {{modes}} b']) {
    test(`already has "${present}": left alone, so the modes are never sent twice`, () => {
      expect(withModesTag(present)).toBe(present);
    });
  }
  test('removal only takes out what was added, never a {{modes}} the user wrote mid-text', () => {
    expect(withoutAddedModesTag('a {{modes}} b')).toBe('a {{modes}} b');
    expect(withoutAddedModesTag('Rules.\n\n{{modes}}')).toBe('Rules.');
  });
  test('very large block (1 MB) is handled', () => {
    const big = 'x'.repeat(1_000_000);
    expect(withModesTag(big).length).toBe(1_000_000 + '\n\n{{modes}}'.length);
  });
});
