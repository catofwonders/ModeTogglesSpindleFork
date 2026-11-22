// Runs the real frontend against a stand-in for Lumiverse's frontend context
// (only what Mode Toggles uses), in a browser-like DOM. Checks what happens
// across chat switches, the extension being disabled while its UI is open,
// and being enabled again.
//
// The stand-in is stricter than Lumiverse on purpose: it does not release
// anything on unload by itself, so every subscription the extension leaves
// behind shows up here.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

type Handler = (payload: any) => void;

function createHost(opts: { modal?: boolean } = {}) {
  const backendHandlers = new Set<Handler>();
  const eventHandlers = new Map<string, Set<Handler>>();
  const sent: any[] = [];
  const styles: HTMLStyleElement[] = [];
  let cleanupCalls = 0;
  const tabs: any[] = [];
  const actions: any[] = [];

  const ctx: any = {
    sendToBackend(payload: any) { sent.push(payload); },
    onBackendMessage(handler: Handler) {
      backendHandlers.add(handler);
      return () => backendHandlers.delete(handler);
    },
    events: {
      on(event: string, handler: Handler) {
        if (!eventHandlers.has(event)) eventHandlers.set(event, new Set());
        eventHandlers.get(event)!.add(handler);
        return () => eventHandlers.get(event)?.delete(handler);
      },
    },
    dom: {
      addStyle(css: string) {
        const el = document.createElement('style');
        el.textContent = css;
        document.head.appendChild(el);
        styles.push(el);
      },
      cleanup() {
        cleanupCalls++;
        for (const el of styles.splice(0)) el.remove();
      },
    },
    ui: {
      registerDrawerTab(opts: any) {
        const activate = new Set<() => void>();
        const root = document.createElement('div');
        document.body.appendChild(root);
        const handle = {
          opts, root, badge: '' as string | null, destroyed: false, activate,
          setBadge(text: string | null) { handle.badge = text; },
          onActivate(h: () => void) { activate.add(h); return () => activate.delete(h); },
          destroy() { handle.destroyed = true; root.remove(); },
        };
        tabs.push(handle);
        return handle;
      },
      registerInputBarAction(opts: any) {
        const click = new Set<() => void>();
        const handle = {
          opts, label: opts.label, destroyed: false, click,
          setLabel(label: string) { handle.label = label; },
          setSubtitle() {}, setEnabled() {},
          onClick(h: () => void) { click.add(h); return () => click.delete(h); },
          destroy() { handle.destroyed = true; },
        };
        actions.push(handle);
        return handle;
      },
    },
    uploads: { async pickFile() { return []; } },
  };
  const modals: any[] = [];
  if (opts.modal) {
    ctx.ui.showModal = (o: any) => {
      if (modals.filter((m) => !m.dismissed).length >= 2) throw new Error('modal stack limit');
      const root = document.createElement('div');
      root.className = 'host-modal';
      document.body.appendChild(root);
      const onDismiss = new Set<() => void>();
      const m: any = {
        title: o.title, root, dismissed: false,
        dismiss() { if (m.dismissed) return; m.dismissed = true; root.remove(); onDismiss.forEach((h) => h()); },
        setTitle(t: string) { m.title = t; },
        onDismiss(h: () => void) { onDismiss.add(h); return () => onDismiss.delete(h); },
      };
      modals.push(m);
      return m;
    };
  }

  return {
    ctx, sent, tabs, actions, modals,
    get cleanupCalls() { return cleanupCalls; },
    fromBackend(payload: any) { for (const h of [...backendHandlers]) h(payload); },
    emit(event: string, payload: any) { for (const h of [...(eventHandlers.get(event) ?? [])]) h(payload); },
    clickAction() { for (const h of [...actions.at(-1)!.click]) h(); },
    subscriptionCount() {
      let n = backendHandlers.size;
      for (const set of eventHandlers.values()) n += set.size;
      for (const t of tabs) n += t.activate.size;
      for (const a of actions) n += a.click.size;
      return n;
    },
  };
}

function stateFor(chatId: string, on: string[]) {
  const all = ['Power 0: Rules', 'Power 1: Flight', 'Tone: Grim'];
  return {
    type: 'state_update', enabled: true, chatId,
    modes: all.map((name) => ({
      name, group: name.split(':')[0], description: `${name} text.`,
      status: on.includes(name) ? 'ON' : 'OFF', source: 'core',
    })),
    activeCount: on.length,
    presets: [], undoAvailable: false, undoLabel: '',
    settings: { loadCoreModes: true, sortMode: 'group', framing: '{{modes}}' },
    presetBlocks: [],
  };
}

const popover = () => (document.querySelector('.mt-popover') as HTMLElement | null) ?? undefined;

let setup: (ctx: any) => () => void;

beforeAll(async () => {
  ({ setup } = (await import('../src/frontend')) as any);
});

describe('first setup', () => {
  const host = createHost();
  let teardown: () => void;

  test('registers one drawer tab and one input bar button, and asks for state', () => {
    teardown = setup(host.ctx);
    expect(host.tabs.length).toBe(1);
    expect(host.actions.length).toBe(1);
    expect(host.sent.filter((p) => p.type === 'request_state').length).toBe(1);
  });

  test('the badge and the button show the open chat\'s count', () => {
    host.fromBackend(stateFor('c1', ['Power 0: Rules', 'Tone: Grim']));
    expect(host.tabs[0].badge).toBe('2');
    expect(host.actions[0].label).toBe('Mode Toggles (2)');
  });

  test('switching chats asks for the new chat\'s state, with its id', () => {
    host.sent.length = 0;
    host.emit('CHAT_SWITCHED', { chatId: 'c2' });
    expect(host.sent).toEqual([{ type: 'request_state', chatId: 'c2' }]);
  });

  test('the badge follows the new chat', () => {
    host.fromBackend(stateFor('c2', []));
    expect(host.tabs[0].badge).toBe('');
    expect(host.actions[0].label).toBe('Mode Toggles');
  });

  test('the home screen (chatId null) asks for nothing', () => {
    host.sent.length = 0;
    host.emit('CHAT_SWITCHED', { chatId: null });
    expect(host.sent).toEqual([]);
  });

  test('later messages go out with the new chat\'s id', () => {
    host.sent.length = 0;
    host.clickAction();
    expect(host.sent.at(-1)).toEqual({ type: 'request_state', chatId: 'c2' });
    expect(popover()).toBeDefined();
  });

  test('disabling with the popover and a dialog open leaves nothing behind', async () => {
    // A dialog: exporting with nothing to export shows an alert overlay.
    host.fromBackend({ type: 'export_data', text: '', count: 0 });
    expect(document.querySelector('.mt-overlay')).not.toBeNull();

    teardown();

    expect(host.subscriptionCount()).toBe(0);
    expect(popover()).toBeUndefined();
    expect(document.querySelector('.mt-overlay')).toBeNull();
    expect(host.tabs[0].destroyed).toBe(true);
    expect(host.actions[0].destroyed).toBe(true);
    expect(host.cleanupCalls).toBe(1);
    expect(document.head.querySelectorAll('style').length).toBe(0);
  });

  test('a message or switch arriving after disable does nothing', () => {
    host.sent.length = 0;
    host.fromBackend(stateFor('c1', ['Power 0: Rules']));
    host.emit('CHAT_SWITCHED', { chatId: 'c1' });
    expect(host.sent).toEqual([]);
    expect(host.tabs[0].badge).toBe('');
  });
});

describe('disabling right after opening the popover', () => {
  test('the popover\'s outside-click listeners are never attached', async () => {
    const host = createHost();
    const added: string[] = [];
    const realAdd = document.addEventListener.bind(document);
    (document as any).addEventListener = (type: string, ...rest: any[]) => {
      added.push(type);
      return (realAdd as any)(type, ...rest);
    };
    try {
      const teardown = setup(host.ctx);
      host.fromBackend(stateFor('c1', []));
      host.clickAction();
      teardown(); // before the popover's 50 ms delay runs out
      await sleep(80);
      expect(added.filter((t) => t === 'click' || t === 'keydown')).toEqual([]);
    } finally {
      (document as any).addEventListener = realAdd;
    }
  });
});

describe('enabling again', () => {
  test('a second setup works on its own, with no leftovers from the first', () => {
    const first = createHost();
    const firstTeardown = setup(first.ctx);
    first.fromBackend(stateFor('c1', ['Power 0: Rules']));
    firstTeardown();

    const host = createHost();
    const teardown = setup(host.ctx);
    const subscribed = host.subscriptionCount();
    expect(subscribed).toBe(4); // backend messages, CHAT_SWITCHED, tab activate, button click

    host.fromBackend(stateFor('c3', ['Power 1: Flight']));
    expect(host.tabs[0].badge).toBe('1');
    expect(first.tabs[0].badge).toBe('1'); // the old tab saw nothing new

    host.clickAction();
    expect(document.querySelectorAll('.mt-popover').length).toBe(1);

    teardown();
    expect(host.subscriptionCount()).toBe(0);
    expect(popover()).toBeUndefined();
  });
});

describe('dialogs in Lumiverse\'s own modal', () => {
  test('a dialog opens in the host modal, keeps the popover open, and closes on disable', async () => {
    const host = createHost({ modal: true });
    const teardown = setup(host.ctx);
    host.fromBackend(stateFor('c1', ['Power 0: Rules']));
    host.clickAction();
    await sleep(80); // the popover's outside-click listener is attached after 50 ms

    // "Presets" in the popover footer opens a host modal.
    const presetsBtn = [...document.querySelectorAll('.mt-action')].find((b) => b.textContent?.includes('Presets')) as HTMLElement;
    presetsBtn.click();
    expect(host.modals.length).toBe(1);
    expect(host.modals[0].title).toBe('Presets');
    expect(document.querySelector('.mt-overlay')).toBeNull();

    // Clicking inside the modal does not close the popover.
    host.modals[0].root.querySelector('input')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(popover()).toBeDefined();

    teardown();
    expect(host.modals[0].dismissed).toBe(true);
    expect(popover()).toBeUndefined();
    expect(host.subscriptionCount()).toBe(0);
  });

  test('past the host\'s two-modal limit, a third dialog falls back to the themed overlay', () => {
    const host = createHost({ modal: true });
    const teardown = setup(host.ctx);
    host.fromBackend(stateFor('c1', []));
    host.fromBackend({ type: 'export_data', text: '', count: 0 });
    host.fromBackend({ type: 'export_data', text: '', count: 0 });
    host.fromBackend({ type: 'export_data', text: '', count: 0 });
    expect(host.modals.length).toBe(2);
    expect(document.querySelectorAll('.mt-overlay').length).toBe(1);
    teardown();
    expect(document.querySelector('.mt-overlay')).toBeNull();
    expect(host.modals.every((m) => m.dismissed)).toBe(true);
  });
});

describe('keyboard and screen readers', () => {
  test('each mode is a labelled switch that reports its state', () => {
    const host = createHost();
    const teardown = setup(host.ctx);
    host.fromBackend(stateFor('c1', ['Tone: Grim']));
    host.clickAction();
    const toggles = [...document.querySelectorAll('.mt-mode-toggle')] as HTMLButtonElement[];
    const grim = toggles.find((t) => t.textContent?.includes('Tone: Grim'))!;
    expect(grim.tagName).toBe('BUTTON');
    expect(grim.getAttribute('role')).toBe('switch');
    expect(grim.getAttribute('aria-checked')).toBe('true');
    host.sent.length = 0;
    grim.click();
    expect(host.sent).toEqual([{ type: 'toggle_mode', modeName: 'Tone: Grim', chatId: 'c1' }]);
    teardown();
  });
});
