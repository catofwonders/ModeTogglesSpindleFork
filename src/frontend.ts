import type { SpindleFrontendContext } from 'lumiverse-spindle-types';

interface ModeView {
  name: string;
  group: string;
  description: string;
  status: string;
  countdown?: number;
  schedule?: string;
}

interface StateUpdate {
  type: 'state_update';
  enabled: boolean;
  modes: ModeView[];
  activeCount: number;
  chatId: string;
  presets: Array<{ name: string; count: number }>;
  settings: {
    loadCoreModes: boolean;
    preFraming: string;
    mergeFormat: string;
    postFraming: string;
    countdown: number;
    injectionPosition: string;
    injectionRole: string;
  };
}

interface ExportData {
  type: 'export_data';
  text: string;
  count: number;
}

const MICROCHIP_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="20" height="20"><path d="M5 3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H5zm2 2h6v6H7V5zm1 1v4h4V6H8zM2 7h1v2H2V7zm15 0h1v2h-1V7zM2 11h1v2H2v-2zm15 0h1v2h-1v-2zM7 0v2h2V0H7zm4 0v2h2V0h-2zM7 18v2h2v-2H7zm4 0v2h2v-2h-2z"/></svg>';
const MICROCHIP_SVG_14 = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path d="M5 3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H5zm2 2h6v6H7V5zm1 1v4h4V6H8zM2 7h1v2H2V7zm15 0h1v2h-1V7zM2 11h1v2H2v-2zm15 0h1v2h-1v-2zM7 0v2h2V0H7zm4 0v2h2V0h-2zM7 18v2h2v-2H7zm4 0v2h2v-2h-2z"/></svg>';

export function setup(ctx: SpindleFrontendContext) {
  let state: StateUpdate | null = null;
  let searchQuery = '';
  let accordionOpen: Record<string, boolean> = {};
  let tab: any = null;
  let toggleAction: any = null;
  let currentChatId: string = '';

  // Helper: send message to backend, always including chatId
  function send(payload: Record<string, any>) {
    ctx.sendToBackend({ ...payload, chatId: currentChatId });
  }

  // ===== Styles =====
  ctx.dom.addStyle(`
    .mt-container { font-family: inherit; font-size: 13px; color: var(--lumiverse-text, #ddd); }
    .mt-section { margin-bottom: 12px; }
    .mt-label { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; cursor: pointer; }
    .mt-label input[type="checkbox"] { margin: 0; }
    .mt-textarea { width: 100%; padding: 6px 8px; border-radius: var(--lumiverse-radius, 4px);
      border: 1px solid var(--lumiverse-border, #444); background: var(--lumiverse-fill-subtle, #222);
      color: var(--lumiverse-text, #ddd); resize: vertical; min-height: 60px;
      font-family: inherit; font-size: 12px; box-sizing: border-box; }
    .mt-input { width: 80px; padding: 4px 6px; border-radius: var(--lumiverse-radius, 4px);
      border: 1px solid var(--lumiverse-border, #444); background: var(--lumiverse-fill-subtle, #222);
      color: var(--lumiverse-text, #ddd); font-family: inherit; }
    .mt-select { padding: 4px 6px; border-radius: var(--lumiverse-radius, 4px);
      border: 1px solid var(--lumiverse-border, #444); background: var(--lumiverse-fill-subtle, #222);
      color: var(--lumiverse-text, #ddd); font-family: inherit; font-size: 12px; }
    .mt-btn { padding: 6px 12px; border-radius: var(--lumiverse-radius, 4px);
      border: 1px solid var(--lumiverse-border, #444); background: var(--lumiverse-fill-subtle, #333);
      color: var(--lumiverse-text, #ddd); cursor: pointer; font-size: 12px; }
    .mt-btn:hover { border-color: var(--lumiverse-border-hover, #666); }
    .mt-btn-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
    .mt-small-label { font-size: 11px; color: var(--lumiverse-text-muted, #999); margin-bottom: 4px; display: block; }

    .mt-menu { max-height: 450px; overflow-y: auto; }
    .mt-search { width: 100%; padding: 6px 8px; border-radius: var(--lumiverse-radius, 4px);
      border: 1px solid var(--lumiverse-border, #444); background: var(--lumiverse-fill-subtle, #222);
      color: var(--lumiverse-text, #ddd); margin-bottom: 8px; box-sizing: border-box; }
    .mt-accordion-header { cursor: pointer; padding: 5px 8px;
      background: var(--lumiverse-fill-subtle, #222); color: var(--lumiverse-text-muted, #ccc);
      font-weight: 600; font-size: 12px; user-select: none; border-radius: var(--lumiverse-radius, 3px);
      margin-bottom: 2px; }
    .mt-accordion-header:hover { border-color: var(--lumiverse-border-hover, #555); }
    .mt-accordion-content { padding-left: 6px; }
    .mt-mode-btn { cursor: pointer; padding: 6px 10px;
      border-bottom: 1px solid var(--lumiverse-border, #333);
      font-size: 12px; border-radius: var(--lumiverse-radius, 3px); margin-bottom: 2px; }
    .mt-mode-btn:hover { filter: brightness(1.2); }
    .mt-mode-name { font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
    .mt-mode-edit { opacity: 0.4; font-size: 11px; padding: 2px 6px; cursor: pointer; }
    .mt-mode-edit:active { opacity: 1; }
    .mt-mode-desc { font-size: 11px; opacity: 0.8; margin-top: 2px; }
    .mt-mode-on { background: rgba(0,255,0,0.08); color: #90EE90; }
    .mt-mode-off { background: rgba(255,0,0,0.06); color: #FFB6C1; }
    .mt-mode-countdown { background: rgba(255,165,0,0.08); color: #FFD700; }
    .mt-separator { border-top: 2px solid var(--lumiverse-border, #555); margin: 6px 0; }
    .mt-action-btn { cursor: pointer; padding: 5px 10px; font-size: 12px; text-align: center;
      border-radius: var(--lumiverse-radius, 3px); flex: 1; }
    .mt-action-btn:hover { filter: brightness(1.3); }
    .mt-action-add { background: rgba(0,0,255,0.08); color: #87CEEB; }
    .mt-action-export { background: rgba(0,128,0,0.08); color: #90EE90; }
    .mt-action-import { background: rgba(255,165,0,0.08); color: #FFA500; }
    .mt-action-disable { background: rgba(255,0,0,0.08); color: #FF6B6B; }
    .mt-action-random { background: rgba(128,0,128,0.08); color: #DA70D6; }
    .mt-action-schedule { background: rgba(137,112,218,0.08); color: #8970da; }
    .mt-action-presets { background: rgba(255,215,0,0.08); color: #FFD700; }
    .mt-action-config-export { background: rgba(0,200,200,0.08); color: #5FD4D4; }
    .mt-action-config-import { background: rgba(0,200,200,0.08); color: #5FD4D4; }
    .mt-preset-row { display: flex; align-items: center; gap: 8px; padding: 8px;
      border-bottom: 1px solid var(--lumiverse-border, #333); }
    .mt-preset-row:hover { background: rgba(255,255,255,0.03); }
    .mt-preset-name { flex: 1; font-weight: 600; font-size: 13px; }
    .mt-preset-count { font-size: 11px; color: var(--lumiverse-text-muted, #999); }
    .mt-preset-btn { padding: 4px 8px; font-size: 11px; border-radius: 3px; cursor: pointer;
      border: 1px solid var(--lumiverse-border, #444); background: var(--lumiverse-fill-subtle, #222);
      color: var(--lumiverse-text, #ddd); }
    .mt-preset-btn:hover { filter: brightness(1.3); }
    .mt-preset-btn-load { background: rgba(0,128,0,0.12); color: #90EE90; border-color: rgba(0,128,0,0.3); }
    .mt-preset-btn-merge { background: rgba(0,0,255,0.12); color: #87CEEB; border-color: rgba(0,0,255,0.3); }
    .mt-preset-btn-delete { background: rgba(255,0,0,0.12); color: #FF6B6B; border-color: rgba(255,0,0,0.3); }

    .mt-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 100000;
      display: flex; align-items: center; justify-content: center; }
    .mt-modal { background: #1a1a1a; border: 1px solid var(--lumiverse-border, #444);
      border-radius: 8px; padding: 16px; max-width: 500px; width: 90%; max-height: 80vh; overflow-y: auto;
      color: var(--lumiverse-text, #ddd); }
    .mt-schedule-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .mt-schedule-table th, .mt-schedule-table td { padding: 6px 8px; text-align: left;
      border-bottom: 1px solid var(--lumiverse-border, #333); }
    .mt-schedule-input { width: 100%; padding: 4px 6px; border-radius: var(--lumiverse-radius, 3px);
      border: 1px solid var(--lumiverse-border, #444); background: var(--lumiverse-fill-subtle, #222);
      color: var(--lumiverse-text, #ddd); font-family: monospace; box-sizing: border-box; }
  `);

  // ===== Drawer Tab: Settings =====
  tab = ctx.ui.registerDrawerTab({
    id: 'mode-toggles-settings',
    title: 'Mode Toggles',
    iconSvg: MICROCHIP_SVG,
  });
  tab.onActivate(() => send({ type: 'request_state' }));
  renderSettingsTab();

  // ===== Input Bar Action: Quick Toggle Menu =====
  toggleAction = ctx.ui.registerInputBarAction({
    id: 'mode-toggles-menu',
    label: 'Mode Toggles',
    iconSvg: MICROCHIP_SVG_14,
    enabled: true,
  });
  toggleAction.onClick(() => showTogglePopover());

  // ===== Backend Messages =====
  ctx.onBackendMessage((payload: any) => {
    if (payload.type === 'state_update') {
      state = payload as StateUpdate;
      // Always sync chatId from backend
      if (state.chatId) currentChatId = state.chatId;
      updateBadge();
      renderSettingsTab();
      if (activePopover && document.body.contains(activePopover)) {
        renderPopoverContent(activePopover);
      }
    } else if (payload.type === 'export_data') {
      const data = payload as ExportData;
      const blob = new Blob([data.text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'mode-toggles-export.txt';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } else if (payload.type === 'export_config_data') {
      const blob = new Blob([payload.json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'mode-toggles-config.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  });

  // Request initial state
  send({ type: 'request_state' });

  // Proactively sync on chat switches so the popover/tab UI reflects the new
  // chat immediately, instead of waiting for a backend-driven state_update.
  ctx.events.on('CHAT_CHANGED', (data: any) => {
    const newId = data?.chatId;
    if (newId && newId !== currentChatId) {
      currentChatId = newId;
    }
    // Always ask backend for the fresh state — it will resolve via getActive()
    send({ type: 'request_state' });
  });

  // ===== Active popover tracking =====
  let activePopover: HTMLElement | null = null;

  function updateBadge() {
    if (tab && state) {
      tab.setBadge(state.activeCount > 0 ? String(state.activeCount) : '');
    }
    if (toggleAction && state) {
      toggleAction.setLabel(
        state.activeCount > 0 ? `Mode Toggles (${state.activeCount})` : 'Mode Toggles'
      );
    }
  }

  // ===== Settings Tab =====
  function renderSettingsTab() {
    if (!tab) return;
    const root = tab.root as HTMLElement;
    root.innerHTML = '';

    if (!state) {
      root.innerHTML = '<div class="mt-container" style="padding:12px">Loading mode toggles...</div>';
      return;
    }

    const container = document.createElement('div');
    container.className = 'mt-container';
    container.style.padding = '12px';

    // Enable toggle
    const enableLabel = mkEl('label', 'mt-label');
    const enableCb = document.createElement('input');
    enableCb.type = 'checkbox';
    enableCb.checked = state.enabled;
    enableCb.addEventListener('change', () =>
      send({ type: 'set_enabled', enabled: enableCb.checked }));
    enableLabel.append(enableCb, document.createTextNode(' Enable Mode Toggles'));
    container.appendChild(enableLabel);

    // Chat ID debug label
    const chatIdLabel = mkEl('div');
    chatIdLabel.style.cssText = 'font-size:10px;color:var(--lumiverse-text-dim,#666);margin-bottom:8px;font-family:monospace;';
    const shortId = state.chatId.length > 16 ? state.chatId.slice(0, 8) + '…' + state.chatId.slice(-8) : state.chatId;
    chatIdLabel.textContent = `Chat: ${shortId}`;
    chatIdLabel.title = state.chatId;
    container.appendChild(chatIdLabel);

    // Load core modes
    const coreLabel = mkEl('label', 'mt-label');
    const coreCb = document.createElement('input');
    coreCb.type = 'checkbox';
    coreCb.checked = state.settings.loadCoreModes;
    coreCb.addEventListener('change', () =>
      send({ type: 'update_settings', loadCoreModes: coreCb.checked }));
    coreLabel.append(coreCb, document.createTextNode(' Load Core (Default) Modes'));
    container.appendChild(coreLabel);

    // Pre-framing
    container.appendChild(
      labeledTextarea('Text before mode content', state.settings.preFraming, (val) =>
        send({ type: 'update_settings', preFraming: val }))
    );

    // Merge format
    container.appendChild(
      labeledTextarea('Merge format ({{modeName}}, {{displayStatus}}, {{modeDescription}})',
        state.settings.mergeFormat, (val) =>
          send({ type: 'update_settings', mergeFormat: val }))
    );

    // Post-framing
    container.appendChild(
      labeledTextarea('Text after mode content', state.settings.postFraming, (val) =>
        send({ type: 'update_settings', postFraming: val }))
    );

    // Countdown
    const countSection = mkEl('div', 'mt-section');
    const countLbl = document.createElement('small');
    countLbl.className = 'mt-small-label';
    countLbl.textContent = 'Message count before OFF removal';
    const countInput = document.createElement('input') as HTMLInputElement;
    countInput.type = 'number';
    countInput.className = 'mt-input';
    countInput.value = String(state.settings.countdown);
    countInput.min = '0';
    countInput.addEventListener('change', () =>
      send({ type: 'update_settings', countdown: parseInt(countInput.value) || 5 }));
    countSection.append(countLbl, countInput);
    container.appendChild(countSection);

    // Injection Position
    const posSection = mkEl('div', 'mt-section');
    const posLbl = document.createElement('small');
    posLbl.className = 'mt-small-label';
    posLbl.textContent = 'Injection position';
    const posSelect = document.createElement('select') as HTMLSelectElement;
    posSelect.className = 'mt-select';
    const posOptions: [string, string][] = [
      ['prepend', 'Prepend to user message'],
      ['append', 'Append to user message'],
      ['before_user', 'New message before user message'],
      ['start', 'New message at start'],
      ['end', 'New message at end'],
    ];
    for (const [val, label] of posOptions) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      if (val === state.settings.injectionPosition) opt.selected = true;
      posSelect.appendChild(opt);
    }
    posSection.append(posLbl, posSelect);
    container.appendChild(posSection);

    // Injection Role (only for positions that create a new message)
    const roleSection = mkEl('div', 'mt-section');
    const roleLbl = document.createElement('small');
    roleLbl.className = 'mt-small-label';
    roleLbl.textContent = 'Injected message role';
    const roleSelect = document.createElement('select') as HTMLSelectElement;
    roleSelect.className = 'mt-select';
    const roleOptions: [string, string][] = [
      ['system', 'System'],
      ['user', 'User'],
      ['assistant', 'Assistant'],
    ];
    for (const [val, label] of roleOptions) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      if (val === state.settings.injectionRole) opt.selected = true;
      roleSelect.appendChild(opt);
    }
    roleSelect.addEventListener('change', () =>
      send({ type: 'update_settings', injectionRole: roleSelect.value }));
    roleSection.append(roleLbl, roleSelect);

    // Show/hide role based on position
    const needsRole = (pos: string) => pos !== 'prepend' && pos !== 'append';
    roleSection.style.display = needsRole(state.settings.injectionPosition) ? '' : 'none';
    posSelect.addEventListener('change', () => {
      send({ type: 'update_settings', injectionPosition: posSelect.value });
      roleSection.style.display = needsRole(posSelect.value) ? '' : 'none';
    });
    container.appendChild(roleSection);

    // Buttons
    const btnRow = mkEl('div', 'mt-btn-row');
    const removeBtn = document.createElement('button');
    removeBtn.className = 'mt-btn';
    removeBtn.textContent = 'Remove All Custom Modes';
    removeBtn.addEventListener('click', () => {
      showThemedConfirm('Remove all custom modes? Default modes will remain.', () =>
        send({ type: 'remove_all_custom' }));
    });
    const resetBtn = document.createElement('button');
    resetBtn.className = 'mt-btn';
    resetBtn.textContent = 'Reset to Defaults';
    resetBtn.addEventListener('click', () => {
      showThemedConfirm('Reset all settings, custom modes, and per-chat states?', () =>
        send({ type: 'reset_defaults' }));
    });
    btnRow.append(removeBtn, resetBtn);
    container.appendChild(btnRow);

    root.appendChild(container);
  }

  // ===== Toggle Popover (via Input Bar Action) =====
  function showTogglePopover() {
    if (activePopover && document.body.contains(activePopover)) {
      activePopover.remove();
      activePopover = null;
      return;
    }

    // Ask backend for fresh state (detects chat switches)
    send({ type: 'request_state' });

    const popover = document.createElement('div');
    popover.style.cssText =
      'position:fixed;z-index:99999;max-width:400px;min-width:320px;max-height:500px;' +
      'background:var(--lumiverse-fill,#1a1a1a);opacity:1;border:1px solid var(--lumiverse-border,#444);' +
      'border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.7);overflow:hidden;backdrop-filter:none;' +
      'bottom:80px;right:20px;';

    activePopover = popover;
    renderPopoverContent(popover);
    document.body.appendChild(popover);

    const closeHandler = (e: MouseEvent) => {
      if (!popover.contains(e.target as Node)) {
        popover.remove();
        activePopover = null;
        document.removeEventListener('click', closeHandler, true);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler, true), 50);
  }

  function renderPopoverContent(container: HTMLElement) {
    container.innerHTML = '';
    if (!state) {
      container.innerHTML = '<div class="mt-container" style="padding:12px">Loading...</div>';
      return;
    }

    // Search header
    const header = document.createElement('div');
    header.style.cssText = 'padding:8px;border-bottom:1px solid var(--lumiverse-border,#333);background:#1a1a1a;';
    const search = document.createElement('input') as HTMLInputElement;
    search.type = 'search';
    search.className = 'mt-search';
    search.placeholder = 'Search modes...';
    search.value = searchQuery;
    search.addEventListener('input', () => {
      searchQuery = search.value.trim().toLowerCase();
      renderModeList(listEl);
    });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { searchQuery = ''; search.value = ''; renderModeList(listEl); }
    });
    header.appendChild(search);
    container.appendChild(header);

    // Mode list
    const listEl = document.createElement('div');
    listEl.style.cssText = 'max-height:380px;overflow-y:auto;padding:4px;background:#1a1a1a;';
    renderModeList(listEl);
    container.appendChild(listEl);

    // Focus search
    setTimeout(() => { search.focus(); search.select(); }, 50);
  }

  function renderModeList(container: HTMLElement) {
    container.innerHTML = '';
    if (!state) return;

    const q = searchQuery;
    const filtered = state.modes.filter((m) =>
      !q || `${m.name} ${m.group} ${m.description}`.toLowerCase().includes(q)
    );

    const isActiveish = (m: ModeView) => m.status === 'ON';

    // Enabled section
    const enabled = filtered.filter(isActiveish).sort((a, b) => a.name.localeCompare(b.name));
    if (enabled.length > 0) {
      container.appendChild(renderAccordion('Enabled', enabled));
    }

    // Group sections
    const groupsMap = new Map<string, ModeView[]>();
    for (const mode of filtered) {
      const g = mode.group || 'Unsorted';
      if (!groupsMap.has(g)) groupsMap.set(g, []);
      groupsMap.get(g)!.push(mode);
    }
    for (const gName of Array.from(groupsMap.keys()).sort()) {
      const items = groupsMap.get(gName)!.sort((a, b) => a.name.localeCompare(b.name));
      container.appendChild(renderAccordion(gName, items));
    }

    // Separator + actions
    const sep = document.createElement('div');
    sep.className = 'mt-separator';
    container.appendChild(sep);

    const row1 = mkEl('div');
    row1.style.cssText = 'display:flex;gap:3px;padding:2px 4px;';
    row1.appendChild(actionBtn('+ Add New', 'mt-action-add', showAddEditPrompt));
    row1.appendChild(actionBtn('Export Modes', 'mt-action-export', () =>
      send({ type: 'export_modes' })));
    row1.appendChild(actionBtn('Import Modes', 'mt-action-import', doImport));
    container.appendChild(row1);

    const row2 = mkEl('div');
    row2.style.cssText = 'display:flex;gap:3px;padding:2px 4px;';
    row2.appendChild(actionBtn('Disable All', 'mt-action-disable', () =>
      send({ type: 'disable_all' })));
    row2.appendChild(actionBtn('Random', 'mt-action-random', () =>
      send({ type: 'activate_random' })));
    row2.appendChild(actionBtn('Schedule', 'mt-action-schedule', showScheduleDialog));
    row2.appendChild(actionBtn('Presets', 'mt-action-presets', showPresetsDialog));
    container.appendChild(row2);

    const row3 = mkEl('div');
    row3.style.cssText = 'display:flex;gap:3px;padding:2px 4px 4px;';
    row3.appendChild(actionBtn('Export Config', 'mt-action-config-export', () =>
      send({ type: 'export_config' })));
    row3.appendChild(actionBtn('Import Config', 'mt-action-config-import', doImportConfig));
    container.appendChild(row3);
  }

  function renderAccordion(title: string, items: ModeView[]): HTMLElement {
    const section = document.createElement('div');
    const header = document.createElement('div');
    header.className = 'mt-accordion-header';
    header.textContent = `${title} (${items.length})`;
    const content = document.createElement('div');
    content.className = 'mt-accordion-content';
    content.style.display = accordionOpen[title] ? 'block' : 'none';

    header.addEventListener('click', () => {
      const open = content.style.display === 'none';
      content.style.display = open ? 'block' : 'none';
      accordionOpen[title] = open;
    });

    for (const mode of items) content.appendChild(renderModeButton(mode));
    section.append(header, content);
    return section;
  }

  function renderModeButton(mode: ModeView): HTMLElement {
    let cls = 'mt-mode-off';
    let statusText = mode.status;
    if (mode.status === 'ON') cls = 'mt-mode-on';
    else if (mode.status === 'OFF' && mode.countdown !== undefined) {
      cls = 'mt-mode-countdown';
      statusText = `OFF(${mode.countdown})`;
    }

    const btn = document.createElement('div');
    btn.className = `mt-mode-btn ${cls}`;
    btn.title = 'Click to toggle';
    const nameDiv = document.createElement('div');
    nameDiv.className = 'mt-mode-name';
    const nameText = document.createElement('span');
    nameText.textContent = `${mode.name} ${statusText}`;
    const editIcon = document.createElement('span');
    editIcon.className = 'mt-mode-edit';
    editIcon.textContent = '✎';
    editIcon.title = 'Edit mode';
    editIcon.addEventListener('click', (e) => {
      e.stopPropagation();
      showAddEditPrompt({ name: mode.name, group: mode.group, description: mode.description });
    });
    nameDiv.append(nameText, editIcon);
    const descDiv = document.createElement('div');
    descDiv.className = 'mt-mode-desc';
    descDiv.textContent = mode.description;
    btn.append(nameDiv, descDiv);
    btn.addEventListener('click', () =>
      send({ type: 'toggle_mode', modeName: mode.name }));
    return btn;
  }

  // ===== Dialogs =====
  function showThemedConfirm(message: string, onConfirm: () => void) {
    const overlay = document.createElement('div');
    overlay.className = 'mt-overlay';
    const modal = document.createElement('div');
    modal.className = 'mt-modal';

    const msg = document.createElement('p');
    msg.style.cssText = 'margin:0 0 16px';
    msg.textContent = message;
    modal.appendChild(msg);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'mt-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => overlay.remove());
    const okBtn = document.createElement('button');
    okBtn.className = 'mt-btn';
    okBtn.style.background = 'rgba(255,0,0,0.15)';
    okBtn.textContent = 'Confirm';
    okBtn.addEventListener('click', () => { overlay.remove(); onConfirm(); });
    btnRow.append(cancelBtn, okBtn);
    modal.appendChild(btnRow);

    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  function showThemedAlert(message: string) {
    const overlay = document.createElement('div');
    overlay.className = 'mt-overlay';
    const modal = document.createElement('div');
    modal.className = 'mt-modal';

    const msg = document.createElement('p');
    msg.style.cssText = 'margin:0 0 16px';
    msg.textContent = message;
    modal.appendChild(msg);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;justify-content:flex-end;';
    const okBtn = document.createElement('button');
    okBtn.className = 'mt-btn';
    okBtn.textContent = 'OK';
    okBtn.addEventListener('click', () => overlay.remove());
    btnRow.appendChild(okBtn);
    modal.appendChild(btnRow);

    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  function showAddEditPrompt(prefill?: { name: string; group: string; description: string }) {
    const overlay = document.createElement('div');
    overlay.className = 'mt-overlay';
    const modal = document.createElement('div');
    modal.className = 'mt-modal';

    const title = document.createElement('h3');
    title.style.cssText = 'margin:0 0 12px';
    title.textContent = prefill ? 'Edit Mode' : 'Add Mode';
    modal.appendChild(title);

    const help = document.createElement('small');
    help.style.cssText = 'display:block;margin-bottom:12px;color:var(--lumiverse-text-muted,#999)';
    help.textContent = prefill ? 'Edit the group or description for this mode.' : 'Create a new custom mode.';
    modal.appendChild(help);

    const nameLabel = document.createElement('small');
    nameLabel.className = 'mt-small-label';
    nameLabel.textContent = 'Name (required)';
    const nameInput = document.createElement('input') as HTMLInputElement;
    nameInput.type = 'text';
    nameInput.className = 'mt-search';
    nameInput.placeholder = 'Mode name';
    if (prefill) { nameInput.value = prefill.name; nameInput.readOnly = true; nameInput.style.opacity = '0.6'; }

    const groupLabel = document.createElement('small');
    groupLabel.className = 'mt-small-label';
    groupLabel.textContent = 'Group';
    const groupInput = document.createElement('input') as HTMLInputElement;
    groupInput.type = 'text';
    groupInput.className = 'mt-search';
    groupInput.placeholder = 'Unsorted';
    if (prefill) groupInput.value = prefill.group;

    const descLabel = document.createElement('small');
    descLabel.className = 'mt-small-label';
    descLabel.textContent = 'Description';
    const descInput = document.createElement('textarea') as HTMLTextAreaElement;
    descInput.className = 'mt-textarea';
    descInput.rows = 3;
    descInput.placeholder = 'What this mode does...';
    if (prefill) descInput.value = prefill.description;

    modal.append(nameLabel, nameInput, groupLabel, groupInput, descLabel, descInput);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'mt-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => overlay.remove());
    const saveBtn = document.createElement('button');
    saveBtn.className = 'mt-btn';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => {
      const name = nameInput.value.trim();
      if (!name) return;
      const group = groupInput.value.trim() || 'Unsorted';
      const description = descInput.value.trim();
      // When adding new, warn if name already exists
      if (!prefill && state && state.modes.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
        showThemedConfirm(`A mode called "${name}" already exists. Overwrite it?`, () => {
          send({ type: 'add_edit_mode', name, group, description });
          overlay.remove();
        });
        return;
      }
      send({ type: 'add_edit_mode', name, group, description });
      overlay.remove();
    });
    btnRow.append(cancelBtn, saveBtn);
    if (prefill) {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'mt-btn';
      deleteBtn.style.cssText = 'background:rgba(255,0,0,0.15);margin-right:auto;';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', () => {
        showThemedConfirm(`Delete mode "${prefill.name}"?`, () => {
          send({ type: 'add_edit_mode', name: prefill.name, group: '', description: '' });
          overlay.remove();
        });
      });
      btnRow.prepend(deleteBtn);
    }
    modal.appendChild(btnRow);

    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    setTimeout(() => (prefill ? descInput : nameInput).focus(), 50);
  }

  async function doImport() {
    try {
      const files = await ctx.uploads.pickFile({
        accept: ['.txt', 'text/plain'],
        multiple: false,
      });
      if (files.length > 0) {
        const text = new TextDecoder().decode(files[0].bytes);
        if (text.trim()) {
          send({ type: 'import_modes', text });
        }
      }
    } catch (e) {
      // User cancelled or error
    }
  }

  async function doImportConfig() {
    try {
      const files = await ctx.uploads.pickFile({
        accept: ['.json', 'application/json'],
        multiple: false,
      });
      if (files.length > 0) {
        const text = new TextDecoder().decode(files[0].bytes);
        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch {
          showThemedAlert('Invalid JSON file.');
          return;
        }
        showThemedConfirm(
          'This will replace all settings, custom modes, and presets. Per-chat mode states will be kept. Continue?',
          () => send({ type: 'import_config', config: parsed })
        );
      }
    } catch (e) {
      // User cancelled or error
    }
  }

  function showScheduleDialog() {
    if (!state) return;
    const activeModes = state.modes.filter(
      (m) => m.status === 'ON'
    );
    if (activeModes.length === 0) {
      showThemedAlert('No active modes to schedule.');
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'mt-overlay';

    const modal = document.createElement('div');
    modal.className = 'mt-modal';

    const title = document.createElement('h3');
    title.style.cssText = 'margin:0 0 8px';
    title.textContent = 'Mode Scheduling';
    modal.appendChild(title);

    const help = document.createElement('small');
    help.style.cssText = 'display:block;margin-bottom:12px;color:var(--lumiverse-text-muted,#999)';
    help.textContent = 'Each character: X=100%, - or 0=0%, 1-9=probability\u00d710%. Mask repeats in a loop.';
    modal.appendChild(help);

    const table = document.createElement('table');
    table.className = 'mt-schedule-table';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Mode</th><th>Schedule</th></tr>';
    table.appendChild(thead);
    const tbody = document.createElement('tbody');

    const inputs: { name: string; input: HTMLInputElement }[] = [];
    for (const mode of activeModes) {
      const tr = document.createElement('tr');
      const tdName = document.createElement('td');
      const strong = document.createElement('strong');
      strong.textContent = mode.name;
      const br = document.createElement('br');
      const small = document.createElement('small');
      small.textContent = mode.description;
      tdName.append(strong, br, small);
      const tdInput = document.createElement('td');
      const inp = document.createElement('input') as HTMLInputElement;
      inp.type = 'text';
      inp.className = 'mt-schedule-input';
      inp.value = mode.schedule || 'X';
      inp.addEventListener('input', () => {
        inp.value = inp.value.toUpperCase().replace(/[^\-X0-9]/g, '');
      });
      tdInput.appendChild(inp);
      tr.append(tdName, tdInput);
      tbody.appendChild(tr);
      inputs.push({ name: mode.name, input: inp });
    }
    table.appendChild(tbody);
    modal.appendChild(table);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'mt-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => overlay.remove());
    const saveBtn = document.createElement('button');
    saveBtn.className = 'mt-btn';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => {
      const schedules: Record<string, string> = {};
      for (const { name, input } of inputs) schedules[name] = input.value || 'X';
      send({ type: 'update_schedules', schedules });
      overlay.remove();
    });
    btnRow.append(cancelBtn, saveBtn);
    modal.appendChild(btnRow);

    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  // ===== Presets Dialog =====
  function showPresetsDialog() {
    if (!state) return;

    const overlay = document.createElement('div');
    overlay.className = 'mt-overlay';
    const modal = document.createElement('div');
    modal.className = 'mt-modal';

    const title = document.createElement('h3');
    title.style.cssText = 'margin:0 0 8px';
    title.textContent = 'Presets';
    modal.appendChild(title);

    const help = document.createElement('small');
    help.style.cssText = 'display:block;margin-bottom:12px;color:var(--lumiverse-text-muted,#999)';
    help.textContent = 'Save the current chat\u2019s active modes as a preset, or load one into this chat.';
    modal.appendChild(help);

    // Save section
    const saveRow = document.createElement('div');
    saveRow.style.cssText = 'display:flex;gap:6px;margin-bottom:12px;';
    const saveInput = document.createElement('input') as HTMLInputElement;
    saveInput.type = 'text';
    saveInput.className = 'mt-search';
    saveInput.placeholder = 'New preset name...';
    saveInput.style.marginBottom = '0';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'mt-btn';
    saveBtn.textContent = 'Save current';
    const activeCount = state.modes.filter((m) => m.status === 'ON').length;
    if (activeCount === 0) {
      saveBtn.disabled = true;
      saveBtn.style.opacity = '0.4';
      saveBtn.title = 'No modes currently active';
    }
    saveBtn.addEventListener('click', () => {
      const name = saveInput.value.trim();
      if (!name) { saveInput.focus(); return; }
      const exists = state!.presets.some((p) => p.name === name);
      const doSave = () => {
        send({ type: 'save_preset', name });
        overlay.remove();
      };
      if (exists) {
        showThemedConfirm(`Preset "${name}" already exists. Overwrite?`, doSave);
      } else {
        doSave();
      }
    });
    saveRow.append(saveInput, saveBtn);
    saveInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveBtn.click();
    });
    modal.appendChild(saveRow);

    // Separator
    const sep = document.createElement('div');
    sep.className = 'mt-separator';
    modal.appendChild(sep);

    // List section
    const listWrap = document.createElement('div');
    listWrap.style.cssText = 'max-height:50vh;overflow-y:auto;';
    if (state.presets.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:16px;text-align:center;color:var(--lumiverse-text-muted,#999);font-size:12px;';
      empty.textContent = 'No presets saved yet.';
      listWrap.appendChild(empty);
    } else {
      for (const preset of state.presets) {
        const row = document.createElement('div');
        row.className = 'mt-preset-row';

        const info = document.createElement('div');
        info.style.cssText = 'flex:1;min-width:0;';
        const nameEl = document.createElement('div');
        nameEl.className = 'mt-preset-name';
        nameEl.textContent = preset.name;
        nameEl.title = 'Click to rename';
        nameEl.style.cursor = 'pointer';
        nameEl.addEventListener('click', () => {
          showRenamePrompt(preset.name, (newName) => {
            send({ type: 'rename_preset', oldName: preset.name, newName });
            overlay.remove();
          });
        });
        const countEl = document.createElement('div');
        countEl.className = 'mt-preset-count';
        countEl.textContent = `${preset.count} mode${preset.count === 1 ? '' : 's'}`;
        info.append(nameEl, countEl);

        const loadBtn = document.createElement('button');
        loadBtn.className = 'mt-preset-btn mt-preset-btn-load';
        loadBtn.textContent = 'Load';
        loadBtn.title = 'Replace current ON modes with this preset';
        loadBtn.addEventListener('click', () => {
          send({ type: 'load_preset', name: preset.name, mergeMode: 'replace' });
          overlay.remove();
        });

        const mergeBtn = document.createElement('button');
        mergeBtn.className = 'mt-preset-btn mt-preset-btn-merge';
        mergeBtn.textContent = 'Merge';
        mergeBtn.title = 'Add preset\u2019s modes without disabling current ones';
        mergeBtn.addEventListener('click', () => {
          send({ type: 'load_preset', name: preset.name, mergeMode: 'merge' });
          overlay.remove();
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'mt-preset-btn mt-preset-btn-delete';
        delBtn.textContent = '\u2715';
        delBtn.title = 'Delete preset';
        delBtn.addEventListener('click', () => {
          showThemedConfirm(`Delete preset "${preset.name}"?`, () => {
            send({ type: 'delete_preset', name: preset.name });
            overlay.remove();
          });
        });

        row.append(info, loadBtn, mergeBtn, delBtn);
        listWrap.appendChild(row);
      }
    }
    modal.appendChild(listWrap);

    // Close button
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'mt-btn';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => overlay.remove());
    btnRow.append(closeBtn);
    modal.appendChild(btnRow);

    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    setTimeout(() => saveInput.focus(), 50);
  }

  function showRenamePrompt(oldName: string, onRename: (newName: string) => void) {
    const overlay = document.createElement('div');
    overlay.className = 'mt-overlay';
    const modal = document.createElement('div');
    modal.className = 'mt-modal';
    modal.style.maxWidth = '360px';

    const title = document.createElement('h3');
    title.style.cssText = 'margin:0 0 12px';
    title.textContent = 'Rename Preset';
    modal.appendChild(title);

    const input = document.createElement('input') as HTMLInputElement;
    input.type = 'text';
    input.className = 'mt-search';
    input.value = oldName;

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'mt-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => overlay.remove());
    const okBtn = document.createElement('button');
    okBtn.className = 'mt-btn';
    okBtn.textContent = 'Rename';
    okBtn.addEventListener('click', () => {
      const v = input.value.trim();
      if (v && v !== oldName) onRename(v);
      overlay.remove();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') okBtn.click();
      if (e.key === 'Escape') cancelBtn.click();
    });
    btnRow.append(cancelBtn, okBtn);

    modal.append(input, btnRow);
    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    setTimeout(() => { input.focus(); input.select(); }, 50);
  }

  // ===== Helpers =====
  function mkEl(tag: string, className?: string): HTMLElement {
    const e = document.createElement(tag);
    if (className) e.className = className;
    return e;
  }

  function labeledTextarea(label: string, value: string, onChange: (val: string) => void): HTMLElement {
    const section = mkEl('div', 'mt-section');
    const lbl = document.createElement('small');
    lbl.className = 'mt-small-label';
    lbl.textContent = label;
    const ta = document.createElement('textarea') as HTMLTextAreaElement;
    ta.className = 'mt-textarea';
    ta.rows = 3;
    ta.value = value;
    let debounce: ReturnType<typeof setTimeout>;
    ta.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => onChange(ta.value), 500);
    });
    section.append(lbl, ta);
    return section;
  }

  function actionBtn(text: string, className: string, onClick: () => void): HTMLElement {
    const btn = document.createElement('div');
    btn.className = `mt-action-btn ${className}`;
    const strong = document.createElement('strong');
    strong.textContent = text;
    btn.appendChild(strong);
    btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return btn;
  }

  // Cleanup
  return () => {
    ctx.dom.cleanup();
    if (tab) tab.destroy();
    if (toggleAction) toggleAction.destroy();
    if (activePopover) { activePopover.remove(); activePopover = null; }
  };
}
