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
  schedule?: string;
}

interface ModeView extends ModeDefinition {
  status: string;
  schedule?: string;
}

interface Config {
  enabled: boolean;
  loadCoreModes: boolean;
  preFraming: string;
  mergeFormat: string;
  postFraming: string;
  injectionPosition: 'prepend' | 'append' | 'before_user' | 'start' | 'end';
  injectionRole: 'system' | 'user' | 'assistant';
  deterministic: boolean;
  sortMode: 'group' | 'flat';
  modeOverrides: Record<string, { description: string; group: string }>;
  chatStates: Record<string, Record<string, ModeState>>;
  presets: Record<string, { name: string; modes: string[] }>;
}

// ===== Constants =====
// Assertion register: state what is true of the scene, never what to suppress.
const DEFAULT_PRE_FRAMING =
  'The following are true of this scene right now. Write everything in accordance with them:';
const DEFAULT_MERGE_FORMAT = '{{modeDescription}}';
const DEFAULT_POST_FRAMING =
  'Render these as lived reality, not as instructions. Never name, list, or acknowledge them.';

// ===== State =====
let config: Config = {
  enabled: true,
  loadCoreModes: true,
  preFraming: DEFAULT_PRE_FRAMING,
  mergeFormat: DEFAULT_MERGE_FORMAT,
  postFraming: DEFAULT_POST_FRAMING,
  injectionPosition: 'prepend',
  injectionRole: 'system',
  deterministic: false,
  sortMode: 'group',
  modeOverrides: {},
  chatStates: {},
  presets: {},
};

let coreModes: ModeDefinition[] = [];
let tick = 0;
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
      const anyState = st as { countdown?: number };
      if (anyState.countdown !== undefined) { delete anyState.countdown; dirty = true; }
      if (st.status !== 'ON') { delete states[name]; dirty = true; }
    }
    if (Object.keys(states).length === 0) { delete config.chatStates[chatId]; dirty = true; }
  }
  // Also clean up orphaned 'default' bucket
  if (config.chatStates['default']) {
    delete config.chatStates['default'];
    dirty = true;
  }
  // Drop the dead 'countdown' key from older configs.
  if ((config as { countdown?: number }).countdown !== undefined) {
    delete (config as { countdown?: number }).countdown;
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
  return effective.map((m) => {
    const s = state[m.name];
    return {
      name: m.name,
      description: m.description,
      group: m.group || 'Unsorted',
      status: s?.status ?? 'OFF',
      schedule: s?.schedule,
    };
  });
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
      preFraming: config.preFraming,
      mergeFormat: config.mergeFormat,
      postFraming: config.postFraming,
      injectionPosition: config.injectionPosition,
      injectionRole: config.injectionRole,
      deterministic: config.deterministic,
      sortMode: config.sortMode,
    },
  });
}

// ===== Message Handler from Frontend =====
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
      if (!config.enabled) return;
      const state = getChatState(chatId);
      const isOn = (state[payload.modeName]?.status ?? 'OFF') === 'ON';
      if (isOn) {
        // OFF is instant and total — no lingering state, no ghost line.
        delete state[payload.modeName];
        if (Object.keys(state).length === 0) delete config.chatStates[chatId];
      } else {
        state[payload.modeName] = { status: 'ON', schedule: state[payload.modeName]?.schedule || 'X' };
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
      if (payload.preFraming !== undefined) config.preFraming = payload.preFraming;
      if (payload.mergeFormat !== undefined) config.mergeFormat = payload.mergeFormat;
      if (payload.postFraming !== undefined) config.postFraming = payload.postFraming;
      if (payload.injectionPosition !== undefined) config.injectionPosition = payload.injectionPosition;
      if (payload.injectionRole !== undefined) config.injectionRole = payload.injectionRole;
      if (payload.deterministic !== undefined) config.deterministic = !!payload.deterministic;
      if (payload.sortMode !== undefined) config.sortMode = payload.sortMode === 'flat' ? 'flat' : 'group';
      await saveConfig();
      sendStateToFrontend();
      break;

    case 'add_edit_mode': {
      if (!payload.name) return;
      if (!payload.description) {
        delete config.modeOverrides[payload.name];
        const isDefault = coreModes.some((m) => m.name === payload.name);
        if (!isDefault) {
          for (const chatId of Object.keys(config.chatStates)) {
            delete config.chatStates[chatId][payload.name];
          }
        }
        toast.success(`Mode "${payload.name}" override removed`);
      } else {
        config.modeOverrides[payload.name] = {
          description: payload.description,
          group: normalizeGroup(payload.group),
        };
        toast.success(`Mode "${payload.name}" saved`);
      }
      await saveConfig();
      sendStateToFrontend();
      break;
    }

    case 'import_modes': {
      // Pre-process: join continuation lines. A valid entry starts with "Name - Group - Desc"
      // where Group is a short category name (e.g. "Social & Power", not a description fragment).
      const rawLines = payload.text.replace(/\r/g, '').split('\n');
      const mergedLines: string[] = [];

      function looksLikeNewEntry(line: string): boolean {
        const dashCount = (line.match(/ - /g) || []).length;
        if (dashCount < 2) return false;
        // Validate the group field (second part) looks like a real category
        const parts = line.split(' - ');
        const group = (parts[1] || '').trim();
        // Real groups are short category names, not description fragments
        if (group.length > 40) return false;
        if (group.includes('{{')) return false;
        if (group.includes(',')) return false;
        if (group.length === 0) return false;
        return true;
      }

      for (const raw of rawLines) {
        const trimmed = raw.trim();
        if (!trimmed) continue;

        if (looksLikeNewEntry(trimmed)) {
          mergedLines.push(trimmed);
        } else if (mergedLines.length > 0) {
          mergedLines[mergedLines.length - 1] += ' ' + trimmed;
        }
      }

      let imported = 0;
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
        if (!name || !description) { errors++; continue; }
        config.modeOverrides[name] = { description, group: normalizeGroup(group) };
        imported++;
      }
      await saveConfig();
      sendStateToFrontend();
      if (imported > 0) toast.success(`Imported ${imported} mode(s)`);
      if (errors > 0) toast.warning(`${errors} line(s) skipped due to format errors`);
      break;
    }

    case 'export_modes': {
      const lines = Object.entries(config.modeOverrides).map(
        ([name, ov]) => `${name} - ${ov.group || 'Unsorted'} - ${ov.description}`
      );
      spindle.sendToFrontend({ type: 'export_data', text: lines.join('\n'), count: lines.length });
      break;
    }

    case 'export_config': {
      // Export everything except chatStates (those are per-chat session data)
      const exportObj = {
        enabled: config.enabled,
        loadCoreModes: config.loadCoreModes,
        preFraming: config.preFraming,
        mergeFormat: config.mergeFormat,
        postFraming: config.postFraming,
        injectionPosition: config.injectionPosition,
        injectionRole: config.injectionRole,
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
      if (typeof incoming.preFraming === 'string') config.preFraming = incoming.preFraming;
      if (typeof incoming.mergeFormat === 'string') config.mergeFormat = incoming.mergeFormat;
      if (typeof incoming.postFraming === 'string') config.postFraming = incoming.postFraming;
      if (typeof incoming.injectionPosition === 'string') config.injectionPosition = incoming.injectionPosition as any;
      if (typeof incoming.injectionRole === 'string') config.injectionRole = incoming.injectionRole as any;
      if (incoming.modeOverrides && typeof incoming.modeOverrides === 'object') {
        config.modeOverrides = incoming.modeOverrides;
      }
      if (incoming.presets && typeof incoming.presets === 'object') {
        config.presets = incoming.presets;
      }
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

    case 'reset_defaults':
      // Preserve user's presets — they represent meaningful work.
      const preservedPresets = config.presets;
      config = {
        enabled: true, loadCoreModes: true,
        preFraming: DEFAULT_PRE_FRAMING, mergeFormat: DEFAULT_MERGE_FORMAT,
        postFraming: DEFAULT_POST_FRAMING,
        injectionPosition: 'prepend', injectionRole: 'system',
        deterministic: false, sortMode: 'group',
        modeOverrides: {}, chatStates: {}, presets: preservedPresets,
      };
      lastUndo = null;
      await saveConfig();
      sendStateToFrontend();
      toast.success('Extension reset to defaults');
      break;

    case 'disable_all': {
      if (!config.enabled) return;
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
      if (!config.enabled) return;
      const view = getModesView(chatId);
      const inactive = view.filter((m) => m.status === 'OFF');
      if (inactive.length === 0) { toast.info('No inactive modes available'); return; }
      const pick = inactive[Math.floor(Math.random() * inactive.length)];
      const st = getChatState(chatId);
      st[pick.name] = { status: 'ON', schedule: st[pick.name]?.schedule || 'X' };
      await saveConfig();
      sendStateToFrontend();
      toast.success(`Randomly activated: ${pick.name}`);
      break;
    }

    case 'update_schedules': {
      const st = peekChatState(chatId);
      for (const [modeName, schedule] of Object.entries(payload.schedules as Record<string, string>)) {
        if (st[modeName]) {
          let val = schedule.toUpperCase().replace(/[^\-X0-9]/g, '');
          st[modeName].schedule = val || 'X';
        }
      }
      await saveConfig();
      sendStateToFrontend();
      break;
    }

    case 'save_preset': {
      const name = (payload.name || '').trim();
      if (!name) { toast.error('Preset name required'); return; }
      const st = peekChatState(chatId);
      const onModes = Object.entries(st)
        .filter(([, s]) => s.status === 'ON')
        .map(([n]) => n);
      if (onModes.length === 0) { toast.warning('No modes are active to save'); return; }
      config.presets[name] = { name, modes: onModes };
      await saveConfig();
      sendStateToFrontend();
      toast.success(`Preset "${name}" saved (${onModes.length} mode${onModes.length === 1 ? '' : 's'})`);
      break;
    }

    case 'load_preset': {
      if (!config.enabled) return;
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
      // Turn ON all preset modes (preserves existing schedule if present)
      let activated = 0;
      for (const modeName of preset.modes) {
        const prev = st[modeName];
        const wasOn = prev?.status === 'ON';
        st[modeName] = { status: 'ON', schedule: prev?.schedule || 'X' };
        if (!wasOn) activated++;
      }
      lastUndo = { chatId, label: `Load "${name}"`, states: undoSnapshot };
      await saveConfig();
      sendStateToFrontend();
      const verb = mergeMode === 'replace' ? 'Loaded' : 'Merged';
      toast.success(`${verb} "${name}" — ${activated} mode${activated === 1 ? '' : 's'} activated · undo available`);
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
  tick = 0;
  sendStateToFrontend();
});

// Note: there is no per-turn state to refresh anymore (ON is the only state and
// it changes only through explicit user actions). We therefore don't subscribe
// to GENERATION_ENDED — which in Lumiverse 1.0 would require the broad
// `generation` permission this extension intentionally avoids.

// ===== Interceptor =====
spindle.permissions.onDenied(({ permission, operation }) => {
  spindle.log.warn(`Permission "${permission}" denied for ${operation}`);
});

// Subset of the interceptor context we rely on. The full object also carries
// connectionId, personaId, generationType and activatedWorldInfo (Lumiverse 1.0).
interface InterceptorContext {
  chatId?: string;
  connectionId?: string;
  personaId?: string;
  userId?: string;
  generationType?: string;
}

spindle.registerInterceptor(async (messages, context) => {
  if (!config.enabled) return messages;

  const ctx = context as InterceptorContext;

  // DIAGNOSTIC: confirm we have a userId to resolve persona/macros with. The
  // interceptor context never carries one on operator-scoped installs, so we
  // rely on currentUserId captured from frontend messages (set elsewhere).
  spindle.log.info(
    `Interceptor: chatId=${ctx?.chatId ?? '(none)'} personaId=${
      ctx?.personaId ?? '(none)'
    } currentUserId=${currentUserId ?? '(none)'}`,
  );

  // Use generation context's chatId as source of truth; it's the actual chat
  // this generation is for, regardless of any UI state drift.
  const chatId = ctx?.chatId || currentChatId || 'default';
  if (chatId !== currentChatId) currentChatId = chatId;

  // The active persona / user identity for operator-scoped resolution. The
  // interceptor context doesn't provide it, so use the userId captured from
  // frontend traffic; fall back to ctx.userId in case a host version supplies it.
  const userId = currentUserId ?? ctx?.userId;

  const view = getModesView(chatId);

  // Only ON modes are injected. A mode that is off has no line at all — its
  // absence is what "off" means. No status text, no "[OFF]", nothing to plant.
  const onModes = view.filter((m) => m.status === 'ON');

  if (onModes.length > 0 && messages.length > 0) {
    const mergeFormat = config.mergeFormat || DEFAULT_MERGE_FORMAT;
    const lines: string[] = [];
    for (const m of onModes) {
      // Schedule mask (skipped in deterministic mode): a failed roll simply
      // omits this mode's line this turn — fade by omission, never by "[OFF]".
      if (!config.deterministic) {
        const schedule = m.schedule || 'X';
        const tickChar = schedule[tick % schedule.length];
        const prob = parseInt(tickChar.replace('X', '10').replace('-', '0')) * 10;
        const active = Math.round(Math.random() * 100) <= prob;
        if (!active) continue;
      }
      lines.push(mergeFormat
        .replaceAll('{{modeName}}', m.name)
        .replaceAll('{{displayStatus}}', 'ON')
        .replaceAll('{{modeDescription}}', m.description));
    }

    if (lines.length > 0) {
      const pre = (config.preFraming ?? DEFAULT_PRE_FRAMING).trim();
      const post = (config.postFraming ?? DEFAULT_POST_FRAMING).trim();
      let modeText = '\n' + pre + '\n\n' + lines.join('\n') + '\n\n' + post + '\n';

      // Resolve {{user}} ourselves first. The macro engine binds character and
      // chat context from chatId, but NOT the active persona, so {{user}} would
      // otherwise reach the model as the literal string "{{user}}" (and the model
      // then invents a stranger by that name). We have the active persona id on
      // the interceptor context; look up its name and substitute it in before
      // handing the rest of the text to the engine.
      if (modeText.includes('{{user}}')) {
        try {
          // On operator-scoped installs the persona API needs an explicit
          // userId (the one captured from frontend traffic above). On user-scoped
          // installs it's undefined and the host infers it automatically.
          const persona = ctx.personaId
            ? await spindle.personas.get(ctx.personaId, userId)
            : await spindle.personas.getActive(userId);
          if (persona?.name) {
            modeText = modeText.replaceAll('{{user}}', persona.name);
          } else {
            spindle.log.warn('No active persona found; {{user}} left unresolved');
          }
        } catch (e) {
          spindle.log.warn(`Persona lookup failed for {{user}}: ${e}`);
        }
      }

      // Resolve the remaining Lumiverse macros ({{char}}, etc.) in the final
      // text. characterId is inferred from chatId by the macro engine.
      try {
        const resolved = await spindle.macros.resolve(modeText, {
          chatId,
          userId,
        });
        if (resolved?.text) modeText = resolved.text;
        // Surface macro-engine warnings instead of swallowing them, so an
        // unresolved token shows up in the logs rather than silently shipping.
        if (resolved?.diagnostics?.length) {
          spindle.log.warn(
            `Macro resolve diagnostics: ${JSON.stringify(resolved.diagnostics)}`,
          );
        }
      } catch (e) {
        // Don't fail generation if the macro API is unavailable — inject the
        // text unresolved, but log it rather than swallowing the error silently.
        spindle.log.warn(`Macro resolve failed, injecting unresolved: ${e}`);
      }

      const position = config.injectionPosition || 'prepend';
      const role = config.injectionRole || 'system';

      if (position === 'prepend') {
        // Prepend to last user message (always user)
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'user') {
            messages[i].content = modeText + '\n' + messages[i].content;
            break;
          }
        }
      } else if (position === 'append') {
        // Append to last user message (always user)
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'user') {
            messages[i].content = messages[i].content + '\n' + modeText;
            break;
          }
        }
      } else if (position === 'before_user') {
        // Insert separate message before last user message
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'user') {
            messages.splice(i, 0, { role, content: modeText });
            break;
          }
        }
      } else if (position === 'start') {
        // Insert as first message
        messages.unshift({ role, content: modeText });
      } else if (position === 'end') {
        // Insert as last message
        messages.push({ role, content: modeText });
      }
    }

    tick++;
  }

  // Nothing to persist or refresh per-turn: ON is the only state, and it only
  // changes through explicit user actions (which already save + refresh).
  return messages;
});

// ===== Init =====
(async () => {
  await loadConfig();
  await loadCoreModesFromStorage();

  // Resolve the real active chatId immediately
  currentChatId = await resolveActiveChatId();

  sendStateToFrontend();
})();
