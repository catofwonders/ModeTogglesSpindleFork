import { describe, expect, test } from 'bun:test';
import {
  applyFraming, findAssignedBlock, hasModesTag, pickableBlocks, withModesTag, withoutAddedModesTag,
} from '../src/preset-blocks';

describe('withModesTag', () => {
  test('adds {{modes}} after a blank line at the end', () => {
    expect(withModesTag('Main rules.')).toBe('Main rules.\n\n{{modes}}');
  });
  test('trims trailing whitespace before adding', () => {
    expect(withModesTag('Main rules.\n\n  \n')).toBe('Main rules.\n\n{{modes}}');
  });
  test('empty block becomes just {{modes}}', () => {
    expect(withModesTag('')).toBe('{{modes}}');
  });
  test('leaves a block that already has {{modes}} unchanged, wherever it is', () => {
    expect(withModesTag('A {{modes}} B')).toBe('A {{modes}} B');
    expect(withModesTag('A {{ Modes }} B')).toBe('A {{ Modes }} B');
  });
});

describe('withoutAddedModesTag', () => {
  test('removes exactly what withModesTag added', () => {
    expect(withoutAddedModesTag(withModesTag('Main rules.'))).toBe('Main rules.');
  });
  test('leaves a {{modes}} in the middle alone', () => {
    expect(withoutAddedModesTag('A {{modes}} B')).toBe('A {{modes}} B');
  });
});

test('hasModesTag', () => {
  expect(hasModesTag('x {{modes}} y')).toBe(true);
  expect(hasModesTag('x {{mode}} y')).toBe(false);
  expect(hasModesTag('')).toBe(false);
});

describe('pickableBlocks', () => {
  const blocks = [
    { id: 'a', name: 'Main', content: '', marker: null },
    { id: 'b', name: 'Chat History', content: '', marker: 'chat_history' },
    { id: 'c', name: 'Header', content: 'text', marker: 'category' },
    { id: 'd', name: 'Sealed', content: '', marker: null, sealed: true },
    { id: 'e', name: 'Old', content: '' },
  ];
  test('keeps regular blocks and category headers, drops markers and sealed blocks', () => {
    expect(pickableBlocks(blocks).map((b) => b.id)).toEqual(['a', 'c', 'e']);
  });
});

describe('findAssignedBlock', () => {
  const blocks = [
    { id: 'new-1', name: 'Contract', content: '', marker: null },
    { id: 'x', name: 'Style', content: '', marker: null },
    { id: 'y', name: 'Style', content: '', marker: null },
  ];
  test('finds by id', () => {
    expect(findAssignedBlock(blocks, { blockId: 'x', blockName: 'whatever' })?.id).toBe('x');
  });
  test('falls back to the name when an update changed the id', () => {
    expect(findAssignedBlock(blocks, { blockId: 'old-1', blockName: 'Contract' })?.id).toBe('new-1');
  });
  test('gives up when the name matches more than one block', () => {
    expect(findAssignedBlock(blocks, { blockId: 'gone', blockName: 'Style' })).toBeNull();
  });
  test('gives up when nothing matches', () => {
    expect(findAssignedBlock(blocks, { blockId: 'gone', blockName: 'Nope' })).toBeNull();
  });
});

describe('applyFraming', () => {
  test('no modes: nothing, framing included', () => {
    expect(applyFraming('', '[Rules]\n{{modes}}')).toBe('');
  });
  test('no framing: the modes alone', () => {
    expect(applyFraming('M1\n\nM2', '   ')).toBe('M1\n\nM2');
  });
  test('modes go where {{modes}} is in the framing', () => {
    expect(applyFraming('M1', '[Rules for {{user}}]\n{{modes}}\n[End]')).toBe('[Rules for {{user}}]\nM1\n[End]');
  });
  test('framing without {{modes}}: modes follow it', () => {
    expect(applyFraming('M1', '[Rules]')).toBe('[Rules]\nM1');
  });
  test('$ in a mode description is kept literally', () => {
    expect(applyFraming('costs $1 and $&', '{{modes}}')).toBe('costs $1 and $&');
  });
});
