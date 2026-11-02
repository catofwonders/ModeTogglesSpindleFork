/**
 * ============================================================================
 * LUMISCRIPT — INJECTION STORE
 * ============================================================================
 * Module-level singleton that holds all active prompt injections for the
 * current LumiScript backend worker lifetime. Both the api.chat.inject()
 * call-path (per script execution) and the Spindle interceptor/context-handler
 * registrations (backend.ts, registered at startup) share this store.
 *
 * Injection modes:
 *  'intercept' — spliced into the assembled message array post-assembly by the
 *                registered spindle.registerInterceptor() handler.
 *  'context'   — forwarded to the assembler context object pre-assembly by the
 *                registered spindle.registerContextHandler() handler.
 */

/** Internal record stored in the singleton map. */
export interface InjectionEntry {
  id: string;
  content: string;
  mode: 'intercept' | 'context';
  role: string;         // 'system' | 'user' | 'assistant'
  depth: number;        // intercept only — messages from end; 0 = append
  ephemeral: boolean;   // if true, cleared after the next generation cycle
  scriptId: string;     // script that registered this injection (for cleanup)
}

// ─── Singleton ────────────────────────────────────────────────────────────────

const store = new Map<string, InjectionEntry>();

// ─── Limits ───────────────────────────────────────────────────────────────────

/** Maximum character count per injection content string (≈ 32 KB). */
const MAX_INJECTION_CONTENT_CHARS = 32 * 1024;

/**
 * Maximum number of simultaneously active injection entries (across all scripts).
 * Scripts should call removeInjection() or clearInjections() when injections
 * are no longer needed.
 */
const MAX_INJECTIONS = 50;

// ─── Mutators ─────────────────────────────────────────────────────────────────

/**
 * Add or overwrite an injection entry.
 *
 * Throws if `entry.content` exceeds the 32 KB character limit or if the total
 * active injection count would exceed 50. The count limit is skipped when
 * updating an existing entry (same ID) since the store size does not grow.
 */
export function addInjection(entry: InjectionEntry): void {
  if (entry.content.length > MAX_INJECTION_CONTENT_CHARS) {
    throw new Error(
      `api.chat.inject: content too large (${entry.content.length} chars). ` +
      `Maximum is ${MAX_INJECTION_CONTENT_CHARS} chars (32 KB).`,
    );
  }
  if (!store.has(entry.id) && store.size >= MAX_INJECTIONS) {
    throw new Error(
      `api.chat.inject: active injection limit reached (${MAX_INJECTIONS}). ` +
      `Call api.chat.removeInjection() or api.chat.clearInjections() to free slots.`,
    );
  }
  store.set(entry.id, entry);
}

/** Remove an injection by ID. No-op if not found. */
export function removeInjection(id: string): void {
  store.delete(id);
}

/** Remove all injections created by a given script (on delete / disable). */
export function clearByScriptId(scriptId: string): void {
  for (const [id, entry] of store) {
    if (entry.scriptId === scriptId) store.delete(id);
  }
}

/** Remove all ephemeral injections of a given mode (called after generation). */
export function clearEphemeral(mode: 'intercept' | 'context'): void {
  for (const [id, entry] of store) {
    if (entry.ephemeral && entry.mode === mode) store.delete(id);
  }
}

/** Remove every injection regardless of script or mode. */
export function clearAll(): void {
  store.clear();
}

// ─── Readers ──────────────────────────────────────────────────────────────────

/** Return a snapshot array of all current entries. */
export function listAll(): InjectionEntry[] {
  return [...store.values()];
}

/** Return entries for a specific mode (single allocation — no intermediate spread). */
export function listByMode(mode: 'intercept' | 'context'): InjectionEntry[] {
  const result: InjectionEntry[] = [];
  for (const entry of store.values()) {
    if (entry.mode === mode) result.push(entry);
  }
  return result;
}

/** Return entries belonging to a specific script. */
export function listByScriptId(scriptId: string): InjectionEntry[] {
  return [...store.values()].filter(e => e.scriptId === scriptId);
}
