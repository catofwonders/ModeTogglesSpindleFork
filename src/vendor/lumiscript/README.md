# Code adapted from LumiScript

Mode Toggles uses code adapted from [LumiScript](https://github.com/mindbound/lumiscript) by mindbound (Arets Paeglis), MIT licensed (see `LICENSE` in this folder), at commit `66ac526a4e58ef90fa5cad755a4e6a4741148112` (2026-07-05):

| In Mode Toggles | From LumiScript | What it does |
|---|---|---|
| `src/chat-store.ts`, `ChatModeStore.save` | `src/engine/api/chat.ts`, `setMetadata` | Saves per-chat data inside the chat's own metadata, with a read-modify-write that only changes one key, and a per-chat queue so two saves can't overwrite each other |
| (Mode Toggles' addition) | — | The write itself is conditional (Lumiverse's `compareAndSetMetadata`), so a change Lumiverse makes between the read and the write is never overwritten |
| `src/chat-store.ts`, `createWriteQueue` | the same queue pattern | Makes saves of `config.json` run one after another |

Mode Toggles also uses Lumiverse's preset editing (`spindle.presets`), the host feature LumiScript's `api.presets` gives scripts access to. That part is written for Mode Toggles; LumiScript's own presets code only passes calls through to Lumiverse.

Version 1.1.0 copied LumiScript's prompt-injection files (`interceptor-pipeline.ts`, `injection-store.ts`). They were removed in 1.2.0, because Mode Toggles no longer adds separate messages to the prompt.
