# Vendored from LumiScript

These files are copied **unchanged** from [LumiScript](https://github.com/mindbound/lumiscript) by mindbound (Arets Paeglis), MIT licensed (see `LICENSE` in this folder), at commit `66ac526a4e58ef90fa5cad755a4e6a4741148112` (2026-07-05):

| File | Original path | Used for |
|---|---|---|
| `interceptor-pipeline.ts` | `src/engine/interceptor-pipeline.ts` | Splicing the modes into the assembled prompt and reporting them in the Prompt Breakdown |
| `injection-store.ts` | `src/engine/injection-store.ts` | The `InjectionEntry` shape the pipeline works with |

LumiScript's own tests for these files are in `tests/vendor/lumiscript/`, with only their import paths changed. Run them with `bun test`.

Mode Toggles builds its injection entries itself (`src/placement.ts`) and passes them straight to the pipeline. It does not route them through the injection store's registry, whose 32 KB per-injection limit is meant for user scripts and would cut off large sets of modes.

To update, copy the two files again from a newer LumiScript commit and run `bun test`.
