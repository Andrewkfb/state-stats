"use strict";

/*
 * State Stats
 *
 * State, not notes. What is in flight, what is late, what has gone quiet, and
 * where the vault's own conventions are not being met.
 *
 * Reads only Obsidian's metadata cache, which is already parsed before this
 * runs, so there is no YAML parsing, no file reading, and no scheduled job.
 * The view recomputes when the cache changes.
 *
 * Logs boundary: notes under the configured Logs folder are handled by
 * filename and modification time only. getFileCache() is never called on them.
 * See guardedCache() below — that is the single place the rule is enforced.
 *
 * Read-only. This plugin never writes to a note.
 */

const obsidian = require("obsidian");
const { Plugin, ItemView, PluginSettingTab, Setting, debounce, Notice, Keymap } = obsidian;

const VIEW_TYPE_STATE_STATS = "state-stats-view";
const DAY = 86400000;

const DEFAULT_SETTINGS = {
  folders: {
    projects: "Projects",
    drafts: "Drafts",
    quests: "Quests",
    inbox: "Inbox",
    library: "Library",
    highlights: "Highlights",
    maps: "Maps",
    themes: "Timeline/Themes",
    lifeAreas: "Life Areas",
    logs: "Timeline/Logs",
  },
  activeStats: "greenlight, ongoing, remix",
  staleDays: 21,
  inboxWarnDays: 7,
  panels: {
    deadlines: true,
    flight: true,
    drift: true,
    inbox: true,
    themes: true,
    distribution: true,
    maps: true,
    gaps: true,
    activity: true,
    logs: true,
  },
  liveRefresh: true,
  tooltips: true,
};

// Routing links that send an Inbox note to the Logs folder.
const LOG_ROUTES = new Set([
  "Journal", "Sessions", "Dream", "Echoes",
  "Third Place", "Meetings", "Event", "Core Memory",
]);

// ===========================================================================
// Value helpers — Obsidian hands back parsed YAML, so these only normalise
// shape (scalar vs array) and strip wikilink brackets.
// ===========================================================================

function asList(v) {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v])
    .filter((x) => x != null)
    .map((x) => String(x).trim())
    .filter(Boolean);
}

// "[[Joyfulness]]" -> "Joyfulness"; "[[A|B]]" -> "A"
function delink(v) {
  const s = String(v == null ? "" : v).trim();
  const m = /^\[\[([^\]|#]+)/.exec(s);
  return m ? m[1].trim() : s;
}

function asLinkList(v) {
  return asList(v).map(delink).filter(Boolean);
}

function tagsOf(fm) {
  if (!fm) return [];
  const raw = fm.tags != null ? fm.tags : fm.tag;
  // A string value may be space or comma separated.
  const list = Array.isArray(raw)
    ? raw
    : String(raw == null ? "" : raw).split(/[,\s]+/);
  return asList(list).map((t) => t.replace(/^#/, ""));
}

const statTags = (t) => t.filter((x) => x.startsWith("stat/"));
const typeTags = (t) => t.filter((x) => x.startsWith("type/"));

function inFolder(path, folder) {
  if (!folder) return false;
  return path === folder || path.startsWith(folder.replace(/\/+$/, "") + "/");
}

// A note whose basename matches its folder is a folder dashboard, not an item.
function isFolderIndex(path) {
  const parts = path.split("/");
  if (parts.length < 2) return false;
  const base = parts[parts.length - 1].replace(/\.md$/, "");
  return base === parts[parts.length - 2];
}

function parseActiveStats(text) {
  return asList(String(text || "").split(","))
    .map((s) => (s.startsWith("stat/") ? s : "stat/" + s))
    .filter((s) => s !== "stat/");
}

// ===========================================================================
// collectState — the whole analysis, as a pure function.
//
// ctx = {
//   files: [{ path, basename, mtime }],
//   cache: (path) => ({ frontmatter }) | null,
//   vaultName: string,
// }
//
// Kept free of Obsidian imports so it can be exercised outside the app.
// ===========================================================================

function collectState(ctx, settings, nowMs) {
  const NOW = nowMs == null ? Date.now() : nowMs;
  const F = settings.folders;
  const ACTIVE_STATS = parseActiveStats(settings.activeStats);
  const ageDays = (ms) => (ms ? Math.max(0, Math.floor((NOW - ms) / DAY)) : null);

  // --- the Logs boundary, enforced in exactly one place -------------------
  const inLogs = (path) => inFolder(path, F.logs);
  const guardedCache = (path) => (inLogs(path) ? null : ctx.cache(path));

  const fm = (path) => {
    const c = guardedCache(path);
    return c && c.frontmatter ? c.frontmatter : null;
  };

  const filesIn = (folder) =>
    !folder ? [] : ctx.files.filter((f) => inFolder(f.path, folder) && !isFolderIndex(f.path));

  // --- life areas ---------------------------------------------------------
  const lifeAreaNames = filesIn(F.lifeAreas).map((f) => f.basename).sort();

  // --- projects -----------------------------------------------------------
  const projects = filesIn(F.projects).map((f) => {
    const p = fm(f.path);
    const tags = tagsOf(p);
    const stat = statTags(tags);
    return {
      name: f.basename,
      path: f.path,
      stat,
      type: typeTags(tags),
      active: stat.some((s) => ACTIVE_STATS.includes(s)),
      priority: p && p.Priority != null ? Number(p.Priority) : null,
      lifeAreas: asLinkList(p && (p["Life Areas"] != null ? p["Life Areas"] : p["life-areas"])),
      links: asLinkList(p && p.Links),
      age: ageDays(f.mtime),
      mtime: f.mtime,
      draftCount: 0,
    };
  });
  const projectsByName = new Map(projects.map((p) => [p.name, p]));

  // --- drafts -------------------------------------------------------------
  const draftsRoot = (F.drafts || "").replace(/\/+$/, "");
  const drafts = filesIn(F.drafts).map((f) => {
    const p = fm(f.path);
    // Drafts/<Project Name>/<note>.md — the folder is the primary signal.
    const rest = f.path.slice(draftsRoot.length + 1);
    const parts = rest.split("/");
    const folderProject = parts.length >= 2 ? parts[0] : null;
    const project = folderProject || delink(p && p.Project) || null;
    const stat = statTags(tagsOf(p))[0] || null;
    const proj = project ? projectsByName.get(project) : null;
    const projectStat = proj ? proj.stat[0] || null : null;
    return {
      name: f.basename,
      path: f.path,
      project: project || "—",
      stat,
      projectStat,
      // Only a genuine mismatch counts. A draft with no project, or a project
      // with no stat, is missing data rather than drift, and is reported under
      // Data gaps instead.
      drift: Boolean(proj && stat && projectStat && stat !== projectStat),
      age: ageDays(f.mtime),
      mtime: f.mtime,
    };
  });
  for (const d of drafts) {
    const p = projectsByName.get(d.project);
    if (p) p.draftCount++;
  }

  // --- quests -------------------------------------------------------------
  const todayMs = new Date(new Date(NOW).toDateString()).getTime();
  const quests = filesIn(F.quests)
    .map((f) => {
      const p = fm(f.path);
      // Questline reads a note as a quest when type is quest, or is absent.
      const type = p && p.type != null ? String(p.type).trim() : "quest";
      if (type && type !== "quest") return null;
      const dueRaw = p && p.due != null ? String(p.due).trim() : "";
      const due = /^\d{4}-\d{2}-\d{2}/.test(dueRaw) ? dueRaw.slice(0, 10) : "";
      let daysLeft = null;
      if (due) daysLeft = Math.round((new Date(due + "T00:00:00").getTime() - todayMs) / DAY);
      return {
        name: f.basename,
        path: f.path,
        status: p && p.status != null ? String(p.status).trim() : "",
        due: due || null,
        daysLeft,
        lifeAreas: asLinkList(p && (p["life-areas"] != null ? p["life-areas"] : p["Life Areas"])),
        projects: asLinkList(p && (p.projects != null ? p.projects : p.Projects)),
        blockedBy: asLinkList(p && p["blocked-by"]),
        blocked: false,
        blockerMissing: false,
        dueBeforeBlocker: false,
        age: ageDays(f.mtime),
        mtime: f.mtime,
      };
    })
    .filter(Boolean);

  // Blocking is derived, never stored — a quest is blocked while a quest it
  // names is still open. Quests are addressed by basename, so a blocker that
  // resolves to nothing parks the quest in Blocked forever with nothing to
  // show why. That case is reported separately from an honest block.
  const questsByName = new Map(quests.map((q) => [q.name, q]));
  const isDone = (s) => /^(done|complete|completed|closed)$/i.test(s || "");
  for (const q of quests) {
    for (const b of q.blockedBy) {
      const t = questsByName.get(b);
      if (!t) {
        q.blockerMissing = true;
        q.blocked = true;
        continue;
      }
      if (isDone(t.status)) continue;
      q.blocked = true;
      if (q.daysLeft != null && t.daysLeft != null && q.daysLeft < t.daysLeft) {
        q.dueBeforeBlocker = true;
      }
    }
  }

  // --- inbox --------------------------------------------------------------
  const inbox = filesIn(F.inbox).map((f) => {
    const p = fm(f.path);
    const links = asLinkList(p && p.Links);
    return {
      name: f.basename,
      path: f.path,
      links,
      routing: links.filter((l) => LOG_ROUTES.has(l)),
      routed: links.length > 0,
      age: ageDays(f.mtime),
      mtime: f.mtime,
    };
  });

  // --- themes -------------------------------------------------------------
  const themes = filesIn(F.themes).map((f) => {
    const p = fm(f.path);
    return {
      name: f.basename,
      path: f.path,
      valence: p && p.Valence != null ? String(p.Valence).trim() : "",
      status: p && p.Status != null ? String(p.Status).trim() : "",
      lifeAreas: asLinkList(p && p["Life Areas"]),
      age: ageDays(f.mtime),
      mtime: f.mtime,
    };
  });

  // --- maps ---------------------------------------------------------------
  const maps = filesIn(F.maps).map((f) => {
    const p = fm(f.path);
    return {
      name: f.basename,
      path: f.path,
      stage: p && p.Stage != null ? String(p.Stage).trim() : "",
      age: ageDays(f.mtime),
      mtime: f.mtime,
    };
  });

  // --- library / highlights ----------------------------------------------
  const library = { total: 0, byClass: {}, missingClass: [] };
  for (const f of filesIn(F.library)) {
    library.total++;
    const p = fm(f.path);
    const cls = p && p.Class != null ? String(p.Class).trim() : "";
    if (!cls) library.missingClass.push({ name: f.basename, path: f.path });
    else library.byClass[cls] = (library.byClass[cls] || 0) + 1;
  }

  const highlights = { total: 0, byType: {} };
  for (const f of filesIn(F.highlights)) {
    highlights.total++;
    const t = typeTags(tagsOf(fm(f.path)))[0] || "untyped";
    highlights.byType[t] = (highlights.byType[t] || 0) + 1;
  }

  // --- logs: filenames and modification times only ------------------------
  const logFiles = ctx.files.filter((f) => inLogs(f.path));
  const logs = (() => {
    const byMonth = {};
    let undated = 0;
    let last = null;
    for (const f of logFiles) {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(f.basename);
      if (!m) {
        undated++;
        continue;
      }
      const key = m[1] + "-" + m[2];
      byMonth[key] = (byMonth[key] || 0) + 1;
      const iso = m[1] + "-" + m[2] + "-" + m[3];
      if (!last || iso > last) last = iso;
    }
    // Twelve months, oldest first, empty months included so gaps stay visible.
    const recentMonths = [];
    const cur = new Date(NOW);
    for (let i = 11; i >= 0; i--) {
      const d = new Date(cur.getFullYear(), cur.getMonth() - i, 1);
      const key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      recentMonths.push({
        label: d.toLocaleDateString("en-US", { month: "short" }) + " " + String(d.getFullYear()).slice(2),
        count: byMonth[key] || 0,
      });
    }
    const daysSinceLast = last
      ? Math.max(0, Math.round((todayMs - new Date(last + "T00:00:00").getTime()) / DAY))
      : null;
    return { total: logFiles.length, lastDate: last, daysSinceLast, undated, recentMonths };
  })();

  // --- activity: modification times only, so Logs need not be opened ------
  const weeks = [];
  for (let i = 11; i >= 0; i--) {
    const end = NOW - i * 7 * DAY;
    weeks.push({
      start: end - 7 * DAY,
      end,
      count: 0,
      label: new Date(end).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    });
  }
  const recentByFolder = {};
  for (const f of ctx.files) {
    const top = f.path.includes("/") ? f.path.split("/")[0] : "(root)";
    if (NOW - f.mtime <= 30 * DAY) recentByFolder[top] = (recentByFolder[top] || 0) + 1;
    for (const w of weeks) {
      if (f.mtime > w.start && f.mtime <= w.end) {
        w.count++;
        break;
      }
    }
  }

  // --- distributions ------------------------------------------------------
  const projectStats = {};
  for (const p of projects) {
    for (const s of p.stat.length ? p.stat : ["(no stat)"]) {
      projectStats[s] = (projectStats[s] || 0) + 1;
    }
  }

  const lifeAreas = lifeAreaNames.map((name) => ({
    name,
    projects: projects.filter((p) => p.lifeAreas.includes(name)).length,
    quests: quests.filter((q) => q.lifeAreas.includes(name)).length,
    themes: themes.filter((t) => t.lifeAreas.includes(name)).length,
  }));

  // --- data gaps: conventions that fail silently in Obsidian --------------
  const gaps = {
    projectsNoStat: projects.filter((p) => !p.stat.length).map((p) => ({ name: p.name, path: p.path })),
    projectsNoArea: projects
      .filter((p) => !p.lifeAreas.length && !p.stat.includes("stat/idea"))
      .map((p) => ({ name: p.name, path: p.path })),
    draftsNoProject: drafts.filter((d) => d.project === "—").map((d) => ({ name: d.name, path: d.path })),
    draftsNoStat: drafts.filter((d) => !d.stat).map((d) => ({ name: d.name, path: d.path })),
    questsNoDue: quests.filter((q) => !q.due).map((q) => ({ name: q.name, path: q.path })),
    questsBadBlocker: quests.filter((q) => q.blockerMissing).map((q) => ({ name: q.name, path: q.path })),
    libraryNoClass: library.missingClass,
    mapsNoStage: maps.filter((m) => !m.stage).map((m) => ({ name: m.name, path: m.path })),
    unknownAreas: Array.from(
      new Set([].concat(projects, quests, themes).reduce((acc, x) => acc.concat(x.lifeAreas), []))
    )
      .filter((a) => !lifeAreaNames.includes(a))
      .map((a) => ({ name: a, path: null })),
  };

  // Folders configured but holding nothing. This vault gets reorganised often;
  // a renamed folder should say so rather than quietly emptying a panel.
  const counted = {
    projects: projects.length, drafts: drafts.length, quests: quests.length,
    inbox: inbox.length, library: library.total, highlights: highlights.total,
    maps: maps.length, themes: themes.length, lifeAreas: lifeAreaNames.length,
    logs: logFiles.length,
  };
  const missingFolders = Object.keys(F).filter((k) => F[k] && !counted[k]).map((k) => ({ key: k, path: F[k] }));

  return {
    vault: ctx.vaultName || "",
    generated: new Date(NOW).toISOString(),
    generatedLabel: new Date(NOW).toLocaleString("en-US", {
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    }),
    config: { staleDays: settings.staleDays, inboxWarnDays: settings.inboxWarnDays, activeStats: ACTIVE_STATS },
    counts: {
      notes: ctx.files.length,
      projects: projects.length,
      drafts: drafts.length,
      quests: quests.length,
      inbox: inbox.length,
    },
    lifeAreas, quests, projects, projectStats, drafts, inbox, themes, maps,
    gaps, missingFolders, library, highlights, logs,
    activity: weeks.map((w) => ({ label: w.label, count: w.count })),
    recentByFolder,
  };
}

// ===========================================================================
// Rendering — plain DOM, so every value goes in as text and nothing is
// interpolated into markup.
// ===========================================================================

function el(parent, tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  if (parent) parent.appendChild(n);
  return n;
}

const plural = (n, s, p) => (n === 1 ? s : p || s + "s");

function ageLabel(days) {
  if (days == null) return "";
  if (days === 0) return "today";
  if (days === 1) return "1d";
  if (days < 60) return days + "d";
  const m = Math.round(days / 30.4);
  return m < 24 ? m + "mo" : Math.round(days / 365) + "y";
}

function dueLabel(d) {
  if (d == null) return "—";
  if (d < 0) return Math.abs(d) + "d over";
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  return "in " + d + "d";
}

function dueClass(d) {
  if (d == null) return "";
  if (d < 0) return "is-alert";
  if (d <= 3) return "is-warn";
  if (d <= 14) return "is-accent";
  return "";
}

// Each gap: [label, short consequence, full explanation]
const GAP_LABELS = {
  projectsNoStat: [
    "Projects with no stat/*", "invisible to every status view",
    "These project notes carry no stat/* tag at all. Any Base, Dataview query or view that filters on status will silently leave them out.",
  ],
  projectsNoArea: [
    "Past-idea projects with no Life Area", "will not roll up into an area note",
    "These projects have moved past stat/idea but have no Life Areas property, so they never appear in the rollup on a Life Area note. Ideas are not counted here — an idea has not earned an area yet.",
  ],
  draftsNoProject: [
    "Drafts outside a project folder", "status sync skips these",
    "These drafts sit directly in the Drafts folder rather than in Drafts/<Project Name>/, so there is no project to compare their status against and the draft status sync has nothing to work from.",
  ],
  draftsNoStat: [
    "Drafts with no stat/*", "nothing to sync",
    "These drafts carry no stat/* tag, so their status cannot drift from their project's — there is nothing there to compare.",
  ],
  questsNoDue: [
    "Quests with no due date", "never surfaces as upcoming",
    "These quests have no due property, so they can never appear as overdue or upcoming anywhere, including in the Deadlines panel above.",
  ],
  questsBadBlocker: [
    "Quests with an unresolvable blocker", "parked in Blocked forever",
    "The blocked-by property names a quest that does not exist. Questline matches blockers by basename, so the quest stays Blocked until the name is corrected, with nothing to show why.",
  ],
  libraryNoClass: [
    "Library notes with no Class", "missing from class views",
    "Every Library note is meant to carry a Class property. These do not, so they drop out of any view that groups or filters by class.",
  ],
  mapsNoStage: [
    "Maps with no Stage", "unsorted in map views",
    "These map notes have no Stage property, so they cannot be sorted or filtered by maturity.",
  ],
  unknownAreas: [
    "Life Areas named but not in the folder", "fails silently",
    "A note names this life area, but no note with that basename exists in the Life Areas folder. The link resolves to nothing and the rollup quietly drops it.",
  ],
};

function dateLabel(ms) {
  if (!ms) return "an unknown date";
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Explanations for anything whose meaning is not obvious from the label alone.
// Attached on hover so the view stays uncluttered; anything carrying one is
// marked with a dotted underline so it can be found without hunting.
const EXPLAIN = {
  strip: {
    overdue: "Quests whose due date has already passed. Reflects the life-area filter above.",
    soon: "Quests due within the next fourteen days. Overdue ones are counted separately, on the left.",
    inflight: "Projects carrying one of the active status tags. Which tags count is set in State Stats settings.",
    stalled: "Projects in flight whose file has not changed in a while. Measured from the file's modification time on disk, not from anything written inside the note.",
    drift: "Drafts whose stat/* tag disagrees with the stat/* tag on their project. A draft in Drafts/X/ belongs to project X.",
    inbox: "Notes sitting in the Inbox folder, waiting to be triaged.",
    sinceLog: "Time since the most recent date in a Log filename. Log contents are never opened.",
  },
  panels: {
    deadlines: "Every quest, soonest due date first. Blocking is worked out from each quest's blocked-by property rather than read from a status field, because Questline derives it the same way.",
    flight: "Projects carrying an active status tag, the ones untouched longest at the top. A project can carry more than one status tag and every one is shown.",
    drift: "A draft and its project should agree on status. These disagree. The draft's own tag is on the left, its project's on the right.",
    inbox: "What is waiting in the Inbox, oldest first, with the routing link that triage would use to file each one.",
    themes: "Notes in the Themes folder — recurring patterns in life and work — showing the Valence and Status recorded on each.",
    projectStats: "How projects divide across stat/* tags. A project carrying two status tags is counted under both, so these can add up to more than the project count.",
    libraryClass: "Library notes grouped by their Class property, largest group first. Only the top ten are shown.",
    maps: "Notes in the Maps folder with their Stage property, least recently modified at the top.",
    highlights: "Highlight notes grouped by their type/* tag, largest group first.",
    gaps: "Places where a note does not meet a convention the vault relies on. Each of these fails quietly: the note simply drops out of a view and nothing reports it.",
    activity: "How many notes were modified in each of the last twelve weeks. This reads file modification times, so a sync, a restore or a bulk maintenance pass looks the same as a week of writing.",
    logs: "How many Logs carry a date in each of the last twelve months, read from filenames alone. Log contents are never opened.",
  },
  tags: {
    status: "The quest's status property.",
    questProject: "The first project in this quest's projects property.",
    valence: "The Valence property on this theme note.",
    themeStatus: "The Status property on this theme note.",
    stage: "The Stage property on this map note.",
    noStage: "This map note has no Stage property.",
    routed: (link) => "The Links property contains [[" + link + "]], which sends this note to the Logs folder during triage.",
    unrouted: "No Links property, so triage has nothing to route this note by.",
    noDue: "This quest has no due property, so it never appears as overdue or upcoming.",
  },
};

/**
 * renderInto(container, data, settings, handlers, filter)
 *
 * handlers = {
 *   onOpenNote(path, evt), onHoverNote(path, evt, el),
 *   onFilter(next, keepFocus), onRefresh(),
 *   tip(el, text)   // optional; falls back to the title attribute
 * }
 */
function renderInto(container, data, settings, handlers, filter) {
  container.empty ? container.empty() : (container.innerHTML = "");
  container.classList.add("ss-root");

  const F = filter || { area: null, q: "" };
  const h = handlers || {};
  const tooltipsOn = settings.tooltips !== false;

  // Obsidian's setTooltip when it is available, the title attribute otherwise,
  // so this renders the same inside and outside the app.
  const setTip = h.tip || ((node, text) => { node.title = text; });

  /** Attach an explanation. `mark` gives the element a dotted underline. */
  function tip(node, text, mark) {
    if (!tooltipsOn || !text || !node) return node;
    setTip(node, text);
    if (mark) node.classList.add("ss-has-tip");
    return node;
  }

  const matchesArea = (areas) => !F.area || (areas || []).some((a) => a === F.area);
  const matchesQuery = (...fields) => {
    if (!F.q) return true;
    const q = F.q.toLowerCase();
    return fields.some((f) => f && String(f).toLowerCase().includes(q));
  };

  // ---------------------------------------------------------------- rows --
  function noteRow(parent, item) {
    const row = el(parent, "div", "ss-row");
    const name = el(row, "a", "ss-name", item.name);
    name.setAttr ? name.setAttr("href", "#") : (name.href = "#");
    setTip(name, item.path);
    name.addEventListener("click", (evt) => {
      evt.preventDefault();
      if (h.onOpenNote) h.onOpenNote(item.path, evt);
    });
    name.addEventListener("mouseover", (evt) => {
      if (h.onHoverNote) h.onHoverNote(item.path, evt, name);
    });
    for (const t of (item.tags || []).filter(Boolean)) {
      const tag = el(row, "span", "ss-tag " + (t.cls || ""), t.text);
      tip(tag, t.tip);
    }
    if (item.meta) tip(el(row, "span", "ss-meta", item.meta), item.metaTip);
    return row;
  }

  /** One panel. `parent` defaults to the page; pass a column to nest it. */
  function panel(opts, parent) {
    const sec = el(parent || container, "section", "ss-panel");
    const head = el(sec, "div", "ss-phead");
    tip(el(head, "h2", "ss-ptitle", opts.title), opts.tip, true);
    if (opts.sub) el(head, "span", "ss-psub", opts.sub);
    el(head, "span", "ss-pcount", opts.count != null ? opts.count : "");
    const body = el(sec, "div", "ss-pbody");
    return { sec, body, note: (text) => (text ? el(sec, "div", "ss-note", text) : null) };
  }

  function bars(parent, entries, tipFor) {
    const max = Math.max(1, ...entries.map((e) => e[1]));
    const total = entries.reduce((a, e) => a + e[1], 0);
    const wrap = el(parent, "div", "ss-bars");
    for (const [label, n] of entries) {
      const bar = el(wrap, "div", "ss-bar");
      const lab = el(bar, "span", "ss-bar-label", label);
      const text = tipFor ? tipFor(label, n, total) : null;
      tip(lab, text);
      const track = el(bar, "span", "ss-bar-track");
      el(track, "span", "ss-bar-fill").style.width = Math.max(2, (n / max) * 100) + "%";
      tip(el(bar, "span", "ss-bar-value", n), text);
    }
  }

  const pct = (n, total) => (total ? " (" + Math.round((n / total) * 100) + "% of " + total + ")" : "");

  // ------------------------------------------------------- filtered views --
  const quests = data.quests.filter((q) => matchesArea(q.lifeAreas) && matchesQuery(q.name, q.projects.join(" ")));
  const projects = data.projects.filter(
    (p) => matchesArea(p.lifeAreas) && matchesQuery(p.name, p.stat.join(" "), p.type.join(" "))
  );
  const drafts = data.drafts.filter((d) => matchesQuery(d.name, d.project));
  const inbox = data.inbox.filter((i) => matchesQuery(i.name));
  const themes = data.themes.filter((t) => matchesArea(t.lifeAreas) && matchesQuery(t.name));
  const maps = data.maps.filter((m) => matchesQuery(m.name));

  const activeProjects = projects.filter((p) => p.active);
  const staleActive = activeProjects.filter((p) => p.age >= data.config.staleDays).sort((a, b) => b.age - a.age);
  const overdue = quests.filter((q) => q.daysLeft != null && q.daysLeft < 0);
  const soon = quests.filter((q) => q.daysLeft != null && q.daysLeft >= 0 && q.daysLeft <= 14);
  const blocked = quests.filter((q) => q.blocked);
  const drift = drafts.filter((d) => d.drift);
  const oldInbox = inbox.filter((i) => i.age >= data.config.inboxWarnDays);
  const questsByName = new Map(data.quests.map((q) => [q.name, q]));

  // ------------------------------------------------------------- header ---
  const head = el(container, "div", "ss-top");
  tip(
    el(head, "span", "ss-stamp",
      data.counts.notes.toLocaleString() + " notes · stale after " + data.config.staleDays + "d · " + data.generatedLabel),
    "Every markdown note in the vault, the stale threshold from settings, and when this view last recomputed. It recomputes on its own whenever the vault changes.",
    true
  );
  const refresh = el(head, "button", "ss-refresh", "Refresh");
  tip(refresh, "Recompute now. Normally unnecessary — the view follows the vault.");
  refresh.addEventListener("click", () => h.onRefresh && h.onRefresh());

  if (data.missingFolders.length) {
    const warn = el(container, "div", "ss-warning");
    el(warn, "strong", null, "Configured but empty: ");
    el(warn, "span", null,
      data.missingFolders.map((m) => m.path).join(", ") +
      ". Renamed since the last settings change? Update the folder paths in State Stats settings.");
  }

  // ------------------------------------------------------------ filters ---
  const filters = el(container, "div", "ss-filters");
  const chip = (label, value, tipText) => {
    const c = el(filters, "button", "ss-chip", label);
    if ((value === null && F.area === null) || (value !== null && F.area === value)) {
      c.addClass ? c.addClass("is-on") : c.classList.add("is-on");
    }
    if (tipText) setTip(c, tipText);
    c.addEventListener("click", () => {
      const next = value === null ? null : F.area === value ? null : value;
      if (h.onFilter) h.onFilter({ area: next, q: F.q });
    });
    return c;
  };
  chip("All areas", null, "Show everything. Life-area filters narrow quests, projects and themes — the folder-wide counts below are unaffected.");
  for (const a of data.lifeAreas) {
    chip(a.name, a.name,
      a.projects + " " + plural(a.projects, "project") + ", " + a.quests + " " + plural(a.quests, "quest") +
      " and " + a.themes + " " + plural(a.themes, "theme") + " name this area.");
  }
  const search = el(filters, "input", "ss-search");
  search.type = "search";
  search.placeholder = "filter by name…";
  search.value = F.q;
  search.addEventListener("input", (e) => h.onFilter && h.onFilter({ area: F.area, q: e.target.value }, true));

  // -------------------------------------------------------------- strip ---
  const strip = el(container, "div", "ss-strip");
  const stat = (n, label, tone, tipText) => {
    const s = el(strip, "div", "ss-stat" + (tone ? " " + tone : ""));
    el(s, "span", "ss-stat-n", n);
    tip(el(s, "span", "ss-stat-l", label), tipText, true);
  };
  stat(overdue.length, "overdue", overdue.length ? "is-hot" : "is-good", EXPLAIN.strip.overdue);
  stat(soon.length, "due ≤14d", soon.length ? "is-warm" : "", EXPLAIN.strip.soon);
  stat(activeProjects.length, "in flight", "",
    EXPLAIN.strip.inflight + " Right now those are: " +
    data.config.activeStats.map((s) => s.replace("stat/", "")).join(", ") + ".");
  stat(staleActive.length, "stalled", staleActive.length ? "is-warm" : "is-good",
    EXPLAIN.strip.stalled + " The threshold is " + data.config.staleDays + " days.");
  stat(drift.length, "stat drift", drift.length ? "is-warm" : "is-good", EXPLAIN.strip.drift);
  stat(inbox.length, "inbox", oldInbox.length ? "is-warm" : "is-good",
    EXPLAIN.strip.inbox + (oldInbox.length ? " " + oldInbox.length + " of these are older than " + data.config.inboxWarnDays + " days." : ""));
  stat(ageLabel(data.logs.daysSinceLast) || "—", "since log",
    "",
    EXPLAIN.strip.sinceLog + (data.logs.lastDate ? " The most recent is dated " + data.logs.lastDate + "." : ""));

  const P = settings.panels;

  // ----------------------------------------------------------- deadlines --
  if (P.deadlines) {
    const p = panel({ title: "Deadlines", sub: "Quests by due date", count: quests.length, tip: EXPLAIN.panels.deadlines });
    const sorted = quests.slice().sort((a, b) => {
      const av = a.daysLeft == null ? 9e9 : a.daysLeft;
      const bv = b.daysLeft == null ? 9e9 : b.daysLeft;
      return av - bv;
    });
    if (!sorted.length) el(p.body, "div", "ss-empty", "No quests match this filter.");
    for (const q of sorted) {
      const blockerNames = q.blockedBy.join(", ");
      const blockerQuest = q.blockedBy.map((b) => questsByName.get(b)).filter(Boolean)[0];
      noteRow(p.body, {
        path: q.path,
        name: q.name,
        tags: [
          q.daysLeft != null
            ? {
                text: dueLabel(q.daysLeft),
                cls: dueClass(q.daysLeft),
                tip: "Due " + q.due + ", which is " +
                  (q.daysLeft < 0 ? Math.abs(q.daysLeft) + " days ago." : q.daysLeft === 0 ? "today." : "in " + q.daysLeft + " days."),
              }
            : { text: "no due date", cls: "is-warn", tip: EXPLAIN.tags.noDue },
          q.dueBeforeBlocker
            ? {
                text: "due before blocker",
                cls: "is-alert",
                tip: "This is due " + q.due + " but waits on " + blockerNames +
                  (blockerQuest && blockerQuest.due ? ", which is not due until " + blockerQuest.due : "") +
                  ". One of those dates is wrong, or the block is.",
              }
            : null,
          q.blockerMissing
            ? {
                text: "blocker not found",
                cls: "is-alert",
                tip: "blocked-by names " + blockerNames + ", but no quest file has that basename. Questline matches blockers by basename, so this quest stays Blocked until the name is fixed.",
              }
            : q.blocked
            ? { text: "blocked", cls: "is-warn", tip: "Waiting on " + blockerNames + ", which is not done yet." }
            : null,
          { text: q.status || "no status", cls: q.status === "active" ? "is-ok" : "", tip: EXPLAIN.tags.status },
          q.projects.length ? { text: q.projects[0], cls: "is-cool", tip: EXPLAIN.tags.questProject } : null,
        ],
        meta: (q.lifeAreas || []).join(" · "),
        metaTip: q.lifeAreas.length ? "From this quest's life-areas property." : null,
      });
    }
    const conflicted = quests.filter((q) => q.dueBeforeBlocker);
    const badBlocker = quests.filter((q) => q.blockerMissing);
    if (conflicted.length) {
      p.note(
        conflicted.map((q) => q.name).join(", ") +
          (conflicted.length === 1 ? " is due before the quest it waits on." : " are due before the quests they wait on.") +
          " Either a date is wrong or the block is."
      );
    } else if (badBlocker.length) {
      p.note(
        badBlocker.length + " " + plural(badBlocker.length, "quest") +
          " names a blocker matching no quest basename — Questline parks " +
          (badBlocker.length === 1 ? "it" : "them") + " in Blocked indefinitely."
      );
    } else if (blocked.length) {
      p.note(blocked.length + " " + plural(blocked.length, "quest") + " waiting on another quest.");
    }
  }

  // ------------------------------------------------------ work in flight --
  if (P.flight) {
    const p = panel({
      title: "Work in flight",
      sub: "Projects tagged " + data.config.activeStats.map((s) => s.replace("stat/", "")).join(" / "),
      count: activeProjects.length,
      tip: EXPLAIN.panels.flight,
    });
    const sorted = activeProjects.slice().sort((a, b) => b.age - a.age);
    if (!sorted.length) el(p.body, "div", "ss-empty", "Nothing in flight under this filter.");
    for (const pr of sorted) {
      const others = pr.stat.filter((s) => data.config.activeStats.includes(s)).map((s) => s.replace("stat/", ""));
      const statTagList = (pr.stat.length ? pr.stat : ["no stat"]).map((st) => {
        const isActive = data.config.activeStats.includes(st);
        return {
          text: st.replace("stat/", ""),
          cls: st === "stat/greenlight" ? "is-ok" : isActive ? "is-accent" : "",
          tip: st === "no stat"
            ? "This project carries no stat/* tag."
            : isActive
            ? "One of your active statuses, which is why this project is listed here."
            : "Not an active status. This project is listed because it also carries " + others.join(" and ") + ".",
        };
      });
      noteRow(p.body, {
        path: pr.path,
        name: pr.name,
        tags: statTagList.concat([
          pr.age >= data.config.staleDays
            ? {
                text: "stalled " + ageLabel(pr.age),
                cls: "is-warn",
                tip: "Last modified " + dateLabel(pr.mtime) + ", " + pr.age + " days ago. Anything past " +
                  data.config.staleDays + " days is called stalled.",
              }
            : null,
          pr.draftCount
            ? {
                text: pr.draftCount + " " + plural(pr.draftCount, "draft"),
                cls: "is-cool",
                tip: pr.draftCount + " " + plural(pr.draftCount, "note") + " in the Drafts folder for this project.",
              }
            : null,
        ]),
        meta: [ageLabel(pr.age), (pr.lifeAreas || []).join(" ")].filter(Boolean).join(" · "),
        metaTip: "Last modified " + dateLabel(pr.mtime) +
          (pr.lifeAreas.length ? ". Life areas from the note's Life Areas property." : "."),
      });
    }
    p.note(
      staleActive.length
        ? staleActive.length + " untouched for " + data.config.staleDays +
          "+ days. Either move them or change the tag — a greenlight nobody touches is an idea wearing a costume."
        : "Everything in flight has been touched recently."
    );
  }

  // --------------------------------------------------------- stat drift ---
  if (P.drift && drift.length) {
    const p = panel({
      title: "Draft status drift",
      sub: "Draft stat/* ≠ its project stat/*",
      count: drift.length,
      tip: EXPLAIN.panels.drift,
    });
    for (const d of drift) {
      noteRow(p.body, {
        path: d.path,
        name: d.name,
        tags: [
          { text: (d.stat || "none").replace("stat/", ""), cls: "is-warn", tip: "What this draft says: " + d.stat + "." },
          {
            text: "→ " + (d.projectStat || "none").replace("stat/", ""),
            cls: "is-ok",
            tip: "What its project says: " + d.project + " is tagged " + d.projectStat + ". Syncing would change the draft to match.",
          },
          { text: d.project, cls: "is-cool", tip: "This draft is in Drafts/" + d.project + "/, which is what assigns it to that project." },
        ],
        meta: ageLabel(d.age),
        metaTip: "Last modified " + dateLabel(d.mtime) + ".",
      });
    }
    p.note("Sync with the Draft Status Sync script, or edit the tags directly.");
  }

  // ------------------------------------------------------ inbox + themes --
  if (P.inbox || P.themes) {
    const cols = el(container, "div", "ss-cols");
    if (P.inbox) {
      const p = panel({ title: "Inbox", sub: "oldest first", count: inbox.length, tip: EXPLAIN.panels.inbox }, cols);
      const sorted = inbox.slice().sort((a, b) => b.age - a.age);
      if (!sorted.length) el(p.body, "div", "ss-empty", "Inbox is clear.");
      for (const i of sorted) {
        noteRow(p.body, {
          path: i.path,
          name: i.name,
          tags: [
            {
              text: ageLabel(i.age),
              cls: i.age >= data.config.inboxWarnDays * 2 ? "is-alert" : i.age >= data.config.inboxWarnDays ? "is-warn" : "",
              tip: "Last modified " + dateLabel(i.mtime) + ". Flagged past " + data.config.inboxWarnDays + " days.",
            },
            i.routed
              ? { text: i.routing[0] || "routed", cls: "is-ok",
                  tip: i.routing.length ? EXPLAIN.tags.routed(i.routing[0]) : "Has a Links property, though none of its links is a Logs routing link." }
              : { text: "unrouted", cls: "is-warn", tip: EXPLAIN.tags.unrouted },
          ],
        });
      }
      const unrouted = inbox.filter((i) => !i.routed);
      p.note(unrouted.length ? unrouted.length + " without a routing link in Links." : "All routed.");
    }
    if (P.themes) {
      const p = panel({ title: "Themes", sub: "recurring patterns", count: themes.length, tip: EXPLAIN.panels.themes }, cols);
      if (!themes.length) el(p.body, "div", "ss-empty", "No themes match.");
      for (const t of themes) {
        noteRow(p.body, {
          path: t.path,
          name: t.name,
          tags: [
            { text: t.valence || "—", cls: /detriment/i.test(t.valence || "") ? "is-alert" : "is-ok", tip: EXPLAIN.tags.valence },
            { text: t.status || "—", cls: /active/i.test(t.status || "") ? "is-accent" : "", tip: EXPLAIN.tags.themeStatus },
          ],
          meta: (t.lifeAreas || []).join(" "),
          metaTip: t.lifeAreas.length ? "From this note's Life Areas property." : null,
        });
      }
    }
  }

  // ----------------------------------------------------- distributions ----
  if (P.distribution) {
    const cols = el(container, "div", "ss-cols");

    const s1 = panel({ title: "Projects by status", count: data.counts.projects, tip: EXPLAIN.panels.projectStats }, cols);
    s1.body.classList.add("ss-pad");
    bars(
      s1.body,
      Object.entries(data.projectStats).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k.replace("stat/", ""), v]),
      (label, n) => n + " " + plural(n, "project") + " tagged stat/" + label + pct(n, data.counts.projects)
    );

    const s2 = panel({ title: "Library by class", sub: "top 10", count: data.library.total, tip: EXPLAIN.panels.libraryClass }, cols);
    s2.body.classList.add("ss-pad");
    bars(
      s2.body,
      Object.entries(data.library.byClass).sort((a, b) => b[1] - a[1]).slice(0, 10),
      (label, n) => n + " Library " + plural(n, "note") + " with Class: " + label + pct(n, data.library.total)
    );
    s2.note(
      data.library.missingClass.length
        ? data.library.missingClass.length + " missing a Class."
        : "Every Library note carries a Class."
    );
  }

  // ------------------------------------------------------ maps + highlights
  if (P.maps) {
    const cols = el(container, "div", "ss-cols");

    const a = panel({ title: "Maps", sub: "by stage, stalest first", count: maps.length, tip: EXPLAIN.panels.maps }, cols);
    if (!maps.length) el(a.body, "div", "ss-empty", "No maps match.");
    for (const m of maps.slice().sort((x, y) => y.age - x.age)) {
      noteRow(a.body, {
        path: m.path,
        name: m.name,
        tags: [{
          text: m.stage || "no stage",
          cls: /seed|stub/i.test(m.stage || "") ? "is-warn" : "",
          tip: m.stage ? EXPLAIN.tags.stage : EXPLAIN.tags.noStage,
        }],
        meta: ageLabel(m.age),
        metaTip: "Last modified " + dateLabel(m.mtime) + ".",
      });
    }

    const b = panel({ title: "Highlights", sub: "by type", count: data.highlights.total, tip: EXPLAIN.panels.highlights }, cols);
    b.body.classList.add("ss-pad");
    bars(
      b.body,
      Object.entries(data.highlights.byType).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => [k.replace("type/", ""), v]),
      (label, n) => n + " " + plural(n, "highlight") + " tagged type/" + label + pct(n, data.highlights.total)
    );
  }

  // ---------------------------------------------------------- data gaps ---
  if (P.gaps) {
    const entries = Object.keys(data.gaps)
      .filter((k) => data.gaps[k].length)
      .sort((a, b) => data.gaps[b].length - data.gaps[a].length);
    const p = panel({
      title: "Data gaps",
      sub: "conventions not met — each of these fails silently in Obsidian",
      count: entries.length ? entries.length + " " + plural(entries.length, "kind") : 0,
      tip: EXPLAIN.panels.gaps,
    });
    if (!entries.length) {
      el(p.body, "div", "ss-empty", "Every note meets the vault conventions. Nothing to fix.");
    }
    for (const key of entries) {
      const items = data.gaps[key];
      const meta = GAP_LABELS[key] || [key, "", ""];
      const row = el(p.body, "div", "ss-row ss-gap");
      tip(el(row, "span", "ss-gap-label", meta[0]), meta[2], true);
      tip(
        el(row, "span", "ss-tag is-warn", items.length),
        items.slice(0, 12).map((i) => i.name).join(", ") + (items.length > 12 ? ", and " + (items.length - 12) + " more" : "")
      );
      const sample = el(row, "span", "ss-gap-sample");
      items.slice(0, 4).forEach((item, idx) => {
        if (idx) el(sample, "span", null, ", ");
        if (item.path) {
          const a = el(sample, "a", "ss-gap-link", item.name);
          setTip(a, item.path);
          a.addEventListener("click", (evt) => {
            evt.preventDefault();
            if (h.onOpenNote) h.onOpenNote(item.path, evt);
          });
        } else {
          el(sample, "span", null, item.name);
        }
      });
      if (items.length > 4) el(sample, "span", null, " …");
      tip(el(row, "span", "ss-meta", meta[1]), meta[2]);
    }
  }

  // ----------------------------------------------------------- activity ---
  if (P.activity) {
    const p = panel({ title: "Vault activity", sub: "notes modified, last 12 weeks", count: "", tip: EXPLAIN.panels.activity });
    p.body.classList.add("ss-pad");
    const max = Math.max(1, ...data.activity.map((a) => a.count));
    const heat = el(p.body, "div", "ss-heat");
    for (const a of data.activity) {
      const col = el(heat, "span", "ss-heat-col" + (a.count ? " is-on" : ""));
      col.style.height = Math.max(3, (a.count / max) * 100) + "%";
      setTip(col, "Week ending " + a.label + ": " + a.count + " " + plural(a.count, "note") + " modified.");
    }
    const labels = el(p.body, "div", "ss-heat-labels");
    el(labels, "span", null, data.activity.length ? data.activity[0].label : "");
    el(labels, "span", null, data.activity.length ? data.activity[data.activity.length - 1].label : "");
    const busiest = Object.entries(data.recentByFolder).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([f, n]) => f + " " + n).join(" · ");
    p.note(
      "Measured from file modification times, so a sync or a bulk maintenance pass shows as a spike. " +
      "Busiest folders in the last 30 days: " + (busiest || "nothing") + "."
    );
  }

  // --------------------------------------------------------------- logs ---
  if (P.logs) {
    const p = panel({
      title: "Logs",
      sub: "filenames and dates only — contents never read",
      count: data.logs.total,
      tip: EXPLAIN.panels.logs,
    });
    p.body.classList.add("ss-pad");
    bars(
      p.body,
      data.logs.recentMonths.map((m) => [m.label, m.count]),
      (label, n) => n + " " + plural(n, "Log") + " dated to " + label + "."
    );
    p.note(
      "Last log dated " + (data.logs.lastDate || "unknown") +
      (data.logs.daysSinceLast != null ? " — " + ageLabel(data.logs.daysSinceLast) + " ago" : "") + "." +
      (data.logs.undated ? " " + data.logs.undated + " " + plural(data.logs.undated, "file") + " without a parseable date." : "")
    );
  }
}

// ===========================================================================
// The view
// ===========================================================================

class StateStatsView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.filter = { area: null, q: "" };
    this.data = null;
  }

  getViewType() { return VIEW_TYPE_STATE_STATS; }
  getDisplayText() { return "State Stats"; }
  getIcon() { return "gauge"; }

  async onOpen() {
    this.refresh = debounce(() => this.recompute(), 800, true);
    if (this.plugin.settings.liveRefresh) {
      this.registerEvent(this.app.metadataCache.on("changed", this.refresh));
      this.registerEvent(this.app.vault.on("create", this.refresh));
      this.registerEvent(this.app.vault.on("delete", this.refresh));
      this.registerEvent(this.app.vault.on("rename", this.refresh));
    }
    this.recompute();
  }

  recompute() {
    this.data = this.plugin.buildState();
    this.draw();
  }

  draw() {
    if (!this.data) return;
    const container = this.containerEl.children[1] || this.containerEl;
    // Preserve focus and caret in the search box across a redraw.
    const active = container.querySelector(".ss-search");
    const hadFocus = active && document.activeElement === active;

    renderInto(
      container,
      this.data,
      this.plugin.settings,
      {
        // Obsidian's tooltip when the app provides it, so explanations match
        // the rest of the UI; renderInto falls back to the title attribute.
        tip: (node, text) => {
          if (obsidian.setTooltip) obsidian.setTooltip(node, text, { delay: 250 });
          else node.title = text;
        },
        onOpenNote: (path, evt) => {
          const inNew = Keymap && Keymap.isModEvent ? Keymap.isModEvent(evt) : evt.metaKey || evt.ctrlKey;
          this.app.workspace.openLinkText(path, "", inNew);
        },
        onHoverNote: (path, evt, target) => {
          this.app.workspace.trigger("hover-link", {
            event: evt,
            source: VIEW_TYPE_STATE_STATS,
            hoverParent: this,
            targetEl: target,
            linktext: path,
          });
        },
        onFilter: (next, keepFocus) => {
          this.filter = next;
          this.draw();
          if (keepFocus) {
            const box = container.querySelector(".ss-search");
            if (box) {
              box.focus();
              box.setSelectionRange(box.value.length, box.value.length);
            }
          }
        },
        onRefresh: () => {
          this.recompute();
          new Notice("State Stats refreshed");
        },
      },
      this.filter
    );

    if (hadFocus) {
      const box = container.querySelector(".ss-search");
      if (box) box.focus();
    }
  }

  async onClose() {}
}

// ===========================================================================
// Settings
// ===========================================================================

const FOLDER_FIELDS = [
  ["projects", "Projects"],
  ["drafts", "Drafts"],
  ["quests", "Quests"],
  ["inbox", "Inbox"],
  ["library", "Library"],
  ["highlights", "Highlights"],
  ["maps", "Maps"],
  ["themes", "Themes"],
  ["lifeAreas", "Life Areas"],
  ["logs", "Logs"],
];

const PANEL_FIELDS = [
  ["deadlines", "Deadlines"],
  ["flight", "Work in flight"],
  ["drift", "Draft status drift"],
  ["inbox", "Inbox"],
  ["themes", "Themes"],
  ["distribution", "Projects by status / Library by class"],
  ["maps", "Maps / Highlights"],
  ["gaps", "Data gaps"],
  ["activity", "Vault activity"],
  ["logs", "Logs"],
];

class StateStatsSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const save = async () => {
      await this.plugin.saveSettings();
      this.plugin.refreshViews();
    };

    new Setting(containerEl)
      .setName("Stale threshold")
      .setDesc("Days before work in flight is called stalled.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.staleDays)).onChange(async (v) => {
          const n = Number(v);
          if (!Number.isNaN(n) && n > 0) {
            this.plugin.settings.staleDays = n;
            await save();
          }
        })
      );

    new Setting(containerEl)
      .setName("Inbox warning age")
      .setDesc("Days before an Inbox note is flagged.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.inboxWarnDays)).onChange(async (v) => {
          const n = Number(v);
          if (!Number.isNaN(n) && n > 0) {
            this.plugin.settings.inboxWarnDays = n;
            await save();
          }
        })
      );

    new Setting(containerEl)
      .setName("Active statuses")
      .setDesc("Comma separated. A project with any of these counts as in flight. The stat/ prefix is optional.")
      .addText((t) =>
        t.setValue(this.plugin.settings.activeStats).onChange(async (v) => {
          this.plugin.settings.activeStats = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Explanation tooltips")
      .setDesc("Hover any dotted-underlined label for an explanation of what it counts.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.tooltips !== false).onChange(async (v) => {
          this.plugin.settings.tooltips = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Recompute on vault changes")
      .setDesc("Off means the view only updates when you press Refresh or reopen it.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.liveRefresh).onChange(async (v) => {
          this.plugin.settings.liveRefresh = v;
          await this.plugin.saveSettings();
          new Notice("Reopen the State Stats view for this to take effect");
        })
      );

    new Setting(containerEl).setName("Folders").setHeading();
    containerEl.createEl("p", {
      text: "Where each kind of note lives. Update these after a vault reorganisation; an empty folder is called out at the top of the view.",
      cls: "setting-item-description",
    });
    for (const [key, label] of FOLDER_FIELDS) {
      new Setting(containerEl).setName(label).addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.folders[key])
          .setValue(this.plugin.settings.folders[key])
          .onChange(async (v) => {
            this.plugin.settings.folders[key] = v.trim();
            await save();
          })
      );
    }

    new Setting(containerEl).setName("Panels").setHeading();
    for (const [key, label] of PANEL_FIELDS) {
      new Setting(containerEl).setName(label).addToggle((t) =>
        t.setValue(this.plugin.settings.panels[key]).onChange(async (v) => {
          this.plugin.settings.panels[key] = v;
          await save();
        })
      );
    }
  }
}

// ===========================================================================
// Plugin
// ===========================================================================

class StateStatsPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_STATE_STATS, (leaf) => new StateStatsView(leaf, this));

    this.addRibbonIcon("gauge", "State Stats", () => this.activateView());

    this.addCommand({
      id: "open-state-stats",
      name: "Open State Stats",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "refresh-state-stats",
      name: "Refresh State Stats",
      callback: () => {
        this.refreshViews();
        new Notice("State Stats refreshed");
      },
    });

    this.addSettingTab(new StateStatsSettingTab(this.app, this));
  }

  async loadSettings() {
    const saved = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved, {
      folders: Object.assign({}, DEFAULT_SETTINGS.folders, saved && saved.folders),
      panels: Object.assign({}, DEFAULT_SETTINGS.panels, saved && saved.panels),
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_STATE_STATS)) {
      if (leaf.view && leaf.view.recompute) leaf.view.recompute();
    }
  }

  /** Builds the adapter collectState expects, from the metadata cache. */
  buildState() {
    const files = this.app.vault.getMarkdownFiles().map((f) => ({
      path: f.path,
      basename: f.basename,
      mtime: f.stat ? f.stat.mtime : 0,
    }));
    const byPath = new Map(this.app.vault.getMarkdownFiles().map((f) => [f.path, f]));
    const ctx = {
      files,
      vaultName: this.app.vault.getName(),
      cache: (path) => {
        const f = byPath.get(path);
        return f ? this.app.metadataCache.getFileCache(f) : null;
      },
    };
    return collectState(ctx, this.settings, Date.now());
  }

  async activateView() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_STATE_STATS);
    if (existing.length) {
      workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_STATE_STATS, active: true });
    workspace.revealLeaf(leaf);
  }
}

module.exports = StateStatsPlugin;

// Exposed for testing outside Obsidian. Not part of the plugin's behaviour.
module.exports.__internals = {
  collectState,
  renderInto,
  DEFAULT_SETTINGS,
  parseActiveStats,
  isFolderIndex,
  VIEW_TYPE_STATE_STATS,
};
