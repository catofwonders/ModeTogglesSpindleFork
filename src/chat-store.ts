// ===== Per-chat modes, stored inside each chat =====
// Each chat's active modes are saved in that chat's own metadata (key
// "mode_toggles"), the way LumiScript stores per-chat data
// (api.chat.setMetadata). Deleting a chat deletes its modes with it, a
// branched chat keeps its modes (Lumiverse copies metadata on branch), and
// toggling a mode only writes that one chat.
//
// The save is LumiScript's read-modify-write with its per-chat serialization
// queue, adapted from LumiScript (MIT, mindbound,
// https://github.com/mindbound/lumiscript, src/engine/api/chat.ts, commit
// 66ac526; see src/vendor/lumiscript/LICENSE). Lumiverse replaces a chat's
// metadata in full on every update, so each save re-reads the chat and only
// changes Mode Toggles' own key. On top of LumiScript's version, the write
// itself is conditional (Lumiverse's compareAndSetMetadata), so it can't
// overwrite a change Lumiverse made between the read and the write.
//
// The host calls are injected, so this file can be tested without Lumiverse.

export const METADATA_KEY = 'mode_toggles';

export interface ModeState {
  status: 'ON';
}

export type ChatModes = Record<string, ModeState>;

export type WriteResult = 'ok' | 'conflict' | 'gone';

export interface ChatIO {
  /** The chat's metadata, or null when the chat no longer exists. */
  read(chatId: string): Promise<Record<string, unknown> | null>;
  /**
   * Replace the chat's metadata, but only if it still equals `expected` (what
   * was read). 'conflict' = something else changed it in between, nothing
   * was written; 'gone' = the chat was deleted.
   */
  write(chatId: string, metadata: Record<string, unknown>, expected: Record<string, unknown>): Promise<WriteResult>;
}

/** How many times a save re-reads and retries after something else changed the chat. */
export const MAX_SAVE_ATTEMPTS = 5;

/** Stored form: the names of the modes that are on, in order. */
export function parseStored(raw: unknown): ChatModes | null {
  if (!Array.isArray(raw)) return null;
  const out: ChatModes = {};
  for (const name of raw) {
    if (typeof name === 'string' && name.trim()) out[name] = { status: 'ON' };
  }
  return out;
}

export function toStored(modes: ChatModes): string[] {
  return Object.keys(modes).filter((n) => modes[n]?.status === 'ON');
}

export class ChatModeStore {
  private cache = new Map<string, ChatModes>();
  private loading = new Map<string, Promise<ChatModes>>();
  // LumiScript: per-chat serialization queue for metadata writes.
  private queues = new Map<string, Promise<void>>();

  constructor(
    private io: ChatIO,
    /** Old per-chat states from config.json, used once for a chat that has none of its own. */
    private legacy: (chatId: string) => ChatModes | undefined = () => undefined,
    private onLegacyMoved: (chatId: string) => void = () => {},
  ) {}

  /** Loaded modes for a chat (empty if not loaded yet). Never creates storage. */
  peek(chatId: string): ChatModes {
    return this.cache.get(chatId) ?? {};
  }

  /** The chat's modes object, created in memory on first write use. */
  edit(chatId: string): ChatModes {
    let modes = this.cache.get(chatId);
    if (!modes) {
      modes = {};
      this.cache.set(chatId, modes);
    }
    return modes;
  }

  isLoaded(chatId: string): boolean {
    return this.cache.has(chatId);
  }

  /** Load a chat's modes once; later calls use the cache. */
  async load(chatId: string): Promise<ChatModes> {
    const cached = this.cache.get(chatId);
    if (cached) return cached;
    const pending = this.loading.get(chatId);
    if (pending) return pending;
    const p = (async () => {
      let metadata: Record<string, unknown> | null;
      try {
        metadata = await this.io.read(chatId);
      } catch {
        // Couldn't read (e.g. no user yet): use what we know, but don't cache
        // it, so the next call tries again.
        return this.cache.get(chatId) ?? { ...(this.legacy(chatId) ?? {}) };
      }
      if (!metadata) {
        // The chat no longer exists: drop any old leftover for it.
        if (this.legacy(chatId)) this.onLegacyMoved(chatId);
        return this.cache.get(chatId) ?? {};
      }
      let modes = parseStored(metadata[METADATA_KEY]);
      let fromLegacy = false;
      if (!modes) {
        const old = this.legacy(chatId);
        if (old) {
          modes = { ...old };
          fromLegacy = true;
        }
      } else if (this.legacy(chatId)) {
        // Already stored in the chat: the old copy is a leftover.
        this.onLegacyMoved(chatId);
      }
      const result = modes ?? {};
      // A write made while loading wins over what was read.
      if (!this.cache.has(chatId)) this.cache.set(chatId, result);
      if (fromLegacy) {
        await this.save(chatId);
        this.onLegacyMoved(chatId);
      }
      return this.cache.get(chatId)!;
    })().finally(() => this.loading.delete(chatId));
    this.loading.set(chatId, p);
    return p;
  }

  /** Replace a chat's modes in memory (used by undo). */
  set(chatId: string, modes: ChatModes): void {
    this.cache.set(chatId, modes);
  }

  /** Save the chat's current modes into its metadata. */
  save(chatId: string): Promise<void> {
    const queued = this.queues.get(chatId) ?? Promise.resolve();
    // As in LumiScript: run after the previous write whatever its outcome,
    // and drop the queue entry once it drains.
    const next: Promise<void> = queued.catch(() => {}).then(async () => {
      // Lumiverse's conditional write only lands if the chat is unchanged
      // since we read it, so a change Lumiverse makes in between (chat
      // variables after a reply, world book attachments…) is never lost: we
      // re-read and apply our key on top of it.
      for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt++) {
        const metadata = await this.io.read(chatId);
        if (!metadata) {
          // The chat was deleted: nothing to save, forget it.
          this.cache.delete(chatId);
          return;
        }
        const stored = toStored(this.peek(chatId));
        const updated: Record<string, unknown> = { ...metadata };
        if (stored.length > 0) updated[METADATA_KEY] = stored;
        else delete updated[METADATA_KEY];
        const before = JSON.stringify(metadata[METADATA_KEY] ?? null);
        const after = JSON.stringify(updated[METADATA_KEY] ?? null);
        if (before === after) return;
        const result = await this.io.write(chatId, updated, metadata);
        if (result === 'ok') return;
        if (result === 'gone') {
          this.cache.delete(chatId);
          return;
        }
      }
      throw new Error(`chat ${chatId} kept changing; modes not saved after ${MAX_SAVE_ATTEMPTS} attempts`);
    }).finally(() => {
      if (this.queues.get(chatId) === next) this.queues.delete(chatId);
    });
    this.queues.set(chatId, next);
    return next;
  }

  forget(chatId: string): void {
    this.cache.delete(chatId);
  }

  /** Wait for every queued save (used before reading many chats at once). */
  async flush(): Promise<void> {
    await Promise.all(Array.from(this.queues.values()).map((p) => p.catch(() => {})));
  }
}

/**
 * A serialization queue for one resource (here: config.json), the same
 * pattern as LumiScript's per-chat queue: each write starts after the
 * previous one finished, so an older snapshot can never land last.
 */
export function createWriteQueue(): (task: () => Promise<void>) => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  return (task) => {
    const next = tail.catch(() => {}).then(task);
    tail = next;
    return next;
  };
}
