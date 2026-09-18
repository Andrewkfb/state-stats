# State Stats

An Obsidian plugin that shows the vault's **state** — what is in flight, what is late, what has gone quiet, and where the vault's own conventions are quietly not being met.

Built for one vault (Foundry) and its conventions. Every folder path, status tag and threshold is a setting, so it can be pointed at another vault, but it assumes a particular way of working and makes no attempt to be general.

**Read-only. It never writes to a note.**

## What it shows

- **Deadlines** — quests by due date. Blocking is derived from each quest's `blocked-by` property rather than read from a status field, matching how Questline does it. A quest due *before* the quest it waits on is called out, and so is a `blocked-by` value that matches no quest basename — that one otherwise parks a quest in Blocked indefinitely with nothing to show why.
- **Work in flight** — projects carrying an active status tag, stalest first. Every `stat/*` tag is shown, so intentional combinations stay visible.
- **Draft status drift** — drafts whose `stat/*` disagrees with their project's. Hidden when there are none.
- **Inbox** — oldest first, with the routing link triage would use for each note.
- **Themes** — recurring patterns, with valence and status.
- **Distributions** — projects by status, Library by class, Highlights by type, Maps by stage.
- **Data gaps** — conventions not met. Each of these fails silently in Obsidian: the note simply drops out of a Base or Dataview view and nothing reports it.
- **Vault activity** — notes modified per week for twelve weeks.
- **Logs** — Logs per month and the date of the most recent one.

Rows open the note on click, open in a new tab on ⌘-click, and preview on hover. Life-area chips and the search box filter the whole view.

Anything whose meaning is not obvious carries an explanation on hover, marked with a dotted underline. Where a label is one of the vault's own properties, the explanation names the property rather than defining the value.

## Design

**No YAML parsing, no file reading, no scheduled job.** Obsidian has already parsed every note into its metadata cache before the plugin runs, so the analysis reads `metadataCache.getFileCache()` and `file.stat.mtime` and nothing else. The view recomputes on cache changes, so it is correct whenever it is open.

**The Logs boundary.** Notes under the configured Logs folder are handled by filename and modification time only; `getFileCache()` is never called on them. This is enforced in one place — `guardedCache()` in `main.js` — so it can be audited rather than trusted. Obsidian has already parsed those notes into its cache, so this is a boundary the plugin keeps, not a property of its design. Any new panel must keep it.

**Plain CommonJS, no build step.** `main.js` is loaded directly. Edit it and use *Reload app without saving*.

**Testable outside Obsidian.** The analysis is one pure function, `collectState(ctx, settings, now)`, taking a list of files and a cache lookup. It is reachable through `module.exports.__internals` along with `renderInto`, so both can be exercised with a stubbed `obsidian` module. Rendering builds plain DOM, so every value goes in as text and nothing is interpolated into markup.

## Install

Copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/state-stats/`, then enable the plugin in Settings → Community plugins.

Or from this folder:

```sh
sh install.sh                    # defaults to ~/Documents/Foundry
sh install.sh /path/to/vault
```

Settings live in `data.json` inside the installed folder and are not touched by `install.sh`.

## Settings

Stale threshold, Inbox warning age, which status tags count as active, whether to recompute on vault changes, whether to show explanation tooltips, the path to each folder, and which panels appear.

The folder paths matter most: this vault gets reorganised, and a configured folder holding nothing is called out at the top of the view rather than quietly emptying a panel.

## Conventions it assumes

- Projects carry `stat/*` and `type/*` tags plus a `Life Areas` property.
- Drafts live in `Drafts/<Project Name>/`; the folder is the primary signal, with a `Project` property as fallback.
- Quests use `type`, `status`, `due`, `life-areas`, `projects` and `blocked-by`, addressed by basename.
- Library notes carry `Class`; Highlights carry a `type/*` tag; Maps carry `Stage`; Themes carry `Valence` and `Status`.
- A note whose basename matches its folder (`Projects/Projects.md`) is a folder dashboard and is excluded from counts.

## Related

A standalone implementation of the same analysis lives in the Foundry vault as `For AI/Scripts/foundry-state.mjs`, which bakes a self-contained HTML page. It is the version that opens without Obsidian — in a browser, on a phone, with the vault closed. The two were verified to agree on every figure.
