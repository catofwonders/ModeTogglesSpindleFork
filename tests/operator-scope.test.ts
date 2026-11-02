// An operator-scoped install: like Lumiverse (resolveEffectiveUserId), every
// chat or preset call without a userId fails with "userId is required for
// operator-scoped extensions". At startup Mode Toggles doesn't know the user
// yet; it must not report an error then, and must do the work once it does.
import { beforeAll, expect, test } from 'bun:test';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NEED_USER = 'userId is required for operator-scoped extensions';

const files = new Map<string, string>();
const chats = new Map<string, Record<string, unknown>>([['c1', {}]]);
const preset = {
  id: 'p1', name: 'Some Preset', revision: 1,
  blocks: [{ id: 'main', name: 'Main', content: 'Rules.', enabled: true, marker: 'main_prompt' }] as any[],
};
const toasts: string[] = [];
let frontendHandler: (payload: any, userId?: string) => Promise<void>;
let macroHandler: (ctx: any) => Promise<string>;
const listeners = new Map<string, (payload: any, userId?: string) => void>();

function needUser(userId?: string) {
  if (!userId) throw new Error(NEED_USER);
}

const spindle = {
  storage: {
    async getJson(path: string, opts: { fallback: unknown }) {
      return files.has(path) ? JSON.parse(files.get(path)!) : opts.fallback;
    },
    async setJson(path: string, value: unknown) { files.set(path, JSON.stringify(value)); },
    async read() { throw new Error('missing'); },
  },
  chats: {
    async get(id: string, userId?: string) {
      needUser(userId);
      const m = chats.get(id);
      return m ? { id, metadata: { ...m } } : null;
    },
    async getActive(userId?: string) { needUser(userId); return { id: 'c1', metadata: { ...chats.get('c1') } }; },
    async compareAndSetMetadata(id: string, input: any, userId?: string) {
      needUser(userId);
      if (JSON.stringify(chats.get(id)) !== JSON.stringify(input.expected_metadata)) return null;
      chats.set(id, { ...input.metadata });
      return { id };
    },
    async update(id: string, input: any, userId?: string) { needUser(userId); chats.set(id, { ...input.metadata }); return { id }; },
    async list(opts: any) { needUser(opts?.userId); return { data: [], total: 0 }; },
  },
  presets: {
    async get(id: string, userId?: string) {
      needUser(userId);
      return id === preset.id
        ? { id, name: preset.name, prompt_order: JSON.parse(JSON.stringify(preset.blocks)), metadata: {}, cache_revision: preset.revision }
        : null;
    },
    async update(id: string, input: any, userId?: string) {
      needUser(userId);
      if (input.expected_cache_revision !== preset.revision) throw Object.assign(new Error('changed since revision'), { code: 'PRESET_REVISION_CONFLICT' });
      preset.blocks = JSON.parse(JSON.stringify(input.prompt_order));
      preset.revision++;
      return { id };
    },
    async list(opts: any) { needUser(opts?.userId); return { data: [{ id: preset.id, name: preset.name }], total: 1 }; },
  },
  registerMacro(def: any) { macroHandler = def.handler; },
  on(event: string, handler: any) { listeners.set(event, handler); return () => {}; },
  onFrontendMessage(handler: any) { frontendHandler = handler; },
  sendToFrontend() {},
  toast: {
    info: (m: string) => toasts.push(m), success: (m: string) => toasts.push(m),
    warning: (m: string) => toasts.push(m), error: (m: string) => toasts.push(m),
  },
  log: { info() {}, warn() {}, error() {} },
  permissions: { onDenied() {} },
};

beforeAll(async () => {
  // Already set up earlier: the block was picked; a preset update removed {{modes}}.
  files.set('config.json', JSON.stringify({
    enabled: true, loadCoreModes: true, sortMode: 'group', presets: {}, chatStates: {},
    modeOverrides: { 'Rule A': { description: 'Rule A text.', group: 'G' } },
    framing: '', presetBlocks: { p1: { blockId: 'main', blockName: 'Main', presetName: 'Some Preset' } },
  }));
  chats.set('c1', { mode_toggles: ['Rule A'] });
  (globalThis as any).spindle = spindle;
  await import('../src/backend');
  await sleep(50);
});

test('startup without a known user: no error notice, nothing changed yet', () => {
  expect(toasts.filter((t) => /couldn't|could not|error/i.test(t))).toEqual([]);
  expect(preset.blocks[0].content).toBe('Rules.');
});

test('a {{modes}} request names the user: the modes come out, and the preset is fixed', async () => {
  expect(await macroHandler({ chatId: 'c1', env: { extra: { userId: 'u1' } } })).toBe('Rule A text.');
  await sleep(50);
  expect(preset.blocks[0].content).toBe('Rules.\n\n{{modes}}');
  expect(toasts.filter((t) => /couldn't|could not|error/i.test(t))).toEqual([]);
});

test('later checks use the known user', async () => {
  preset.blocks[0].content = 'Rules, updated.';
  preset.revision++;
  listeners.get('PRESET_CHANGED')?.({ id: 'p1' }, 'u1');
  await sleep(50);
  expect(preset.blocks[0].content).toBe('Rules, updated.\n\n{{modes}}');
});
