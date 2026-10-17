declare const spindle: import('lumiverse-spindle-types').SpindleAPI;

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

interface ModeState {
  status: 'OFF' | 'ON';
}

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
  chatStates: Record<string, Record<string, ModeState>>;
  presets: Record<string, { name: string; modes: string[] }>;
}

// ===== Constants =====

// ===== State =====
let config: Config = {
  enabled: true,
  loadCoreModes: true,
  sortMode: 'group',
  modeOverrides: {},
  chatStates: {},
  presets: {},
};

let coreModes: ModeDefinition[] = [];
let currentChatId = 'default';
let currentUserId: string | undefined;

// Single-level undo snapshot for destructive actions (Disable All, preset load).
// Scoped to the chat it was captured in.
let lastUndo: { chatId: string; label: string; states: Record<string, ModeState> } | null = null;

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

  // Migrate: 'ON' is the only persisted state now. Old 'OFF'/countdown/transition
  // entries no longer mean anything, so strip them and drop empty buckets.
  let dirty = false;
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

async function saveConfig(): Promise<void> {
  try {
    await spindle.storage.setJson('config.json', config, { indent: 2 });
  } catch (e) {
    spindle.log.error(`Failed to save config: ${e}`);
  }
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

// Create-on-access: use ONLY on write paths (toggling a mode on, etc.).
function getChatState(chatId: string): Record<string, ModeState> {
  if (!config.chatStates[chatId]) config.chatStates[chatId] = {};
  return config.chatStates[chatId];
}

// Read-only: never creates or persists an empty bucket. Use on read paths
// (rendering, snapshots, interceptor) so merely viewing a chat doesn't leave
// an empty {} bucket behind in storage.
function peekChatState(chatId: string): Record<string, ModeState> {
  return config.chatStates[chatId] || {};
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
  emptyChatBuckets: number;// chat state buckets with no toggles left
}

function computeTidyReport(): TidyReport {
  const effective = knownModeNames();
  let orphanToggles = 0;
  let emptyChatBuckets = 0;
  for (const [cid, states] of Object.entries(config.chatStates)) {
    const names = Object.keys(states);
    let live = 0;
    for (const name of names) {
      if (effective.has(name)) live++; else orphanToggles++;
    }
    // The active chat always has (or instantly regains) a bucket, so don't
    // count it as cleanable — otherwise "tidy" could never report zero.
    if ((names.length === 0 || live === 0) && cid !== currentChatId) emptyChatBuckets++;
  }
  let emptyPresets = 0;
  let deadPresetRefs = 0;
  for (const p of Object.values(config.presets)) {
    const live = p.modes.filter((n) => effective.has(n));
    deadPresetRefs += p.modes.length - live.length;
    if (live.length === 0) emptyPresets++;
  }
  return { orphanToggles, emptyPresets, deadPresetRefs, emptyChatBuckets };
}

function applyTidy(): void {
  const effective = knownModeNames();
  // Drop orphaned toggles, then drop now-empty chat buckets.
  for (const [cid, states] of Object.entries(config.chatStates)) {
    for (const name of Object.keys(states)) {
      if (!effective.has(name)) delete states[name];
    }
    if (Object.keys(states).length === 0) delete config.chatStates[cid];
  }
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
    },
  });

  // Keep the {{modes}} macro value in sync with the current chat's ON modes.
  pushModesMacro();
}

// ===== {{modes}} macro (push model) =====
// Exposes the current chat's ON modes as a macro the user can place anywhere in
// their Loom preset (e.g. inside a System block), instead of relying on fixed
// injection. Outputs ONLY the mode descriptions, blank-line separated, with no
// framing — the user writes any framing around the tag in their prompt.

// Raw text: all ON modes for the chat, blank line between each. No scheduling
// (always all ON modes) and no framing.
function buildModesRawText(chatId: string): string {
  // Master switch: when Mode Toggles is disabled the macro emits nothing.
  if (!config.enabled) return '';
  const onModes = getModesView(chatId).filter((m) => m.status === 'ON');
  if (onModes.length === 0) return '';
  return onModes.map((m) => m.description).join('\n\n');
}

// Push the raw descriptions, macros and all. Lumiverse expands any {{char}},
// {{user}}, {{random}} etc. inside an extension macro's value during prompt
// assembly, so they resolve fresh for every generation, against whichever
// character is speaking (group chats included). Resolving them here instead
// would freeze them at toggle time.
// Fire-and-forget; synchronous, so pushes can never land out of order.
function pushModesMacro(): void {
  try {
    spindle.updateMacroValue('modes', buildModesRawText(currentChatId));
  } catch (e) {
    spindle.log.warn(`[modes macro] push failed: ${e}`);
  }
}
spindle.onFrontendMessage(async (payload: any, userId?: string) => {
  // Capture userId for operator-scoped extensions
  if (userId && userId !== currentUserId) currentUserId = userId;

  // Authoritative chatId: getActive() > payload.chatId > cached currentChatId.
  // This protects against stale frontend chatIds after rapid chat switches.
  const chatId = await resolveActiveChatId(payload.chatId);
  if (chatId !== currentChatId) currentChatId = chatId;

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
        if (Object.keys(state).length === 0) delete config.chatStates[chatId];
      } else {
        state[payload.modeName] = { status: 'ON' };
      }
      await saveConfig();
      sendStateToFrontend();
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
        // Custom mode is gone for good: drop its toggles and any emptied buckets.
        for (const cid of Object.keys(config.chatStates)) {
          delete config.chatStates[cid][name];
          if (Object.keys(config.chatStates[cid]).length === 0) delete config.chatStates[cid];
        }
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
      for (const e of plan.entries) {
        config.modeOverrides[e.name] = { description: e.description, group: normalizeGroup(e.group) };
      }
      let renamedCount = 0;
      let removedCount = 0;
      if (replace) {
        // Carry renamed modes' toggles and preset entries over to the new name.
        for (const [from, to] of plan.renames) {
          for (const states of Object.values(config.chatStates)) {
            if (states[from]) { states[to] = states[from]; delete states[from]; }
          }
          for (const preset of Object.values(config.presets)) {
            preset.modes = Array.from(new Set(preset.modes.map((n) => (n === from ? to : n))));
          }
          delete config.modeOverrides[from];
          renamedCount++;
        }
        // Remove custom modes from the file's groups that the file no longer contains.
        for (const name of plan.removed) {
          delete config.modeOverrides[name];
          for (const cid of Object.keys(config.chatStates)) {
            delete config.chatStates[cid][name];
            if (Object.keys(config.chatStates[cid]).length === 0) delete config.chatStates[cid];
          }
          removedCount++;
        }
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
      for (const chatId of Object.keys(config.chatStates)) {
        for (const name of toRemove) delete config.chatStates[chatId][name];
      }
      await saveConfig();
      sendStateToFrontend();
      toast.success('All custom modes removed');
      break;
    }

    case 'reset_defaults': {
      // Preserve user's presets — they represent meaningful work.
      const preservedPresets = config.presets;
      config = {
        enabled: true, loadCoreModes: true,
        sortMode: 'group',
        modeOverrides: {}, chatStates: {}, presets: preservedPresets,
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
        if (Object.keys(st).length === 0) delete config.chatStates[chatId];
        lastUndo = { chatId, label: 'Disable All', states: snapshot };
        await saveConfig();
        sendStateToFrontend();
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
      await saveConfig();
      sendStateToFrontend();
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
      await saveConfig();
      sendStateToFrontend();
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
      config.chatStates[chatId] = lastUndo.states;
      lastUndo = null;
      await saveConfig();
      sendStateToFrontend();
      toast.success(`Undid: ${label}`);
      break;
    }

    case 'request_tidy_report': {
      spindle.sendToFrontend({ type: 'tidy_report', report: computeTidyReport() });
      break;
    }

    case 'apply_tidy': {
      const before = computeTidyReport();
      const total = before.orphanToggles + before.emptyPresets + before.deadPresetRefs + before.emptyChatBuckets;
      if (total === 0) { toast.info('Already tidy — nothing to clean'); return; }
      applyTidy();
      // A tidy pass can invalidate the undo snapshot (it may reference removed modes).
      lastUndo = null;
      await saveConfig();
      sendStateToFrontend();
      toast.success(`Tidied: removed ${before.orphanToggles} orphan toggle(s), ${before.emptyPresets} empty preset(s), ${before.deadPresetRefs} dead reference(s)`);
      break;
    }
  }
});

// ===== Events =====
spindle.on('CHAT_CHANGED', async (data) => {
  // Lumiverse 1.0 payload shape is { chat: { id }, changedFields? }.
  // Keep a defensive fallback to the older flat { chatId } for pre-1.0 hosts.
  const hint = data?.chat?.id ?? (data as any)?.chatId;
  const resolved = await resolveActiveChatId(hint);
  if (resolved === currentChatId) return;
  currentChatId = resolved;
  sendStateToFrontend();
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

  // Register the {{modes}} macro (push model — value supplied via
  // updateMacroValue whenever modes/chat change, including from sendStateToFrontend).
  spindle.registerMacro({
    name: 'modes',
    category: 'extension:mode_toggles',
    description:
      "Active Mode Toggles modes for the current chat, blank-line separated. Place {{modes}} anywhere in your preset.",
    returnType: 'string',
    handler: '',
  });

  sendStateToFrontend(); // also performs the initial {{modes}} push
})();
