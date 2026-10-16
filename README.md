# Mode Toggles — Spindle Extension for Lumiverse

A port of [st-mode-toggles](https://github.com/dfaker/st-mode-toggles) (SillyTavern) to Lumiverse's Spindle extension system.

Toggle non-diegetic "modifier" modes on and off per chat, then drop them anywhere in your prompt with the **`{{modes}}`** macro. Modes are grouped, searchable, and can be saved as presets, imported and exported.

## Features

- **340+ built-in modes** in groups such as Visual & Aesthetic, Genre & Cinematic, Social & Power, Abstract & Metaphysical, Narrative & Story, Temporal & Physics and more
- **`{{modes}}` macro**: place your active modes anywhere in your Loom preset instead of a fixed injection point
- **Macros inside modes**: `{{user}}`, `{{char}}` and other Lumiverse macros in a mode's description are resolved before output
- **Per-chat state**: each chat remembers which modes are ON
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

## Using the quick toggle menu

Click the **microchip icon** in the input bar to open the menu.

- **Search** filters by name, group or description.
- **Click a mode** to toggle it ON/OFF for the current chat. Click **✎** to edit it.
- **+ Add New**: create a custom mode (name, group, description).
- **Export Modes / Import Modes**: save or load your custom modes as a `.txt` file.
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
- **Remove All Custom Modes**
- **Reset to Defaults**: clears custom modes and per-chat toggles; presets are kept

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
| `chats` | Detects the active chat so toggles are stored per chat |
| `personas` | Resolves `{{user}}` to the active persona's name inside mode descriptions |

## Extension structure

```
ModeTogglesSpindleFork/
├── spindle.json          # Extension manifest
├── src/
│   ├── backend.ts        # Storage, per-chat state, presets, {{modes}} macro
│   └── frontend.ts       # Drawer settings tab + input bar toggle menu
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
- Loads built-in modes from `modes/modes_N.txt` in extension storage, and custom modes and overrides from `config.json`.
- Stores only the modes that are ON for each chat; OFF is simply absent.
- Registers the `{{modes}}` macro and pushes a new value with `updateMacroValue` whenever modes or the active chat change. Before pushing, it resolves `{{user}}` and any other macros in the text.
- Handles presets, undo, import/export and tidy actions from the frontend.

**Frontend (`src/frontend.ts`)**
- Registers the **Mode Toggles** drawer tab for settings.
- Registers the input bar action that opens the quick toggle menu.
- Requests fresh state when opened, so it always reflects the current chat.

## Credits

Based on [st-mode-toggles](https://github.com/dfaker/st-mode-toggles) by dfaker. Spindle port by catofwonders.

## License

MIT. See [LICENSE.txt](LICENSE.txt).
