/**
 * ============================================================================
 * LUMISCRIPT — INTERCEPTOR PIPELINE
 * ============================================================================
 * Pure helper for splicing LumiScript-owned injection entries into the
 * assembled prompt-message array AND emitting breakdown metadata so each
 * injection appears as a first-class row in Lumiverse's Prompt Breakdown
 * / Dry Run UI, attributed back to the owning script.
 *
 * Backed by the `InterceptorResultDTO.breakdown` field added in
 * `lumiverse-spindle-types` 0.4.37. Backwards-compatible: when the
 * breakdown array is empty, the caller can still return a plain
 * `LlmMessageDTO[]` (matches pre-0.4.37 hosts that may not parse the
 * object form). The helper returns both shapes structurally — the caller
 * decides which to surface.
 *
 * ## Splicing semantics
 *
 * - **context-mode** entries prepend at indices `0..N-1` in input order,
 *   so context injections always lead the assembled prompt regardless
 *   of their relative depth.
 * - **intercept-mode** entries splice at `result.length - e.depth` from
 *   the END of the current array, AFTER the context-mode prepend has
 *   already shifted positions. Multiple intercept-mode entries are
 *   processed in input order; each splice may shift earlier-spliced
 *   entries forward.
 *
 * ## Breakdown index correctness
 *
 * Splice-shift is the subtle bit. If we recorded `breakdown.messageIndex`
 * inline at the moment of splicing, a later intercept-mode insertion
 * before an earlier one's index would invalidate the earlier captured
 * position. The fix is to TAG injected messages by reference (via a
 * `WeakMap<object, string>` keyed on the message object itself) during
 * splicing, then walk the final settled array exactly once to emit
 * `breakdown` entries with current indices. This is correct regardless
 * of splice ordering and costs O(N) over the final array.
 *
 * ## Why a separate file
 *
 * Extracted from `backend.ts` for testability — the interceptor closure
 * registered via `spindle.registerInterceptor` is otherwise un-mockable
 * inline. Pure function: no Spindle imports, no module-state, dependency
 * injection for `resolveScriptName` so tests can pass a fixed mock and
 * production passes `scriptId => scriptStorage.getScript(scriptId)?.name`.
 */

import type { InjectionEntry } from './injection-store.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Minimal LLM-message shape consumed by the pipeline. Matches the
 * structural subset of `LlmMessageDTO` we touch — keeps this module
 * decoupled from `lumiverse-spindle-types` so tests don't need a
 * mock spindle to import.
 *
 * `content` mirrors `LlmMessageDTO.content` (string | parts array) since
 * spindle-types 0.4.71. The pipeline does NOT introspect content — it
 * only constructs new injection messages (always string-content) and
 * shallow-copies references into the output array. Parts-content from
 * upstream simply flows through.
 */
export type PipelineMessagePart =
  | { type: 'text';        text: string;                                                  cache_control?: Record<string, unknown> }
  | { type: 'image';       data: string; mime_type: string;                               cache_control?: Record<string, unknown> }
  | { type: 'audio';       data: string; mime_type: string;                               cache_control?: Record<string, unknown> }
  | { type: 'tool_use';    id: string;   name: string; input: Record<string, unknown>;    cache_control?: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean;      cache_control?: Record<string, unknown> };

export interface PipelineMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | PipelineMessagePart[];
}

/**
 * One row in the Prompt Breakdown UI per LumiScript-injected message.
 * Maps to `InterceptorBreakdownEntryDTO` from spindle-types 0.4.37.
 *
 * `name` follows `<scriptName>: <injectionId>` so a user with multiple
 * scripts injecting to the same chat can attribute "this 1.2k tokens
 * came from `roll-dice: history-context`" at a glance.
 */
export interface PipelineBreakdownEntry {
  messageIndex: number;
  name: string;
}

export interface PipelineResult {
  messages: PipelineMessage[];
  /** Empty when no LumiScript injections were applied. The caller is
   *  expected to omit `breakdown` from `InterceptorResultDTO` (or
   *  return the legacy array shape entirely) when this is empty. */
  breakdown: PipelineBreakdownEntry[];
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

/**
 * Apply context-mode + intercept-mode injection entries to a base
 * message array and emit Prompt Breakdown metadata.
 *
 * Pure / deterministic given the same inputs. Does NOT mutate
 * `baseMessages`, `contextEntries`, or `interceptEntries`; produces a
 * fresh `messages` array.
 *
 * @param baseMessages       Host-assembled messages from the prompt
 *                           pipeline. Treated as read-only.
 * @param contextEntries     Snapshot of context-mode entries to prepend
 *                           (typically `listByMode('context')` result).
 *                           Order preserved at indices 0..N-1.
 * @param interceptEntries   Snapshot of intercept-mode entries to splice
 *                           at depth from the end. Order preserved;
 *                           later entries may shift earlier ones'
 *                           positions per splice semantics.
 * @param resolveScriptName  Callback to resolve a `scriptId` to a
 *                           display name. Tests pass a deterministic
 *                           mock; backend.ts passes
 *                           `id => scriptStorage.getScript(id)?.name ?? id`
 *                           so deleted scripts gracefully degrade to
 *                           the bare scriptId in breakdown labels.
 */
export function applyLumiScriptInjections(
  baseMessages: ReadonlyArray<PipelineMessage>,
  contextEntries: ReadonlyArray<InjectionEntry>,
  interceptEntries: ReadonlyArray<InjectionEntry>,
  resolveScriptName: (scriptId: string) => string,
): PipelineResult {
  let result: PipelineMessage[] = [...baseMessages];

  // Tag injected messages by object identity so we can recover correct
  // post-splicing positions later. WeakMap so the tags don't outlive
  // the messages themselves (Map would also work — these messages
  // don't escape this function — but WeakMap signals intent).
  const tagged = new WeakMap<object, string>();

  function labelFor(e: InjectionEntry): string {
    return `${resolveScriptName(e.scriptId)}: ${e.id}`;
  }

  // ── 1. Context-mode prepend ─────────────────────────────────────────────
  if (contextEntries.length > 0) {
    const ctxMsgs = contextEntries.map((e): PipelineMessage => {
      const msg: PipelineMessage = {
        role: e.role as PipelineMessage['role'],
        content: e.content,
      };
      tagged.set(msg, labelFor(e));
      return msg;
    });
    result = [...ctxMsgs, ...result];
  }

  // ── 2. Intercept-mode splice at depth ───────────────────────────────────
  for (const e of interceptEntries) {
    const idx = Math.max(0, result.length - e.depth);
    const msg: PipelineMessage = {
      role: e.role as PipelineMessage['role'],
      content: e.content,
    };
    tagged.set(msg, labelFor(e));
    result.splice(idx, 0, msg);
  }

  // ── 3. Walk the settled array to emit breakdown ────────────────────────
  // Indices captured here are FINAL positions — splice-shift on later
  // intercept-mode insertions is already accounted for since we look
  // up by object identity, not by remembered index.
  const breakdown: PipelineBreakdownEntry[] = [];
  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    if (msg && tagged.has(msg)) {
      breakdown.push({ messageIndex: i, name: tagged.get(msg)! });
    }
  }

  return { messages: result, breakdown };
}
