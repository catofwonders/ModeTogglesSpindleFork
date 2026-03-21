# Mode Toggles — Spindle Extension for Lumiverse

A port of [st-mode-toggles](https://github.com/dfaker/st-mode-toggles) (SillyTavern) to the Lumiverse Spindle extension system.

Toggle non-diegetic modifier modes that get injected into your prompts before they reach the LLM. Modes can be grouped, searched, scheduled with probability masks, imported/exported, and tracked per-chat.

## Features

- **600+ built-in modes** across categories like Visual & Aesthetic, Genre & Cinematic, Social & Power, Temporal & Physics, and more
- **Per-chat state** — each chat remembers which modes are active
- **Prompt interceptor** — active modes are prepended to your last message with configurable framing text
- **Schedule masks** — control mode activation probability per message cycle (`X` = always, `5` = 50%, `-` = never)
- **OFF countdown** — modes linger for a configurable number of messages after being turned off, then auto-clear
- **Custom modes** — add, edit, import, and export your own modes
- **Quick toggle menu** — accessible from the input bar with search and accordion grouping

## Installation

### From GitHub
Install via the Lumiverse Extensions panel or:
```
POST /api/v1/spindle/install
{ "github": "https://github.com/dfaker/mode-toggles-spindle" }
```

### Manual Build
```bash
bun install
bun run build
```

## Permissions

| Permission | Why |
|---|---|
| `interceptor` | Modifies the prompt before generation to inject active mode descriptions |

## Extension Structure

```
mode-toggles-spindle/
├── spindle.json           # Extension manifest
├── src/
│   ├── backend.ts         # Interceptor, storage, mode logic (Bun worker)
│   └── frontend.ts        # Drawer tab settings + input bar toggle menu (browser)
├── dist/
│   ├── backend.js          # Compiled backend
│   └── frontend.js         # Compiled frontend
├── defaults/
│   ├── config.json         # Default settings (seeded to storage on install)
│   └── modes/              # Core mode definition files (seeded to storage)
│       ├── modes_1.txt
│       ├── modes_4.txt
│       ├── modes_5.txt
│       └── modes_6.txt
├── tsconfig.json
└── package.json
```

## How It Works

### Backend (`src/backend.ts`)
- Loads core mode definitions from `modes/*.txt` in extension storage
- Loads and persists config (settings, custom modes, per-chat states) in `config.json`
- Registers a **prompt interceptor** that:
  - Collects all active/transitioning modes
  - Applies schedule probability masks
  - Builds a formatted prefix block and prepends it to the last user message
  - Advances mode state transitions (Activating→ON, Deactivating→OFF→countdown→removed)
- Handles all frontend messages (toggle, settings, import/export, etc.)

### Frontend (`src/frontend.ts`)
- Registers a **Drawer Tab** ("Mode Toggles") for extension settings (enable/disable, framing text, merge format, countdown, reset)
- Registers an **Input Bar Action** (microchip icon) that opens a floating popover with:
  - Search bar to filter modes by name, group, or description
  - Accordion-grouped mode buttons with color-coded status
  - Add/Edit, Import, Export, Disable All, Random Activate, and Schedule actions

## Mode Format

Modes are defined in text files, one per line:
```
Mode Name - Group Name - Description of what the mode does
```

If only two parts are given, the group defaults to "Unsorted":
```
Mode Name - Description of what the mode does
```

## Schedule Masks

Each character in a schedule mask corresponds to one message in the cycle:
- `X` = 100% (always active)
- `-` or `0` = 0% (never active)
- `1`–`9` = probability × 10% (e.g., `5` = 50%)

Examples:
- `X--` = active every 3rd message
- `5-5-` = 50% chance every other message
- `1XXX` = 10% on first message, then 3 guaranteed

## Credits

Original SillyTavern extension by [depFA](https://github.com/dfaker).
Spindle port maintains full feature parity with the original.

## License

MIT
