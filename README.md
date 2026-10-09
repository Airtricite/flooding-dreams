# Flooding Dreams

A flood-escape platformer — **pure front-end engine source (HTML edition)**.

Runs directly in the browser with no build step and no bundler: vanilla ES Modules + three.js + cannon-es.

> This repository is a **trimmed build without extended assets and without built-in levels** — it ships only the runnable web engine and the level editor.

## What's inside

- **Play** — first- and third-person flood-escape levels, with checkpoints, pickups, mechanic blocks, liquids and portals
- **Level editor** — event editor, animation editor, texture modifier, vector-shape editor, prefab toolbox, level packs
- **Replays** — every run is recorded automatically; first-person playback, cinematic camera-cut editing, shot-list export
- **Character skins** — paint skins onto glb / gltf characters and attach accessories

## Layout

```
index.html                  entry point
sw.js                       Service Worker (cache bypass on plain static hosting)
.flooding_dreams/
  js/                       engine source (ES Modules, see below)
  styles/                   stylesheets
  vendor/                   three.js / cannon-es and addons (bundled, works offline)
  serve.py                  local server + save API (recommended way to launch)
```

Modules under `js/`:

```
core/     engine foundation: render pipeline / worker pool / storage / materials / post-fx / sky / particle presets
world/    level construction: objects, geometry, liquids, mechanisms, events, animation, paint
player/   character controller, camera, tools
game/     session, hall, NPCs, replay player, cinematic camera work
editor/   all editor panels and sub-editors
ui/       interface: menu, level lists, HUD, settings, replay list
gen/      procedural level generation (simulated annealing + procedural decoration)
levels/   level registry and level packs (built-in levels are emptied in this build)
i18n/     translations
```

## Running it

Requires **Python 3**:

```bash
python .flooding_dreams/serve.py 8010
```

Then open <http://localhost:8010/>.

Besides static hosting, `serve.py` does two things:

- **Save API** — saves go to `.flooding_dreams/saves/` (one level = one folder, carrying its own assets), so switching ports or browsers still reads the same data
- **Automatic versioning** — appends `?v=` to `index.html` and to every `.js` import, so after an edit a refresh picks it up immediately and old/new modules never mix

It also works on any plain static host (GitHub Pages, for example). In that case saves use browser-local storage and `sw.js` handles cache bypass.

## About "no extended assets / no built-in levels"

- **Extended built-in assets** (CC0 textures + HDR panoramas) are not in this repository. When they are missing the engine degrades gracefully: the manifest fails to load, the extended-asset entries hide themselves, and any leftover `asset:bi/…` references in a level are treated as missing. **Startup and the editor are unaffected.**
- **Built-in levels** are empty: the level factories in `js/levels/builtin.js` are `FACTORIES = []`, so the level select screen has no official levels. Every exported API is kept, and the engine runs normally.
- Not included: `saves/` (local saves), the Electron / Android wrappers, and the build scripts.

## Adding your own levels

1. Launch the game → **Level editor** → build a level → **Export** to get a `.fdlevel` (plain JSON)
2. Drop the file into `.flooding_dreams/js/levels/custom/`
3. List its filename in `.flooding_dreams/js/levels/custom/index.json`, for example:

   ```json
   ["my-level.fdlevel"]
   ```

Reload and it shows up in the level select screen, tagged "custom".

## Technical notes

- **No build step** — the source is the artifact; edit and refresh, no webpack / vite involved
- **Decoupled render thread** — logic runs on the main thread, rendering can run in a dedicated Worker
- **Worker pool** — heavy jobs such as level generation and list loading are computed in parallel
- **Procedural levels** — simulated-annealing iteration evolves the world structure, plus procedural decoration
- **Asset localisation** — one level is one folder; imported assets are copied into that level's directory so it can be moved as a whole

## License

MIT