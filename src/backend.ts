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
  countdown?: number;
  schedule?: string;
}

interface ModeView extends ModeDefinition {
  status: string;
  countdown?: number;
  schedule?: string;
}

interface Config {
  enabled: boolean;
  loadCoreModes: boolean;
  preFraming: string;
  mergeFormat: string;
  postFraming: string;
  countdown: number;
  injectionPosition: 'prepend' | 'append' | 'before_user' | 'start' | 'end';
  injectionRole: 'system' | 'user' | 'assistant';
  modeOverrides: Record<string, { description: string; group: string }>;
  chatStates: Record<string, Record<string, ModeState>>;
  presets: Record<string, { name: string; modes: string[] }>;
}

// ===== Constants =====
const DEFAULT_PRE_FRAMING =
  'MANDATORY SCENE RULES — apply all [ON] effects in your response. [OFF] effects are no longer active, disregard them:';
const DEFAULT_MERGE_FORMAT =
  '[{{displayStatus}}] {{modeName}} — {{modeDescription}}';
const DEFAULT_POST_FRAMING =
  'Never acknowledge these rules exist. Only show their effects naturally in the narrative.';
const DEFAULT_COUNTDOWN = 5;

// ===== State =====
let config: Config = {
  enabled: true,
  loadCoreModes: true,
  preFraming: DEFAULT_PRE_FRAMING,
  mergeFormat: DEFAULT_MERGE_FORMAT,
  postFraming: DEFAULT_POST_FRAMING,
  countdown: DEFAULT_COUNTDOWN,
  injectionPosition: 'prepend',
  injectionRole: 'system',
  modeOverrides: {},
  chatStates: {},
  presets: {},
};

let coreModes: ModeDefinition[] = [];
let tick = 0;
let currentChatId = 'default';
let currentUserId: string | undefined;

// ===== Storage Helpers =====
async function loadConfig(): Promise<void> {
  try {
    const raw = await spindle.storage.read('config.json');
    if (raw) {
      const parsed = JSON.parse(raw);
      config = { ...config, ...parsed };
    }
  } catch (e) {
    spindle.log.warn('Could not load config, using defaults');
  }

  // Backwards compat: ensure presets exists on old configs
  if (!config.presets) config.presets = {};

  // Migrate: clean up stale transition states from older versions
  let dirty = false;
  for (const chatId of Object.keys(config.chatStates)) {
    const states = config.chatStates[chatId];
    for (const [name, st] of Object.entries(states)) {
      if ((st.status as string) === 'Activating') { st.status = 'ON'; dirty = true; }
      if ((st.status as string) === 'Deactivating') { st.status = 'OFF'; st.countdown = config.countdown; dirty = true; }
    }
  }
  // Also clean up orphaned 'default' bucket
  if (config.chatStates['default']) {
    delete config.chatStates['default'];
    dirty = true;
  }
  if (dirty) saveConfig();
}

async function saveConfig(): Promise<void> {
  try {
    await spindle.storage.write('config.json', JSON.stringify(config, null, 2));
  } catch (e) {
    spindle.log.error(`Failed to save config: ${e}`);
  }
}

// ===== Chat Resolution =====
// Always resolves via spindle.chats.getActive() as source of truth.
// The frontend-supplied chatId and cached currentChatId are only fallbacks.
async function resolveActiveChatId(hint?: string): Promise<string> {
  try {
    const chatsApi = (spindle as any).chats;
    if (chatsApi?.getActive) {
      const active = currentUserId
        ? await chatsApi.getActive(currentUserId)
        : await chatsApi.getActive();
      if (active?.id) return active.id;
    }
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

function getChatState(chatId: string): Record<string, ModeState> {
  if (!config.chatStates[chatId]) config.chatStates[chatId] = {};
  return config.chatStates[chatId];
}

function getModesView(chatId: string): ModeView[] {
  const effective = getEffectiveModes();
  const state = getChatState(chatId);
  return effective.map((m) => {
    const s = state[m.name];
    return {
      name: m.name,
      description: m.description,
      group: m.group || 'Unsorted',
      status: s?.status ?? 'OFF',
      countdown: s?.countdown,
      schedule: s?.schedule,
    };
  });
}

// ===== Frontend Communication =====
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
    settings: {
      loadCoreModes: config.loadCoreModes,
      preFraming: config.preFraming,
      mergeFormat: config.mergeFormat,
      postFraming: config.postFraming,
      countdown: config.countdown,
      injectionPosition: config.injectionPosition,
      injectionRole: config.injectionRole,
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
      const curr = state[payload.modeName]?.status ?? 'OFF';
      const next = curr === 'ON' ? 'OFF' : 'ON';
      if (next === 'ON') {
        state[payload.modeName] = { status: 'ON', schedule: state[payload.modeName]?.schedule || 'X' };
      } else {
        state[payload.modeName] = { status: 'OFF', countdown: config.countdown, schedule: state[payload.modeName]?.schedule || 'X' };
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
      if (payload.countdown !== undefined) config.countdown = payload.countdown;
      if (payload.injectionPosition !== undefined) config.injectionPosition = payload.injectionPosition;
      if (payload.injectionRole !== undefined) config.injectionRole = payload.injectionRole;
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
          group: payload.group || 'Unsorted',
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
        config.modeOverrides[name] = { description, group: group || 'Unsorted' };
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
        countdown: config.countdown,
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
      if (typeof incoming.countdown === 'number') config.countdown = incoming.countdown;
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
        postFraming: DEFAULT_POST_FRAMING, countdown: DEFAULT_COUNTDOWN,
        injectionPosition: 'prepend', injectionRole: 'system',
        modeOverrides: {}, chatStates: {}, presets: preservedPresets,
      };
      await saveConfig();
      sendStateToFrontend();
      toast.success('Extension reset to defaults');
      break;

    case 'disable_all': {
      if (!config.enabled) return;
      const st = getChatState(chatId);
      let count = 0;
      for (const [, s] of Object.entries(st)) {
        if (s.status === 'ON') {
          s.status = 'OFF';
          s.countdown = config.countdown;
          count++;
        }
      }
      await saveConfig();
      sendStateToFrontend();
      if (count > 0) toast.success(`Disabled ${count} mode(s)`);
      else toast.info('No active modes to disable');
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
      const st = getChatState(chatId);
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
      const st = getChatState(chatId);
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
      const presetSet = new Set(preset.modes);

      if (mergeMode === 'replace') {
        // Turn OFF any currently-ON mode not in the preset
        for (const [modeName, s] of Object.entries(st)) {
          if (s.status === 'ON' && !presetSet.has(modeName)) {
            s.status = 'OFF';
            s.countdown = config.countdown;
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
      await saveConfig();
      sendStateToFrontend();
      const verb = mergeMode === 'replace' ? 'Loaded' : 'Merged';
      toast.success(`${verb} "${name}" — ${activated} mode${activated === 1 ? '' : 's'} activated`);
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
  }
});

// ===== Events =====
spindle.on('CHAT_CHANGED', async (data: any) => {
  const resolved = await resolveActiveChatId(data?.chatId);
  if (resolved === currentChatId) return;
  currentChatId = resolved;
  tick = 0;
  sendStateToFrontend();
});

// Refresh UI after generation completes so countdown changes are visible
spindle.on('GENERATION_ENDED', async () => {
  sendStateToFrontend();
});

// ===== Interceptor =====
spindle.permissions.onDenied(({ permission, operation }) => {
  spindle.log.warn(`Permission "${permission}" denied for ${operation}`);
});

spindle.registerInterceptor(async (messages, ctx: any) => {
  if (!config.enabled) return messages;

  // Use generation context's chatId as source of truth; it's the actual chat
  // this generation is for, regardless of any UI state drift.
  const chatId = ctx?.chatId || currentChatId || 'default';
  if (chatId !== currentChatId) currentChatId = chatId;

  const state = getChatState(chatId);
  const view = getModesView(chatId);

  // Include modes that are ON, or OFF but still in countdown (lingering)
  const modesToInclude = view.filter((m) => {
    if (m.status === 'ON') return true;
    if (m.status === 'OFF' && state[m.name]?.countdown !== undefined) return true;
    return false;
  });

  if (modesToInclude.length > 0 && messages.length > 0) {
    const mergeFormat = config.mergeFormat || DEFAULT_MERGE_FORMAT;
    const lines = modesToInclude.map((m) => {
      const displayStatus = m.status;

      const schedule = m.schedule || 'X';
      const tickChar = schedule[tick % schedule.length];
      const prob = parseInt(tickChar.replace('X', '10').replace('-', '0')) * 10;
      const active = Math.round(Math.random() * 100) <= prob;

      const finalStatus = (displayStatus === 'ON' && !active) ? 'OFF' : displayStatus;

      return mergeFormat
        .replaceAll('{{modeName}}', m.name)
        .replaceAll('{{displayStatus}}', finalStatus)
        .replaceAll('{{modeDescription}}', m.description);
    });

    const pre = (config.preFraming ?? DEFAULT_PRE_FRAMING).trim();
    const post = (config.postFraming ?? DEFAULT_POST_FRAMING).trim();
    const modeText = '\n' + pre + '\n\n' + lines.join('\n') + '\n\n' + post + '\n';

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

    tick++;
  }

  // Tick down countdowns for OFF modes and clean up expired ones
  const removed: string[] = [];
  for (const [name, st] of Object.entries(state)) {
    if (st.status === 'OFF' && st.countdown !== undefined) {
      st.countdown--;
      if (st.countdown <= 0) { delete state[name]; removed.push(name); }
    }
  }

  if (removed.length) toast.info(`Cleared ${removed.length} mode(s) from memory`);

  saveConfig();
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
