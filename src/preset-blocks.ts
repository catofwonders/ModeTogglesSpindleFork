// ===== Rules inside a preset block =====
// For each preset, the user picks one block. Mode Toggles keeps {{modes}} at
// the end of that block, so the modes (and the framing) are sent as part of
// that block's own text instead of as a separate block.
//
// Pure helpers only (no Spindle calls), so they can be tested without a host.

export const MODES_TAG = '{{modes}}';
const HAS_MODES_TAG = /\{\{\s*modes\s*\}\}/i;
// Only the exact text Mode Toggles adds: optional blank lines + {{modes}} at the end.
const ADDED_MODES_TAG = /\n*\{\{modes\}\}\s*$/;

export interface BlockLike {
  id: string;
  name: string;
  content: string;
  enabled?: boolean;
  marker?: string | null;
  sealed?: boolean;
  stashId?: string;
  role?: string;
  position?: string;
  injectionTrigger?: string[];
  characterTagTrigger?: string[];
}

/** What the user picked for one preset. The name is kept so the block can be
 *  found again if a preset update gives it a new id. */
export interface BlockAssignment {
  blockId: string;
  blockName: string;
  presetName: string;
}

export function hasModesTag(content: string): boolean {
  return HAS_MODES_TAG.test(content || '');
}

/** The block's content with {{modes}} at the end (unchanged if already present). */
export function withModesTag(content: string): string {
  const text = content || '';
  if (hasModesTag(text)) return text;
  const trimmed = text.replace(/\s+$/, '');
  return trimmed ? `${trimmed}\n\n${MODES_TAG}` : MODES_TAG;
}

/** The block's content with the {{modes}} Mode Toggles added removed again. */
export function withoutAddedModesTag(content: string): string {
  return (content || '').replace(ADDED_MODES_TAG, '');
}

/**
 * Markers whose block text Lumiverse sends as written (its
 * CONTENT_BEARING_MARKERS in prompt-assembly.service.ts), e.g. a preset's
 * Main Prompt. Category headers are sent too when they hold text.
 */
const TEXT_MARKERS = new Set(['category', 'main_prompt', 'enhance_definitions', 'jailbreak', 'nsfw_prompt']);

/**
 * Blocks whose own text is sent to the model and can safely hold {{modes}}:
 * regular blocks, the text-bearing markers above, and category headers. Not:
 *  - structural markers (Chat History, World Info, …): placeholders Lumiverse
 *    fills itself;
 *  - sealed LumiHub blocks: their text is supplied by LumiHub;
 *  - stashed blocks (stashId): shared across presets, so Lumiverse copies any
 *    edit into every preset that uses them (syncStashedBlocksAcrossPresets).
 */
export function pickableBlocks<T extends BlockLike>(blocks: ReadonlyArray<T>): T[] {
  return blocks.filter((b) =>
    !!b && typeof b.id === 'string'
    && (b.marker === null || b.marker === undefined || TEXT_MARKERS.has(b.marker))
    && b.sealed !== true
    && !(typeof b.stashId === 'string' && b.stashId.trim()));
}

/** Plain-words notes on when a block's text actually reaches the model. */
export function blockNotes(b: BlockLike): string[] {
  const notes: string[] = [];
  if (b.enabled === false) notes.push('off');
  if (b.position === 'in_history') notes.push('inside the chat history');
  if (b.position === 'post_history') notes.push('after the chat history');
  if (b.role === 'user_append' || b.role === 'assistant_append') notes.push('added onto a chat message');
  else if (b.role === 'user') notes.push('sent as a user message');
  else if (b.role === 'assistant') notes.push('sent as an assistant message');
  if (Array.isArray(b.injectionTrigger) && b.injectionTrigger.length > 0) notes.push('only for some kinds of generation');
  if (Array.isArray(b.characterTagTrigger) && b.characterTagTrigger.length > 0) notes.push('only for some characters');
  return notes;
}

// ===== Editing one block's text without touching anything else =====
// Lumiverse has two ways to save a block. spindle.presets.blocks.update
// re-saves EVERY block of the preset through normalizePromptBlock, which keeps
// only a fixed list of fields (it drops LumiHub's sealed fields, for one).
// spindle.presets.update stores prompt_order exactly as given, and only if the
// preset's cache_revision still matches (else it throws a revision conflict).
// So Mode Toggles reads the preset as stored, changes one block's content,
// and saves the whole list back as it was, retrying on a conflict.

export interface StoredPreset {
  prompt_order: Array<Record<string, unknown>>;
  cache_revision: number;
}

export interface PresetIO {
  get(presetId: string): Promise<StoredPreset | null>;
  /** Save prompt_order if the preset is still at `expectedRevision`; 'conflict' if it changed. */
  save(presetId: string, promptOrder: Array<Record<string, unknown>>, expectedRevision: number): Promise<'ok' | 'conflict' | 'gone'>;
}

export const MAX_PRESET_ATTEMPTS = 5;

export type EditResult = 'ok' | 'unchanged' | 'missing' | 'gone';

export async function editBlockContent(
  io: PresetIO,
  presetId: string,
  blockId: string,
  transform: (content: string) => string,
): Promise<EditResult> {
  for (let attempt = 1; attempt <= MAX_PRESET_ATTEMPTS; attempt++) {
    const preset = await io.get(presetId);
    if (!preset) return 'gone';
    const order = Array.isArray(preset.prompt_order) ? preset.prompt_order : [];
    const index = order.findIndex((b) => b && b.id === blockId);
    if (index === -1) return 'missing';
    const before = typeof order[index].content === 'string' ? (order[index].content as string) : '';
    const after = transform(before);
    if (after === before) return 'unchanged';
    // Every block, and every field of the edited block, stays exactly as stored.
    const next = order.map((b, i) => (i === index ? { ...b, content: after } : b));
    const result = await io.save(presetId, next, preset.cache_revision);
    if (result === 'ok') return 'ok';
    if (result === 'gone') return 'gone';
  }
  throw new Error(`the preset kept changing; not saved after ${MAX_PRESET_ATTEMPTS} attempts`);
}

/**
 * What {{modes}} outputs: the Framing text with the modes in place of its
 * {{modes}}, or after it when it has none. No active modes = nothing at all,
 * framing included.
 */
export function applyFraming(modesText: string, framing: string): string {
  if (!modesText) return '';
  const f = (framing || '').trim();
  if (!f) return modesText;
  if (HAS_MODES_TAG.test(f)) return f.replace(/\{\{\s*modes\s*\}\}/gi, () => modesText);
  return `${f}\n${modesText}`;
}

/** Finds the picked block: by id, or else by name when exactly one pickable block has it. */
export function findAssignedBlock<T extends BlockLike>(
  blocks: ReadonlyArray<T>,
  assignment: Pick<BlockAssignment, 'blockId' | 'blockName'>,
): T | null {
  const pickable = pickableBlocks(blocks);
  const byId = pickable.find((b) => b.id === assignment.blockId);
  if (byId) return byId;
  const byName = pickable.filter((b) => b.name === assignment.blockName);
  return byName.length === 1 ? byName[0] : null;
}
