import { describe, expect, test } from 'bun:test';
import {
  ChatModeStore, MAX_SAVE_ATTEMPTS, METADATA_KEY, createWriteQueue, type ChatIO, type ChatModes,
} from '../src/chat-store';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// In-memory stand-in for Lumiverse chats. Writes behave like
// compareAndSetMetadata: metadata is replaced in full, but only if it still
// equals what the caller read. `beforeWrite` lets a test change the chat
// between the read and the write, like Lumiverse saving something meanwhile.
function fakeChats(initial: Record<string, Record<string, unknown>>, writeDelay = 0) {
  const chats = new Map(Object.entries(initial).map(([k, v]) => [k, { ...v }]));
  const log: string[] = [];
  let active = 0;
  let maxActive = 0;
  const hooks: { beforeWrite?: (chatId: string) => void } = {};
  const io: ChatIO = {
    async read(chatId) {
      const m = chats.get(chatId);
      return m ? JSON.parse(JSON.stringify(m)) : null;
    },
    async write(chatId, metadata, expected) {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(writeDelay);
      hooks.beforeWrite?.(chatId);
      try {
        const current = chats.get(chatId);
        if (!current) return 'gone';
        if (JSON.stringify(current) !== JSON.stringify(expected)) return 'conflict';
        chats.set(chatId, { ...metadata });
        log.push(chatId);
        return 'ok';
      } finally {
        active--;
      }
    },
  };
  return { chats, io, log, hooks, maxActive: () => maxActive };
}

describe('ChatModeStore', () => {
  test('loads the names stored in the chat', async () => {
    const f = fakeChats({ c1: { [METADATA_KEY]: ['A', 'B'] } });
    const store = new ChatModeStore(f.io);
    expect(Object.keys(await store.load('c1'))).toEqual(['A', 'B']);
  });

  test('saves only its own key and keeps everything else in the chat', async () => {
    const f = fakeChats({ c1: { chat_variables: { x: '1' } } });
    const store = new ChatModeStore(f.io);
    await store.load('c1');
    store.edit('c1')['A'] = { status: 'ON' };
    // Lumiverse changes another key before the save runs.
    f.chats.get('c1')!.chat_variables = { x: '2' };
    await store.save('c1');
    expect(f.chats.get('c1')).toEqual({ chat_variables: { x: '2' }, [METADATA_KEY]: ['A'] });
  });

  test('a change made between the read and the write is kept, not overwritten', async () => {
    const f = fakeChats({ c1: { chat_variables: { x: '1' } } });
    const store = new ChatModeStore(f.io);
    (await store.load('c1'))['A'] = { status: 'ON' };
    let once = true;
    f.hooks.beforeWrite = (id) => {
      if (once) { once = false; f.chats.get(id)!.chat_variables = { x: '2' }; }
    };
    await store.save('c1');
    expect(f.chats.get('c1')).toEqual({ chat_variables: { x: '2' }, [METADATA_KEY]: ['A'] });
  });

  test('gives up with an error, writing nothing, if the chat keeps changing', async () => {
    const f = fakeChats({ c1: { n: 0 } });
    const store = new ChatModeStore(f.io);
    (await store.load('c1'))['A'] = { status: 'ON' };
    f.hooks.beforeWrite = (id) => { (f.chats.get(id)!.n as number)++; };
    await expect(store.save('c1')).rejects.toThrow('kept changing');
    expect(f.chats.get('c1')![METADATA_KEY]).toBeUndefined();
    expect(f.chats.get('c1')!.n).toBe(MAX_SAVE_ATTEMPTS);
  });

  test('a chat deleted between the read and the write is forgotten', async () => {
    const f = fakeChats({ c1: {} });
    const store = new ChatModeStore(f.io);
    (await store.load('c1'))['A'] = { status: 'ON' };
    f.hooks.beforeWrite = (id) => { f.chats.delete(id); };
    await store.save('c1');
    expect(store.isLoaded('c1')).toBe(false);
  });

  test('removes its key when no modes are on', async () => {
    const f = fakeChats({ c1: { [METADATA_KEY]: ['A'], other: true } });
    const store = new ChatModeStore(f.io);
    const modes = await store.load('c1');
    delete modes['A'];
    await store.save('c1');
    expect(f.chats.get('c1')).toEqual({ other: true });
  });

  test('saves for one chat run one at a time and the last state wins', async () => {
    const f = fakeChats({ c1: {} }, 5);
    const store = new ChatModeStore(f.io);
    const modes = await store.load('c1');
    modes['A'] = { status: 'ON' };
    const s1 = store.save('c1');
    modes['B'] = { status: 'ON' };
    const s2 = store.save('c1');
    await Promise.all([s1, s2]);
    expect(f.maxActive()).toBe(1);
    expect(f.chats.get('c1')![METADATA_KEY]).toEqual(['A', 'B']);
  });

  test('a failed save does not stop the next one', async () => {
    const f = fakeChats({ c1: {} });
    let fail = true;
    const io: ChatIO = {
      read: f.io.read,
      async write(id, m, expected) {
        if (fail) { fail = false; throw new Error('boom'); }
        return f.io.write(id, m, expected);
      },
    };
    const store = new ChatModeStore(io);
    const modes = await store.load('c1');
    modes['A'] = { status: 'ON' };
    const s1 = store.save('c1');
    const s2 = store.save('c1');
    await expect(s1).rejects.toThrow('boom');
    await s2;
    expect(f.chats.get('c1')![METADATA_KEY]).toEqual(['A']);
  });

  test('moves an old config.json entry into the chat once', async () => {
    const f = fakeChats({ c1: { other: 1 } });
    const legacy: Record<string, ChatModes> = { c1: { A: { status: 'ON' } } };
    const moved: string[] = [];
    const store = new ChatModeStore(f.io, (id) => legacy[id], (id) => { moved.push(id); delete legacy[id]; });
    expect(Object.keys(await store.load('c1'))).toEqual(['A']);
    expect(f.chats.get('c1')).toEqual({ other: 1, [METADATA_KEY]: ['A'] });
    expect(moved).toEqual(['c1']);
  });

  test('an old entry for a chat that already has its own modes is a leftover', async () => {
    const f = fakeChats({ c1: { [METADATA_KEY]: ['B'] } });
    const legacy: Record<string, ChatModes> = { c1: { A: { status: 'ON' } } };
    const moved: string[] = [];
    const store = new ChatModeStore(f.io, (id) => legacy[id], (id) => moved.push(id));
    expect(Object.keys(await store.load('c1'))).toEqual(['B']);
    expect(moved).toEqual(['c1']);
  });

  test('an old entry for a deleted chat is dropped', async () => {
    const f = fakeChats({});
    const legacy: Record<string, ChatModes> = { gone: { A: { status: 'ON' } } };
    const moved: string[] = [];
    const store = new ChatModeStore(f.io, (id) => legacy[id], (id) => moved.push(id));
    expect(await store.load('gone')).toEqual({});
    expect(moved).toEqual(['gone']);
    expect(f.log).toEqual([]);
  });

  test('a failed read is not cached, so the next load tries again', async () => {
    const f = fakeChats({ c1: { [METADATA_KEY]: ['A'] } });
    let fail = true;
    const io: ChatIO = {
      async read(id) { if (fail) { fail = false; throw new Error('no user yet'); } return f.io.read(id); },
      write: f.io.write,
    };
    const store = new ChatModeStore(io);
    expect(await store.load('c1')).toEqual({});
    expect(store.isLoaded('c1')).toBe(false);
    expect(Object.keys(await store.load('c1'))).toEqual(['A']);
  });

  test('saving a chat that was deleted forgets it instead of failing', async () => {
    const f = fakeChats({ c1: {} });
    const store = new ChatModeStore(f.io);
    (await store.load('c1'))['A'] = { status: 'ON' };
    f.chats.delete('c1');
    await store.save('c1');
    expect(store.isLoaded('c1')).toBe(false);
  });

  test('ignores junk stored under its key', async () => {
    const f = fakeChats({ c1: { [METADATA_KEY]: 'nonsense' } });
    const store = new ChatModeStore(f.io);
    expect(await store.load('c1')).toEqual({});
  });
});

test('createWriteQueue runs tasks one after another, in order', async () => {
  const queue = createWriteQueue();
  const order: string[] = [];
  const a = queue(async () => { await sleep(10); order.push('a'); });
  const b = queue(async () => { order.push('b'); });
  const c = queue(async () => { throw new Error('x'); });
  const d = queue(async () => { order.push('d'); });
  await Promise.all([a, b, c.catch(() => {}), d]);
  expect(order).toEqual(['a', 'b', 'd']);
});
