import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { tokenize, scoreMode, naturalCompare, familyOf } from './search';

interface ModeView {
  name: string;
  group: string;
  description: string;
  status: string;
  source?: 'core' | 'override' | 'custom';
}

interface StateUpdate {
  type: 'state_update';
  enabled: boolean;
  modes: ModeView[];
  activeCount: number;
  chatId: string;
  presets: Array<{ name: string; count: number }>;
  undoAvailable: boolean;
  undoLabel: string;
  settings: {
    loadCoreModes: boolean;
    sortMode: 'group' | 'flat';
    framing: string;
  };
  presetBlocks: Array<{ presetId: string; presetName: string; blockName: string }>;
}

interface BlockOption { id: string; name: string; enabled: boolean; isCategory: boolean; notes?: string[]; hasModes?: boolean }

interface ExportData {
  type: 'export_data';
  text: string;
  count: number;
  groups?: string[];
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
  // Unsubscribe functions for everything this setup subscribes to. Lumiverse
  // also drops them on unload, but releasing them here keeps teardown complete
  // on any host and lets the extension be set up again cleanly.
  const unsubs: Array<() => void> = [];
  // Picker for "{{modes}} inside a preset block" (filled on request).
  let presetList: Array<{ id: string; name: string }> | null = null;
  let presetListError = '';
  let pickerPresetId = '';
  let pickerBlocks: BlockOption[] | null = null;
  let pickerBlockId = '';
  let pickerError = '';

  // Helper: send message to backend, always including chatId
  function send(payload: Record<string, any>) {
    ctx.sendToBackend({ ...payload, chatId: currentChatId });
  }

  // ===== Styles =====
  // Everything is built on Lumiverse's theme variables, so the extension
  // follows the user's accent color, light/dark mode and font scale. The
  // fallbacks are Lumiverse's own defaults. All classes are prefixed mt-.
  const fs = (px: number) => `calc(${px}px * var(--lumiverse-font-scale, 1))`;
  ctx.dom.addStyle(`
    .mt-root { font-family: inherit; font-size: ${fs(13)}; color: var(--lumiverse-text, rgba(255,255,255,0.9));
      display: flex; flex-direction: column; gap: 12px; }
    .mt-root *, .mt-popover *, .mt-dialog * { box-sizing: border-box; }

    /* ----- Shared atoms ----- */
    .mt-hint { font-size: ${fs(11)}; line-height: 1.45; color: var(--lumiverse-text-dim, rgba(255,255,255,0.4)); margin: 0; }
    .mt-hint code, .mt-root code, .mt-dialog code { font-family: var(--lumiverse-font-mono, monospace); font-size: 0.95em;
      color: var(--lumiverse-primary-text, rgba(186,135,255,0.95)); }
    .mt-field-label { display: block; font-size: ${fs(12)}; font-weight: 500; color: var(--lumiverse-text-muted, rgba(255,255,255,0.65));
      margin: 0 0 6px; }
    .mt-input, .mt-textarea, .mt-select { width: 100%; padding: 7px 10px; font: inherit; font-size: ${fs(13)};
      color: var(--lumiverse-text, rgba(255,255,255,0.9)); background: var(--lumiverse-input-bg, rgba(0,0,0,0.15));
      border: 1px solid var(--lumiverse-border, rgba(147,112,219,0.12)); border-radius: var(--lumiverse-radius, 8px);
      outline: none; transition: border-color var(--lumiverse-transition-fast, 150ms ease), box-shadow var(--lumiverse-transition-fast, 150ms ease); }
    .mt-input::placeholder, .mt-textarea::placeholder { color: var(--lumiverse-text-hint, rgba(255,255,255,0.3)); }
    .mt-input:hover, .mt-textarea:hover, .mt-select:hover { border-color: var(--lumiverse-border-hover, rgba(147,112,219,0.25)); }
    .mt-input:focus, .mt-textarea:focus, .mt-select:focus { border-color: var(--lumiverse-primary, rgba(147,112,219,0.9));
      box-shadow: 0 0 0 3px var(--lumiverse-primary-015, rgba(147,112,219,0.15)); }
    .mt-input[readonly] { opacity: 0.6; cursor: default; }
    .mt-textarea { resize: vertical; min-height: 72px; line-height: 1.5; font-family: var(--lumiverse-font-mono, monospace); font-size: ${fs(12)}; }
    .mt-select { appearance: none; -webkit-appearance: none; padding-right: 30px; cursor: pointer;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 10px center; }
    .mt-select option { background: var(--lumiverse-bg-opaque, rgb(28 24 38)); color: var(--lumiverse-text, #eee); }
    .mt-error { color: var(--lumiverse-danger, #ef4444); font-size: ${fs(12)}; margin: 0; }
    .mt-error:empty { display: none; }

    .mt-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 7px 12px;
      font: inherit; font-size: ${fs(12)}; font-weight: 500; line-height: 1.2; white-space: nowrap;
      color: var(--lumiverse-text-muted, rgba(255,255,255,0.65)); background: var(--lumiverse-fill-subtle, rgba(0,0,0,0.1));
      border: 1px solid var(--lumiverse-border, rgba(147,112,219,0.12)); border-radius: var(--lumiverse-radius, 8px);
      cursor: pointer; transition: background var(--lumiverse-transition-fast, 150ms ease), color var(--lumiverse-transition-fast, 150ms ease), border-color var(--lumiverse-transition-fast, 150ms ease); }
    .mt-btn:hover:not(:disabled) { color: var(--lumiverse-text, rgba(255,255,255,0.9)); background: var(--lumiverse-surface-hover, rgba(45,40,58,0.9));
      border-color: var(--lumiverse-border-hover, rgba(147,112,219,0.25)); }
    .mt-btn:focus-visible, .mt-switch:focus-visible, .mt-seg-btn:focus-visible, .mt-mode-toggle:focus-visible,
    .mt-icon-btn:focus-visible, .mt-group-header:focus-visible, .mt-action:focus-visible {
      outline: 2px solid var(--lumiverse-primary, rgba(147,112,219,0.9)); outline-offset: 1px; }
    .mt-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .mt-btn svg, .mt-action svg, .mt-icon-btn svg { flex-shrink: 0; }
    .mt-btn-primary { color: var(--lumiverse-primary-contrast, #fff); background: var(--lumiverse-primary, rgba(147,112,219,0.9));
      border-color: var(--lumiverse-primary, rgba(147,112,219,0.9)); }
    .mt-btn-primary:hover:not(:disabled) { color: var(--lumiverse-primary-contrast, #fff); background: var(--lumiverse-primary-hover, rgba(167,132,239,0.95));
      border-color: var(--lumiverse-primary-hover, rgba(167,132,239,0.95)); }
    .mt-btn-danger { color: var(--lumiverse-danger, #ef4444); border-color: var(--lumiverse-danger-020, rgba(239,68,68,0.2)); background: transparent; }
    .mt-btn-danger:hover:not(:disabled) { color: #fff; background: var(--lumiverse-danger, #ef4444); border-color: var(--lumiverse-danger, #ef4444); }
    .mt-btn-warning { color: var(--lumiverse-warning, #f59e0b); border-color: var(--lumiverse-warning-020, rgba(245,158,11,0.2)); background: transparent; }
    .mt-btn-warning:hover:not(:disabled) { color: #fff; background: var(--lumiverse-warning, #f59e0b); border-color: var(--lumiverse-warning, #f59e0b); }
    .mt-btn-block { width: 100%; }

    .mt-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0;
      color: var(--lumiverse-text-dim, rgba(255,255,255,0.4)); background: transparent; border: 0; border-radius: 6px;
      cursor: pointer; transition: background var(--lumiverse-transition-fast, 150ms ease), color var(--lumiverse-transition-fast, 150ms ease); }
    .mt-icon-btn:hover { color: var(--lumiverse-text, rgba(255,255,255,0.9)); background: var(--lumiverse-fill-hover, rgba(0,0,0,0.2)); }
    .mt-icon-btn-danger:hover { color: var(--lumiverse-danger, #ef4444); background: var(--lumiverse-danger-015, rgba(239,68,68,0.15)); }

    /* Switch: same sizes and colors as Lumiverse's own. */
    .mt-switch { position: relative; flex-shrink: 0; width: 36px; height: 20px; padding: 0; border: 0; border-radius: 10px;
      background: var(--lumiverse-border, rgba(147,112,219,0.12)); cursor: pointer;
      transition: background var(--lumiverse-transition-fast, 150ms ease); }
    .mt-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
      background: #fff; transition: transform var(--lumiverse-transition-fast, 150ms ease); }
    .mt-switch[aria-checked="true"] { background: var(--lumiverse-primary, rgba(147,112,219,0.9)); }
    .mt-switch[aria-checked="true"]::after { transform: translateX(16px); }
    .mt-switch-sm { width: 32px; height: 18px; border-radius: 9px; }
    .mt-switch-sm::after { top: 3px; left: 3px; width: 12px; height: 12px; }
    .mt-switch-sm[aria-checked="true"]::after { transform: translateX(14px); }

    .mt-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 6px;
      font-size: ${fs(10)}; font-weight: 600; border-radius: 9px; line-height: 1;
      color: var(--lumiverse-text-dim, rgba(255,255,255,0.4)); background: var(--lumiverse-fill, rgba(0,0,0,0.15)); }
    .mt-badge-on { color: var(--lumiverse-primary-contrast, #fff); background: var(--lumiverse-primary, rgba(147,112,219,0.9)); }

    .mt-notice { display: flex; gap: 8px; align-items: flex-start; padding: 8px 10px; font-size: ${fs(12)}; line-height: 1.45;
      border-radius: var(--lumiverse-radius, 8px); color: var(--lumiverse-warning, #f59e0b);
      background: var(--lumiverse-warning-015, rgba(245,158,11,0.15)); border: 1px solid var(--lumiverse-warning-020, rgba(245,158,11,0.2)); }

    /* ----- Drawer tab ----- */
    .mt-card { padding: 12px; border: 1px solid var(--lumiverse-border, rgba(147,112,219,0.12));
      border-radius: var(--lumiverse-radius-md, 10px); background: var(--lumiverse-fill-subtle, rgba(0,0,0,0.1));
      display: flex; flex-direction: column; gap: 10px; }
    .mt-card-title { display: flex; align-items: center; gap: 8px; margin: 0; font-size: ${fs(11)}; font-weight: 600;
      letter-spacing: 0.06em; text-transform: uppercase; color: var(--lumiverse-text-dim, rgba(255,255,255,0.4)); }
    .mt-card-danger { border-color: var(--lumiverse-danger-015, rgba(239,68,68,0.15)); }
    .mt-hero { display: flex; align-items: center; gap: 12px; }
    .mt-hero-text { flex: 1; min-width: 0; }
    .mt-hero-title { font-size: ${fs(14)}; font-weight: 600; margin: 0; }
    .mt-hero-sub { font-size: ${fs(12)}; color: var(--lumiverse-text-muted, rgba(255,255,255,0.65)); margin: 2px 0 0; }
    .mt-hero-sub strong { color: var(--lumiverse-primary-text, rgba(186,135,255,0.95)); font-weight: 600; }
    .mt-setting { display: flex; align-items: center; gap: 12px; }
    .mt-setting-text { flex: 1; min-width: 0; }
    .mt-setting-label { font-size: ${fs(13)}; color: var(--lumiverse-text, rgba(255,255,255,0.9)); margin: 0; }
    .mt-setting-hint { font-size: ${fs(11)}; color: var(--lumiverse-text-dim, rgba(255,255,255,0.4)); margin: 2px 0 0; line-height: 1.4; }
    .mt-seg { display: inline-flex; padding: 2px; gap: 2px; border-radius: var(--lumiverse-radius, 8px);
      background: var(--lumiverse-fill, rgba(0,0,0,0.15)); border: 1px solid var(--lumiverse-border, rgba(147,112,219,0.12)); }
    .mt-seg-btn { padding: 4px 10px; font: inherit; font-size: ${fs(12)}; border: 0; border-radius: 6px; cursor: pointer;
      color: var(--lumiverse-text-dim, rgba(255,255,255,0.4)); background: transparent;
      transition: background var(--lumiverse-transition-fast, 150ms ease), color var(--lumiverse-transition-fast, 150ms ease); }
    .mt-seg-btn:hover { color: var(--lumiverse-text, rgba(255,255,255,0.9)); }
    .mt-seg-btn[aria-pressed="true"] { color: var(--lumiverse-primary-contrast, #fff); background: var(--lumiverse-primary, rgba(147,112,219,0.9)); }
    .mt-linked { display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 10px; border-radius: var(--lumiverse-radius, 8px);
      background: var(--lumiverse-primary-010, rgba(147,112,219,0.1)); border: 1px solid var(--lumiverse-primary-020, rgba(147,112,219,0.2)); }
    .mt-linked-text { flex: 1; min-width: 0; }
    .mt-linked-name { font-size: ${fs(13)}; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .mt-linked-block { font-size: ${fs(11)}; color: var(--lumiverse-text-muted, rgba(255,255,255,0.65)); }
    .mt-stack { display: flex; flex-direction: column; gap: 8px; }
    .mt-row { display: flex; gap: 8px; flex-wrap: wrap; }
    .mt-row > .mt-btn { flex: 1; }

    /* ----- Popover -----
       z-index 10000: above Lumiverse's drawer (9992) and below its modals
       (10003), so dialogs opened from the popover appear on top of it. */
    .mt-popover { position: fixed; z-index: 10000; right: 20px; bottom: 80px; width: 380px; max-width: calc(100vw - 24px);
      max-height: min(560px, calc(100vh - 110px)); display: flex; flex-direction: column; overflow: hidden;
      font-size: ${fs(13)}; color: var(--lumiverse-text, rgba(255,255,255,0.9));
      background: var(--lumiverse-bg-elevated, rgba(35,30,48,0.9)); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--lumiverse-border, rgba(147,112,219,0.12)); border-radius: var(--lumiverse-radius-lg, 12px);
      box-shadow: var(--lumiverse-shadow-lg, 0 24px 80px rgba(0,0,0,0.5)); }
    @media (max-width: 600px) { .mt-popover { right: 12px; left: 12px; width: auto; max-width: none; bottom: 76px; } }
    .mt-pop-head { padding: 12px 12px 10px; display: flex; flex-direction: column; gap: 10px;
      border-bottom: 1px solid var(--lumiverse-border, rgba(147,112,219,0.12)); }
    .mt-pop-title-row { display: flex; align-items: center; gap: 8px; }
    .mt-pop-title { font-size: ${fs(14)}; font-weight: 600; margin: 0; flex: 1; }
    .mt-search-wrap { position: relative; }
    .mt-search-wrap svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--lumiverse-text-dim, rgba(255,255,255,0.4)); pointer-events: none; }
    .mt-search-wrap .mt-input { padding-left: 32px; }
    .mt-search-wrap .mt-input::-webkit-search-cancel-button { filter: grayscale(1) opacity(0.6); }
    .mt-pop-list { flex: 1; min-height: 0; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 2px;
      overscroll-behavior: contain; }
    .mt-pop-list > .mt-notice { margin: 2px 2px 6px; }
    .mt-empty { padding: 24px 12px; text-align: center; color: var(--lumiverse-text-dim, rgba(255,255,255,0.4)); font-size: ${fs(12)}; }

    .mt-group-header { display: flex; align-items: center; gap: 6px; width: 100%; padding: 7px 8px; font: inherit;
      font-size: ${fs(12)}; font-weight: 600; text-align: left; color: var(--lumiverse-text-muted, rgba(255,255,255,0.65));
      background: transparent; border: 0; border-radius: var(--lumiverse-radius-sm, 5px); cursor: pointer; user-select: none;
      transition: background var(--lumiverse-transition-fast, 150ms ease), color var(--lumiverse-transition-fast, 150ms ease); }
    .mt-group-header:hover { background: var(--lumiverse-fill-hover, rgba(0,0,0,0.2)); color: var(--lumiverse-text, rgba(255,255,255,0.9)); }
    .mt-group-header .mt-chev { transition: transform var(--lumiverse-transition-fast, 150ms ease); color: var(--lumiverse-text-dim, rgba(255,255,255,0.4)); }
    .mt-group-header[aria-expanded="true"] .mt-chev { transform: rotate(90deg); }
    .mt-group-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .mt-group-count { font-size: ${fs(11)}; font-weight: 500; font-variant-numeric: tabular-nums; color: var(--lumiverse-text-dim, rgba(255,255,255,0.4)); }
    .mt-group-count b { color: var(--lumiverse-primary-text, rgba(186,135,255,0.95)); font-weight: 600; }
    .mt-group-sub { font-weight: 500; font-size: ${fs(12)}; }
    .mt-group-body { display: flex; flex-direction: column; gap: 2px; padding: 2px 0 4px 10px; margin-left: 9px;
      border-left: 1px solid var(--lumiverse-border, rgba(147,112,219,0.12)); }
    .mt-group-body[hidden] { display: none; }
    .mt-group-enabled > .mt-group-header { color: var(--lumiverse-primary-text, rgba(186,135,255,0.95)); }

    .mt-mode { position: relative; display: flex; align-items: flex-start; border-radius: var(--lumiverse-radius, 8px);
      transition: background var(--lumiverse-transition-fast, 150ms ease); }
    .mt-mode:hover { background: var(--lumiverse-surface-hover, rgba(45,40,58,0.9)); }
    .mt-mode-on { background: var(--lumiverse-primary-010, rgba(147,112,219,0.1)); }
    .mt-mode-on:hover { background: var(--lumiverse-primary-015, rgba(147,112,219,0.15)); }
    .mt-mode-on::before { content: ''; position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px; border-radius: 2px;
      background: var(--lumiverse-primary, rgba(147,112,219,0.9)); }
    .mt-mode-toggle { flex: 1; min-width: 0; display: flex; align-items: flex-start; gap: 10px; padding: 8px 8px 8px 12px;
      font: inherit; text-align: left; color: inherit; background: transparent; border: 0; border-radius: inherit; cursor: pointer; }
    .mt-mode-text { flex: 1; min-width: 0; }
    .mt-mode-name { display: block; font-size: ${fs(13)}; font-weight: 500; line-height: 1.35; color: var(--lumiverse-text, rgba(255,255,255,0.9)); }
    .mt-mode-desc { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
      margin-top: 2px; font-size: ${fs(11.5)}; line-height: 1.45; color: var(--lumiverse-text-dim, rgba(255,255,255,0.4)); }
    .mt-mode-on .mt-mode-desc { color: var(--lumiverse-text-muted, rgba(255,255,255,0.65)); }
    .mt-mode .mt-switch { margin-top: 1px; pointer-events: none; }
    .mt-mode-edit { margin: 4px 4px 0 -4px; opacity: 0; }
    .mt-mode:hover .mt-mode-edit, .mt-mode-edit:focus-visible { opacity: 1; }
    @media (hover: none) { .mt-mode-edit { opacity: 0.6; } }

    .mt-pop-foot { padding: 8px; border-top: 1px solid var(--lumiverse-border, rgba(147,112,219,0.12));
      display: flex; flex-direction: column; gap: 6px; background: var(--lumiverse-fill-subtle, rgba(0,0,0,0.1)); }
    .mt-actions { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 4px; }
    .mt-actions-more { grid-template-columns: repeat(5, minmax(0, 1fr)); }
    .mt-action { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; min-width: 0;
      padding: 7px 4px 6px; font: inherit; font-size: ${fs(10.5)}; line-height: 1.1; text-align: center;
      color: var(--lumiverse-text-dim, rgba(255,255,255,0.4)); background: transparent; border: 1px solid transparent;
      border-radius: var(--lumiverse-radius, 8px); cursor: pointer;
      transition: background var(--lumiverse-transition-fast, 150ms ease), color var(--lumiverse-transition-fast, 150ms ease), border-color var(--lumiverse-transition-fast, 150ms ease); }
    .mt-action span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mt-action:hover { color: var(--lumiverse-text, rgba(255,255,255,0.9)); background: var(--lumiverse-surface-hover, rgba(45,40,58,0.9));
      border-color: var(--lumiverse-border, rgba(147,112,219,0.12)); }
    .mt-action[aria-expanded="true"] { color: var(--lumiverse-primary-text, rgba(186,135,255,0.95)); background: var(--lumiverse-primary-010, rgba(147,112,219,0.1)); }
    .mt-action-danger:hover { color: var(--lumiverse-danger, #ef4444); border-color: var(--lumiverse-danger-020, rgba(239,68,68,0.2));
      background: var(--lumiverse-danger-015, rgba(239,68,68,0.15)); }
    .mt-undo { justify-content: flex-start; color: var(--lumiverse-primary-text, rgba(186,135,255,0.95));
      background: var(--lumiverse-primary-010, rgba(147,112,219,0.1)); border-color: var(--lumiverse-primary-020, rgba(147,112,219,0.2)); }
    .mt-undo span { overflow: hidden; text-overflow: ellipsis; }

    /* ----- Dialogs ----- */
    .mt-dialog { display: flex; flex-direction: column; gap: 12px; font-size: ${fs(13)}; color: var(--lumiverse-text, rgba(255,255,255,0.9)); }
    .mt-dialog p { margin: 0; line-height: 1.5; white-space: pre-line; }
    .mt-dialog-foot { display: flex; gap: 8px; justify-content: flex-end; align-items: center; flex-wrap: wrap; padding-top: 4px; }
    .mt-dialog-foot .mt-spacer { margin-right: auto; }
    .mt-check-list { display: flex; flex-direction: column; gap: 2px; max-height: 45vh; overflow-y: auto; }
    .mt-check { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: var(--lumiverse-radius-sm, 5px); cursor: pointer; }
    .mt-check:hover { background: var(--lumiverse-fill-hover, rgba(0,0,0,0.2)); }
    .mt-check input { accent-color: var(--lumiverse-primary, rgba(147,112,219,0.9)); width: 15px; height: 15px; margin: 0; }
    .mt-check-label { flex: 1; }
    .mt-check-count { font-size: ${fs(11)}; color: var(--lumiverse-text-dim, rgba(255,255,255,0.4)); font-variant-numeric: tabular-nums; }
    .mt-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    .mt-stat { padding: 8px; text-align: center; border-radius: var(--lumiverse-radius, 8px); background: var(--lumiverse-fill-subtle, rgba(0,0,0,0.1));
      border: 1px solid var(--lumiverse-border, rgba(147,112,219,0.12)); }
    .mt-stat b { display: block; font-size: ${fs(18)}; font-weight: 600; font-variant-numeric: tabular-nums; }
    .mt-stat span { font-size: ${fs(11)}; color: var(--lumiverse-text-dim, rgba(255,255,255,0.4)); }
    .mt-scroll-box { max-height: 30vh; overflow-y: auto; padding: 8px 10px; font-size: ${fs(12)}; line-height: 1.5;
      border-radius: var(--lumiverse-radius, 8px); background: var(--lumiverse-fill-subtle, rgba(0,0,0,0.1));
      border: 1px solid var(--lumiverse-border, rgba(147,112,219,0.12)); }
    .mt-scroll-box ul { margin: 4px 0 0; padding-left: 18px; }
    .mt-scroll-box li { margin: 1px 0; }
    .mt-preset-list { display: flex; flex-direction: column; gap: 4px; max-height: 45vh; overflow-y: auto; }
    .mt-preset { display: flex; align-items: center; gap: 6px; padding: 8px 8px 8px 10px; border-radius: var(--lumiverse-radius, 8px);
      background: var(--lumiverse-fill-subtle, rgba(0,0,0,0.1)); border: 1px solid var(--lumiverse-border, rgba(147,112,219,0.12)); }
    .mt-preset-info { flex: 1; min-width: 0; }
    .mt-preset-name { font-size: ${fs(13)}; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .mt-preset-count { font-size: ${fs(11)}; color: var(--lumiverse-text-dim, rgba(255,255,255,0.4)); }
    .mt-preset .mt-btn { padding: 5px 10px; }
    .mt-inline { display: flex; gap: 8px; }
    .mt-inline .mt-input { flex: 1; }

    /* Fallback dialog chrome, only for hosts without ctx.ui.showModal. */
    .mt-overlay { position: fixed; inset: 0; z-index: 10003; display: flex; align-items: center; justify-content: center;
      background: var(--lumiverse-modal-backdrop, rgba(0,0,0,0.6)); }
    .mt-modal { width: 92%; max-height: 82vh; display: flex; flex-direction: column; overflow: hidden;
      background: var(--lumiverse-gradient-modal, rgb(28 24 38)); border: 1px solid var(--lumiverse-border, rgba(147,112,219,0.12));
      border-radius: var(--lumiverse-radius-lg, 12px); box-shadow: var(--lumiverse-shadow-lg, 0 24px 80px rgba(0,0,0,0.5));
      color: var(--lumiverse-text, rgba(255,255,255,0.9)); }
    .mt-modal-head { display: flex; align-items: center; gap: 8px; padding: 12px 12px 12px 16px;
      border-bottom: 1px solid var(--lumiverse-border, rgba(147,112,219,0.12)); }
    .mt-modal-title { flex: 1; margin: 0; font-size: ${fs(15)}; font-weight: 600; }
    .mt-modal-body { padding: 16px; overflow-y: auto; }
  `);

  // ===== Drawer Tab: Settings =====
  tab = ctx.ui.registerDrawerTab({
    id: 'mode-toggles-settings',
    title: 'Mode Toggles',
    iconSvg: MICROCHIP_SVG,
  });
  unsubs.push(tab.onActivate(() => {
    send({ type: 'request_state' });
    // Presets may have been added or deleted since the list was loaded.
    if (presetList !== null) send({ type: 'list_presets' });
  }));
  renderSettingsTab();

  // ===== Input Bar Action: Quick Toggle Menu =====
  toggleAction = ctx.ui.registerInputBarAction({
    id: 'mode-toggles-menu',
    label: 'Mode Toggles',
    iconSvg: MICROCHIP_SVG_14,
    enabled: true,
  });
  unsubs.push(toggleAction.onClick(() => showTogglePopover()));

  // ===== Backend Messages =====
  unsubs.push(ctx.onBackendMessage((payload: any) => {
    if (payload.type === 'state_update') {
      state = payload as StateUpdate;
      // Always sync chatId from backend
      if (state.chatId) currentChatId = state.chatId;
      updateBadge();
      renderSettingsTab();
      if (activePopover && document.body.contains(activePopover)) {
        refreshPopoverList();
      }
    } else if (payload.type === 'export_data') {
      const data = payload as ExportData;
      if (data.count === 0) {
        showThemedAlert('You have no custom or edited modes to export yet.');
        return;
      }
      // Name the file after the group when exactly one was chosen.
      const slug = data.groups && data.groups.length === 1
        ? data.groups[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        : '';
      downloadText(data.text, slug ? `mode-toggles-${slug}.txt` : 'mode-toggles-export.txt', 'text/plain');
    } else if (payload.type === 'export_config_data') {
      downloadText(payload.json, 'mode-toggles-config.json', 'application/json');
    } else if (payload.type === 'presets_list') {
      // A refresh only updates a list the user has already opened.
      if (payload.refresh && presetList === null) return;
      presetList = Array.isArray(payload.presets) ? payload.presets : [];
      if (pickerPresetId && !presetList!.some((p) => p.id === pickerPresetId)) {
        pickerPresetId = '';
        pickerBlocks = null;
        pickerBlockId = '';
        pickerError = '';
      }
      presetListError = payload.error ? String(payload.error) : '';
      renderSettingsTab();
    } else if (payload.type === 'blocks_list') {
      if (payload.presetId !== pickerPresetId) return; // an older request
      pickerBlocks = Array.isArray(payload.blocks) ? payload.blocks : [];
      pickerError = payload.error ? String(payload.error) : '';
      pickerBlockId = payload.selectedId && pickerBlocks!.some((b) => b.id === payload.selectedId)
        ? payload.selectedId : '';
      renderSettingsTab();
    } else if (payload.type === 'import_preview') {
      showImportPreview(payload.text, payload.report);
    } else if (payload.type === 'tidy_report') {
      const r = payload.report as {
        orphanToggles: number; emptyPresets: number; deadPresetRefs: number; emptyChatBuckets: number;
      };
      const total = r.orphanToggles + r.emptyPresets + r.deadPresetRefs + r.emptyChatBuckets;
      if (total === 0) {
        showThemedAlert('Everything is tidy — no orphaned toggles, dead references, or empty presets.');
      } else {
        const lines = [
          `${r.orphanToggles} orphaned toggle(s) (modes no longer exist)`,
          `${r.deadPresetRefs} dead preset reference(s)`,
          `${r.emptyPresets} empty preset(s)`,
          `${r.emptyChatBuckets} leftover entr${r.emptyChatBuckets === 1 ? 'y' : 'ies'} for deleted chats`,
        ].filter((_, i) => [r.orphanToggles, r.deadPresetRefs, r.emptyPresets, r.emptyChatBuckets][i] > 0);
        showThemedConfirm(
          'Clean up the following?\n\n• ' + lines.join('\n• '),
          () => send({ type: 'apply_tidy' }),
          'Clean up',
        );
      }
    }
  }));

  // Request initial state
  send({ type: 'request_state' });

  // Sync on chat switches so the popover/tab UI reflects the new chat right
  // away. The backend also pushes the new chat's state when it sees the switch;
  // asking here covers a backend that started before the frontend was ready.
  // chatId is null on the home screen.
  unsubs.push(ctx.events.on('CHAT_SWITCHED', (data: any) => {
    const newId = typeof data?.chatId === 'string' ? data.chatId : '';
    if (!newId) return;
    if (newId !== currentChatId) currentChatId = newId;
    send({ type: 'request_state' });
  }));

  // ===== Active popover tracking =====
  let activePopover: HTMLElement | null = null;
  let activeListEl: HTMLElement | null = null;
  let activeCountEl: HTMLElement | null = null;
  let activeFootEl: HTMLElement | null = null;
  let popoverCloseHandler: ((e: MouseEvent) => void) | null = null;
  let popoverKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  // The row the user just toggled, and where it was in the list. Turning a
  // mode on or off adds or removes it in "On in this chat" at the top, which
  // would push the clicked row up or down; after the update the list scrolls
  // so the row stays under the pointer.
  let toggleAnchor: { section: string; name: string; offset: number; focused: boolean; at: number } | null = null;
  // The second row of popover actions (export/import, config, tidy).
  let moreActionsOpen = false;
  // Timestamp of the last outside-click close. Clicking the input bar button
  // while the popover is open fires the outside-click close first and then the
  // button's onClick, which used to reopen it immediately.
  let lastOutsideCloseAt = 0;

  function closePopover() {
    if (popoverCloseHandler) document.removeEventListener('click', popoverCloseHandler, true);
    if (popoverKeyHandler) document.removeEventListener('keydown', popoverKeyHandler, true);
    popoverCloseHandler = null;
    popoverKeyHandler = null;
    if (activePopover) activePopover.remove();
    activePopover = null;
    activeListEl = null;
    activeCountEl = null;
    activeFootEl = null;
  }

  function findModeRow(list: HTMLElement, section: string, name: string): HTMLElement | null {
    for (const row of list.querySelectorAll<HTMLElement>('.mt-mode')) {
      if (row.dataset.section === section && row.dataset.mode === name) return row;
    }
    return null;
  }

  function refreshPopoverList() {
    if (!activeListEl) return;
    const list = activeListEl;
    const scroll = list.scrollTop;
    renderModeList(list);
    list.scrollTop = scroll;
    const anchor = toggleAnchor;
    toggleAnchor = null;
    if (anchor && Date.now() - anchor.at < 5000) {
      const row = findModeRow(list, anchor.section, anchor.name);
      if (row) {
        const offset = row.getBoundingClientRect().top - list.getBoundingClientRect().top;
        list.scrollTop += offset - anchor.offset;
        if (anchor.focused) row.querySelector<HTMLElement>('.mt-mode-toggle')?.focus({ preventScroll: true });
      }
    }
    renderPopoverCount();
    if (activeFootEl) renderPopoverFooter(activeFootEl);
  }

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

  // ===== Small builders =====
  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function button(label: string, variant = '', onClick?: () => void, iconName?: IconName): HTMLButtonElement {
    const b = el('button', `mt-btn${variant ? ` ${variant}` : ''}`);
    b.type = 'button';
    if (iconName) b.insertAdjacentHTML('afterbegin', icon(iconName, 14));
    b.append(document.createTextNode(label));
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  function iconButton(name: IconName, label: string, onClick: (e: MouseEvent) => void, extra = ''): HTMLButtonElement {
    const b = el('button', `mt-icon-btn${extra ? ` ${extra}` : ''}`);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = icon(name, 14);
    b.addEventListener('click', onClick);
    return b;
  }

  function switchControl(checked: boolean, label: string, onChange?: (on: boolean) => void, small = false): HTMLButtonElement {
    const s = el('button', `mt-switch${small ? ' mt-switch-sm' : ''}`);
    s.type = 'button';
    s.setAttribute('role', 'switch');
    s.setAttribute('aria-checked', String(checked));
    s.setAttribute('aria-label', label);
    if (onChange) {
      s.addEventListener('click', () => {
        const next = s.getAttribute('aria-checked') !== 'true';
        s.setAttribute('aria-checked', String(next));
        onChange(next);
      });
    } else {
      s.tabIndex = -1;
      s.setAttribute('aria-hidden', 'true');
    }
    return s;
  }

  // Text with {{modes}} shown as code.
  function richText(target: HTMLElement, text: string) {
    for (const [i, part] of text.split('{{modes}}').entries()) {
      if (i > 0) target.appendChild(el('code', '', '{{modes}}'));
      if (part) target.appendChild(document.createTextNode(part));
    }
    return target;
  }

  function card(title: string, extraClass = ''): HTMLElement {
    const c = el('section', `mt-card${extraClass ? ` ${extraClass}` : ''}`);
    c.appendChild(el('h3', 'mt-card-title', title));
    return c;
  }

  function settingRow(label: string, hint: string, control: HTMLElement): HTMLElement {
    const row = el('div', 'mt-setting');
    const text = el('div', 'mt-setting-text');
    text.appendChild(el('p', 'mt-setting-label', label));
    if (hint) text.appendChild(richText(el('p', 'mt-setting-hint'), hint));
    row.append(text, control);
    return row;
  }

  function select(options: Array<[string, string]>, value: string, label: string, onChange: (v: string) => void): HTMLSelectElement {
    const s = el('select', 'mt-select');
    s.setAttribute('aria-label', label);
    for (const [v, text] of options) {
      const o = el('option', '', text);
      o.value = v;
      if (v === value) o.selected = true;
      s.appendChild(o);
    }
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }

  // ===== Settings Tab =====
  function renderSettingsTab() {
    if (!tab) return;
    const root = tab.root as HTMLElement;
    root.innerHTML = '';
    const container = el('div', 'mt-root');
    root.appendChild(container);

    if (!state) {
      container.appendChild(el('p', 'mt-empty', 'Loading Mode Toggles…'));
      return;
    }
    const s = state;

    // Status
    const status = el('section', 'mt-card');
    const hero = el('div', 'mt-hero');
    const heroText = el('div', 'mt-hero-text');
    heroText.appendChild(el('p', 'mt-hero-title', s.enabled ? 'Enabled' : 'Disabled'));
    const sub = el('p', 'mt-hero-sub');
    if (!s.enabled) {
      richText(sub, 'Off, so {{modes}} sends nothing');
    } else if (s.activeCount > 0) {
      sub.append(el('strong', '', String(s.activeCount)), document.createTextNode(` mode${s.activeCount === 1 ? '' : 's'} on in this chat`));
    } else {
      sub.textContent = 'No modes on in this chat';
    }
    sub.title = `Chat ${s.chatId}`;
    heroText.appendChild(sub);
    hero.append(heroText, switchControl(s.enabled, 'Enable Mode Toggles', (on) => send({ type: 'set_enabled', enabled: on })));
    status.appendChild(hero);
    container.appendChild(status);

    // Mode list
    const list = card('Mode list');
    list.appendChild(settingRow('Built-in modes', 'Include the modes that come with Mode Toggles.',
      switchControl(s.settings.loadCoreModes, 'Include built-in modes',
        (on) => send({ type: 'update_settings', loadCoreModes: on }))));
    const seg = el('div', 'mt-seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Mode list order');
    for (const [val, label] of [['group', 'By group'], ['flat', 'A–Z']] as const) {
      const b = el('button', 'mt-seg-btn', label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(s.settings.sortMode === val));
      b.addEventListener('click', () => {
        if (s.settings.sortMode !== val) send({ type: 'update_settings', sortMode: val });
      });
      seg.appendChild(b);
    }
    list.appendChild(settingRow('Order', '', seg));
    container.appendChild(list);

    // Prompt: framing
    const prompt = card('Prompt');
    prompt.appendChild(richText(el('p', 'mt-hint'),
      'Your active modes are sent wherever {{modes}} is in your preset. Put it there yourself, or let Mode Toggles keep it in a block (below).'));
    const framingWrap = el('div');
    const framingLabel = el('label', 'mt-field-label', 'Framing (optional)');
    const framingInput = el('textarea', 'mt-textarea');
    framingInput.id = 'mt-framing';
    framingLabel.htmlFor = framingInput.id;
    framingInput.rows = 4;
    framingInput.value = s.settings.framing;
    framingInput.placeholder = '[Setting rules for this story…]\n{{modes}}';
    framingInput.addEventListener('change', () =>
      send({ type: 'update_settings', framing: framingInput.value }));
    framingWrap.append(framingLabel, framingInput);
    prompt.appendChild(framingWrap);
    prompt.appendChild(richText(el('p', 'mt-hint'),
      'Sent around your modes. Put {{modes}} where they go, or leave it out to add them at the end. Leave empty if your preset already frames {{modes}}.'));
    container.appendChild(prompt);

    // {{modes}} kept inside a chosen block, per preset
    const blocks = card('Preset block');
    blocks.appendChild(richText(el('p', 'mt-hint'),
      'Pick a preset and the block your rules belong in. Mode Toggles adds {{modes}} to the end of it, and puts it back if a preset update removes it. Turn off other blocks with {{modes}} in that preset so modes aren\'t sent twice.'));
    const linked = el('div', 'mt-stack');
    for (const a of s.presetBlocks || []) {
      const row = el('div', 'mt-linked');
      const text = el('div', 'mt-linked-text');
      text.append(el('div', 'mt-linked-name', a.presetName), el('div', 'mt-linked-block', `→ ${a.blockName}`));
      row.append(text, iconButton('x', `Stop keeping {{modes}} in ${a.blockName}`, () =>
        showThemedConfirm(`Remove {{modes}} from "${a.blockName}" in "${a.presetName}"?`, () =>
          send({ type: 'clear_preset_block', presetId: a.presetId }), 'Remove'), 'mt-icon-btn-danger'));
      linked.appendChild(row);
    }
    if (linked.childElementCount) blocks.appendChild(linked);

    if (presetList === null) {
      blocks.appendChild(button('Choose a preset block…', 'mt-btn-block', () => send({ type: 'list_presets' }), 'plus'));
    } else {
      const picker = el('div', 'mt-stack');
      picker.appendChild(select(
        [['', presetList.length ? 'Choose a preset…' : 'No presets found'], ...presetList.map((p) => [p.id, p.name] as [string, string])],
        pickerPresetId, 'Preset', (v) => {
          pickerPresetId = v;
          pickerBlocks = null;
          pickerBlockId = '';
          pickerError = '';
          if (pickerPresetId) send({ type: 'list_blocks', presetId: pickerPresetId });
          renderSettingsTab();
        }));
      if (presetListError) {
        picker.appendChild(el('p', 'mt-error', `Couldn't read your presets (grant the "presets" permission): ${presetListError}`));
      }
      if (pickerPresetId && pickerBlocks === null) {
        picker.appendChild(el('p', 'mt-hint', 'Loading blocks…'));
      } else if (pickerPresetId && pickerBlocks) {
        picker.appendChild(select(
          [['', pickerBlocks.length ? 'Choose a block…' : 'No blocks that can hold text'],
            ...pickerBlocks.map((b) => {
              const notes = [...(b.notes ?? (b.enabled ? [] : ['off'])), ...(b.hasModes ? ['already has {{modes}}'] : [])];
              return [b.id, `${b.isCategory ? '▸ ' : ''}${b.name || '(unnamed)'}${notes.length ? ` (${notes.join(', ')})` : ''}`] as [string, string];
            })],
          pickerBlockId, 'Block', (v) => { pickerBlockId = v; }));
        const applyBtn = button('Keep {{modes}} in this block', 'mt-btn-primary mt-btn-block', () => {
          if (!pickerBlockId) return;
          const presetName = presetList?.find((p) => p.id === pickerPresetId)?.name ?? '';
          send({ type: 'set_preset_block', presetId: pickerPresetId, blockId: pickerBlockId, presetName });
        });
        picker.appendChild(applyBtn);
        if (pickerError) picker.appendChild(el('p', 'mt-error', pickerError));
      }
      blocks.appendChild(picker);
    }
    container.appendChild(blocks);

    // Reset
    const danger = card('Reset', 'mt-card-danger');
    const row = el('div', 'mt-row');
    row.append(
      button('Remove custom modes', 'mt-btn-danger', () =>
        showThemedConfirm('Remove all custom modes? Built-in modes stay.', () =>
          send({ type: 'remove_all_custom' }), 'Remove')),
      button('Reset to defaults', 'mt-btn-danger', () =>
        showThemedConfirm('Reset all settings, custom modes, and per-chat states? Your presets will be kept.', () =>
          send({ type: 'reset_defaults' }), 'Reset')),
    );
    danger.appendChild(row);
    container.appendChild(danger);
  }

  // ===== Toggle Popover (via Input Bar Action) =====
  function showTogglePopover() {
    if (activePopover && document.body.contains(activePopover)) {
      closePopover();
      return;
    }
    if (Date.now() - lastOutsideCloseAt < 300) return; // this click just closed it

    // Ask backend for fresh state (detects chat switches)
    send({ type: 'request_state' });

    const popover = el('div', 'mt-popover');
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', 'Mode Toggles');
    activePopover = popover;
    renderPopoverContent(popover);
    document.body.appendChild(popover);

    const closeHandler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (popover.contains(target)) return;
      // Our own dialogs (Add/Edit, Presets, confirms) sit outside the popover;
      // working in them shouldn't close it.
      if (openDialogs.size > 0) return;
      lastOutsideCloseAt = Date.now();
      closePopover();
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || openDialogs.size > 0) return;
      // First Escape clears the search (handled by the input); a second one closes.
      if (searchQuery) return;
      closePopover();
    };
    popoverCloseHandler = closeHandler;
    popoverKeyHandler = keyHandler;
    setTimeout(() => {
      if (activePopover !== popover) return; // closed before the listener attached
      document.addEventListener('click', closeHandler, true);
      document.addEventListener('keydown', keyHandler, true);
    }, 50);
  }

  function renderPopoverCount() {
    if (!activeCountEl || !state) return;
    const n = state.activeCount;
    activeCountEl.className = n > 0 ? 'mt-badge mt-badge-on' : 'mt-badge';
    activeCountEl.textContent = `${n} on`;
  }

  function renderPopoverContent(container: HTMLElement) {
    container.innerHTML = '';
    if (!state) {
      container.appendChild(el('p', 'mt-empty', 'Loading…'));
      return;
    }

    // Header: title, count, search
    const head = el('div', 'mt-pop-head');
    const titleRow = el('div', 'mt-pop-title-row');
    titleRow.insertAdjacentHTML('afterbegin', MICROCHIP_SVG_14);
    titleRow.appendChild(el('h2', 'mt-pop-title', 'Mode Toggles'));
    activeCountEl = el('span', 'mt-badge');
    titleRow.appendChild(activeCountEl);
    titleRow.appendChild(iconButton('x', 'Close', () => closePopover()));
    head.appendChild(titleRow);

    const searchWrap = el('div', 'mt-search-wrap');
    searchWrap.insertAdjacentHTML('afterbegin', icon('search', 14));
    const search = el('input', 'mt-input');
    search.type = 'search';
    search.placeholder = 'Search modes…';
    search.setAttribute('aria-label', 'Search modes');
    search.value = searchQuery;
    search.addEventListener('input', () => {
      searchQuery = search.value.trim().toLowerCase();
      listEl.scrollTop = 0;
      renderModeList(listEl);
    });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && searchQuery) {
        e.stopPropagation();
        searchQuery = ''; search.value = ''; renderModeList(listEl);
      }
    });
    searchWrap.appendChild(search);
    head.appendChild(searchWrap);
    container.appendChild(head);

    // Mode list
    const listEl = el('div', 'mt-pop-list');
    activeListEl = listEl;
    renderModeList(listEl);
    container.appendChild(listEl);

    // Actions, always visible
    const foot = el('div', 'mt-pop-foot');
    activeFootEl = foot;
    renderPopoverFooter(foot);
    container.appendChild(foot);

    renderPopoverCount();
    // Focus search
    setTimeout(() => { search.focus(); search.select(); }, 50);
  }

  function actionButton(label: string, iconName: IconName, onClick: () => void, extra = ''): HTMLButtonElement {
    const b = el('button', `mt-action${extra ? ` ${extra}` : ''}`);
    b.type = 'button';
    b.title = label;
    b.innerHTML = icon(iconName, 16);
    b.appendChild(el('span', '', label));
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  function renderPopoverFooter(foot: HTMLElement) {
    foot.innerHTML = '';
    if (!state) return;
    // Undo (reversibility) — only when a destructive action can be reverted.
    if (state.undoAvailable) {
      const undo = button(`Undo: ${state.undoLabel}`, 'mt-undo mt-btn-block', () => send({ type: 'undo_last' }), 'undo');
      foot.appendChild(undo);
    }
    const main = el('div', 'mt-actions');
    main.append(
      actionButton('Add', 'plus', () => showAddEditPrompt()),
      actionButton('Presets', 'layers', showPresetsDialog),
      actionButton('Random', 'shuffle', () => send({ type: 'activate_random' })),
      actionButton('All off', 'power', () => send({ type: 'disable_all' }), 'mt-action-danger'),
    );
    const moreBtn = actionButton('More', 'more', () => {
      moreActionsOpen = !moreActionsOpen;
      renderPopoverFooter(foot);
    });
    moreBtn.setAttribute('aria-expanded', String(moreActionsOpen));
    main.appendChild(moreBtn);
    foot.appendChild(main);
    if (moreActionsOpen) {
      const more = el('div', 'mt-actions mt-actions-more');
      more.append(
        actionButton('Export', 'download', showExportDialog),
        actionButton('Import', 'upload', doImport),
        actionButton('Save config', 'save', () => send({ type: 'export_config' })),
        actionButton('Load config', 'folder', doImportConfig),
        actionButton('Tidy', 'sparkle', () => send({ type: 'request_tidy_report' })),
      );
      foot.appendChild(more);
    }
  }

  function renderModeList(container: HTMLElement) {
    container.innerHTML = '';
    if (!state) return;

    // Word-by-word, typo-tolerant search (see search.ts). Every word must
    // match somewhere; results are ranked with name matches first.
    const tokens = tokenize(searchQuery);
    const searching = tokens.length > 0;
    const scores = new Map<string, number>();
    const filtered = state.modes.filter((m) => {
      const s = scoreMode(m, tokens);
      if (s > 0) scores.set(m.name, s);
      return s > 0;
    });
    const order = (a: ModeView, b: ModeView) =>
      searching
        ? (scores.get(b.name)! - scores.get(a.name)!) || naturalCompare(a.name, b.name)
        : naturalCompare(a.name, b.name);

    if (!state.enabled) {
      const banner = el('div', 'mt-notice');
      banner.insertAdjacentHTML('afterbegin', icon('alert', 14));
      banner.appendChild(richText(el('span'), 'Mode Toggles is off, so {{modes}} sends nothing. Turn it on in the Mode Toggles drawer tab.'));
      container.appendChild(banner);
    }

    // Enabled section
    const enabled = filtered.filter((m) => m.status === 'ON').sort(order);
    if (enabled.length > 0) {
      container.appendChild(renderAccordion('On in this chat', enabled, false, { forceOpen: true, key: '__enabled__', enabledGroup: true }));
    }

    if (searching && filtered.length === 0) {
      container.appendChild(el('div', 'mt-empty', 'No modes match. Try fewer or different words.'));
    } else if (!searching && state.modes.length === 0) {
      container.appendChild(el('div', 'mt-empty', 'No modes yet. Add one, or turn on built-in modes in the drawer tab.'));
    } else if (state.settings.sortMode === 'flat') {
      // One predictable A→Z list of everything (ranked while searching).
      const all = filtered.slice().sort(order);
      if (all.length > 0) container.appendChild(renderAccordion('All modes', all, true, { forceOpen: searching }));
    } else {
      const groupsMap = new Map<string, ModeView[]>();
      for (const mode of filtered) {
        const g = mode.group || 'Unsorted';
        if (!groupsMap.has(g)) groupsMap.set(g, []);
        groupsMap.get(g)!.push(mode);
      }
      // Browsing: groups A→Z, split into families ("Tech Era", "Tiny Treatment"...).
      // Searching: groups with the best match first, open, ranked flat inside.
      const best = (g: string) => Math.max(...groupsMap.get(g)!.map((m) => scores.get(m.name) || 0));
      const groupNames = Array.from(groupsMap.keys()).sort((a, b) =>
        searching ? (best(b) - best(a)) || naturalCompare(a, b) : naturalCompare(a, b));
      for (const gName of groupNames) {
        const items = groupsMap.get(gName)!.sort(order);
        container.appendChild(renderAccordion(gName, items, true, {
          forceOpen: searching,
          families: !searching,
        }));
      }
    }
  }

  function renderAccordion(
    title: string,
    items: ModeView[],
    showActiveCount = false,
    opts: { forceOpen?: boolean; families?: boolean; key?: string; nested?: boolean; enabledGroup?: boolean } = {},
  ): HTMLElement {
    const key = opts.key ?? title;
    const section = el('div', `mt-group${opts.enabledGroup ? ' mt-group-enabled' : ''}`);
    const header = el('button', `mt-group-header${opts.nested ? ' mt-group-sub' : ''}`);
    header.type = 'button';
    header.innerHTML = `<span class="mt-chev">${icon('chevron', 12)}</span>`;
    header.appendChild(el('span', 'mt-group-name', title));
    const count = el('span', 'mt-group-count');
    if (showActiveCount) {
      const active = items.filter((m) => m.status === 'ON').length;
      if (active > 0) count.append(el('b', '', String(active)), document.createTextNode(` / ${items.length}`));
      else count.textContent = String(items.length);
    } else {
      count.textContent = String(items.length);
    }
    header.appendChild(count);

    const content = el('div', 'mt-group-body');
    // While searching, sections with matches open automatically; the saved
    // open/closed state comes back once the search is cleared.
    const startOpen = !!(opts.forceOpen || accordionOpen[key]);
    content.hidden = !startOpen;
    header.setAttribute('aria-expanded', String(startOpen));

    header.addEventListener('click', () => {
      const open = content.hidden;
      content.hidden = !open;
      header.setAttribute('aria-expanded', String(open));
      if (!opts.forceOpen) accordionOpen[key] = open;
    });

    if (opts.families) {
      // Modes named "<Family> <number>: <title>" are gathered under a family
      // sub-header, even a family of one (like a lone master such as "Size Law 0").
      const fams = new Map<string, ModeView[]>();
      for (const m of items) {
        const f = familyOf(m.name);
        if (!f) continue;
        if (!fams.has(f)) fams.set(f, []);
        fams.get(f)!.push(m);
      }
      const loose = items.filter((m) => !familyOf(m.name));
      const familyNames = Array.from(fams.keys()).sort(naturalCompare);
      if (familyNames.length === 0) {
        // No families in this group (e.g. the built-in groups): plain list.
        for (const m of loose) content.appendChild(renderModeRow(m, key));
      } else {
        // Modes without a family go under one "General" header at the top,
        // so they don't sit expanded between the family headers.
        if (loose.length > 0) {
          content.appendChild(renderAccordion('General', loose, true, { key: `${key}::General`, nested: true }));
        }
        for (const f of familyNames) {
          content.appendChild(renderAccordion(f, fams.get(f)!, true, { key: `${key}::${f}`, nested: true }));
        }
      }
    } else {
      for (const mode of items) content.appendChild(renderModeRow(mode, key));
    }
    section.append(header, content);
    return section;
  }

  function renderModeRow(mode: ModeView, section: string): HTMLElement {
    const on = mode.status === 'ON';
    const row = el('div', `mt-mode${on ? ' mt-mode-on' : ''}`);
    row.dataset.section = section;
    row.dataset.mode = mode.name;
    const toggle = el('button', 'mt-mode-toggle');
    toggle.type = 'button';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(on));
    toggle.title = mode.description ? `${mode.name}\n\n${mode.description}` : mode.name;
    const text = el('span', 'mt-mode-text');
    text.appendChild(el('span', 'mt-mode-name', mode.name));
    if (mode.description) text.appendChild(el('span', 'mt-mode-desc', mode.description));
    toggle.append(text, switchControl(on, '', undefined, true));
    toggle.addEventListener('click', () => {
      const list = activeListEl;
      if (list) {
        toggleAnchor = {
          section, name: mode.name, at: Date.now(),
          offset: row.getBoundingClientRect().top - list.getBoundingClientRect().top,
          focused: document.activeElement === toggle,
        };
      }
      send({ type: 'toggle_mode', modeName: mode.name });
    });
    const edit = iconButton('pencil', `Edit ${mode.name}`, (e) => {
      e.stopPropagation();
      showAddEditPrompt({ name: mode.name, group: mode.group, description: mode.description });
    }, 'mt-mode-edit');
    row.append(toggle, edit);
    return row;
  }

  // ===== Dialogs =====
  // Lumiverse's own modal when the host has it (its header, close button and
  // theme), otherwise a themed overlay. Each dialog is tracked so the popover
  // stays open while one is in use and unload closes any left open.
  interface Dialog { key: string; body: HTMLElement; footer: HTMLElement; close: () => void }
  const openDialogs = new Set<Dialog>();

  // True (and focuses it) if a dialog with this key is already open, so a
  // second click on Presets, Add, Export... doesn't stack another copy.
  function dialogAlreadyOpen(key: string): boolean {
    for (const d of openDialogs) {
      if (d.key !== key) continue;
      d.body.querySelector<HTMLElement>('input, textarea, button')?.focus();
      return true;
    }
    return false;
  }

  function openDialog(title: string, width = 420, key = title): Dialog {
    const body = el('div', 'mt-dialog');
    const footer = el('div', 'mt-dialog-foot');
    let closed = false;
    let dismissHost: (() => void) | null = null;
    let overlay: HTMLElement | null = null;
    const dialog: Dialog = {
      key, body, footer,
      close: () => {
        if (closed) return;
        closed = true;
        openDialogs.delete(dialog);
        if (dismissHost) dismissHost();
        if (overlay) overlay.remove();
      },
    };
    const showModal = (ctx.ui as any).showModal as undefined | ((o: any) => any);
    let hosted = false;
    if (typeof showModal === 'function') {
      try {
        const modal = showModal.call(ctx.ui, { title, width });
        modal.root.appendChild(body);
        modal.onDismiss(() => { if (!closed) { closed = true; openDialogs.delete(dialog); } });
        dismissHost = () => modal.dismiss();
        hosted = true;
      } catch {
        // e.g. the host's two-modal stack limit: fall back to our overlay.
      }
    }
    if (!hosted) {
      overlay = el('div', 'mt-overlay');
      const modal = el('div', 'mt-modal');
      modal.style.maxWidth = `${width}px`;
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-label', title);
      const head = el('div', 'mt-modal-head');
      head.append(el('h2', 'mt-modal-title', title), iconButton('x', 'Close', () => dialog.close()));
      const scroll = el('div', 'mt-modal-body');
      scroll.appendChild(body);
      modal.append(head, scroll);
      overlay.appendChild(modal);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) dialog.close(); });
      overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); dialog.close(); } });
      document.body.appendChild(overlay);
    }
    body.appendChild(footer);
    openDialogs.add(dialog);
    return dialog;
  }

  // Adds content above the footer.
  function addToDialog(d: Dialog, ...nodes: Node[]) {
    for (const n of nodes) d.body.insertBefore(n, d.footer);
  }

  function showThemedConfirm(message: string, onConfirm: () => void, confirmLabel = 'Confirm') {
    const d = openDialog('Are you sure?', 380);
    addToDialog(d, richText(el('p'), message));
    d.footer.append(
      button('Cancel', '', () => d.close()),
      button(confirmLabel, 'mt-btn-danger', () => { d.close(); onConfirm(); }),
    );
  }

  function showThemedAlert(message: string, title = 'Mode Toggles') {
    const d = openDialog(title, 380);
    addToDialog(d, richText(el('p'), message));
    const ok = button('OK', 'mt-btn-primary', () => d.close());
    d.footer.append(ok);
    setTimeout(() => ok.focus(), 50);
  }

  function field(label: string, control: HTMLInputElement | HTMLTextAreaElement, id: string): HTMLElement {
    const wrap = el('div');
    const l = el('label', 'mt-field-label', label);
    control.id = id;
    l.htmlFor = id;
    wrap.append(l, control);
    return wrap;
  }

  function showAddEditPrompt(prefill?: { name: string; group: string; description: string }) {
    if (dialogAlreadyOpen('mode-editor')) return;
    const d = openDialog(prefill ? 'Edit mode' : 'Add mode', 440, 'mode-editor');

    const nameInput = el('input', 'mt-input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Mode name';
    if (prefill) { nameInput.value = prefill.name; nameInput.readOnly = true; }

    const groupInput = el('input', 'mt-input');
    groupInput.type = 'text';
    groupInput.placeholder = 'Unsorted';
    if (prefill) groupInput.value = prefill.group;
    // Offer existing groups as suggestions.
    const groups = Array.from(new Set((state?.modes ?? []).map((m) => m.group).filter(Boolean))).sort(naturalCompare);
    if (groups.length) {
      const dl = el('datalist');
      dl.id = 'mt-group-suggestions';
      for (const g of groups) { const o = el('option'); o.value = g; dl.appendChild(o); }
      groupInput.setAttribute('list', dl.id);
      d.body.appendChild(dl);
    }

    const descInput = el('textarea', 'mt-textarea');
    descInput.rows = 4;
    descInput.style.fontFamily = 'inherit';
    descInput.style.fontSize = fs(13);
    descInput.placeholder = 'What this mode tells the model…';
    if (prefill) descInput.value = prefill.description;

    const errorEl = el('p', 'mt-error');
    errorEl.setAttribute('role', 'alert');
    addToDialog(d,
      field('Name', nameInput, 'mt-mode-name-input'),
      field('Group', groupInput, 'mt-mode-group-input'),
      field('Description', descInput, 'mt-mode-desc-input'),
      richText(el('p', 'mt-hint'), 'The description is what {{modes}} sends to the model.'),
      errorEl,
    );

    const saveBtn = button('Save', 'mt-btn-primary', () => {
      const name = nameInput.value.trim();
      const group = groupInput.value.trim() || 'Unsorted';
      const description = descInput.value.trim();
      const err = !name ? 'Name is required.'
        : !description ? 'Description is required. This text is what {{modes}} sends to the model.'
        : name.includes(' - ') ? 'Name cannot contain " - " (it separates fields on export).'
        : group.includes(' - ') ? 'Group cannot contain " - ".'
        : group.includes(',') ? 'Group cannot contain commas.'
        : group.length > 40 ? 'Group must be 40 characters or fewer.'
        : '';
      if (err) { errorEl.textContent = err; return; }
      // When adding new, warn if the name already exists. Mode names are
      // case-sensitive keys, so reuse the existing spelling to really overwrite it.
      const existing = !prefill && state
        ? state.modes.find((m) => m.name.toLowerCase() === name.toLowerCase())
        : undefined;
      if (existing) {
        showThemedConfirm(`A mode called "${existing.name}" already exists. Overwrite it?`, () => {
          send({ type: 'add_edit_mode', name: existing.name, group, description });
          d.close();
        }, 'Overwrite');
        return;
      }
      send({ type: 'add_edit_mode', name, group, description });
      d.close();
    });
    // Built-in modes can't be deleted; an edited built-in can be restored.
    const source = prefill ? state?.modes.find((m) => m.name === prefill.name)?.source : undefined;
    if (prefill && (source === 'custom' || source === 'override')) {
      const isRestore = source === 'override';
      const del = button(isRestore ? 'Restore default' : 'Delete', `${isRestore ? 'mt-btn-warning' : 'mt-btn-danger'} mt-spacer`, () => {
        const msg = isRestore
          ? `Discard your edits to "${prefill.name}" and restore the built-in version?`
          : `Delete mode "${prefill.name}"?`;
        showThemedConfirm(msg, () => {
          send({ type: 'delete_mode', name: prefill.name });
          d.close();
        }, isRestore ? 'Restore' : 'Delete');
      }, isRestore ? 'undo' : 'trash');
      d.footer.appendChild(del);
    }
    d.footer.append(button('Cancel', '', () => d.close()), saveBtn);
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
          // Ask the backend what this import would do before doing it.
          send({ type: 'import_preview', text });
        }
      }
    } catch (e) {
      // User cancelled or error
    }
  }

  // Pick which groups of custom modes to export. All start ticked.
  function showExportDialog() {
    if (!state) return;
    const counts = new Map<string, number>();
    for (const m of state.modes) {
      if (m.source === 'core') continue; // only custom and edited modes are exportable
      const g = m.group || 'Unsorted';
      counts.set(g, (counts.get(g) || 0) + 1);
    }
    if (counts.size === 0) {
      showThemedAlert('You have no custom or edited modes to export yet.', 'Export modes');
      return;
    }
    if (dialogAlreadyOpen('export')) return;
    const d = openDialog('Export modes', 400, 'export');
    addToDialog(d, el('p', 'mt-hint', 'Choose which groups of your custom modes to export.'));
    const boxes: Array<{ group: string; cb: HTMLInputElement }> = [];
    const list = el('div', 'mt-check-list');
    for (const g of Array.from(counts.keys()).sort(naturalCompare)) {
      const label = el('label', 'mt-check');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = true;
      label.append(cb, el('span', 'mt-check-label', g), el('span', 'mt-check-count', String(counts.get(g))));
      list.appendChild(label);
      boxes.push({ group: g, cb });
    }
    addToDialog(d, list);

    const toggleAll = button('Select none', 'mt-spacer', () => {
      const anyOn = boxes.some((x) => x.cb.checked);
      for (const x of boxes) x.cb.checked = !anyOn;
      toggleAll.textContent = anyOn ? 'Select all' : 'Select none';
    });
    d.footer.append(
      toggleAll,
      button('Cancel', '', () => d.close()),
      button('Export', 'mt-btn-primary', () => {
        const groups = boxes.filter((x) => x.cb.checked).map((x) => x.group);
        if (groups.length === 0) return;
        send({ type: 'export_modes', groups });
        d.close();
      }, 'download'),
    );
  }

  function showImportPreview(text: string, r: {
    valid: number; errors: number; groups: string[]; added: number; updated: number;
    unchanged: number; renamed: Array<{ from: string; to: string }>; removed: string[];
  }) {
    if (r.valid === 0) {
      showThemedAlert(r.errors > 0
        ? `No valid modes found (${r.errors} line(s) had format errors). Each line should look like: Name - Group - Description`
        : 'No modes found. Each line should look like: Name - Group - Description', 'Import modes');
      return;
    }
    if (dialogAlreadyOpen('import')) return;
    const d = openDialog('Import modes', 460, 'import');
    addToDialog(d, el('p', 'mt-hint', `${r.valid} mode${r.valid === 1 ? '' : 's'} in the file · ${r.groups.join(', ')}`));

    const stats = el('div', 'mt-stats');
    for (const [n, label] of [[r.added, 'new'], [r.updated, 'changed'], [r.unchanged, 'up to date']] as const) {
      const s = el('div', 'mt-stat');
      s.append(el('b', '', String(n)), el('span', '', label));
      stats.appendChild(s);
    }
    addToDialog(d, stats);
    if (r.errors) addToDialog(d, el('p', 'mt-error', `${r.errors} line(s) skipped: format errors`));

    const hasReplaceWork = r.renamed.length > 0 || r.removed.length > 0;
    if (hasReplaceWork) {
      addToDialog(d, el('p', '', 'Add imports the file and leaves everything else. Replace also cleans up modes in those groups that the file no longer has:'));
      const box = el('div', 'mt-scroll-box');
      if (r.renamed.length) {
        box.appendChild(el('div', '', `${r.renamed.length} rename${r.renamed.length === 1 ? '' : 's'}: the old name is removed and its chat toggles and presets move to the new one (Add would keep both).`));
        const ul = el('ul');
        for (const x of r.renamed.slice(0, 8)) ul.appendChild(el('li', '', `${x.from} → ${x.to}`));
        if (r.renamed.length > 8) ul.appendChild(el('li', '', `…and ${r.renamed.length - 8} more`));
        box.appendChild(ul);
      }
      if (r.removed.length) {
        box.appendChild(el('div', '', `${r.removed.length} removed:`));
        const ul = el('ul');
        for (const n of r.removed.slice(0, 8)) ul.appendChild(el('li', '', n));
        if (r.removed.length > 8) ul.appendChild(el('li', '', `…and ${r.removed.length - 8} more`));
        box.appendChild(ul);
      }
      addToDialog(d, box, el('p', 'mt-hint', 'Other groups and edited built-in modes are not touched.'));
    } else {
      addToDialog(d, el('p', 'mt-hint', 'Nothing would be renamed or removed, so Add and Replace do the same thing.'));
    }

    d.footer.append(button('Cancel', '', () => d.close()));
    if (hasReplaceWork) {
      d.footer.append(button('Replace', 'mt-btn-warning', () => { send({ type: 'import_modes', text, mode: 'replace' }); d.close(); }));
    }
    d.footer.append(button('Add', 'mt-btn-primary', () => { send({ type: 'import_modes', text, mode: 'add' }); d.close(); }));
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
          showThemedAlert('Invalid JSON file.', 'Load config');
          return;
        }
        showThemedConfirm(
          'This will replace all settings, custom modes, and presets. Per-chat mode states will be kept. Continue?',
          () => send({ type: 'import_config', config: parsed }),
          'Replace',
        );
      }
    } catch (e) {
      // User cancelled or error
    }
  }

  // ===== Presets Dialog =====
  function showPresetsDialog() {
    if (!state) return;
    if (dialogAlreadyOpen('presets')) return;
    const d = openDialog('Presets', 440, 'presets');
    addToDialog(d, el('p', 'mt-hint', 'Save this chat’s active modes as a preset, or load one into this chat.'));

    // Save
    const saveRow = el('div', 'mt-inline');
    const saveInput = el('input', 'mt-input');
    saveInput.type = 'text';
    saveInput.placeholder = 'New preset name…';
    saveInput.setAttribute('aria-label', 'New preset name');
    const activeCount = state.modes.filter((m) => m.status === 'ON').length;
    const saveBtn = button('Save current', 'mt-btn-primary', () => {
      const name = saveInput.value.trim();
      if (!name) { saveInput.focus(); return; }
      const exists = state!.presets.some((p) => p.name === name);
      const doSave = () => {
        send({ type: 'save_preset', name });
        d.close();
      };
      if (exists) showThemedConfirm(`Preset "${name}" already exists. Overwrite?`, doSave, 'Overwrite');
      else doSave();
    }, 'save');
    if (activeCount === 0) {
      saveBtn.disabled = true;
      saveBtn.title = 'No modes currently active';
    }
    saveInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveBtn.click(); });
    saveRow.append(saveInput, saveBtn);
    addToDialog(d, saveRow);

    // List
    const listWrap = el('div', 'mt-preset-list');
    if (state.presets.length === 0) {
      listWrap.appendChild(el('div', 'mt-empty', 'No presets saved yet.'));
    } else {
      for (const preset of state.presets) {
        const row = el('div', 'mt-preset');
        const info = el('div', 'mt-preset-info');
        info.append(el('div', 'mt-preset-name', preset.name),
          el('div', 'mt-preset-count', `${preset.count} mode${preset.count === 1 ? '' : 's'}`));
        const load = button('Load', 'mt-btn-primary', () => {
          send({ type: 'load_preset', name: preset.name, mergeMode: 'replace' });
          d.close();
        });
        load.title = 'Replace the modes that are on with this preset';
        const merge = button('Merge', '', () => {
          send({ type: 'load_preset', name: preset.name, mergeMode: 'merge' });
          d.close();
        });
        merge.title = 'Turn on this preset’s modes and keep the ones already on';
        row.append(info, load, merge,
          iconButton('pencil', `Rename ${preset.name}`, () =>
            showRenamePrompt(preset.name, (newName) => {
              send({ type: 'rename_preset', oldName: preset.name, newName });
              d.close();
            })),
          iconButton('trash', `Delete ${preset.name}`, () =>
            showThemedConfirm(`Delete preset "${preset.name}"?`, () => {
              send({ type: 'delete_preset', name: preset.name });
              d.close();
            }, 'Delete'), 'mt-icon-btn-danger'));
        listWrap.appendChild(row);
      }
    }
    addToDialog(d, listWrap);
    d.footer.append(button('Close', '', () => d.close()));
    setTimeout(() => saveInput.focus(), 50);
  }

  function showRenamePrompt(oldName: string, onRename: (newName: string) => void) {
    if (dialogAlreadyOpen('rename')) return;
    const d = openDialog('Rename preset', 360, 'rename');
    const input = el('input', 'mt-input');
    input.type = 'text';
    input.value = oldName;
    addToDialog(d, field('Name', input, 'mt-rename-input'));
    const ok = button('Rename', 'mt-btn-primary', () => {
      const v = input.value.trim();
      if (v && v !== oldName) onRename(v);
      d.close();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') ok.click();
      if (e.key === 'Escape') { e.stopPropagation(); d.close(); }
    });
    d.footer.append(button('Cancel', '', () => d.close()), ok);
    setTimeout(() => { input.focus(); input.select(); }, 50);
  }

  // ===== Helpers =====
  function downloadText(text: string, filename: string, mime: string) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoking synchronously can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Cleanup
  return () => {
    for (const unsub of unsubs.splice(0)) {
      try { unsub(); } catch { /* the host may have released it already */ }
    }
    closePopover();
    // Dialogs live outside the drawer tab, so close any left open.
    for (const d of [...openDialogs]) {
      try { d.close(); } catch { /* the host may have closed it already */ }
    }
    ctx.dom.cleanup();
    if (tab) tab.destroy();
    if (toggleAction) toggleAction.destroy();
  };
}

// ===== Icons =====
// Small stroke icons drawn in the current text color.
type IconName = 'plus' | 'layers' | 'shuffle' | 'power' | 'more' | 'download' | 'upload' | 'save' | 'folder'
  | 'sparkle' | 'undo' | 'pencil' | 'trash' | 'x' | 'search' | 'chevron' | 'alert';
const ICON_PATHS: Record<IconName, string> = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/>',
  shuffle: '<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  upload: '<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14"/>',
  save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7V3"/><path d="M8 21v-7h8v7"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  pencil: '<path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
};
function icon(name: IconName, size = 16): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
}
