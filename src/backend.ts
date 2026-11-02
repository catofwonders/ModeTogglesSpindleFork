declare const spindle: import('lumiverse-spindle-types').SpindleAPI;

import { familyOf, naturalCompare } from './search';
import { ChatModeStore, createWriteQueue, type ChatModes } from './chat-store';
import {
  applyFraming, blockNotes, editBlockContent, findAssignedBlock, pickableBlocks, withModesTag, withoutAddedModesTag,
  hasModesTag, type BlockAssignment, type BlockLike, type PresetIO,
} from './preset-blocks';

// ===== Safe Toast Helper =====
// Guard in case spindle.toast isn't ready during early init
const toast = {
  info: (msg: string) => { spindle.toast?.info(msg) },
  success: (msg: string) => { spindle.toast?.success(msg) },
  warning: (msg: string) => { spindle.toast?.warning(msg) },
  error: (msg: string) => { spindle.toast?.error(msg) },
};

// ===== Types =====
interface ModeDefinition {
  name: string;
  group: string;
  description: string;
}

type ModeState = ChatModes[string];

interface ModeView extends ModeDefinition {
  status: string;
  // 'core' = built-in, 'override' = built-in edited by the user, 'custom' = user-made
  source: 'core' | 'override' | 'custom';
}

interface Config {
  enabled: boolean;
  loadCoreModes: boolean;
  sortMode: 'group' | 'flat';
  modeOverrides: Record<string, { description: string; group: string }>;
  // Old storage: every chat's modes in this file. Chats now keep their own
  // modes (see chat-store.ts); entries here are moved into their chat the
  // first time that chat is opened, and dropped if the chat no longer exists.
  chatStates: Record<string, Record<string, ModeState>>;
  presets: Record<string, { name: string; modes: string[] }>;
  // Text sent with the modes wherever {{modes}} is. {{modes}} inside it marks
  // where the modes go; without it the modes follow the framing. Empty = the
  // modes alone, as before.
  framing: string;
  // Per preset (by preset id): the block that holds {{modes}}.
  presetBlocks: Record<string, BlockAssignment>;
}

// ===== State =====
let config: Config = {
  enabled: true,
  loadCoreModes: true,
  sortMode: 'group',
  modeOverrides: {},
  chatStates: {},
  presets: {},
  framing: '',
  presetBlocks: {},
};

let coreModes: ModeDefinition[] = [];
let currentChatId = 'default';
let currentUserId: string | undefined;

// Single-level undo snapshot for destructive actions (Disable All, preset load).
// Scoped to the chat it was captured in.
let lastUndo: { chatId: string; label: string; states: Record<string, ModeState> } | null = null;

// ===== Per-chat modes (stored in each chat) =====
let warnedNoConditionalWrite = false;
const chatStore = new ChatModeStore(
  {
    async read(chatId) {
      const chat = await spindle.chats.get(chatId, currentUserId);
      return chat ? (chat.metadata ?? {}) : null;
    },
    async write(chatId, metadata, expected) {
      // Conditional write: lands only if the chat's metadata still equals
      // what was read (needs the chat_mutation permission).
      try {
        const saved = await spindle.chats.compareAndSetMetadata(
          chatId, { expected_metadata: expected, metadata }, currentUserId);
        if (saved) return 'ok';
        return (await spindle.chats.get(chatId, currentUserId)) ? 'conflict' : 'gone';
      } catch (e) {
        if (!/chat_mutation|not a function/i.test(String(e))) throw e;
        // Permission not granted (or an older Lumiverse): plain write, so
        // toggles still save, and say once how to make it safe.
        if (!warnedNoConditionalWrite) {
          warnedNoConditionalWrite = true;
          spindle.log.warn(`Mode Toggles: safe chat saves unavailable (${e}); using plain saves`);
          toast.warning('Mode Toggles: grant the "chat_mutation" permission so saving modes can never overwrite other chat data.');
        }
        await spindle.chats.update(chatId, { metadata }, currentUserId);
        return 'ok';
      }
    },
  },
  (chatId) => config.chatStates[chatId],
  (chatId) => {
    delete config.chatStates[chatId];
    saveConfig();
  },
);

// A chat id that isn't a real chat (no chat open) is kept in memory only.
function isRealChat(chatId: string): boolean {
  return !!chatId && chatId !== 'default';
}

async function loadChat(chatId: string): Promise<void> {
  if (isRealChat(chatId)) await chatStore.load(chatId);
}

async function saveChat(chatId: string): Promise<void> {
  if (!isRealChat(chatId)) return;
  try {
    await chatStore.save(chatId);
  } catch (e) {
    spindle.log.error(`Failed to save modes for chat ${chatId}: ${e}`);
  }
}

// Every chat that has modes, from Lumiverse's chat list plus any old entries
// still in config.json. `change` edits the modes in place and returns true
// when it changed something; changed chats are saved.
async function forEachChatWithModes(change: (modes: ChatModes) => boolean): Promise<void> {
  await chatStore.flush();
  // Move old entries into their chats first, so they're edited in one place.
  for (const chatId of Object.keys(config.chatStates)) await loadChat(chatId);

  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    let page: { data: Array<{ id: string; metadata: Record<string, unknown> }>; total: number };
    try {
      page = await spindle.chats.list({ limit, offset, userId: currentUserId });
    } catch (e) {
      spindle.log.warn(`Could not list chats: ${e}`);
      break;
    }
    for (const chat of page.data) {
      if (!chatStore.isLoaded(chat.id) && !Array.isArray(chat.metadata?.mode_toggles)) continue;
      const modes = await chatStore.load(chat.id);
      if (change(modes)) await saveChat(chat.id);
    }
    if (page.data.length < limit || offset + limit >= page.total) break;
  }

  // Old entries that couldn't be moved (chat unreachable right now).
  let legacyChanged = false;
  for (const states of Object.values(config.chatStates)) {
    if (change(states)) legacyChanged = true;
  }
  for (const [chatId, states] of Object.entries(config.chatStates)) {
    if (Object.keys(states).length === 0) { delete config.chatStates[chatId]; legacyChanged = true; }
  }
  if (legacyChanged) await saveConfig();
}

// ===== Storage Helpers =====
async function loadConfig(): Promise<void> {
  try {
    // storage.read() now throws on a missing file; getJson handles
    // read + parse + fallback in one call (Lumiverse 1.0 storage API).
    const parsed = await spindle.storage.getJson<Partial<Config>>('config.json', { fallback: {} });
    if (parsed && typeof parsed === 'object') {
      config = { ...config, ...parsed };
    }
  } catch (e) {
    spindle.log.warn('Could not load config, using defaults');
  }

  // Backwards compat: ensure presets exists on old configs
  if (!config.presets) config.presets = {};
  if (!config.chatStates || typeof config.chatStates !== 'object') config.chatStates = {};
  if (typeof config.framing !== 'string') config.framing = '';
  if (!config.presetBlocks || typeof config.presetBlocks !== 'object') config.presetBlocks = {};

  let dirty = false;
  // 1.1.0's position settings were removed.
  const loose = config as unknown as Record<string, unknown>;
  for (const key of ['placement', 'depth']) {
    if (loose[key] !== undefined) {
      delete loose[key];
      dirty = true;
    }
  }

  // Migrate: 'ON' is the only persisted state now. Old 'OFF'/countdown/transition
  // entries no longer mean anything, so strip them and drop empty buckets.
  for (const chatId of Object.keys(config.chatStates)) {
    const states = config.chatStates[chatId];
    for (const [name, st] of Object.entries(states)) {
      if ((st.status as string) === 'Activating') { st.status = 'ON'; dirty = true; }
      const anyState = st as { countdown?: number; schedule?: string };
      if (anyState.countdown !== undefined) { delete anyState.countdown; dirty = true; }
      // Schedule masks were removed: the {{modes}} macro emits all ON modes
      // every turn, so a per-mode probability string had nothing to act on.
      if (anyState.schedule !== undefined) { delete anyState.schedule; dirty = true; }
      if (st.status !== 'ON') { delete states[name]; dirty = true; }
    }
    if (Object.keys(states).length === 0) { delete config.chatStates[chatId]; dirty = true; }
  }
  // Also clean up orphaned 'default' bucket
  if (config.chatStates['default']) {
    delete config.chatStates['default'];
    dirty = true;
  }
  // Drop dead top-level keys from older configs.
  if ((config as { countdown?: number }).countdown !== undefined) {
    delete (config as { countdown?: number }).countdown;
    dirty = true;
  }
  if ((config as { deterministic?: boolean }).deterministic !== undefined) {
    delete (config as { deterministic?: boolean }).deterministic;
    dirty = true;
  }
  if (dirty) saveConfig();
}

// Saves go through a queue (LumiScript's serialization pattern), so two saves
// close together can't finish out of order and leave an older config on disk.
const configWrites = createWriteQueue();

function saveConfig(): Promise<void> {
  return configWrites(async () => {
    try {
      await spindle.storage.setJson('config.json', config, { indent: 2 });
    } catch (e) {
      spindle.log.error(`Failed to save config: ${e}`);
    }
  });
}

// ===== Chat Resolution =====
// Always resolves via spindle.chats.getActive() as source of truth.
// The frontend-supplied chatId and cached currentChatId are only fallbacks.
async function resolveActiveChatId(hint?: string): Promise<string> {
  try {
    const active = currentUserId
      ? await spindle.chats.getActive(currentUserId)
      : await spindle.chats.getActive();
    if (active?.id) return active.id;
  } catch {
    // chats permission not granted — fall back
  }
  return hint || currentChatId;
}

async function loadCoreModesFromStorage(): Promise<void> {
  const all: ModeDefinition[] = [];
  const seen = new Set<string>();
  let consecutiveMisses = 0;
  for (let n = 1; consecutiveMisses < 5; n++) {
    try {
      const text = await spindle.storage.read(`modes/modes_${n}.txt`);
      if (!text) { consecutiveMisses++; continue; }
      consecutiveMisses = 0;

      // Pre-process: join continuation lines
      const rawLines = text.replace(/\r/g, '').split('\n');
      const mergedLines: string[] = [];

      function looksLikeEntry(line: string): boolean {
        const dc = (line.match(/ - /g) || []).length;
        if (dc < 2) return false;
        const g = (line.split(' - ')[1] || '').trim();
        if (g.length > 40 || g.length === 0 || g.includes('{{') || g.includes(',')) return false;
        return true;
      }

      for (const raw of rawLines) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        if (looksLikeEntry(trimmed)) {
          mergedLines.push(trimmed);
        } else if (mergedLines.length > 0) {
          mergedLines[mergedLines.length - 1] += ' ' + trimmed;
        }
      }

      for (const line of mergedLines) {
        const parts = line.split(' - ');
        const name = parts[0]?.trim();
        let group: string, description: string;
        if (parts.length >= 3) {
          group = (parts[1] || '').trim() || 'Unsorted';
          description = parts.slice(2).join(' - ').trim();
        } else if (parts.length === 2) {
          group = 'Unsorted';
          description = (parts[1] || '').trim();
        } else {
          continue;
        }
        if (!name || !description) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        all.push({ name, group, description });
      }
    } catch {
      consecutiveMisses++;
    }
  }
  coreModes = all;
  spindle.log.info(`Loaded ${coreModes.length} core mode(s) from storage`);
}

// ===== Mode Resolution =====
function getEffectiveModes(): ModeDefinition[] {
  const baseMap = new Map<string, ModeDefinition>();
  if (config.loadCoreModes) {
    for (const m of coreModes) {
      baseMap.set(m.name, { name: m.name, description: m.description, group: m.group || 'Unsorted' });
    }
  }
  for (const [name, ov] of Object.entries(config.modeOverrides)) {
    baseMap.set(name, { name, description: ov.description, group: ov.group || 'Unsorted' });
  }
  return Array.from(baseMap.values());
}

// Write paths (toggling a mode on, etc.): the chat's modes, editable in place.
// Call loadChat(chatId) first and saveChat(chatId) after.
function getChatState(chatId: string): Record<string, ModeState> {
  return chatStore.edit(chatId);
}

// Read paths: the chat's loaded modes; nothing is created or saved.
function peekChatState(chatId: string): Record<string, ModeState> {
  return chatStore.peek(chatId);
}

function getModesView(chatId: string): ModeView[] {
  const effective = getEffectiveModes();
  const state = peekChatState(chatId);
  const coreNames = new Set(coreModes.map((m) => m.name));
  return effective.map((m) => {
    const s = state[m.name];
    const overridden = !!config.modeOverrides[m.name];
    return {
      name: m.name,
      description: m.description,
      group: m.group || 'Unsorted',
      status: s?.status ?? 'OFF',
      source: !overridden ? 'core' : coreNames.has(m.name) ? 'override' : 'custom',
    };
  });
}

// ===== Import planning =====
// Parses an import file and works out what importing it would change, without
// changing anything. Used for the preview and for the import itself, so the
// preview is always exactly what happens.
interface ImportEntry { name: string; group: string; description: string }
interface ImportPlan {
  entries: ImportEntry[];
  errors: number;
  groups: string[];
  added: string[];
  updated: string[];
  unchanged: string[];
  renames: Array<[string, string]>; // [old name, new name]; only applied by Replace
  removed: string[];                 // only applied by Replace
}

function parseImportText(text: string): { entries: ImportEntry[]; errors: number } {
  // Join continuation lines. A valid entry starts with "Name - Group - Desc"
  // where Group is a short category name (e.g. "Social & Power", not a description fragment).
  const rawLines = text.replace(/\r/g, '').split('\n');
  const mergedLines: string[] = [];
  const looksLikeNewEntry = (line: string): boolean => {
    if ((line.match(/ - /g) || []).length < 2) return false;
    const group = (line.split(' - ')[1] || '').trim();
    if (group.length > 40 || group.length === 0) return false;
    if (group.includes('{{') || group.includes(',')) return false;
    return true;
  };
  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (looksLikeNewEntry(trimmed)) mergedLines.push(trimmed);
    else if (mergedLines.length > 0) mergedLines[mergedLines.length - 1] += ' ' + trimmed;
  }
  const byName = new Map<string, ImportEntry>(); // a later duplicate line wins
  let errors = 0;
  for (const line of mergedLines) {
    const parts = line.split(' - ');
    const name = parts[0]?.trim();
    let group: string, description: string;
    if (parts.length >= 3) {
      group = (parts[1] || '').trim() || 'Unsorted';
      description = parts.slice(2).join(' - ').trim();
    } else if (parts.length === 2) {
      group = 'Unsorted';
      description = (parts[1] || '').trim();
    } else { errors++; continue; }
    if (!name || !description || validateModeFields(name, group)) { errors++; continue; }
    byName.set(name, { name, group, description });
  }
  return { entries: Array.from(byName.values()), errors };
}

const normDesc = (d: string) => d.replace(/\s+/g, ' ').trim();

function planImport(text: string): ImportPlan {
  const { entries, errors } = parseImportText(text);
  const coreNames = new Set(coreModes.map((m) => m.name));
  const fileNames = new Set(entries.map((e) => e.name));
  const groups = Array.from(new Set(entries.map((e) => normalizeGroup(e.group))));
  const groupSet = new Set(groups.map((g) => g.toLowerCase()));

  const added: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  for (const e of entries) {
    const cur = config.modeOverrides[e.name];
    if (!cur && !coreNames.has(e.name)) added.push(e.name);
    else if (cur && normDesc(cur.description) === normDesc(e.description)
      && cur.group.toLowerCase() === normalizeGroup(e.group).toLowerCase()) unchanged.push(e.name);
    else updated.push(e.name);
  }

  // Replace only touches user-made modes in the groups this file covers:
  // other groups and edited built-in modes are left alone.
  const stale = Object.keys(config.modeOverrides).filter((n) =>
    !fileNames.has(n) && !coreNames.has(n)
    && groupSet.has((config.modeOverrides[n].group || 'Unsorted').toLowerCase()));

  // A stale mode whose description exactly matches exactly one newly added
  // mode (and vice versa) is treated as a rename.
  const addedByDesc = new Map<string, string[]>();
  for (const n of added) {
    const d = normDesc(entries.find((e) => e.name === n)!.description);
    addedByDesc.set(d, [...(addedByDesc.get(d) || []), n]);
  }
  const staleByDesc = new Map<string, string[]>();
  for (const n of stale) {
    const d = normDesc(config.modeOverrides[n].description);
    staleByDesc.set(d, [...(staleByDesc.get(d) || []), n]);
  }
  const renames: Array<[string, string]> = [];
  for (const [d, olds] of staleByDesc) {
    const news = addedByDesc.get(d);
    if (olds.length === 1 && news && news.length === 1) renames.push([olds[0], news[0]]);
  }
  const renamedOld = new Set(renames.map(([o]) => o));
  const removed = stale.filter((n) => !renamedOld.has(n));
  return { entries, errors, groups, added, updated, unchanged, renames, removed };
}

// ===== Tidiness / Order Helpers =====
function existingGroupNames(): string[] {
  const set = new Set<string>();
  for (const m of coreModes) if (m.group) set.add(m.group);
  for (const ov of Object.values(config.modeOverrides)) if (ov.group) set.add(ov.group);
  return Array.from(set);
}

// Trim + collapse whitespace, and snap to an existing group's canonical casing
// so "Social & Power" and "social & power " can't fork into two accordions.
function normalizeGroup(raw: string): string {
  const cleaned = (raw || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'Unsorted';
  const lc = cleaned.toLowerCase();
  for (const g of existingGroupNames()) {
    if (g.toLowerCase() === lc) return g;
  }
  return cleaned;
}

// Mode names and groups are stored as "Name - Group - Description" lines on
// export, so they can't contain the " - " separator or the line won't round-trip.
function validateModeFields(name: string, group: string): string | null {
  if (!name) return 'Mode name is required';
  if (name.includes(' - ')) return 'Mode name cannot contain " - "';
  if (group.includes(' - ')) return 'Group cannot contain " - "';
  if (group.includes(',')) return 'Group cannot contain commas';
  if (group.length > 40) return 'Group must be 40 characters or fewer';
  if (group.includes('{{')) return 'Group cannot contain macros';
  return null;
}

// Export descriptions on a single line so they re-import cleanly.
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

interface TidyReport {
  orphanToggles: number;   // per-chat toggles pointing at modes that no longer exist
  emptyPresets: number;    // presets with nothing live left in them
  deadPresetRefs: number;  // preset entries pointing at modes that no longer exist
  emptyChatBuckets: number;// old config.json entries for chats that no longer exist
}

async function computeTidyReport(): Promise<TidyReport> {
  const effective = knownModeNames();
  let orphanToggles = 0;
  // Moving old entries into their chats drops the ones whose chat is gone.
  const legacyBefore = Object.keys(config.chatStates).length;
  await forEachChatWithModes((modes) => {
    for (const name of Object.keys(modes)) if (!effective.has(name)) orphanToggles++;
    return false;
  });
  const emptyChatBuckets = legacyBefore - Object.keys(config.chatStates).length;
  let emptyPresets = 0;
  let deadPresetRefs = 0;
  for (const p of Object.values(config.presets)) {
    const live = p.modes.filter((n) => effective.has(n));
    deadPresetRefs += p.modes.length - live.length;
    if (live.length === 0) emptyPresets++;
  }
  return { orphanToggles, emptyPresets, deadPresetRefs, emptyChatBuckets };
}

async function applyTidy(): Promise<void> {
  const effective = knownModeNames();
  // Drop orphaned toggles in every chat.
  await forEachChatWithModes((modes) => {
    let changed = false;
    for (const name of Object.keys(modes)) {
      if (!effective.has(name)) { delete modes[name]; changed = true; }
    }
    return changed;
  });
  // Strip dead references from presets, drop presets left empty.
  for (const [key, p] of Object.entries(config.presets)) {
    p.modes = p.modes.filter((n) => effective.has(n));
    if (p.modes.length === 0) delete config.presets[key];
  }
}

// The full universe of modes that legitimately exist, INDEPENDENT of the
// "Load core modes" display toggle. Tidy uses this so a toggle for a real
// mode is never mistaken for an orphan just because core modes are hidden.
function knownModeNames(): Set<string> {
  const set = new Set<string>();
  for (const m of coreModes) set.add(m.name);
  for (const name of Object.keys(config.modeOverrides)) set.add(name);
  return set;
}


function sendStateToFrontend(): void {
  const view = getModesView(currentChatId);
  const activeCount = view.filter((m) => m.status === 'ON').length;
  const presets = Object.values(config.presets)
    .map((p) => ({ name: p.name, count: p.modes.length }))
    .sort((a, b) => a.name.localeCompare(b.name));
  spindle.sendToFrontend({
    type: 'state_update',
    enabled: config.enabled,
    modes: view,
    activeCount,
    chatId: currentChatId,
    presets,
    undoAvailable: !!(lastUndo && lastUndo.chatId === currentChatId),
    undoLabel: lastUndo && lastUndo.chatId === currentChatId ? lastUndo.label : '',
    settings: {
      loadCoreModes: config.loadCoreModes,
      sortMode: config.sortMode,
      framing: config.framing,
    },
    presetBlocks: Object.entries(config.presetBlocks)
      .map(([presetId, a]) => ({ presetId, presetName: a.presetName, blockName: a.blockName }))
      .sort((a, b) => a.presetName.localeCompare(b.presetName)),
  });
}

// ===== {{modes}} macro (pull model) =====
// Exposes the current chat's ON modes as a macro the user can place anywhere in
// their Loom preset (e.g. inside a System block), or that Mode Toggles keeps in
// a block the user picked per preset. Outputs the mode descriptions,
// blank-line separated, inside the Framing text when one is set.

// Text sent to the model. No headings or names: only descriptions, so it reads
// as plain rules continuing the user's framing. Structure is carried by layout:
//  - a family's master and active levels form ONE paragraph, so the model reads
//    "what this covers" and "what it is here" as a single rule;
//  - modes without a family are one paragraph each;
//  - groups (A-Z, like the menu) are separated by a "~ ~ ~" break line (not "* * *",
//    which markdown viewers turn into an invisible rule).
function buildModesRawText(chatId: string): string {
  // Master switch: when Mode Toggles is disabled the macro emits nothing.
  if (!config.enabled) return '';
  const onModes = getModesView(chatId).filter((m) => m.status === 'ON');
  if (onModes.length === 0) return '';

  const groups = new Map<string, ModeView[]>();
  for (const m of orderForOutput(onModes)) {
    const g = m.group || 'Unsorted';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(m);
  }

  const sections: string[] = [];
  for (const g of Array.from(groups.keys()).sort(naturalCompare)) {
    const paragraphs: string[] = [];
    let currentFamily: string | null = null;
    for (const m of groups.get(g)!) {
      const fam = familyOf(m.name);
      const text = m.description.replace(/\s+/g, ' ').trim();
      if (fam && fam === currentFamily) paragraphs[paragraphs.length - 1] += ' ' + text;
      else paragraphs.push(text);
      currentFamily = fam;
    }
    sections.push(paragraphs.join('\n\n'));
  }
  return sections.join('\n\n~ ~ ~\n\n');
}

// Output order: families stay together, in the order each family first
// appears in storage (which follows the imported file). Inside a family the
// 0 (master) comes first, then the levels by number; modes sharing a number
// keep their stored order. Modes without a family keep their own position.
function orderForOutput<T extends { name: string; group: string }>(list: T[]): T[] {
  const keyOf = (m: T): string => {
    const f = familyOf(m.name);
    return f ? `f:${(m.group || '').toLowerCase()}|${f.toLowerCase()}` : `n:${m.name}`;
  };
  const levelOf = (m: T): number => {
    const match = m.name.match(/^.*?\S\s+(\d+)\s*:/);
    return match ? Number(match[1]) : 0;
  };
  const firstIndex = new Map<string, number>();
  const rows = list.map((m, i) => {
    const key = keyOf(m);
    if (!firstIndex.has(key)) firstIndex.set(key, i);
    return { m, i, key, level: levelOf(m) };
  });
  rows.sort((a, b) =>
    (firstIndex.get(a.key)! - firstIndex.get(b.key)!)
    || (a.level - b.level)
    || (a.i - b.i));
  return rows.map((r) => r.m);
}

// Lumiverse calls this every time it resolves {{modes}} and tells us which
// chat the prompt is for, so each chat gets its own modes even when several
// are open at once. Without a chat id (some previews) the chat open in the
// menu is used. The text is returned macros and all: Lumiverse expands any
// {{user}}, {{random}} etc. in the result for every generation.
// ===== Which user =====
// Operator-scoped installs must name the user on every call ("userId is
// required for operator-scoped extensions"). Lumiverse tells us the user with
// frontend messages, events and macro requests, but not at startup, so the
// startup work (preset checks, moving old data) runs again once it's known.
let startupWorkRunning: Promise<void> | null = null;

function noteUser(userId: unknown): void {
  if (typeof userId !== 'string' || !userId || userId === currentUserId) return;
  const first = !currentUserId;
  currentUserId = userId;
  if (first) void runStartupWork();
}

function isMissingUserError(e: unknown): boolean {
  return /userId is required/i.test(String((e as any)?.message ?? e));
}

function runStartupWork(): Promise<void> {
  if (startupWorkRunning) return startupWorkRunning;
  startupWorkRunning = (async () => {
    await loadChat(currentChatId);
    // Presets updated while Mode Toggles wasn't running: put {{modes}} back.
    for (const presetId of Object.keys(config.presetBlocks)) await ensureModesInPreset(presetId);
    // Move old per-chat entries from config.json into their chats (and drop
    // the ones whose chat was deleted). Entries that can't be reached now are
    // moved the next time their chat is opened.
    for (const chatId of Object.keys(config.chatStates)) await loadChat(chatId);
  })().finally(() => { startupWorkRunning = null; });
  return startupWorkRunning;
}

async function resolveModesMacro(
  ctx: { chatId?: unknown; env?: { extra?: { userId?: unknown } } } | undefined,
): Promise<string> {
  noteUser(ctx?.env?.extra?.userId);
  const chatId = typeof ctx?.chatId === 'string' && ctx.chatId ? ctx.chatId : currentChatId;
  await loadChat(chatId);
  return applyFraming(buildModesRawText(chatId), config.framing);
}

// ===== {{modes}} inside a chosen preset block =====
// Uses Lumiverse's preset editing (spindle.presets, permission "presets"),
// the same host feature LumiScript's api.presets wraps. For each preset the
// user picked a block in, {{modes}} is kept at the end of that block, and put
// back whenever the preset is saved or updated (PRESET_CHANGED).
const presetWrites = new Map<string, Promise<boolean>>();

// Lossless preset access: read the preset as stored, save the whole block list
// back with only one block's content changed, guarded by cache_revision.
const presetIO: PresetIO = {
  async get(presetId) {
    const preset = await spindle.presets.get(presetId, currentUserId);
    if (!preset) return null;
    return {
      prompt_order: (preset.prompt_order || []) as unknown as Array<Record<string, unknown>>,
      cache_revision: preset.cache_revision ?? 0,
    };
  },
  async save(presetId, promptOrder, expectedRevision) {
    try {
      const saved = await spindle.presets.update(
        presetId,
        { prompt_order: promptOrder as any, expected_cache_revision: expectedRevision } as any,
        currentUserId,
      );
      return saved ? 'ok' : 'gone';
    } catch (e: any) {
      if (e?.code === 'PRESET_REVISION_CONFLICT' || /changed since revision/i.test(String(e?.message ?? e))) {
        return 'conflict';
      }
      if (/Preset not found/i.test(String(e?.message ?? e))) return 'gone';
      throw e;
    }
  },
};

async function readPresetBlocks(presetId: string): Promise<BlockLike[] | null> {
  const preset = await presetIO.get(presetId);
  return preset ? (preset.prompt_order as unknown as BlockLike[]) : null;
}

/**
 * Make sure the picked block of this preset holds {{modes}}. Resolves true
 * when it does afterwards. Failures are shown to the user, never silent.
 */
function ensureModesInPreset(presetId: string): Promise<boolean> {
  // One check per preset at a time; our own save fires PRESET_CHANGED again,
  // and that second check finds {{modes}} already there.
  const prev = presetWrites.get(presetId) ?? Promise.resolve(true);
  const next = prev.catch(() => false).then(async () => {
    const assignment = config.presetBlocks[presetId];
    if (!assignment) return false;
    const where = `"${assignment.blockName}" in preset "${assignment.presetName}"`;
    try {
      const blocks = await readPresetBlocks(presetId);
      if (!blocks) {
        toast.warning(`Mode Toggles: preset "${assignment.presetName}" no longer exists.`);
        return false;
      }
      const block = findAssignedBlock(blocks, assignment);
      if (!block) {
        toast.warning(`Mode Toggles: couldn't find ${where} any more. Pick the block again in the Mode Toggles tab.`);
        return false;
      }
      if (block.id !== assignment.blockId) {
        assignment.blockId = block.id;
        await saveConfig();
      }
      if (hasModesTag(block.content)) return true;
      const result = await editBlockContent(presetIO, presetId, block.id, withModesTag);
      if (result === 'ok' || result === 'unchanged') {
        spindle.log.info(`Mode Toggles: {{modes}} is in ${where}`);
        return true;
      }
      toast.warning(`Mode Toggles: couldn't add {{modes}} to ${where} (${result === 'gone' ? 'preset deleted' : 'block removed'}).`);
      return false;
    } catch (e) {
      if (isMissingUserError(e)) {
        // Startup on an operator-scoped install: retried once the user is known.
        spindle.log.info(`Mode Toggles: checking ${where} once the user is known`);
        return false;
      }
      toast.error(`Mode Toggles: couldn't add {{modes}} to ${where}: ${e}`);
      return false;
    }
  }).finally(() => {
    if (presetWrites.get(presetId) === next) presetWrites.delete(presetId);
  });
  presetWrites.set(presetId, next);
  return next;
}

async function removeModesFromPreset(presetId: string, assignment: BlockAssignment): Promise<void> {
  try {
    const blocks = await readPresetBlocks(presetId);
    if (!blocks) return;
    const block = findAssignedBlock(blocks, assignment);
    if (!block) return;
    await editBlockContent(presetIO, presetId, block.id, withoutAddedModesTag);
  } catch (e) {
    toast.error(`Mode Toggles: couldn't remove {{modes}} from "${assignment.blockName}": ${e}`);
  }
}

async function listAllPresets(): Promise<Array<{ id: string; name: string }>> {
  const out: Array<{ id: string; name: string }> = [];
  const limit = 200;
  for (let offset = 0; ; offset += limit) {
    const page = await spindle.presets.list({ limit, offset, userId: currentUserId });
    for (const p of page.data) out.push({ id: p.id, name: p.name });
    if (page.data.length < limit || offset + limit >= page.total) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

spindle.onFrontendMessage(async (payload: any, userId?: string) => {
  // Capture userId for operator-scoped extensions
  noteUser(userId);

  // Authoritative chatId: getActive() > payload.chatId > cached currentChatId.
  // This protects against stale frontend chatIds after rapid chat switches.
  const chatId = await resolveActiveChatId(payload.chatId);
  if (chatId !== currentChatId) currentChatId = chatId;
  // This chat's modes are read from the chat itself (once, then cached).
  await loadChat(chatId);

  switch (payload.type) {
    case 'request_state': {
      sendStateToFrontend();
      break;
    }

    case 'toggle_mode': {
      if (!config.enabled) { toast.warning('Mode Toggles is disabled — enable it in the drawer tab'); return; }
      const state = getChatState(chatId);
      const isOn = (state[payload.modeName]?.status ?? 'OFF') === 'ON';
      if (isOn) {
        // OFF is instant and total — no lingering state, no ghost line.
        delete state[payload.modeName];
      } else {
        state[payload.modeName] = { status: 'ON' };
      }
      sendStateToFrontend();
      await saveChat(chatId);
      break;
    }

    case 'set_enabled':
      config.enabled = payload.enabled;
      await saveConfig();
      sendStateToFrontend();
      toast.info(config.enabled ? 'Mode Toggles enabled' : 'Mode Toggles disabled');
      break;

    case 'update_settings':
      if (payload.loadCoreModes !== undefined) config.loadCoreModes = payload.loadCoreModes;
      if (payload.sortMode !== undefined) config.sortMode = payload.sortMode === 'flat' ? 'flat' : 'group';
      if (typeof payload.framing === 'string') config.framing = payload.framing;
      await saveConfig();
      sendStateToFrontend();
      break;

    case 'delete_mode': {
      const name = String(payload.name || '').trim();
      if (!name) return;
      const isDefault = coreModes.some((m) => m.name === name);
      if (!config.modeOverrides[name]) {
        // Built-in modes without an override have nothing to delete.
        if (isDefault) toast.info(`"${name}" is a built-in mode and can't be deleted`);
        return;
      }
      delete config.modeOverrides[name];
      if (isDefault) {
        toast.success(`Mode "${name}" restored to default`);
      } else {
        // Custom mode is gone for good: drop its toggles in every chat.
        await forEachChatWithModes((modes) => {
          if (!modes[name]) return false;
          delete modes[name];
          return true;
        });
        toast.success(`Mode "${name}" deleted`);
      }
      await saveConfig();
      sendStateToFrontend();
      break;
    }

    case 'add_edit_mode': {
      const name = String(payload.name || '').trim();
      const description = String(payload.description || '').trim();
      const rawGroup = String(payload.group || '').trim();
      if (!name) return;
      if (!description) {
        // Older frontends sent an empty description to mean "delete".
        // Never treat a blank save as a deletion; require explicit delete_mode.
        toast.error('Description is required');
        return;
      }
      const err = validateModeFields(name, rawGroup);
      if (err) { toast.error(err); return; }
      config.modeOverrides[name] = { description, group: normalizeGroup(rawGroup) };
      toast.success(`Mode "${name}" saved`);
      await saveConfig();
      sendStateToFrontend();
      break;
    }

    case 'import_preview': {
      // Dry run: report what an import would do, change nothing.
      const plan = planImport(String(payload.text || ''));
      spindle.sendToFrontend({
        type: 'import_preview',
        text: payload.text,
        report: {
          valid: plan.entries.length,
          errors: plan.errors,
          groups: plan.groups,
          added: plan.added.length,
          updated: plan.updated.length,
          unchanged: plan.unchanged.length,
          renamed: plan.renames.map(([from, to]) => ({ from, to })),
          removed: plan.removed,
        },
      });
      break;
    }

    case 'import_modes': {
      const plan = planImport(String(payload.text || ''));
      const replace = payload.mode === 'replace';
      const keysBefore = Object.keys(config.modeOverrides);
      for (const e of plan.entries) {
        config.modeOverrides[e.name] = { description: e.description, group: normalizeGroup(e.group) };
      }
      let renamedCount = 0;
      let removedCount = 0;
      if (replace) {
        // Carry renamed modes' toggles and preset entries over to the new name.
        for (const [from, to] of plan.renames) {
          for (const preset of Object.values(config.presets)) {
            preset.modes = Array.from(new Set(preset.modes.map((n) => (n === from ? to : n))));
          }
          delete config.modeOverrides[from];
          renamedCount++;
        }
        // Remove custom modes from the file's groups that the file no longer contains.
        for (const name of plan.removed) {
          delete config.modeOverrides[name];
          removedCount++;
        }
        // Apply both to every chat's toggles.
        if (plan.renames.length > 0 || plan.removed.length > 0) {
          await forEachChatWithModes((modes) => {
            let changed = false;
            for (const [from, to] of plan.renames) {
              if (modes[from]) { modes[to] = modes[from]; delete modes[from]; changed = true; }
            }
            for (const name of plan.removed) {
              if (modes[name]) { delete modes[name]; changed = true; }
            }
            return changed;
          });
        }
        // Store the file's modes in the file's order, placed where that set
        // used to sit, so {{modes}} follows the file. Other groups and edited
        // built-in modes keep their positions.
        const fileNames = new Set(plan.entries.map((e) => e.name));
        const replaced = new Set<string>([
          ...plan.renames.map(([from]) => from),
          ...plan.removed,
        ]);
        const rebuilt: Config['modeOverrides'] = {};
        let placed = false;
        const placeFile = () => {
          for (const e of plan.entries) rebuilt[e.name] = config.modeOverrides[e.name];
          placed = true;
        };
        for (const k of keysBefore) {
          if (fileNames.has(k) || replaced.has(k)) {
            if (!placed) placeFile();
            continue;
          }
          if (config.modeOverrides[k]) rebuilt[k] = config.modeOverrides[k];
        }
        if (!placed) placeFile();
        config.modeOverrides = rebuilt;
        lastUndo = null; // snapshot may reference names that no longer exist
      }
      await saveConfig();
      sendStateToFrontend();
      const parts: string[] = [];
      if (plan.added.length) parts.push(`${plan.added.length} added`);
      if (plan.updated.length) parts.push(`${plan.updated.length} updated`);
      if (renamedCount) parts.push(`${renamedCount} renamed`);
      if (removedCount) parts.push(`${removedCount} removed`);
      if (parts.length) toast.success(`Import: ${parts.join(', ')}`);
      else if (plan.entries.length) toast.info('Import: everything was already up to date');
      if (plan.errors > 0) toast.warning(`${plan.errors} line(s) skipped due to format errors`);
      if (plan.entries.length === 0 && plan.errors === 0) {
        toast.warning('No modes found. Each line should look like: Name - Group - Description');
      }
      break;
    }

    case 'export_modes': {
      // Optional group filter: only export custom modes in the chosen groups.
      const wanted: Set<string> | null = Array.isArray(payload.groups)
        ? new Set(payload.groups.map((g: string) => String(g).toLowerCase()))
        : null;
      const lines = Object.entries(config.modeOverrides)
        .filter(([, ov]) => !wanted || wanted.has((ov.group || 'Unsorted').toLowerCase()))
        .map(([name, ov]) => `${name} - ${ov.group || 'Unsorted'} - ${oneLine(ov.description)}`);
      const groups = Array.isArray(payload.groups) ? payload.groups.map(String) : [];
      spindle.sendToFrontend({ type: 'export_data', text: lines.join('\n'), count: lines.length, groups });
      break;
    }

    case 'export_config': {
      // Export everything except chatStates (those are per-chat session data)
      const exportObj = {
        enabled: config.enabled,
        loadCoreModes: config.loadCoreModes,
        sortMode: config.sortMode,
        framing: config.framing,
        modeOverrides: config.modeOverrides,
        presets: config.presets,
      };
      spindle.sendToFrontend({ type: 'export_config_data', json: JSON.stringify(exportObj, null, 2) });
      break;
    }

    case 'import_config': {
      const incoming = payload.config;
      if (!incoming || typeof incoming !== 'object') {
        toast.error('Invalid config file');
        return;
      }
      // Selectively apply known fields, preserving chatStates
      if (typeof incoming.enabled === 'boolean') config.enabled = incoming.enabled;
      if (typeof incoming.loadCoreModes === 'boolean') config.loadCoreModes = incoming.loadCoreModes;
      if (incoming.sortMode === 'group' || incoming.sortMode === 'flat') config.sortMode = incoming.sortMode;
      if (typeof incoming.framing === 'string') config.framing = incoming.framing;
      // Validate shapes: a malformed entry would otherwise print "undefined"
      // into {{modes}} or crash Tidy.
      let skipped = 0;
      if (incoming.modeOverrides && typeof incoming.modeOverrides === 'object') {
        const clean: Config['modeOverrides'] = {};
        for (const [name, ov] of Object.entries(incoming.modeOverrides as Record<string, any>)) {
          const desc = typeof ov?.description === 'string' ? ov.description.trim() : '';
          const grp = typeof ov?.group === 'string' ? ov.group.trim() : '';
          if (!name.trim() || !desc || validateModeFields(name.trim(), grp)) { skipped++; continue; }
          clean[name.trim()] = { description: desc, group: grp || 'Unsorted' };
        }
        config.modeOverrides = clean;
      }
      if (incoming.presets && typeof incoming.presets === 'object') {
        const clean: Config['presets'] = {};
        for (const [key, p] of Object.entries(incoming.presets as Record<string, any>)) {
          const modes = Array.isArray(p?.modes) ? p.modes.filter((m: unknown) => typeof m === 'string') : null;
          const pname = typeof p?.name === 'string' && p.name.trim() ? p.name.trim() : key;
          if (!modes || modes.length === 0) { skipped++; continue; }
          clean[pname] = { name: pname, modes };
        }
        config.presets = clean;
      }
      lastUndo = null;
      if (skipped > 0) toast.warning(`${skipped} invalid entr${skipped === 1 ? 'y' : 'ies'} skipped`);
      await saveConfig();
      sendStateToFrontend();
      toast.success('Config imported successfully');
      break;
    }

    case 'remove_all_custom': {
      const defaultNames = new Set(coreModes.map((m) => m.name));
      const toRemove = new Set<string>();
      for (const name of Object.keys(config.modeOverrides)) {
        if (!defaultNames.has(name)) toRemove.add(name);
        delete config.modeOverrides[name];
      }
      await forEachChatWithModes((modes) => {
        let changed = false;
        for (const name of toRemove) if (modes[name]) { delete modes[name]; changed = true; }
        return changed;
      });
      await saveConfig();
      sendStateToFrontend();
      toast.success('All custom modes removed');
      break;
    }

    case 'reset_defaults': {
      // Preserve user's presets — they represent meaningful work. The preset
      // blocks are kept too: they match {{modes}} already written into presets.
      await forEachChatWithModes((modes) => {
        const names = Object.keys(modes);
        for (const n of names) delete modes[n];
        return names.length > 0;
      });
      const preservedPresets = config.presets;
      const preservedBlocks = config.presetBlocks;
      config = {
        enabled: true, loadCoreModes: true,
        sortMode: 'group',
        modeOverrides: {}, chatStates: {}, presets: preservedPresets,
        framing: '', presetBlocks: preservedBlocks,
      };
      lastUndo = null;
      await saveConfig();
      sendStateToFrontend();
      toast.success('Extension reset to defaults');
      break;
    }

    case 'disable_all': {
      if (!config.enabled) { toast.warning('Mode Toggles is disabled — enable it in the drawer tab'); return; }
      const st = peekChatState(chatId);
      const snapshot = JSON.parse(JSON.stringify(st));
      const onNames = Object.keys(st).filter((n) => st[n].status === 'ON');
      if (onNames.length > 0) {
        for (const n of onNames) delete st[n];
        lastUndo = { chatId, label: 'Disable All', states: snapshot };
        sendStateToFrontend();
        await saveChat(chatId);
        toast.success(`Disabled ${onNames.length} mode(s) — undo available`);
      } else {
        toast.info('No active modes to disable');
      }
      break;
    }

    case 'activate_random': {
      if (!config.enabled) { toast.warning('Mode Toggles is disabled — enable it in the drawer tab'); return; }
      const view = getModesView(chatId);
      const inactive = view.filter((m) => m.status === 'OFF');
      if (inactive.length === 0) { toast.info('No inactive modes available'); return; }
      const pick = inactive[Math.floor(Math.random() * inactive.length)];
      const st = getChatState(chatId);
      st[pick.name] = { status: 'ON' };
      sendStateToFrontend();
      await saveChat(chatId);
      toast.success(`Randomly activated: ${pick.name}`);
      break;
    }

    case 'save_preset': {
      const name = (payload.name || '').trim();
      if (!name) { toast.error('Preset name required'); return; }
      const st = peekChatState(chatId);
      const known = knownModeNames();
      const onModes = Object.entries(st)
        .filter(([n, s]) => s.status === 'ON' && known.has(n))
        .map(([n]) => n);
      if (onModes.length === 0) { toast.warning('No modes are active to save'); return; }
      config.presets[name] = { name, modes: onModes };
      await saveConfig();
      sendStateToFrontend();
      toast.success(`Preset "${name}" saved (${onModes.length} mode${onModes.length === 1 ? '' : 's'})`);
      break;
    }

    case 'load_preset': {
      if (!config.enabled) { toast.warning('Mode Toggles is disabled — enable it in the drawer tab'); return; }
      const name = payload.name;
      const mergeMode = payload.mergeMode === 'merge' ? 'merge' : 'replace';
      const preset = config.presets[name];
      if (!preset) { toast.error(`Preset "${name}" not found`); return; }

      const st = getChatState(chatId);
      const undoSnapshot = JSON.parse(JSON.stringify(st));
      const presetSet = new Set(preset.modes);

      if (mergeMode === 'replace') {
        // Remove any currently-ON mode not in the preset — instant, no ghost.
        for (const modeName of Object.keys(st)) {
          if (st[modeName].status === 'ON' && !presetSet.has(modeName)) {
            delete st[modeName];
          }
        }
      }
      // Turn ON all preset modes that still exist (deleted modes would just
      // become orphan toggles and inflate the "activated" count).
      const known = knownModeNames();
      let activated = 0;
      let missing = 0;
      for (const modeName of preset.modes) {
        if (!known.has(modeName)) { missing++; continue; }
        const prev = st[modeName];
        const wasOn = prev?.status === 'ON';
        st[modeName] = { status: 'ON' };
        if (!wasOn) activated++;
      }
      lastUndo = { chatId, label: `Load "${name}"`, states: undoSnapshot };
      sendStateToFrontend();
      await saveChat(chatId);
      const verb = mergeMode === 'replace' ? 'Loaded' : 'Merged';
      toast.success(`${verb} "${name}" — ${activated} mode${activated === 1 ? '' : 's'} activated · undo available`);
      if (missing > 0) toast.warning(`${missing} mode(s) in this preset no longer exist — run Tidy to clean up`);
      break;
    }

    case 'delete_preset': {
      const name = payload.name;
      if (!config.presets[name]) return;
      delete config.presets[name];
      await saveConfig();
      sendStateToFrontend();
      toast.success(`Preset "${name}" deleted`);
      break;
    }

    case 'rename_preset': {
      const oldName = payload.oldName;
      const newName = (payload.newName || '').trim();
      if (!newName || !config.presets[oldName]) return;
      if (config.presets[newName] && oldName !== newName) {
        toast.error(`Preset "${newName}" already exists`);
        return;
      }
      const p = config.presets[oldName];
      p.name = newName;
      config.presets[newName] = p;
      if (oldName !== newName) delete config.presets[oldName];
      await saveConfig();
      sendStateToFrontend();
      toast.success(`Renamed to "${newName}"`);
      break;
    }

    case 'undo_last': {
      if (!lastUndo || lastUndo.chatId !== chatId) { toast.info('Nothing to undo'); return; }
      const label = lastUndo.label;
      chatStore.set(chatId, lastUndo.states);
      lastUndo = null;
      sendStateToFrontend();
      await saveChat(chatId);
      toast.success(`Undid: ${label}`);
      break;
    }

    case 'request_tidy_report': {
      spindle.sendToFrontend({ type: 'tidy_report', report: await computeTidyReport() });
      break;
    }

    case 'apply_tidy': {
      const before = await computeTidyReport();
      const total = before.orphanToggles + before.emptyPresets + before.deadPresetRefs + before.emptyChatBuckets;
      if (total === 0) { toast.info('Already tidy — nothing to clean'); return; }
      await applyTidy();
      // A tidy pass can invalidate the undo snapshot (it may reference removed modes).
      lastUndo = null;
      await saveConfig();
      sendStateToFrontend();
      toast.success(`Tidied: removed ${before.orphanToggles} orphan toggle(s), ${before.emptyPresets} empty preset(s), ${before.deadPresetRefs} dead reference(s)`);
      break;
    }

    // ===== {{modes}} inside a preset block =====
    case 'list_presets': {
      try {
        spindle.sendToFrontend({ type: 'presets_list', presets: await listAllPresets() });
      } catch (e) {
        spindle.sendToFrontend({ type: 'presets_list', presets: [], error: String(e) });
      }
      break;
    }

    case 'list_blocks': {
      const presetId = String(payload.presetId || '');
      if (!presetId) return;
      try {
        const all = await readPresetBlocks(presetId);
        if (!all) throw new Error('Preset not found');
        const blocks = pickableBlocks(all);
        spindle.sendToFrontend({
          type: 'blocks_list',
          presetId,
          blocks: blocks.map((b) => ({
            id: b.id, name: b.name, enabled: b.enabled !== false, isCategory: b.marker === 'category',
            notes: blockNotes(b), hasModes: hasModesTag(b.content),
          })),
          selectedId: config.presetBlocks[presetId]?.blockId ?? null,
        });
      } catch (e) {
        spindle.sendToFrontend({
          type: 'blocks_list', presetId, blocks: [], selectedId: null,
          error: `Couldn't read this preset's blocks: ${e}`,
        });
      }
      break;
    }

    case 'set_preset_block': {
      const presetId = String(payload.presetId || '');
      const blockId = String(payload.blockId || '');
      if (!presetId || !blockId) return;
      try {
        const all = await readPresetBlocks(presetId);
        if (!all) { toast.error('That preset no longer exists'); return; }
        const block = pickableBlocks(all).find((b) => b.id === blockId);
        if (!block) { toast.error('That block can no longer be found in the preset'); return; }
        const previous = config.presetBlocks[presetId];
        // Record the new choice first, so the "preset changed" signal from the
        // removal below checks the new block, not the old one.
        config.presetBlocks[presetId] = {
          blockId, blockName: block.name, presetName: String(payload.presetName || previous?.presetName || presetId),
        };
        await saveConfig();
        if (previous && previous.blockId !== blockId) await removeModesFromPreset(presetId, previous);
        const ok = await ensureModesInPreset(presetId);
        sendStateToFrontend();
        if (ok) toast.success(`{{modes}} is now kept in "${block.name}"`);
      } catch (e) {
        toast.error(`Could not read that preset: ${e}`);
      }
      break;
    }

    case 'clear_preset_block': {
      const presetId = String(payload.presetId || '');
      const assignment = config.presetBlocks[presetId];
      if (!assignment) return;
      delete config.presetBlocks[presetId];
      await saveConfig();
      await removeModesFromPreset(presetId, assignment);
      sendStateToFrontend();
      toast.success(`Removed {{modes}} from "${assignment.blockName}"`);
      break;
    }
  }
});

// ===== Events =====
spindle.on('CHAT_CHANGED', async (data, userId) => {
  noteUser(userId);
  // Lumiverse 1.0 payload shape is { chat: { id }, changedFields? }.
  // Keep a defensive fallback to the older flat { chatId } for pre-1.0 hosts.
  const hint = data?.chat?.id ?? (data as any)?.chatId;
  const resolved = await resolveActiveChatId(hint);
  if (resolved === currentChatId) return;
  currentChatId = resolved;
  await loadChat(resolved);
  sendStateToFrontend();
});

// A deleted chat takes its modes with it (they live in the chat); just drop
// the cached copy.
spindle.on('CHAT_DELETED', (data: any, userId?: string) => {
  noteUser(userId);
  const id = data?.chatId ?? data?.id ?? data?.chat?.id;
  if (typeof id === 'string') chatStore.forget(id);
});

// A preset was saved or updated (including updates installed from LumiHub):
// put {{modes}} back into its chosen block if the update removed it.
spindle.on('PRESET_CHANGED', (data: any, userId?: string) => {
  noteUser(userId);
  const id = data?.id ?? data?.preset?.id;
  if (typeof id === 'string' && config.presetBlocks[id]) void ensureModesInPreset(id);
});

// Note: there is no per-turn state to refresh anymore (ON is the only state and
// it changes only through explicit user actions). We therefore don't subscribe
// to GENERATION_ENDED — which in Lumiverse 1.0 would require the broad
// `generation` permission this extension intentionally avoids.

// ===== Permission diagnostics =====
spindle.permissions.onDenied(({ permission, operation }) => {
  spindle.log.warn(`Permission "${permission}" denied for ${operation}`);
});


// ===== Init =====
(async () => {
  await loadConfig();
  await loadCoreModesFromStorage();

  // Resolve the real active chatId immediately
  currentChatId = await resolveActiveChatId();

  // Register the {{modes}} macro (pull model — Lumiverse asks for the value
  // per prompt, with the chat id, instead of reading one shared pushed value).
  spindle.registerMacro({
    name: 'modes',
    category: 'extension:mode_toggles',
    description:
      "Active Mode Toggles modes for the current chat, blank-line separated, inside your Framing if set. Place {{modes}} anywhere in your preset, or pick a block for it in the Mode Toggles tab.",
    returnType: 'string',
    volatile: true,
    // The runtime accepts a function handler (sync or async); the published
    // types still say string.
    handler: resolveModesMacro as unknown as string,
  });

  await runStartupWork();
  sendStateToFrontend();
})();
