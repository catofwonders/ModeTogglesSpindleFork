declare const spindle: import('lumiverse-spindle-types').SpindleAPI;

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
    const raw = await spindle.storage.readFile('config.json');
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
    await spindle.storage.writeFile('config.json', JSON.stringify(config, null, 2));
  } catch (e) {
    spindle.log.error(`Failed to save config: ${e}`);
  }
}

async function loadCoreModes(): Promise<void> {
  const all: ModeDefinition[] = [];
  for (let n = 1; ; n++) {
    try {
      const text = await spindle.storage.readFile(`modes/modes_${n}.txt`);
      if (!text) break;

      const lines = text.split('\n').map((l: string) => l.trim()).filter(Boolean);
      for (const line of lines) {
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
  spindle.frontend.send('state_update', {
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

// ===== Message Handlers from Frontend =====
spindle.frontend.onMessage('toggle_mode', async (data: { modeName: string }) => {
  if (!config.enabled) return;
  const state = getChatState(currentChatId);
  const curr = state[data.modeName]?.status ?? 'OFF';

  let next: ModeState['status'];
  switch (curr) {
    case 'OFF':     next = 'Activating'; break;
    case 'ON':      next = 'Deactivating'; break;
    case 'Activating':  next = 'OFF'; break;
    case 'Deactivating': next = 'ON'; break;
    default:        next = 'OFF';
  }

  state[data.modeName] = { status: next, schedule: state[data.modeName]?.schedule || 'X' };
  await saveConfig();
  sendStateToFrontend();
});

spindle.frontend.onMessage('set_enabled', async (data: { enabled: boolean }) => {
  config.enabled = data.enabled;
  await saveConfig();
  sendStateToFrontend();
  spindle.toast.info(config.enabled ? 'Mode Toggles enabled' : 'Mode Toggles disabled');
});

spindle.frontend.onMessage('update_settings', async (data: Partial<Config>) => {
  if (data.loadCoreModes !== undefined) config.loadCoreModes = data.loadCoreModes;
  if (data.preFraming !== undefined) config.preFraming = data.preFraming;
  if (data.mergeFormat !== undefined) config.mergeFormat = data.mergeFormat;
  if (data.postFraming !== undefined) config.postFraming = data.postFraming;
  if (data.countdown !== undefined) config.countdown = data.countdown;
  await saveConfig();
  sendStateToFrontend();
});

spindle.frontend.onMessage('add_edit_mode', async (data: { name: string; group: string; description: string }) => {
  if (!data.name) return;
  if (!data.description) {
    // Remove override
    delete config.modeOverrides[data.name];
    const isDefault = coreModes.some((m) => m.name === data.name);
    if (!isDefault) {
      for (const chatId of Object.keys(config.chatStates)) {
        delete config.chatStates[chatId][data.name];
      }
    }
    spindle.toast.success(`Mode "${data.name}" override removed`);
  } else {
    config.modeOverrides[data.name] = { description: data.description, group: data.group || 'Unsorted' };
    spindle.toast.success(`Mode "${data.name}" saved`);
  }
  await saveConfig();
  sendStateToFrontend();
});

spindle.frontend.onMessage('import_modes', async (data: { text: string }) => {
  const lines = data.text.split('\n').map((l: string) => l.trim()).filter(Boolean);
  let imported = 0;
  let errors = 0;

  for (const line of lines) {
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
      errors++;
      continue;
    }
    if (!name || !description) { errors++; continue; }
    config.modeOverrides[name] = { description, group };
    imported++;
  }

  await saveConfig();
  sendStateToFrontend();
  if (imported > 0) spindle.toast.success(`Imported ${imported} mode(s)`);
  if (errors > 0) spindle.toast.warning(`${errors} line(s) skipped due to format errors`);
});

spindle.frontend.onMessage('export_modes', () => {
  const overrides = config.modeOverrides;
  const lines = Object.entries(overrides).map(
    ([name, ov]) => `${name} - ${ov.group || 'Unsorted'} - ${ov.description}`
  );
  spindle.frontend.send('export_data', { text: lines.join('\n'), count: lines.length });
});

spindle.frontend.onMessage('remove_all_custom', async () => {
  const defaultNames = new Set(coreModes.map((m) => m.name));
  const toRemove = new Set<string>();

  for (const name of Object.keys(config.modeOverrides)) {
    if (!defaultNames.has(name)) toRemove.add(name);
    delete config.modeOverrides[name];
  }

  for (const chatId of Object.keys(config.chatStates)) {
    for (const name of toRemove) {
      delete config.chatStates[chatId][name];
    }
  }

  await saveConfig();
  sendStateToFrontend();
  spindle.toast.success('All custom modes removed');
});

spindle.frontend.onMessage('reset_defaults', async () => {
  config = {
    enabled: true,
    loadCoreModes: true,
    preFraming: DEFAULT_PRE_FRAMING,
    mergeFormat: DEFAULT_MERGE_FORMAT,
    postFraming: DEFAULT_POST_FRAMING,
    countdown: DEFAULT_COUNTDOWN,
    modeOverrides: {},
    chatStates: {},
  };
  await saveConfig();
  sendStateToFrontend();
  spindle.toast.success('Extension reset to defaults');
});

spindle.frontend.onMessage('disable_all', async () => {
  if (!config.enabled) return;
  const state = getChatState(currentChatId);
  let count = 0;
  for (const [name, st] of Object.entries(state)) {
    if (st.status === 'ON' || st.status === 'Activating' || st.status === 'Deactivating') {
      st.status = 'Deactivating';
      delete st.countdown;
      count++;
    }
  }
  await saveConfig();
  sendStateToFrontend();
  if (count > 0) spindle.toast.success(`Disabled ${count} mode(s)`);
  else spindle.toast.info('No active modes to disable');
});

spindle.frontend.onMessage('activate_random', async () => {
  if (!config.enabled) return;
  const view = getModesView(currentChatId);
  const inactive = view.filter((m) => m.status === 'OFF');
  if (inactive.length === 0) {
    spindle.toast.info('No inactive modes available');
    return;
  }
  const pick = inactive[Math.floor(Math.random() * inactive.length)];
  const state = getChatState(currentChatId);
  state[pick.name] = { status: 'Activating', schedule: state[pick.name]?.schedule || 'X' };
  await saveConfig();
  sendStateToFrontend();
  spindle.toast.success(`Randomly activated: ${pick.name}`);
});

spindle.frontend.onMessage('update_schedules', async (data: { schedules: Record<string, string> }) => {
  const state = getChatState(currentChatId);
  for (const [modeName, schedule] of Object.entries(data.schedules)) {
    if (state[modeName]) {
      let val = schedule.toUpperCase().replace(/[^\-X0-9]/g, '');
      state[modeName].schedule = val || 'X';
    }
  }
  await saveConfig();
  sendStateToFrontend();
});

spindle.frontend.onMessage('request_state', () => {
  sendStateToFrontend();
});

// ===== Events =====
spindle.events.on('chat_changed', (data: any) => {
  currentChatId = data?.chatId || 'default';
  tick = 0;
  sendStateToFrontend();
  const state = getChatState(currentChatId);
  const activeCount = Object.values(state).filter((s) => s.status === 'ON').length;
  if (activeCount > 0) {
    spindle.toast.info(`Restored ${activeCount} active mode(s)`);
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

  // Decide which modes to include
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

      // Apply schedule
      const schedule = m.schedule || 'X';
      const tickChar = schedule[tick % schedule.length];
      const prob = parseInt(tickChar.replace('X', '10').replace('-', '0')) * 10;
      const active = Math.round(Math.random() * 100) <= prob;

      if (displayStatus === 'ON' && !active) {
        displayStatus = 'OFF';
      }

      return mergeFormat
        .replaceAll('{{modeName}}', m.name)
        .replaceAll('{{displayStatus}}', displayStatus)
        .replaceAll('{{modeDescription}}', m.description);
    });

    const pre = (config.preFraming ?? DEFAULT_PRE_FRAMING).trim();
    const post = (config.postFraming ?? DEFAULT_POST_FRAMING).trim();
    const prefix = '\n' + pre + '\n\n' + lines.join('\n') + '\n\n' + post + '\n\n';

    // Find last user message and prepend
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
      st.status = 'ON';
      delete st.countdown;
    } else if (st.status === 'Deactivating') {
      st.status = 'OFF';
      st.countdown = config.countdown;
    } else if (st.status === 'OFF' && st.countdown !== undefined) {
      st.countdown--;
      if (st.countdown <= 0) {
        delete state[name];
        removed.push(name);
      }
    }
  }

  if (removed.length) {
    spindle.toast.info(`Cleared ${removed.length} mode(s) from memory`);
  }

  saveConfig(); // fire-and-forget
  sendStateToFrontend();

  return messages;
});

// ===== Init =====
(async () => {
  await loadConfig();
  await loadCoreModes();
  spindle.log.info('Mode Toggles extension initialized');
  sendStateToFrontend();
})();
