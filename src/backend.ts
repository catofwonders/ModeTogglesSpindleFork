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
  status: 'OFF' | 'ON' | 'Activating' | 'Deactivating';
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
  modeOverrides: Record<string, { description: string; group: string }>;
  chatStates: Record<string, Record<string, ModeState>>;
}

// ===== Constants =====
const DEFAULT_PRE_FRAMING =
  'Current Active or now Disabled non-diegetic modifier modes:\n(ON = world rule applies. OFF = no effect; earlier mentions are non-canon.)\n\n';
const DEFAULT_MERGE_FORMAT =
  '[{{modeName}} {{displayStatus}}] - (Effect when ON "{{modeDescription}}", should be removed when OFF)';
const DEFAULT_POST_FRAMING =
  'No reference should be made to the presence of these modifier modes inside the chat, only their effects.';
const DEFAULT_COUNTDOWN = 5;

// ===== State =====
let config: Config = {
  enabled: true,
  loadCoreModes: true,
  preFraming: DEFAULT_PRE_FRAMING,
  mergeFormat: DEFAULT_MERGE_FORMAT,
  postFraming: DEFAULT_POST_FRAMING,
  countdown: DEFAULT_COUNTDOWN,
  modeOverrides: {},
  chatStates: {},
};

let coreModes: ModeDefinition[] = [];
let tick = 0;
let currentChatId = 'default';

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
}

async function saveConfig(): Promise<void> {
  try {
    await spindle.storage.write('config.json', JSON.stringify(config, null, 2));
  } catch (e) {
    spindle.log.error(`Failed to save config: ${e}`);
  }
}

async function loadCoreModesFromStorage(): Promise<void> {
  const all: ModeDefinition[] = [];
  const seen = new Set<string>();
  for (let n = 1; ; n++) {
    try {
      const text = await spindle.storage.read(`modes/modes_${n}.txt`);
      if (!text) break;

      // Pre-process: join continuation lines
      const rawLines = text.replace(/\r/g, '').split('\n');
      const mergedLines: string[] = [];
      for (const raw of rawLines) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        const dashCount = (trimmed.match(/ - /g) || []).length;
        if (dashCount >= 2) {
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
      break;
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
  spindle.sendToFrontend({
    type: 'state_update',
    enabled: config.enabled,
    modes: view,
    activeCount,
    settings: {
      loadCoreModes: config.loadCoreModes,
      preFraming: config.preFraming,
      mergeFormat: config.mergeFormat,
      postFraming: config.postFraming,
      countdown: config.countdown,
    },
  });
}

// ===== Message Handler from Frontend =====
spindle.onFrontendMessage(async (payload: any) => {
  switch (payload.type) {
    case 'request_state':
      sendStateToFrontend();
      break;

    case 'toggle_mode': {
      if (!config.enabled) return;
      const state = getChatState(currentChatId);
      const curr = state[payload.modeName]?.status ?? 'OFF';
      let next: ModeState['status'];
      switch (curr) {
        case 'OFF':          next = 'Activating'; break;
        case 'ON':           next = 'Deactivating'; break;
        case 'Activating':   next = 'OFF'; break;
        case 'Deactivating': next = 'ON'; break;
        default:             next = 'OFF';
      }
      state[payload.modeName] = { status: next, schedule: state[payload.modeName]?.schedule || 'X' };
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
      // (at least 2 " - " separators). Lines that don't match get appended to the previous entry.
      const rawLines = payload.text.replace(/\r/g, '').split('\n');
      const mergedLines: string[] = [];

      for (const raw of rawLines) {
        const trimmed = raw.trim();
        if (!trimmed) continue; // skip blank lines

        // Check if this looks like a new entry: must have at least 2 " - " separators
        const dashCount = (trimmed.match(/ - /g) || []).length;
        if (dashCount >= 2) {
          mergedLines.push(trimmed);
        } else if (mergedLines.length > 0) {
          // Continuation of previous entry — append to its description
          mergedLines[mergedLines.length - 1] += ' ' + trimmed;
        }
        // else: orphan line before any entry, skip
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
      config = {
        enabled: true, loadCoreModes: true,
        preFraming: DEFAULT_PRE_FRAMING, mergeFormat: DEFAULT_MERGE_FORMAT,
        postFraming: DEFAULT_POST_FRAMING, countdown: DEFAULT_COUNTDOWN,
        modeOverrides: {}, chatStates: {},
      };
      await saveConfig();
      sendStateToFrontend();
      toast.success('Extension reset to defaults');
      break;

    case 'disable_all': {
      if (!config.enabled) return;
      const st = getChatState(currentChatId);
      let count = 0;
      for (const [, s] of Object.entries(st)) {
        if (s.status === 'ON' || s.status === 'Activating' || s.status === 'Deactivating') {
          s.status = 'Deactivating';
          delete s.countdown;
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
      const view = getModesView(currentChatId);
      const inactive = view.filter((m) => m.status === 'OFF');
      if (inactive.length === 0) { toast.info('No inactive modes available'); return; }
      const pick = inactive[Math.floor(Math.random() * inactive.length)];
      const st = getChatState(currentChatId);
      st[pick.name] = { status: 'Activating', schedule: st[pick.name]?.schedule || 'X' };
      await saveConfig();
      sendStateToFrontend();
      toast.success(`Randomly activated: ${pick.name}`);
      break;
    }

    case 'update_schedules': {
      const st = getChatState(currentChatId);
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
  }
});

// ===== Events =====
spindle.on('CHAT_CHANGED', (data: any) => {
  currentChatId = data?.chatId || 'default';
  tick = 0;
  sendStateToFrontend();
  const state = getChatState(currentChatId);
  const activeCount = Object.values(state).filter((s) => s.status === 'ON').length;
  if (activeCount > 0) {
    toast.info(`Restored ${activeCount} active mode(s)`);
  }
});

// ===== Interceptor =====
spindle.permissions.onDenied(({ permission, operation }) => {
  spindle.log.warn(`Permission "${permission}" denied for ${operation}`);
});

spindle.registerInterceptor(async (messages, ctx) => {
  if (!config.enabled) return messages;

  const state = getChatState(currentChatId);
  const view = getModesView(currentChatId);

  const modesToInclude = view.filter((m) => {
    const activeish = m.status === 'ON' || m.status === 'Activating' || m.status === 'Deactivating';
    const wasActiveButOff = state[m.name] && m.status === 'OFF';
    return activeish || wasActiveButOff;
  });

  if (modesToInclude.length > 0 && messages.length > 0) {
    const mergeFormat = config.mergeFormat || DEFAULT_MERGE_FORMAT;
    const lines = modesToInclude.map((m) => {
      let displayStatus = m.status;
      if (displayStatus === 'Activating') displayStatus = 'ON';
      if (displayStatus === 'Deactivating') displayStatus = 'OFF';

      const schedule = m.schedule || 'X';
      const tickChar = schedule[tick % schedule.length];
      const prob = parseInt(tickChar.replace('X', '10').replace('-', '0')) * 10;
      const active = Math.round(Math.random() * 100) <= prob;

      if (displayStatus === 'ON' && !active) displayStatus = 'OFF';

      return mergeFormat
        .replaceAll('{{modeName}}', m.name)
        .replaceAll('{{displayStatus}}', displayStatus)
        .replaceAll('{{modeDescription}}', m.description);
    });

    const pre = (config.preFraming ?? DEFAULT_PRE_FRAMING).trim();
    const post = (config.postFraming ?? DEFAULT_POST_FRAMING).trim();
    const prefix = '\n' + pre + '\n\n' + lines.join('\n') + '\n\n' + post + '\n\n';

    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        messages[i].content = prefix + messages[i].content;
        tick++;
        break;
      }
    }
  }

  // Apply transitions and countdowns
  const removed: string[] = [];
  for (const [name, st] of Object.entries(state)) {
    if (st.status === 'Activating') {
      st.status = 'ON'; delete st.countdown;
    } else if (st.status === 'Deactivating') {
      st.status = 'OFF'; st.countdown = config.countdown;
    } else if (st.status === 'OFF' && st.countdown !== undefined) {
      st.countdown--;
      if (st.countdown <= 0) { delete state[name]; removed.push(name); }
    }
  }

  if (removed.length) toast.info(`Cleared ${removed.length} mode(s) from memory`);

  saveConfig();
  sendStateToFrontend();
  return messages;
});

// ===== Init =====
(async () => {
  await loadConfig();
  await loadCoreModesFromStorage();
  spindle.log.info('Mode Toggles extension initialized');
  sendStateToFrontend();
})();
