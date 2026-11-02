// Runs the real backend against an in-memory stand-in for Lumiverse's
// extension API (only the calls Mode Toggles uses), and drives it the way the
// drawer and Lumiverse do.
import { beforeAll, describe, expect, test } from 'bun:test';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(20);

type Block = { id: string; name: string; content: string; enabled: boolean; marker: string | null; sealed?: boolean };

const files = new Map<string, string>();
const chats = new Map<string, Record<string, unknown>>();
const presets = new Map<string, { id: string; name: string; blocks: Block[] }>();
const listeners = new Map<string, (payload: any, userId?: string) => void>();
const sent: any[] = [];
const toasts: string[] = [];
let frontendHandler: (payload: any, userId?: string) => Promise<void>;
let macroHandler: (ctx: any) => Promise<string>;
let activeChat: string | null = 'c1';

function emit(event: string, payload: any) {
  listeners.get(event)?.(payload, 'u1');
}

const spindle = {
  storage: {
    async getJson(path: string, opts: { fallback: unknown }) {
      return files.has(path) ? JSON.parse(files.get(path)!) : opts.fallback;
    },
    async setJson(path: string, value: unknown) { files.set(path, JSON.stringify(value)); },
    async read(path: string) {
      if (!files.has(path)) throw new Error('missing');
      return files.get(path)!;
    },
  },
  chats: {
    async get(id: string) {
      const m = chats.get(id);
      return m ? { id, character_id: 'ch', name: id, metadata: { ...m }, created_at: 0, updated_at: 0 } : null;
    },
    async getActive() { return activeChat ? spindle.chats.get(activeChat) : null; },
    async update(id: string, input: { metadata: Record<string, unknown> }) {
      if (!chats.has(id)) throw new Error('Chat not found');
      chats.set(id, { ...input.metadata });
      emit('CHAT_CHANGED', { chat: { id } });
      return spindle.chats.get(id);
    },
    // Like Lumiverse: replace only if the stored metadata still equals expected_metadata.
    async compareAndSetMetadata(id: string, input: { expected_metadata: unknown; metadata: Record<string, unknown> }) {
      const current = chats.get(id);
      if (!current) return null;
      if (JSON.stringify(current) !== JSON.stringify(input.expected_metadata)) return null;
      return spindle.chats.update(id, { metadata: input.metadata });
    },
    async list({ limit, offset }: { limit: number; offset: number }) {
      const all = Array.from(chats.entries()).map(([id, metadata]) => ({ id, metadata: { ...metadata } }));
      return { data: all.slice(offset, offset + limit), total: all.length };
    },
  },
  presets: {
    async list() {
      const data = Array.from(presets.values()).map((p) => ({ id: p.id, name: p.name }));
      return { data, total: data.length };
    },
    blocks: {
      async list(presetId: string) {
        const p = presets.get(presetId);
        if (!p) throw new Error('Preset not found');
        return p.blocks.map((b) => ({ ...b }));
      },
      async update(presetId: string, blockId: string, input: Partial<Block>) {
        const p = presets.get(presetId)!;
        const b = p.blocks.find((x) => x.id === blockId);
        if (!b) throw new Error('Prompt block not found');
        Object.assign(b, input);
        // Lumiverse fires PRESET_CHANGED on every preset save.
        setTimeout(() => emit('PRESET_CHANGED', { id: presetId }), 0);
        return { ...b };
      },
    },
  },
  registerMacro(def: any) { macroHandler = def.handler; },
  on(event: string, handler: any) { listeners.set(event, handler); return () => {}; },
  onFrontendMessage(handler: any) { frontendHandler = handler; },
  sendToFrontend(payload: any) { sent.push(payload); },
  toast: {
    info: (m: string) => toasts.push(m), success: (m: string) => toasts.push(m),
    warning: (m: string) => toasts.push(m), error: (m: string) => toasts.push(m),
  },
  log: { info() {}, warn() {}, error() {} },
  permissions: { onDenied() {} },
};

async function send(payload: any) {
  await frontendHandler({ chatId: activeChat, ...payload }, 'u1');
  await settle();
}
const lastState = () => [...sent].reverse().find((p) => p.type === 'state_update');
const config = () => JSON.parse(files.get('config.json') ?? '{}');

beforeAll(async () => {
  // A 1.1.0 config: old per-chat states for c1 (exists), c2 (exists) and
  // gone (deleted chat), plus the removed position settings.
  files.set('config.json', JSON.stringify({
    enabled: true, loadCoreModes: true, sortMode: 'group',
    modeOverrides: {
      'Power 0: Rules': { description: 'Rules for {{user}}.', group: 'Powers' },
      'Power 1: Flight': { description: 'Can fly.', group: 'Powers' },
      'Old Name': { description: 'Renamed later.', group: 'Misc' },
    },
    chatStates: {
      c1: { 'Power 0: Rules': { status: 'ON' } },
      c2: { 'Old Name': { status: 'ON' } },
      gone: { 'Power 1: Flight': { status: 'ON' } },
    },
    presets: {},
    placement: 'top', depth: 2, framing: '[Setting rules]\n{{modes}}',
  }));
  chats.set('c1', { chat_variables: { mood: 'calm' } });
  chats.set('c2', {});
  presets.set('p1', {
    id: 'p1', name: 'Any Preset',
    blocks: [
      { id: 'b-main', name: 'Main Instructions', content: 'Be a narrator.', enabled: true, marker: null },
      { id: 'b-hist', name: 'Chat History', content: '', enabled: true, marker: 'chat_history' },
      { id: 'b-seal', name: 'Sealed', content: '', enabled: true, marker: null, sealed: true },
    ],
  });
  (globalThis as any).spindle = spindle;
  await import('../src/backend');
  await sleep(50);
});

describe('moving per-chat modes out of config.json', () => {
  test('old entries are moved into their chats, and the deleted chat is dropped', () => {
    expect(chats.get('c1')).toEqual({ chat_variables: { mood: 'calm' }, mode_toggles: ['Power 0: Rules'] });
    expect(chats.get('c2')).toEqual({ mode_toggles: ['Old Name'] });
    expect(config().chatStates).toEqual({});
  });
  test('the removed 1.1.0 position settings are gone from config.json', () => {
    expect(config().placement).toBeUndefined();
    expect(config().depth).toBeUndefined();
    expect(config().framing).toBe('[Setting rules]\n{{modes}}');
  });
});

describe('toggling', () => {
  test('writes only to the chat, not config.json', async () => {
    const before = files.get('config.json');
    await send({ type: 'toggle_mode', modeName: 'Power 1: Flight' });
    expect(chats.get('c1')!.mode_toggles).toEqual(['Power 0: Rules', 'Power 1: Flight']);
    expect(chats.get('c1')!.chat_variables).toEqual({ mood: 'calm' });
    expect(files.get('config.json')).toBe(before);
  });
  test('the drawer sees the chat\'s modes', () => {
    const on = lastState().modes.filter((m: any) => m.status === 'ON').map((m: any) => m.name);
    expect(on.sort()).toEqual(['Power 0: Rules', 'Power 1: Flight']);
  });
});

describe('{{modes}}', () => {
  test('outputs the chat\'s modes inside the framing', async () => {
    expect(await macroHandler({ chatId: 'c1' })).toBe('[Setting rules]\nRules for {{user}}. Can fly.');
  });
  test('each chat gets its own modes', async () => {
    expect(await macroHandler({ chatId: 'c2' })).toBe('[Setting rules]\nRenamed later.');
  });
  test('a chat with no modes gets nothing', async () => {
    chats.set('c3', {});
    expect(await macroHandler({ chatId: 'c3' })).toBe('');
  });
});

describe('keeping {{modes}} in a preset block', () => {
  test('only blocks that can hold text are offered', async () => {
    await send({ type: 'list_blocks', presetId: 'p1' });
    const list = [...sent].reverse().find((p) => p.type === 'blocks_list');
    expect(list.blocks.map((b: any) => b.id)).toEqual(['b-main']);
  });
  test('picking a block adds {{modes}} to its end', async () => {
    await send({ type: 'set_preset_block', presetId: 'p1', blockId: 'b-main', presetName: 'Any Preset' });
    expect(presets.get('p1')!.blocks[0].content).toBe('Be a narrator.\n\n{{modes}}');
    expect(config().presetBlocks).toEqual({
      p1: { blockId: 'b-main', blockName: 'Main Instructions', presetName: 'Any Preset' },
    });
    expect(lastState().presetBlocks).toEqual([{ presetId: 'p1', presetName: 'Any Preset', blockName: 'Main Instructions' }]);
  });
  test('the preset changing again does not add a second {{modes}}', async () => {
    emit('PRESET_CHANGED', { id: 'p1' });
    await settle();
    expect(presets.get('p1')!.blocks[0].content).toBe('Be a narrator.\n\n{{modes}}');
  });
  test('an update that overwrites the block (new id) gets {{modes}} back', async () => {
    const p = presets.get('p1')!;
    p.blocks[0] = { id: 'b-main-v2', name: 'Main Instructions', content: 'Be a narrator, v2.', enabled: true, marker: null };
    emit('PRESET_CHANGED', { id: 'p1' });
    await settle();
    expect(p.blocks[0].content).toBe('Be a narrator, v2.\n\n{{modes}}');
    expect(config().presetBlocks.p1.blockId).toBe('b-main-v2');
  });
  test('removing the choice takes {{modes}} back out', async () => {
    await send({ type: 'clear_preset_block', presetId: 'p1' });
    expect(presets.get('p1')!.blocks[0].content).toBe('Be a narrator, v2.');
    expect(config().presetBlocks).toEqual({});
    emit('PRESET_CHANGED', { id: 'p1' });
    await settle();
    expect(presets.get('p1')!.blocks[0].content).toBe('Be a narrator, v2.');
  });
});

describe('changes that touch every chat', () => {
  test('an import that renames a mode carries it over in every chat', async () => {
    await send({
      type: 'import_modes', mode: 'replace',
      text: 'New Name - Misc - Renamed later.',
    });
    expect(chats.get('c2')!.mode_toggles).toEqual(['New Name']);
  });
  test('deleting a custom mode removes it from every chat', async () => {
    await send({ type: 'delete_mode', name: 'Power 1: Flight' });
    expect(chats.get('c1')!.mode_toggles).toEqual(['Power 0: Rules']);
  });
  test('a deleted chat takes its modes with it', async () => {
    chats.delete('c2');
    emit('CHAT_DELETED', { id: 'c2' });
    expect(await macroHandler({ chatId: 'c2' })).toBe('');
  });
});

describe('undo', () => {
  test('Disable All then Undo restores the chat\'s modes in the chat', async () => {
    await send({ type: 'disable_all' });
    expect(chats.get('c1')!.mode_toggles).toBeUndefined();
    await send({ type: 'undo_last' });
    expect(chats.get('c1')!.mode_toggles).toEqual(['Power 0: Rules']);
  });
});

describe('without the chat_mutation permission', () => {
  test('toggles still save, and the user is told to grant it', async () => {
    const real = spindle.chats.compareAndSetMetadata;
    (spindle.chats as any).compareAndSetMetadata = async () => {
      throw new Error('Permission denied: chat_mutation — Chat mutation permission not granted');
    };
    try {
      await send({ type: 'toggle_mode', modeName: 'New Name' });
      expect(chats.get('c1')!.mode_toggles).toEqual(['Power 0: Rules', 'New Name']);
      expect(toasts.some((t) => t.includes('chat_mutation'))).toBe(true);
    } finally {
      (spindle.chats as any).compareAndSetMetadata = real;
    }
  });
});
