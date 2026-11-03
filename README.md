# Mode Toggles — Spindle Extension for Lumiverse

A port of [st-mode-toggles](https://github.com/dfaker/st-mode-toggles) (SillyTavern) to Lumiverse's Spindle extension system.

Toggle non-diegetic "modifier" modes on and off per chat, then drop them anywhere in your prompt with the **`{{modes}}`** macro. Modes are grouped, searchable, and can be saved as presets, imported and exported.

## Features

- **340+ built-in modes** in groups such as Visual & Aesthetic, Genre & Cinematic, Social & Power, Abstract & Metaphysical, Narrative & Story, Temporal & Physics and more
- **`{{modes}}` macro**: place your active modes anywhere in your Loom preset instead of a fixed injection point
- **`{{modes}}` kept inside a block you pick**: per preset, choose the block your rules belong in; Mode Toggles adds `{{modes}}` to the end of it and puts it back after preset updates, so the modes are sent as part of that block's own text
- **Framing**: optional text sent with your modes wherever `{{modes}}` is
- **Macros inside modes**: `{{user}}`, `{{char}}` and other Lumiverse macros in a mode's description are resolved fresh at every generation, so `{{char}}` follows whoever is speaking in group chats
- **Per-chat state, stored in each chat**: each chat remembers which modes are ON; deleting a chat deletes its modes, and a branched chat keeps them
- **Presets**: save the current chat's active modes, then load (replace) or merge them into any chat
- **Undo**: reverse the last *Disable All* or preset load
- **Custom modes**: add, edit and override modes, then import/export them as plain text
- **Config import/export**: back up or share your custom modes and presets as JSON
- **Tidy**: clean up orphaned toggles, dead preset references and empty presets
- **Quick toggle menu**: in the input bar, with search and accordion grouping

## Installation

Install from the Lumiverse **Extensions** panel using the GitHub URL:

```
https://github.com/catofwonders/ModeTogglesSpindleFork
```

or through the API:

```
POST /api/v1/spindle/install
{ "github": "https://github.com/catofwonders/ModeTogglesSpindleFork" }
```

Lumiverse builds the extension automatically on install. To build it yourself:

```bash
bun install
bun run build
```

## Setup: using `{{modes}}`

Mode Toggles does not inject anything on its own. Add the macro to your preset where you want the modes to appear, for example in a System block:

```
[Narrative modifiers active for this scene. Follow them throughout your response:]
{{modes}}
```

How the macro behaves:

- It outputs **only the descriptions** of the modes that are ON in the current chat, separated by blank lines. Mode names and groups are not included.
- It outputs **nothing** when no modes are ON, so any framing you write around it will still appear. Keep the framing short or neutral.
- It updates automatically when you toggle modes or switch chats.

## Framing (optional)

The **Framing** box in the drawer tab holds text that is sent together with your modes, wherever `{{modes}}` is. Put `{{modes}}` in it where the modes go, or leave it out to add the modes after the framing. Macros such as `{{user}}` are resolved as usual. Nothing is sent, framing included, when no modes are ON.

Leave it empty if your preset already has framing written around `{{modes}}`, or the framing is sent twice.

## Keeping `{{modes}}` inside a preset block (optional)

Instead of a separate block that only holds `{{modes}}`, you can have the modes sent as part of one of the preset's own blocks, for example the block with its main instructions. In the drawer tab, under **Keep {{modes}} inside a preset block**:

1. Click **Choose a preset block…**, pick a preset, then pick a block.
2. Click **Keep {{modes}} in this block**. Mode Toggles adds `{{modes}}` to the end of that block.
3. Turn off any other block in that preset that also has `{{modes}}`, so the modes aren't sent twice.

Each preset has its own choice, so this works with any preset whatever its blocks are called. Only blocks that can safely hold `{{modes}}` are offered: regular blocks, category headers, and text-bearing markers such as the Main Prompt. Sealed LumiHub blocks are offered too: Lumiverse keeps their real text on your machine and sends it like any other block; sealing only hides it from exports. Not offered: placeholders such as Chat History or World Info, and stashed blocks (shared between presets, so an edit would reach every preset that uses them). Next to each block the list notes anything that changes where or whether it is sent: off, inside or after the chat history, added onto a chat message, only for some kinds of generation, only for some characters.

When the preset is saved or updated (including updates installed from LumiHub) and `{{modes}}` is no longer in the block, Mode Toggles puts it back. If the update gives the block a new id, it is found again by its name. **Remove** stops this and takes out the `{{modes}}` Mode Toggles added. Deleting a preset in Lumiverse removes it from this list by itself; a preset you delete and add again counts as a new preset, so pick its block again.

This edits the preset itself and needs the `presets` permission. Mode Toggles reads the preset as stored and saves its block list back with only that block's text changed, so every other block and every setting stays exactly as it was (it doesn't use Lumiverse's single-block save, which re-writes every block and drops fields such as LumiHub's sealed markings). The save only goes through if nobody changed the preset in between; otherwise it reads it again and retries.

## Using the quick toggle menu

Click the **microchip icon** in the input bar to open the menu.

- **Search** filters by name, group or description.
- **Click a mode** to toggle it ON/OFF for the current chat. Click **✎** to edit it.
- **+ Add New**: create a custom mode (name, group, description).
- **Export Modes / Import Modes**: save or load your custom modes as a `.txt` file. Export lets you pick which groups to include (all are ticked by default). Import first shows a preview of what will be added, changed, renamed or removed, then lets you choose:
  - **Add**: imports the file and leaves everything else as it is.
  - **Replace**: also makes the file's groups match the file exactly. Custom modes in those groups that the file no longer contains are removed, and a mode whose name changed but whose description didn't is treated as a rename, so its chat toggles and presets move to the new name. Other groups and edited built-in modes are never touched.
- **Disable All**: turn off every active mode in this chat (undoable).
- **Random**: turn on one random inactive mode.
- **Presets**: save, load, merge, rename and delete presets.
- **Export Config / Import Config**: back up or restore custom modes and presets as JSON. Per-chat toggles are not included.
- **Tidy**: shows a report of leftover data and offers to clean it.
- **↩ Undo**: appears after a Disable All or preset load.

## Settings (drawer tab)

The **Mode Toggles** tab in the drawer contains:

- **Enable Mode Toggles**: master switch. When off, `{{modes}}` outputs nothing and toggling is paused; your per-chat toggles are kept for when you turn it back on
- **Load Core (Default) Modes**: show or hide the built-in modes (your custom modes stay)
- **Mode list order**: by group or one flat A→Z list
- **Framing** (see above)
- **Keep {{modes}} inside a preset block** (see above)
- **Remove All Custom Modes**
- **Reset to Defaults**: clears custom modes, the framing and every chat's toggles; presets and preset-block choices are kept

## Writing your own modes

Modes are one line each:

```
Name - Group - Description
```

Example:

```
Every Meal Is Plot Relevant - Narrative & Story - Food and drink scenes always carry subtext. Who serves whom, what is refused and what is shared reveal shifting loyalties.
Mirrored Body Language - Character & Psychology - {{char}} subtly mirrors {{user}}'s posture and word choice whenever trying to win them over.
```

Tips:

- **The description is all the model sees.** Write it as a self-contained instruction that makes sense without the name.
- **Name is the ID.** Using an existing mode's name overrides that mode. Built-in modes can't be deleted, but an edited one has a **Restore default** button.
- **Names and groups** can't contain ` - ` (it separates the fields). Groups must be 40 characters or fewer with no commas. Group names are matched case-insensitively, so they won't split into duplicates.
- Save several lines in a `.txt` file and use **Import Modes** to add them all at once. A line that doesn't start a new `Name - Group -` entry is joined onto the previous one.

## Permissions

| Permission | Why |
|---|---|
| `chats` | Detects the active chat, and stores each chat's toggles in that chat |
| `chat_mutation` | Lets Lumiverse save a chat's toggles only if nothing else changed the chat at the same moment, so a save can never overwrite other chat data. Lumiverse puts this check behind the same permission as reading messages; Mode Toggles does not read or edit messages |
| `presets` | Keeps `{{modes}}` in the block you picked (only if you pick one) |

## Extension structure

```
ModeTogglesSpindleFork/
├── spindle.json          # Extension manifest
├── src/
│   ├── backend.ts        # Settings, presets, {{modes}} macro, preset blocks, actions
│   ├── chat-store.ts     # Per-chat toggles stored in each chat (adapted from LumiScript)
│   ├── preset-blocks.ts  # Adding/finding {{modes}} in a preset block, framing
│   ├── frontend.ts       # Drawer settings tab + input bar toggle menu
│   └── vendor/lumiscript # LumiScript's license and what was adapted from it
├── tests/                # bun test
├── defaults/
│   ├── config.json       # Default settings (seeded to storage on install)
│   └── modes/            # Built-in mode files (seeded to storage)
│       ├── modes_1.txt
│       ├── modes_4.txt
│       ├── modes_5.txt
│       └── modes_6.txt
├── package.json
└── tsconfig.json
```

### How it works

**Backend (`src/backend.ts`)**
- Loads built-in modes from `modes/modes_N.txt` in extension storage, and custom modes, overrides and settings from `config.json`.
- Stores the names of the modes that are ON in each chat's own metadata (`mode_toggles`); OFF is simply absent. Each save re-reads the chat and changes only that key, one save at a time per chat, and the write only lands if the chat is unchanged since it was read (otherwise it re-reads and tries again). Older versions kept every chat's toggles in `config.json`; those are moved into their chats automatically, and entries for deleted chats are dropped.
- Registers the `{{modes}}` macro. Lumiverse asks it for a value each time it builds a prompt, with the chat id, so each chat gets its own modes. It returns the descriptions as written, inside the Framing if set; Lumiverse resolves any macros inside them (`{{user}}`, `{{char}}`, `{{random}}`…).
- Keeps `{{modes}}` in the picked block of each preset, and listens for `PRESET_CHANGED` to put it back after updates.
- Handles presets, undo, import/export and tidy actions from the frontend.

**Frontend (`src/frontend.ts`)**
- Registers the **Mode Toggles** drawer tab for settings.
- Registers the input bar action that opens the quick toggle menu.
- Requests fresh state when opened, so it always reflects the current chat.

## Credits

Based on [st-mode-toggles](https://github.com/dfaker/st-mode-toggles) by dfaker. Spindle port by catofwonders.

Per-chat storage and the save queue are adapted from [LumiScript](https://github.com/mindbound/lumiscript) by mindbound (MIT). See `src/vendor/lumiscript` for its license and exactly what was taken.

## License

MIT. See [LICENSE.txt](LICENSE.txt).
