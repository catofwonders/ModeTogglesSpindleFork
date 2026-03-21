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
  enabled: boolean;
  modes: ModeView[];
  activeCount: number;
  settings: {
    loadCoreModes: boolean;
    preFraming: string;
    mergeFormat: string;
    postFraming: string;
    countdown: number;
  };
}

export function setup(ctx: SpindleFrontendContext) {
  let state: StateUpdate | null = null;
  let searchQuery = '';
  let accordionOpen: Record<string, boolean> = {};

  // ===== Styles =====
  ctx.dom.injectCSS(`
    .mt-container { font-family: inherit; font-size: 13px; color: var(--text-color, #ddd); }
    .mt-section { margin-bottom: 12px; }
    .mt-section-title { font-weight: 600; margin-bottom: 6px; font-size: 14px; }
    .mt-label { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; cursor: pointer; }
    .mt-label input[type="checkbox"] { margin: 0; }
    .mt-textarea { width: 100%; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--border-color, #444);
      background: var(--input-bg, #222); color: var(--text-color, #ddd); resize: vertical; min-height: 60px;
      font-family: inherit; font-size: 12px; box-sizing: border-box; }
    .mt-input { width: 80px; padding: 4px 6px; border-radius: 4px; border: 1px solid var(--border-color, #444);
      background: var(--input-bg, #222); color: var(--text-color, #ddd); font-family: inherit; }
    .mt-btn { padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border-color, #444);
      background: var(--btn-bg, #333); color: var(--text-color, #ddd); cursor: pointer; font-size: 12px; }
    .mt-btn:hover { background: var(--btn-hover-bg, #444); }
    .mt-btn-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
    .mt-small-label { font-size: 11px; color: var(--text-muted, #999); margin-bottom: 4px; display: block; }

    .mt-menu { max-height: 450px; overflow-y: auto; }
    .mt-search { width: 100%; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--border-color, #444);
      background: var(--input-bg, #222); color: var(--text-color, #ddd); margin-bottom: 8px; box-sizing: border-box; }
    .mt-accordion-header { cursor: pointer; padding: 5px 8px; background: var(--accordion-bg, #222);
      color: var(--text-muted, #ccc); font-weight: 600; font-size: 12px; user-select: none;
      border-radius: 3px; margin-bottom: 2px; }
    .mt-accordion-header:hover { background: var(--accordion-hover, #2a2a2a); }
    .mt-accordion-content { padding-left: 6px; }
    .mt-mode-btn { cursor: pointer; padding: 6px 10px; border-bottom: 1px solid var(--border-color, #333);
      font-size: 12px; border-radius: 3px; margin-bottom: 2px; }
    .mt-mode-btn:hover { filter: brightness(1.2); }
    .mt-mode-name { font-weight: 600; }
    .mt-mode-desc { font-size: 11px; opacity: 0.8; margin-top: 2px; }
    .mt-mode-on { background: rgba(0,255,0,0.08); color: #90EE90; }
    .mt-mode-off { background: rgba(255,0,0,0.06); color: #FFB6C1; }
    .mt-mode-countdown { background: rgba(255,165,0,0.08); color: #FFD700; }
    .mt-mode-activating { background: rgba(255,255,0,0.08); color: #FFD700; }
    .mt-mode-deactivating { background: rgba(255,165,0,0.08); color: #FFA500; }
    .mt-separator { border-top: 2px solid var(--border-color, #555); margin: 6px 0; }
    .mt-action-btn { cursor: pointer; padding: 5px 10px; font-size: 12px; text-align: center;
      border-radius: 3px; flex: 1; }
    .mt-action-btn:hover { filter: brightness(1.3); }
    .mt-action-add { background: rgba(0,0,255,0.08); color: #87CEEB; }
    .mt-action-export { background: rgba(0,128,0,0.08); color: #90EE90; }
    .mt-action-import { background: rgba(255,165,0,0.08); color: #FFA500; }
    .mt-action-disable { background: rgba(255,0,0,0.08); color: #FF6B6B; }
    .mt-action-random { background: rgba(128,0,128,0.08); color: #DA70D6; }
    .mt-action-schedule { background: rgba(137,112,218,0.08); color: #8970da; }

    .mt-schedule-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .mt-schedule-table th, .mt-schedule-table td { padding: 6px 8px; text-align: left;
      border-bottom: 1px solid var(--border-color, #333); }
    .mt-schedule-input { width: 100%; padding: 4px 6px; border-radius: 3px;
      border: 1px solid var(--border-color, #444); background: var(--input-bg, #222);
      color: var(--text-color, #ddd); font-family: monospace; }
  `);

  // ===== Drawer Tab: Settings =====
  ctx.drawerTab.register({
    id: 'mode-toggles-settings',
    label: 'Mode Toggles',
    icon: 'microchip',
    render: (container: HTMLElement) => renderSettingsTab(container),
  });

  // ===== Input Bar Action: Quick Toggle Menu =====
  ctx.inputBarAction.register({
    id: 'mode-toggles-menu',
    label: 'Mode Toggles',
    icon: 'microchip',
    onClick: () => renderTogglePopover(),
  });

  // ===== Backend Messages =====
  ctx.backend.onMessage('state_update', (data: StateUpdate) => {
    state = data;
    // Re-render any active UI
    refreshActiveUI();
  });

  ctx.backend.onMessage('export_data', (data: { text: string; count: number }) => {
    const blob = new Blob([data.text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mode-toggles-export.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  // Request initial state
  ctx.backend.send('request_state', {});

  // ===== Active UI tracking =====
  let activeSettingsContainer: HTMLElement | null = null;
  let activePopover: HTMLElement | null = null;

  function refreshActiveUI() {
    if (activeSettingsContainer) renderSettingsTab(activeSettingsContainer);
    if (activePopover && document.body.contains(activePopover)) renderPopoverContent(activePopover);
  }

  // ===== Settings Tab Renderer =====
  function renderSettingsTab(container: HTMLElement) {
    activeSettingsContainer = container;
    container.innerHTML = '';
    if (!state) {
      container.innerHTML = '<div class="mt-container">Loading...</div>';
      return;
    }

    const root = document.createElement('div');
    root.className = 'mt-container';

    // Enable toggle
    const enableLabel = el('label', { className: 'mt-label' });
    const enableCb = el('input', { type: 'checkbox', checked: state.enabled }) as HTMLInputElement;
    enableCb.addEventListener('change', () => ctx.backend.send('set_enabled', { enabled: enableCb.checked }));
    enableLabel.append(enableCb, document.createTextNode('Enable Mode Toggles'));
    root.appendChild(enableLabel);

    // Load core modes
    const coreLabel = el('label', { className: 'mt-label' });
    const coreCb = el('input', { type: 'checkbox', checked: state.settings.loadCoreModes }) as HTMLInputElement;
    coreCb.addEventListener('change', () =>
      ctx.backend.send('update_settings', { loadCoreModes: coreCb.checked }));
    coreLabel.append(coreCb, document.createTextNode('Load Core (Default) Modes'));
    root.appendChild(coreLabel);

    // Pre-framing
    root.appendChild(labeledTextarea('Text before mode content', state.settings.preFraming, (val: string) =>
      ctx.backend.send('update_settings', { preFraming: val })));

    // Merge format
    const mergeSection = labeledTextarea('Merge format ({{modeName}}, {{displayStatus}}, {{modeDescription}})',
      state.settings.mergeFormat, (val: string) => ctx.backend.send('update_settings', { mergeFormat: val }));
    root.appendChild(mergeSection);

    // Post-framing
    root.appendChild(labeledTextarea('Text after mode content', state.settings.postFraming, (val: string) =>
      ctx.backend.send('update_settings', { postFraming: val })));

    // Countdown
    const countSection = document.createElement('div');
    countSection.className = 'mt-section';
    const countLabel = el('small', { className: 'mt-small-label', textContent: 'Message count before OFF removal' });
    const countInput = el('input', {
      type: 'number', className: 'mt-input', value: String(state.settings.countdown), min: '0',
    }) as HTMLInputElement;
    countInput.addEventListener('change', () =>
      ctx.backend.send('update_settings', { countdown: parseInt(countInput.value) || DEFAULT_COUNTDOWN }));
    countSection.append(countLabel, countInput);
    root.appendChild(countSection);

    // Buttons
    const btnRow = el('div', { className: 'mt-btn-row' });
    const removeBtn = el('button', { className: 'mt-btn', textContent: 'Remove All Custom Modes' });
    removeBtn.addEventListener('click', () => {
      if (confirm('Remove all custom modes? Default modes will remain.')) {
        ctx.backend.send('remove_all_custom', {});
      }
    });
    const resetBtn = el('button', { className: 'mt-btn', textContent: 'Reset to Defaults' });
    resetBtn.addEventListener('click', () => {
      if (confirm('Reset all settings and remove all custom modes and per-chat states?')) {
        ctx.backend.send('reset_defaults', {});
      }
    });
    btnRow.append(removeBtn, resetBtn);
    root.appendChild(btnRow);

    container.appendChild(root);
  }

  // ===== Toggle Popover =====
  function renderTogglePopover() {
    // Close existing
    if (activePopover && document.body.contains(activePopover)) {
      activePopover.remove();
      activePopover = null;
      return;
    }

    const popover = document.createElement('div');
    popover.style.cssText =
      'position:fixed;z-index:99999;max-width:400px;min-width:350px;max-height:500px;' +
      'background:var(--panel-bg,#1a1a1a);border:1px solid var(--border-color,#444);' +
      'border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.5);overflow:hidden;';

    activePopover = popover;
    renderPopoverContent(popover);

    // Position near bottom-right
    popover.style.bottom = '80px';
    popover.style.right = '20px';

    document.body.appendChild(popover);

    // Close on outside click
    const closeHandler = (e: MouseEvent) => {
      if (!popover.contains(e.target as Node)) {
        popover.remove();
        activePopover = null;
        document.removeEventListener('click', closeHandler, true);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler, true), 0);
  }

  function renderPopoverContent(container: HTMLElement) {
    container.innerHTML = '';
    if (!state) {
      container.innerHTML = '<div class="mt-container" style="padding:12px">Loading...</div>';
      return;
    }

    const wrapper = el('div', { className: 'mt-menu' });

    // Search bar
    const search = el('input', {
      type: 'search', className: 'mt-search', placeholder: 'Search modes...',
    }) as HTMLInputElement;
    search.value = searchQuery;
    search.addEventListener('input', () => {
      searchQuery = search.value.trim().toLowerCase();
      renderModeList(listContainer);
    });
    search.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') { searchQuery = ''; search.value = ''; renderModeList(listContainer); }
    });

    const header = el('div');
    header.style.cssText = 'padding:8px;border-bottom:1px solid var(--border-color,#333);';
    header.appendChild(search);
    container.appendChild(header);

    // Mode list
    const listContainer = el('div');
    listContainer.style.cssText = 'max-height:380px;overflow-y:auto;padding:4px;';
    renderModeList(listContainer);
    container.appendChild(listContainer);
  }

  function renderModeList(container: HTMLElement) {
    container.innerHTML = '';
    if (!state) return;

    const q = searchQuery;
    const filtered = state.modes.filter((m) => {
      if (!q) return true;
      return `${m.name} ${m.group} ${m.description}`.toLowerCase().includes(q);
    });

    const isActiveish = (m: ModeView) =>
      m.status === 'ON' || m.status === 'Activating' || m.status === 'Deactivating';

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
    const groupNames = Array.from(groupsMap.keys()).sort();
    for (const gName of groupNames) {
      const items = groupsMap.get(gName)!.sort((a, b) => a.name.localeCompare(b.name));
      container.appendChild(renderAccordion(gName, items));
    }

    // Separator + action buttons
    container.appendChild(el('div', { className: 'mt-separator' }));

    const row1 = el('div', { style: 'display:flex;gap:3px;padding:2px 4px;' });
    row1.appendChild(actionBtn('+ Add/Edit', 'mt-action-add', showAddEditPrompt));
    row1.appendChild(actionBtn('📤 Export', 'mt-action-export', () => ctx.backend.send('export_modes', {})));
    row1.appendChild(actionBtn('📥 Import', 'mt-action-import', showImportDialog));
    container.appendChild(row1);

    const row2 = el('div', { style: 'display:flex;gap:3px;padding:2px 4px 4px;' });
    row2.appendChild(actionBtn('🚫 Disable All', 'mt-action-disable', () => ctx.backend.send('disable_all', {})));
    row2.appendChild(actionBtn('🎲 Random', 'mt-action-random', () => ctx.backend.send('activate_random', {})));
    row2.appendChild(actionBtn('📅 Schedule', 'mt-action-schedule', showScheduleDialog));
    container.appendChild(row2);
  }

  function renderAccordion(title: string, items: ModeView[]): HTMLElement {
    const section = el('div');
    const header = el('div', {
      className: 'mt-accordion-header',
      textContent: `${title} (${items.length})`,
    });
    const content = el('div', { className: 'mt-accordion-content' });
    content.style.display = accordionOpen[title] ? 'block' : 'none';

    header.addEventListener('click', () => {
      const open = content.style.display === 'none';
      content.style.display = open ? 'block' : 'none';
      accordionOpen[title] = open;
    });

    for (const mode of items) {
      content.appendChild(renderModeButton(mode));
    }

    section.append(header, content);
    return section;
  }

  function renderModeButton(mode: ModeView): HTMLElement {
    let statusClass = 'mt-mode-off';
    let statusText = mode.status;
    if (mode.status === 'ON') statusClass = 'mt-mode-on';
    else if (mode.status === 'Activating') statusClass = 'mt-mode-activating';
    else if (mode.status === 'Deactivating') statusClass = 'mt-mode-deactivating';
    else if (mode.status === 'OFF' && mode.countdown !== undefined) {
      statusClass = 'mt-mode-countdown';
      statusText = `OFF(${mode.countdown})`;
    }

    const btn = el('div', { className: `mt-mode-btn ${statusClass}`, title: 'Click to toggle' });
    btn.innerHTML =
      `<div class="mt-mode-name">${esc(mode.name)} ${esc(statusText)}</div>` +
      `<div class="mt-mode-desc">${esc(mode.description)}</div>`;
    btn.addEventListener('click', () => ctx.backend.send('toggle_mode', { modeName: mode.name }));
    return btn;
  }

  // ===== Dialogs =====
  function showAddEditPrompt() {
    const input = prompt(
      'Enter: "Name - Group - Description"\n' +
      'Also accepts "Name - Description" (uses group "Unsorted").\n' +
      'Leave description blank to remove custom mode.'
    );
    if (!input) return;

    const parts = input.split(' - ');
    const name = (parts[0] || '').trim();
    let group: string, description: string;
    if (parts.length >= 3) {
      group = (parts[1] || '').trim() || 'Unsorted';
      description = parts.slice(2).join(' - ').trim();
    } else if (parts.length === 2) {
      group = 'Unsorted';
      description = (parts[1] || '').trim();
    } else {
      group = 'Unsorted';
      description = '';
    }
    if (!name) return;
    ctx.backend.send('add_edit_mode', { name, group, description });
  }

  function showImportDialog() {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.txt,.text,text/plain';
    fileInput.style.display = 'none';
    document.body.appendChild(fileInput);

    fileInput.addEventListener('change', (e: Event) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target?.result as string;
        if (text) ctx.backend.send('import_modes', { text });
      };
      reader.readAsText(file);
      document.body.removeChild(fileInput);
    });

    fileInput.click();
  }

  function showScheduleDialog() {
    if (!state) return;
    const activeModes = state.modes.filter(
      (m) => m.status === 'ON' || m.status === 'Activating'
    );
    if (activeModes.length === 0) {
      alert('No active modes to schedule.');
      return;
    }

    // Build a simple modal
    const overlay = el('div');
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:100000;display:flex;align-items:center;justify-content:center;';

    const modal = el('div');
    modal.style.cssText =
      'background:var(--panel-bg,#1a1a1a);border:1px solid var(--border-color,#444);' +
      'border-radius:8px;padding:16px;max-width:500px;width:90%;max-height:80vh;overflow-y:auto;color:var(--text-color,#ddd);';

    modal.innerHTML = `
      <h3 style="margin:0 0 8px">Mode Scheduling</h3>
      <small style="display:block;margin-bottom:12px;color:var(--text-muted,#999)">
        Each character: <b>X</b>=100%, <b>-</b> or <b>0</b>=0%, <b>1-9</b>=probability×10%.
        Mask repeats in a loop.
      </small>
    `;

    const table = el('table', { className: 'mt-schedule-table' });
    table.innerHTML = '<thead><tr><th>Mode</th><th>Schedule</th></tr></thead>';
    const tbody = el('tbody');
    const inputs: { name: string; input: HTMLInputElement }[] = [];

    for (const mode of activeModes) {
      const tr = el('tr');
      tr.innerHTML = `<td><strong>${esc(mode.name)}</strong><br><small>${esc(mode.description)}</small></td>`;
      const td = el('td');
      const inp = el('input', {
        type: 'text', className: 'mt-schedule-input', value: mode.schedule || 'X',
      }) as HTMLInputElement;
      inp.addEventListener('input', () => {
        inp.value = inp.value.toUpperCase().replace(/[^\-X0-9]/g, '');
      });
      td.appendChild(inp);
      tr.appendChild(td);
      tbody.appendChild(tr);
      inputs.push({ name: mode.name, input: inp });
    }
    table.appendChild(tbody);
    modal.appendChild(table);

    const btnRow = el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;' });
    const cancelBtn = el('button', { className: 'mt-btn', textContent: 'Cancel' });
    cancelBtn.addEventListener('click', () => overlay.remove());
    const saveBtn = el('button', { className: 'mt-btn', textContent: 'Save' });
    saveBtn.addEventListener('click', () => {
      const schedules: Record<string, string> = {};
      for (const { name, input } of inputs) {
        schedules[name] = input.value || 'X';
      }
      ctx.backend.send('update_schedules', { schedules });
      overlay.remove();
    });
    btnRow.append(cancelBtn, saveBtn);
    modal.appendChild(btnRow);

    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  // ===== Helpers =====
  const DEFAULT_COUNTDOWN = 5;

  function el(tag: string, props?: Record<string, any>): HTMLElement {
    const e = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (k === 'className') e.className = v;
        else if (k === 'style' && typeof v === 'string') e.style.cssText = v;
        else if (k === 'textContent') e.textContent = v;
        else if (k === 'innerHTML') e.innerHTML = v;
        else (e as any)[k] = v;
      }
    }
    return e;
  }

  function esc(s: string): string {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function labeledTextarea(label: string, value: string, onChange: (val: string) => void): HTMLElement {
    const section = el('div', { className: 'mt-section' });
    section.appendChild(el('small', { className: 'mt-small-label', textContent: label }));
    const ta = el('textarea', { className: 'mt-textarea', value, rows: 3 }) as HTMLTextAreaElement;
    ta.value = value;
    let debounce: ReturnType<typeof setTimeout>;
    ta.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => onChange(ta.value), 500);
    });
    section.appendChild(ta);
    return section;
  }

  function actionBtn(text: string, className: string, onClick: () => void): HTMLElement {
    const btn = el('div', { className: `mt-action-btn ${className}`, innerHTML: `<strong>${text}</strong>` });
    btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return btn;
  }
}
