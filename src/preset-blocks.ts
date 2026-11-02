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
 * Blocks whose own text is sent to the model: regular blocks, the
 * text-bearing markers above, and category headers. Structural markers such
 * as Chat History or World Info are placeholders Lumiverse fills itself, and
 * sealed LumiHub blocks have their text supplied by LumiHub, so neither can
 * hold {{modes}}.
 */
export function pickableBlocks<T extends BlockLike>(blocks: ReadonlyArray<T>): T[] {
  return blocks.filter((b) =>
    (b.marker === null || b.marker === undefined || TEXT_MARKERS.has(b.marker)) && b.sealed !== true);
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
