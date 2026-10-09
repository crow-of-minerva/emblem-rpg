/** @layer ui/apps/foundry */
import { FACTION_GROUPS } from '../../../contracts/domains/characters.mjs';
import { ENCOUNTER_PHASES, ENCOUNTER_ROUND_MAX } from '../../../contracts/domains/combat.mjs';
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { UNIT_TYPES } from '../../../game/character/rules.mjs';
import { deadlineFor, objectiveMarkers } from '../../../game/combat/objectives.mjs';
import {
  actorChangeAffectsRoster, enemyListingFlipped, enemyListingIncomplete, enemyRowListed, phaseRosterProgress,
  tokenChangeAffectsRoster
} from '../../../game/combat/phases.mjs';
import {
  downtimeResetAvailable, energyRestoreAvailable, resolveCommittedEnergy
} from '../../../game/downtime/rules.mjs';
import { projectEncounterState, projectObjectiveBoard } from '../../../foundry/adapters/projections/encounters.mjs';
import { NOTIFICATION_IDS, NotificationService } from '../../../presentation/interface/notifications.mjs';
import { openBlockingDialog, openEnergyRestoreDialog } from '../../dialogs.mjs';
import { openObjectivesEditor } from '../menus/objectives-app.mjs';
import { ENCOUNTER_TOOLTIP_IDS, getTooltip } from '../../tooltips.mjs';
import { FoundryDiagnostics } from '../../../foundry/adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Roster vocabulary                           */
/* -------------------------------------------- */

const TRACKER_TEMPLATE = `systems/${SYSTEM_ID}/templates/menus/combat-tracker.hbs`;
const PAGE_SIZE = 8;
const UNIT_ROW_FALLBACK = 50;
const RENDER_COALESCE_MS = 140;
const RENDER_COALESCE_MAX_MS = 400;
const SIDE_DEFAULT_COLOR = Object.freeze({ player: '#5f86b3', enemy: '#ad5a52' });
const SIDE_PAUSED_COLOR = '#8b8279';
const PLAYER_FACTIONS = FACTION_GROUPS.player;
const EXPLORE_ROW_SELECTOR = '.ect-explore-unit[data-token-id]';
const CONFIRM_WINDOW_MS = 3000;
const CONFIRM_TICK_MS = 200;
const RESET_DOWNTIME_PROMPT = 'Reset downtime for every unit on this map? Energy and actions come back, meal and '
  + 'performance buffs end, Stationary factions unlock, vendors forget haggles and buybacks.';
const CONFIRM_ACTIONS = Object.freeze(['emblemAdvancePhase', 'emblemEndSuccess', 'emblemEndFailure']);
const SORT_CYCLE = Object.freeze(['az', 'hp', 'loot', 'aura', 'type', 'turn']);
const SORT_LABELS = Object.freeze({ az: 'A-Z', hp: 'HP', loot: 'Loot', aura: 'Aura', type: 'Type', turn: 'Turn' });
const LOOT_RANK = Object.freeze({ drops: 1, steal: 2, both: 3 });
const LOOT_LABELS = Object.freeze({
  drops: 'Drops loot when defeated',
  steal: 'Carries stealable loot',
  both: 'Carries stealable loot, and drops loot when defeated'
});
const UNIT_TYPE_KEYS = Object.freeze(UNIT_TYPES.map(type => type.key));
const notifications = new NotificationService({ diagnostics: new FoundryDiagnostics() });

const byName = (a, b) => String(a.name).localeCompare(String(b.name));

/**
 * One comparator per sort order, each ending in a name tie-break so the roster never reshuffles
 * between renders that did not actually change.
 */
const SORT_COMPARATORS = Object.freeze({
  hp: (a, b) => (a.hpValue - b.hpValue) || (a.hpPct - b.hpPct) || byName(a, b),
  loot: (a, b) => ((LOOT_RANK[a.lootKind] ?? 0) - (LOOT_RANK[b.lootKind] ?? 0)) || byName(a, b),
  aura: (a, b) => (Number(a.hasAura) - Number(b.hasAura)) || byName(a, b),
  type: (a, b) => (a.typeRank - b.typeRank) || byName(a, b),
  turn: (a, b) => (Number(a.acted) - Number(b.acted)) || byName(a, b)
});

/**
 * Sort a side's roster, then move the objective and protected units to the top.
 *
 * That pass runs last and is stable, so those units keep whatever order the chosen comparator
 * had already put them in.
 */
function sortUnits(units, sortBy, sortDir) {
  const sorted = [...units];
  sorted.sort(SORT_COMPARATORS[sortBy] ?? byName);
  if (sortDir === 'desc') sorted.reverse();
  const pinned = unit => Number(Boolean(unit.isObjective || unit.isProtected));
  return sorted.sort((a, b) => pinned(b) - pinned(a));
}

/* -------------------------------------------- */
/*  Unit rows                                   */
/* -------------------------------------------- */

/**
 * Flatten one unit from the map's encounter data into everything its roster row needs.
 *
 * Built per render rather than cached, because almost every field is derived and a stale row would
 * show a unit at the wrong health or with a badge it has since lost.
 */
function buildRow(unit, context) {
  const hpMax = unit.hpMax || unit.hp || 1;
  const stanceMax = Math.max(0, unit.stanceMax);
  const primaryType = UNIT_TYPE_KEYS.findIndex(key => unit.unitTypes.includes(key));
  const isPlayer = context.playerFactions.includes(unit.actorType);
  const loot = !isPlayer && LOOT_RANK[unit.lootKind] ? unit.lootKind : null;
  const energy = isPlayer
    ? resolveCommittedEnergy({ commitment: unit.downtime, energy: unit.energy, energyMax: unit.energyMax })
    : null;
  return {
    tokenId: unit.tokenId,
    actorId: unit.actorId,
    uuid: unit.actorUuid,
    name: unit.tokenName || unit.actorName,
    img: unit.img,
    system: { art: { avatarScale: unit.avatarScale } },
    color: unit.factionColor || SIDE_DEFAULT_COLOR[isPlayer ? 'player' : 'enemy'],
    skills: unit.skills,
    hpValue: unit.hp,
    hpMax,
    hpPct: Math.max(0, Math.min(100, Math.round((unit.hp / hpMax) * 100))),
    stnValue: Math.max(0, unit.stance),
    stnMax: stanceMax,
    stnPips: Array.from({ length: stanceMax }, (_, index) => index < unit.stance),
    energyPips: energy ? Array.from({ length: energy.max }, (_, index) => index < energy.value) : null,
    energyLabel: energy ? energyTooltip(energy) : '',
    isLord: isPlayer && unit.actorType === 'Lord',
    isObjective: !isPlayer && context.defeatTargets.has(unit.tokenId),
    isProtected: context.protectedTargets.has(unit.tokenId),
    arrived: isPlayer && context.arrivals.has(unit.tokenId),
    typeRank: primaryType === -1 ? UNIT_TYPE_KEYS.length : primaryType,
    lootKind: loot,
    lootLabel: loot ? LOOT_LABELS[loot] : '',
    hasAura: unit.auraCount > 0,
    acted: unit.acted,
    dead: unit.hp <= 0
  };
}

/** Name what a unit committed to and what Energy it has left, for the exploration row's tooltip. */
function energyTooltip({ value, max, action }) {
  const remaining = `${value} / ${max} Energy remaining`;
  return action ? `${action} | ${remaining}` : remaining;
}

/** Whether an enemy row should be listed for the current user. */
function enemyVisibleToUser(unit) {
  return enemyRowListed(unit, game.user.isGM);
}

/** The roster side a phase belongs to, or null for no phase at all. */
function sideForPhase(phase) {
  if (phase === ENCOUNTER_PHASES.PLAYER) return 'player';
  return phase === ENCOUNTER_PHASES.ENEMY ? 'enemy' : null;
}

/* -------------------------------------------- */
/*  Tracker application                         */
/* -------------------------------------------- */

const BaseCombatTracker = foundry.applications.sidebar.tabs.CombatTracker;
const AbstractSidebarTab = foundry.applications.sidebar.AbstractSidebarTab;

/**
 * The combat tracker, drawn as a two-sided faction roster of the current map's encounter. Overrides the Foundry
 * tracker methods that expect initiative markup. init/registrations.mjs installs it as `CONFIG.ui.combat`.
 */
export class EmblemCombatTracker extends BaseCombatTracker {
  #pages = { player: 0, enemy: 0 };
  #side = null;
  #shownSide = 'player';
  #lastPhase = undefined;
  #listedEnemies = new Map();
  #sortBy = 'az';
  #sortDir = 'asc';
  #pageSize = PAGE_SIZE;
  #measuring = false;
  #resizeObserver = null;
  #endMenuOpen = false;
  #renderQueued = null;
  #rowStrideCache = 0;
  #confirm = null;
  #confirmTimer = null;
  #roundEditor = null;

  static DEFAULT_OPTIONS = {
    actions: {
      createCombat(event, target) { return this._onCombatCreate(event, target); },
      emblemToggleAutoAdvance(event, target) { return this._onToggleAutoAdvance(event, target); },
      emblemToggleCombatMusic(event, target) { return this._onToggleCombatMusic(event, target); },
      emblemEditRound(event, target) { return this._onEditRound(event, target); },
      emblemSetSide(event, target) { return this._onSetSide(event, target); },
      emblemCycleSort(event, target) { return this._onCycleSort(event, target); },
      emblemToggleSortDir(event, target) { return this._onToggleSortDir(event, target); },
      emblemPrevPage(event, target) { return this._onPageRoster(event, target, -1); },
      emblemNextPage(event, target) { return this._onPageRoster(event, target, 1); },
      emblemSetObjectives(event, target) { return this._onSetObjectives(event, target); },
      emblemBeginEncounter(event, target) { return this._onBeginEncounter(event, target); },
      emblemAdvancePhase(event, target) { return this._onAdvancePhase(event, target); },
      emblemCancelEncounter(event, target) { return this._onCancelEncounter(event, target); },
      emblemToggleEndMenu(event, target) { return this._onToggleEndMenu(event, target); },
      emblemPauseEncounter(event, target) { return this._onPauseEncounter(event, target); },
      emblemResumeEncounter(event, target) { return this._onResumeEncounter(event, target); },
      emblemDiscardPause(event, target) { return this._onDiscardPause(event, target); },
      emblemEndSuccess(event, target) { return this._onEndEncounter(event, target, 'victory'); },
      emblemEndFailure(event, target) { return this._onEndEncounter(event, target, 'defeat'); }
    }
  };

  static PARTS = foundry.utils.mergeObject(
    BaseCombatTracker.PARTS,
    { tracker: { template: TRACKER_TEMPLATE, scrollable: [] } },
    { inplace: false }
  );

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  /** The viewed Combat, or null once it has been deleted: a delayed render can run after its Combat is gone. */
  get viewed() {
    const combat = super.viewed;
    return combat && game.combats.get(combat.id) ? combat : null;
  }

  // Overriding only the getter would hide the inherited setter.
  set viewed(combat) {
    super.viewed = combat;
  }

  /** Collapse the burst of renders one document write produces into a single pass over the DOM. */
  async render(options = {}, _options = {}) {
    if (typeof options === 'boolean') options = Object.assign(_options, { force: options });
    if (rosterRenderHeld > 0 && !options.force && this.state > 0) return this;
    if (options.force || this.state <= 0) {
      this.#dropQueuedRender();
      return super.render(options, _options);
    }
    const queued = this.#renderQueued ?? this.#queueRender();
    Object.assign(queued.options, options);
    clearTimeout(queued.timer);
    queued.timer = setTimeout(queued.run, Math.max(0, Math.min(RENDER_COALESCE_MS, queued.deadline - Date.now())));
    return queued.promise;
  }

  /** Open a coalescing window, bounded so a long chain of writes cannot starve the roster. */
  #queueRender() {
    const queued = {
      timer: 0,
      deadline: Date.now() + RENDER_COALESCE_MAX_MS,
      options: {},
      resolve: null,
      run: null,
      promise: null
    };
    queued.promise = new Promise(resolve => { queued.resolve = resolve; });
    queued.run = () => {
      if (this.#roundEditor?.isConnected) {
        queued.timer = setTimeout(queued.run, RENDER_COALESCE_MS);
        return;
      }
      this.#renderQueued = null;
      queued.resolve(super.render(queued.options));
    };
    this.#renderQueued = queued;
    return queued;
  }

  /** Retire a pending window when an immediate render is about to cover it anyway. */
  #dropQueuedRender() {
    const queued = this.#renderQueued;
    if (!queued) return;
    clearTimeout(queued.timer);
    this.#renderQueued = null;
    queued.resolve(this);
  }

  /**
   * Post-render wiring. The inherited `_onRender` is deliberately not called: it scrolls the active
   * combatant into view by querying an element the faction template does not produce.
   */
  async _onRender(context, options) {
    await AbstractSidebarTab.prototype._onRender.call(this, context, options);
    this.element.classList.toggle('ect-has-encounter', Boolean(context.emblem?.showBoard));
    this.#applyExplorationHeader(context.emblem);
    this.#paintConfirm();
    this.#syncPageSize();
    this.#observeRoster();
  }

  /**
   * Add exploration controls to Foundry's tracker header and remove encounter creation while exploration is
   * active. A paused encounter adds nothing: the `ect-has-encounter` class set in `_onRender` hides the whole
   * header, so neither creation nor exploration is offered until the map is resumed or ended.
   */
  #applyExplorationHeader(emblem) {
    if (!game.user.isGM || emblem?.paused) return;
    const header = this.element.querySelector('.combat-tracker-header');
    const createButton = header?.querySelector('[data-action="createCombat"]');
    if (!createButton) return;
    const createNav = createButton.closest('nav.encounters');
    if (!createNav || header.querySelector('.ect-exploration-nav')) return;

    const active = emblem?.explorationActive === true;
    const nav = document.createElement('nav');
    nav.className = 'encounters ect-exploration-nav';
    nav.setAttribute('aria-label', 'Free Exploration');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = `combat-control-lg ect-exploration-toggle${active ? ' is-on' : ''}`;
    button.dataset.tooltip = 'Let players select and move units without combat';
    button.innerHTML = `<i class="fa-solid ${active ? 'fa-person-walking-arrow-right' : 'fa-person-hiking'}" inert></i>`
      + `<span>${active ? 'End Free Exploration' : 'Free Exploration'}</span>`;
    button.addEventListener('click', event => this._onToggleExploration(event));

    nav.appendChild(button);
    if (active) nav.appendChild(this.#buildResetDowntimeControl());
    createNav.insertAdjacentElement('afterend', nav);
    if (active) createNav.remove();
  }

  /** The exploration nav's second control, which opens the table's next round of downtime. */
  #buildResetDowntimeControl() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'combat-control-lg ect-reset-downtime';
    button.dataset.tooltip = getTooltip(ENCOUNTER_TOOLTIP_IDS.RESET_DOWNTIME);
    button.innerHTML = '<i class="fa-solid fa-arrows-rotate" inert></i><span>Reset Downtime</span>';
    button.addEventListener('click', event => this._onResetTableDowntime(event));
    return button;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.emblem = this.#buildEmblemContext();
    return context;
  }

  /** True when this token turning visible or hidden adds or removes an enemy row. */
  enemyListingChanged(token) {
    const hidden = token.document.hidden === true;
    const listedNow = enemyVisibleToUser({ hidden, visible: token.visible !== false });
    if (!enemyListingFlipped(this.#listedEnemies.get(token.id), listedNow)) return false;
    this.#listedEnemies.set(token.id, listedNow);
    return true;
  }

  /** True when an enemy on this scene wasn't in the last roster render, such as one just placed. */
  enemyListingIncomplete() {
    const scene = globalThis.canvas?.scene ?? globalThis.game?.scenes?.active ?? null;
    const units = [];
    for (const token of scene?.tokens ?? []) {
      if (!token.actor) continue;
      units.push({ tokenId: String(token.id ?? ''), actorType: String(token.actor.system?.faction?.role ?? '') });
    }
    return enemyListingIncomplete(this.#listedEnemies, units, PLAYER_FACTIONS);
  }

  /**
   * Build roster context from Scene phase and round. Follow the acting side until the user selects a tab, and reset
   * that choice when the phase changes. The side shown here is the one the pager steps.
   *
   * A paused map has no Combat document, so its round, objective roster, progress and auto-advance switch come from
   * the Scene's pause record instead. It keeps the running encounter's layout, greyed and labelled as paused.
   */
  #buildEmblemContext() {
    const scene = globalThis.canvas?.scene ?? globalThis.game?.scenes?.active ?? null;
    const board = rosterBoard(scene);
    const hasCombat = Boolean(board?.combatId);
    const started = board?.started === true;
    if (!started) this.#endMenuOpen = false;

    const paused = hasCombat ? null : board?.paused ?? null;
    const phase = board?.phase || null;
    const shownPhase = phase ?? (paused?.phase || null);
    const round = paused ? paused.round : board?.round ?? (started ? 1 : 0);
    const { limit: roundLimit } = deadlineFor(board?.spec?.objectives ?? [], board?.spec?.roundLimit ?? 0);
    const markers = objectiveMarkers(paused?.targets ?? board?.targets);
    const rowContext = {
      playerFactions: PLAYER_FACTIONS,
      defeatTargets: new Set(markers.defeat),
      protectedTargets: new Set(markers.protected),
      arrivals: new Set(started ? board.progress.arrivals : paused?.progress?.arrivals ?? [])
    };

    const playerUnits = [];
    const enemyUnits = [];
    const listedEnemies = new Map();
    for (const unit of board?.units ?? []) {
      const isPlayer = rowContext.playerFactions.includes(unit.actorType);
      if (!isPlayer) {
        const listed = enemyVisibleToUser(unit);
        listedEnemies.set(unit.tokenId, listed);
        if (!listed) continue;
      }
      (isPlayer ? playerUnits : enemyUnits).push(buildRow(unit, rowContext));
    }
    this.#listedEnemies = listedEnemies;

    const activeSide = sideForPhase(phase);
    if (shownPhase !== this.#lastPhase) {
      this.#lastPhase = shownPhase;
      this.#side = null;
    }
    const shownSide = this.#side ?? activeSide ?? sideForPhase(shownPhase) ?? 'player';
    this.#shownSide = shownSide;

    const isGM = game.user.isGM;
    const sides = [
      { side: 'player', title: 'Player', units: playerUnits },
      { side: 'enemy', title: 'Enemy', units: enemyUnits }
    ].map(entry => ({
      side: entry.side,
      title: entry.title,
      color: paused ? SIDE_PAUSED_COLOR : SIDE_DEFAULT_COLOR[entry.side],
      aliveCount: entry.units.filter(unit => !unit.dead).length,
      selected: entry.side === shownSide,
      isPhase: entry.side === activeSide
    }));

    return {
      hasCombat,
      showBoard: hasCombat || Boolean(paused),
      started,
      endMenuOpen: this.#endMenuOpen,
      paused,
      explorationActive: board?.exploration === true,
      exploreUnits: playerUnits,
      isGM,
      canToggle: isGM && hasCombat,
      canEditRound: isGM && hasCombat && started && Boolean(phase),
      phase,
      phaseLabel: paused ? 'Combat Paused' : phase ? `${phase} Phase` : '',
      phaseVariant: paused ? 'paused' : phase ? phase.toLowerCase() : 'pending',
      round,
      roundLimit,
      autoAdvance: (paused ? paused.autoAdvance : board?.autoAdvance) !== false,
      combatMusic: board?.combatMusic !== false,
      sides,
      sortByLabel: SORT_LABELS[this.#sortBy],
      sortDir: this.#sortDir,
      roster: this.#buildRoster(shownSide, shownSide === 'player' ? playerUnits : enemyUnits),
      showProgress: started || Boolean(paused),
      progress: shownPhase
        ? phaseRosterProgress(board.units, shownPhase)
        : { acted: 0, total: 0, pct: 0 }
    };
  }

  /**
   * Sort, page, and slice one side's units. The stored page is clamped rather than trusted, because
   * units die and the page you were on can stop existing between renders.
   */
  #buildRoster(side, units) {
    const sorted = sortUnits(units, this.#sortBy, this.#sortDir);
    const size = this.#pageSize;
    const pageCount = Math.max(1, Math.ceil(sorted.length / size));
    const page = Math.min(Math.max(0, this.#pages[side]), pageCount - 1);
    this.#pages[side] = page;
    return {
      side,
      color: SIDE_DEFAULT_COLOR[side],
      units: sorted.slice(page * size, page * size + size),
      page: page + 1,
      pageCount,
      hasPrev: page > 0,
      hasNext: page < pageCount - 1
    };
  }

  /* -------------------------------------------- */
  /*  Encounter lifecycle                         */
  /* -------------------------------------------- */

  /** Create the encounter for the current map, which has to be an active one. */
  async _onCombatCreate(event, _target) {
    event.preventDefault();
    const sceneUuid = currentSceneUuid();
    if (!sceneUuid) {
      notifications.show(NOTIFICATION_IDS.ENCOUNTER_SCENE_REQUIRED);
      return;
    }
    await game.emblemRpg.api.encounters.create(sceneUuid);
  }

  /** Turn free exploration on or off. */
  async _onToggleExploration(event, _target) {
    event.preventDefault();
    const active = rosterBoard(globalThis.canvas?.scene)?.exploration === true;
    await game.emblemRpg.api.encounters.setExploration(currentSceneUuid(), !active);
  }

  /* -------------------------------------------- */
  /*  Exploration unit administration             */
  /* -------------------------------------------- */

  /**
   * GM context-menu entries for one exploration row. Each is offered only while the unit has something to undo,
   * checked against the unit's current data when the menu opens. Both go through `game.emblemRpg.api.downtime`,
   * which reports its own result.
   */
  #explorationEntryOptions() {
    return [
      {
        label: 'Reset Downtime Activity',
        icon: '<i class="fa-solid fa-rotate-left"></i>',
        visible: row => downtimeResetAvailable(explorationUnit(row) ?? {}),
        onClick: (_event, row) => this._onResetDowntime(row)
      },
      {
        label: 'Restore Energy',
        icon: '<i class="fa-solid fa-bolt"></i>',
        visible: row => energyRestoreAvailable(explorationUnit(row) ?? {}),
        onClick: (_event, row) => this._onRestoreEnergy(row)
      }
    ];
  }

  /** Give one unit its Energy and its choice of downtime activity back. */
  async _onResetDowntime(row) {
    const unit = explorationUnit(row);
    if (!unit) return;
    await game.emblemRpg.api.downtime.resetActivity({ actorUuid: unit.actorUuid });
  }

  /** Give a part-way crafter back as much of its spent Energy as the GM enters. Zero changes nothing. */
  async _onRestoreEnergy(row) {
    const unit = explorationUnit(row);
    if (!unit) return;
    const amount = await openEnergyRestoreDialog(unit.name, unit.energyMax - Math.min(unit.energyMax, unit.energy));
    if (!(amount > 0)) return;
    await game.emblemRpg.api.downtime.restoreEnergy({ actorUuid: unit.actorUuid, amount });
  }

  /**
   * Reset downtime for this map through api.downtime.resetDowntime: every party unit gets its Downtime Action and
   * Energy back, the downtime buffs are dispelled, the Stationary factions are unlocked and every Vendor on the map
   * forgets its haggles. The API shows the result to the GM. The GM confirms first, and a cancel sends nothing.
   */
  async _onResetTableDowntime(event) {
    event.preventDefault();
    if (!(await confirmDowntimeReset())) return;
    await game.emblemRpg.api.downtime.resetDowntime({ sceneUuid: currentSceneUuid() });
  }

  /** Open the objectives editor for this map. */
  async _onSetObjectives(event, _target) {
    event.preventDefault();
    await openObjectivesEditor(globalThis.canvas?.scene ?? globalThis.game?.scenes?.active ?? null);
  }

  /** Start the encounter that has been set up. */
  async _onBeginEncounter(event, _target) {
    event.preventDefault();
    await game.emblemRpg.api.encounters.begin(currentSceneUuid());
  }

  /**
   * Advance the phase on the second press. The request carries the encounter, phase and round seen on the first
   * press, and the host refuses it if the encounter has moved on since.
   */
  async _onAdvancePhase(event, _target) {
    event.preventDefault();
    const armed = this.#confirm?.action === 'emblemAdvancePhase' ? this.#confirm.intent : null;
    if (!this.#confirmed('emblemAdvancePhase')) {
      this.#confirm.intent = captureAdvanceIntent(currentSceneUuid());
      return;
    }
    await game.emblemRpg.api.encounters.advancePhase(armed);
  }

  /** Delete an encounter that has not started yet. */
  async _onCancelEncounter(event, _target) {
    event.preventDefault();
    await game.emblemRpg.api.encounters.cancel(currentSceneUuid());
  }

  /** Expand or collapse the end-encounter menu. Toggling it disarms any armed two-stage control. */
  _onToggleEndMenu(event, _target) {
    event.preventDefault();
    this.#disarmConfirm();
    this.#endMenuOpen = !this.#endMenuOpen;
    this.render({ force: true });
  }

  /** Declare how the map went and end it, once the control has been pressed twice. */
  async _onEndEncounter(event, _target, outcome) {
    event.preventDefault();
    if (!this.#confirmed(outcome === 'victory' ? 'emblemEndSuccess' : 'emblemEndFailure')) return;
    this.#endMenuOpen = false;
    await game.emblemRpg.api.encounters.end(currentSceneUuid(), outcome);
  }

  /** Stop the encounter, keeping its round on the map for a later resume. */
  async _onPauseEncounter(event, _target) {
    event.preventDefault();
    this.#endMenuOpen = false;
    await game.emblemRpg.api.encounters.pause(currentSceneUuid());
  }

  /** Open the paused encounter again on the round it stopped. */
  async _onResumeEncounter(event, _target) {
    event.preventDefault();
    await game.emblemRpg.api.encounters.resume(currentSceneUuid());
  }

  /** Discard the paused encounter, which is how a paused map is ended. */
  async _onDiscardPause(event, _target) {
    event.preventDefault();
    await game.emblemRpg.api.encounters.discardPause(currentSceneUuid());
  }

  /* -------------------------------------------- */
  /*  Two-stage controls                          */
  /* -------------------------------------------- */

  /**
   * Whether a two-stage control has been pressed twice inside its window.
   *
   * The first press only arms the control and relabels it with the seconds left, so no stray click ends a
   * phase or a map. Arming one control disarms the previous one.
   */
  #confirmed(action) {
    if (this.#confirm?.action === action) {
      this.#disarmConfirm();
      return true;
    }
    clearInterval(this.#confirmTimer);
    this.#confirm = { action, deadline: Date.now() + CONFIRM_WINDOW_MS };
    this.#confirmTimer = setInterval(() => this.#paintConfirm(), CONFIRM_TICK_MS);
    this.#paintConfirm();
    return false;
  }

  /** Disarm the armed control and put its label back: after its second press, a timeout, or a menu toggle. */
  #disarmConfirm() {
    clearInterval(this.#confirmTimer);
    this.#confirmTimer = null;
    this.#confirm = null;
    this.#paintConfirm();
  }

  /**
   * Write each two-stage control's label: its own, or the countdown while it is armed.
   *
   * The label is patched in place rather than rendered, so the countdown tick (every CONFIRM_TICK_MS) never
   * costs a pass over the roster. Every render restores the template's own labels, which is where the base text
   * comes from.
   */
  #paintConfirm() {
    const remaining = this.#confirm ? this.#confirm.deadline - Date.now() : 0;
    if (this.#confirm && remaining <= 0) {
      this.#disarmConfirm();
      return;
    }
    for (const action of CONFIRM_ACTIONS) {
      const button = this.element?.querySelector(`[data-action="${action}"]`);
      const label = button?.querySelector('span');
      if (!label) continue;
      button.dataset.emblemLabel ||= label.textContent;
      const armed = this.#confirm?.action === action;
      label.textContent = armed ? `Confirm? [${Math.ceil(remaining / 1000)}s]` : button.dataset.emblemLabel;
      button.classList.toggle('is-confirming', armed);
    }
  }

  /** Toggle automatic phase advancement. */
  async _onToggleAutoAdvance(event, _target) {
    event.preventDefault();
    const board = rosterBoard(globalThis.canvas?.scene);
    await game.emblemRpg.api.encounters.setAutoAdvance(currentSceneUuid(), board?.autoAdvance === false);
  }

  /** Toggle this encounter's phase music, leaving the map's configured tracks alone. */
  async _onToggleCombatMusic(event, _target) {
    event.preventDefault();
    const board = rosterBoard(globalThis.canvas?.scene);
    await game.emblemRpg.api.encounters.setCombatMusic(currentSceneUuid(), board?.combatMusic === false);
  }

  /**
   * Turn the round number into a text field in place, keeping its styling. Enter or leaving the field sets the
   * encounter's round, Escape puts the old number back. Queued renders wait until the edit ends, so a roster
   * refresh cannot throw away what the GM is typing.
   */
  _onEditRound(event, target) {
    event.preventDefault();
    if (target.isContentEditable) return;
    const shown = target.textContent;
    let settled = false;
    const finish = commit => {
      if (settled) return;
      settled = true;
      this.#roundEditor = null;
      target.contentEditable = 'false';
      const round = Number(target.textContent.trim());
      const valid = Number.isInteger(round) && round >= 1 && round <= ENCOUNTER_ROUND_MAX;
      if (!commit || !valid || String(round) === shown) {
        target.textContent = shown;
        return;
      }
      target.textContent = String(round);
      void game.emblemRpg.api.encounters.setRound(currentSceneUuid(), round).then(result => {
        if (result?.ok !== true) this.render({ force: true });
      });
    };
    this.#roundEditor = target;
    target.contentEditable = 'plaintext-only';
    target.addEventListener('beforeinput', inputEvent => {
      if (inputEvent.data && /\D/.test(inputEvent.data)) inputEvent.preventDefault();
    });
    target.addEventListener('keydown', keyEvent => {
      if (keyEvent.key !== 'Enter' && keyEvent.key !== 'Escape') return;
      keyEvent.preventDefault();
      finish(keyEvent.key === 'Enter');
      target.blur();
    });
    target.addEventListener('blur', () => finish(true), { once: true });
    target.focus();
    globalThis.getSelection()?.selectAllChildren(target);
  }

  /* -------------------------------------------- */
  /*  Roster controls                             */
  /* -------------------------------------------- */

  /** Pin the roster to one side, taking control from the phase until it next changes. */
  _onSetSide(event, target) {
    event.preventDefault();
    const side = target.dataset.side;
    if (side !== 'player' && side !== 'enemy') return;
    this.#side = side;
    this.render({ force: true });
  }

  /**
   * Step the shown roster by one page. The side is the one the last render showed, so a paused map pages the roster
   * its pause record put on screen.
   */
  _onPageRoster(event, _target, delta) {
    event.preventDefault();
    const side = this.#shownSide;
    this.#pages[side] += delta;
    this.render({ force: true });
  }

  /** Step to the next sort order, resetting both sides to their first page. */
  _onCycleSort(event, _target) {
    event.preventDefault();
    this.#sortBy = SORT_CYCLE[(SORT_CYCLE.indexOf(this.#sortBy) + 1) % SORT_CYCLE.length];
    this.#pages.player = 0;
    this.#pages.enemy = 0;
    this.render({ force: true });
  }

  /** Flip the sort direction, likewise resetting the pages. */
  _onToggleSortDir(event, _target) {
    event.preventDefault();
    this.#sortDir = this.#sortDir === 'desc' ? 'asc' : 'desc';
    this.#pages.player = 0;
    this.#pages.enemy = 0;
    this.render({ force: true });
  }

  /* -------------------------------------------- */
  /*  Fitting                                     */
  /* -------------------------------------------- */

  /**
   * Re-point the resize observer at the current list. Every render replaces the part's DOM, so the
   * previously observed node is stale, and the root alone is not enough because the phase panel can
   * grow or shrink without the sidebar itself resizing.
   */
  #observeRoster() {
    const observer = this.#resizeObserver;
    if (!observer) return;
    observer.disconnect();
    observer.observe(this.element);
    const list = this.element.querySelector('.ect-unit-list');
    if (list) observer.observe(list);
  }

  /**
   * How much vertical space one roster row takes, margins included. Measured from the gap between
   * two real rows where there are two, since that captures whatever the layout actually does.
   */
  #rowStride(rows) {
    if (rows.length >= 2) {
      const stride = rows[1].offsetTop - rows[0].offsetTop;
      if (stride > 0) {
        this.#rowStrideCache = stride;
        return stride;
      }
    }
    const row = rows[0];
    if (!row) return this.#rowStrideCache || UNIT_ROW_FALLBACK;
    const style = getComputedStyle(row);
    const margins = (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
    return (row.offsetHeight || UNIT_ROW_FALLBACK) + margins;
  }

  /**
   * Fit as many rows as the sidebar's height allows and page the rest. This cannot oscillate: the
   * list is a flex-grown box with hidden overflow, so its height does not depend on how many rows it
   * holds, and re-rendering with a new page size cannot change the measurement that produced it.
   */
  #syncPageSize() {
    if (this.#measuring) return;
    const list = this.element?.querySelector('.ect-unit-list');
    if (!list) return;
    const available = list.clientHeight;
    if (!available) return;
    const size = Math.max(1, Math.floor(available / this.#rowStride([...list.querySelectorAll('.ect-unit')])));
    if (size === this.#pageSize) return;
    this.#pageSize = size;
    this.#measuring = true;
    Promise.resolve(this.render({ force: true, parts: ['tracker'] })).finally(() => { this.#measuring = false; });
  }

  /* -------------------------------------------- */
  /*  Lifecycle                                   */
  /* -------------------------------------------- */

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this.element.addEventListener('click', this.#onUnitClick.bind(this));
    this.element.addEventListener('dblclick', this.#onUnitDoubleClick.bind(this));
    this.#resizeObserver = new ResizeObserver(foundry.utils.debounce(() => this.#syncPageSize(), 60));
    if (game.user.isGM) {
      this._createContextMenu(this.#explorationEntryOptions, EXPLORE_ROW_SELECTOR, {
        fixed: true, hookName: 'getEmblemExplorationContextOptions', parentClassHooks: false
      });
    }
  }

  _onClose(options) {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    clearInterval(this.#confirmTimer);
    this.#confirmTimer = null;
    this.#confirm = null;
    super._onClose(options);
  }

  /**
   * Select a unit and bring the camera to it. Controls and panels are excluded first, so a click on
   * a button inside a row does its own job rather than also selecting the unit behind it.
   */
  #onUnitClick(event) {
    if (event.target.closest('button, input, select, a, .ect-phase-panel, .ect-roster-bar, .ect-pager')) return;
    const row = event.target.closest('.ect-unit[data-token-id], .ect-explore-unit[data-token-id]');
    if (!row) return;
    focusTrackerUnit(globalThis.canvas?.tokens?.get(row.dataset.tokenId));
  }

  /** Open a unit's sheet, for anyone allowed to observe it. */
  #onUnitDoubleClick(event) {
    const row = event.target.closest('.ect-unit[data-token-id], .ect-explore-unit[data-token-id]');
    if (!row) return;
    const actor = globalThis.canvas?.tokens?.get(row.dataset.tokenId)?.actor;
    if (actor?.testUserPermission(globalThis.game.user, 'OBSERVER')) actor.sheet.render(true);
  }
}

/* -------------------------------------------- */
/*  Shared helpers and refresh                  */
/* -------------------------------------------- */

/**
 * Record the scene, encounter, phase and round an Advance Phase request is meant for, so the host can refuse it
 * if the encounter has moved on.
 * @param {string} sceneUuid The Scene whose encounter would advance.
 * @returns {{sceneUuid: string, expected?: {combatId: string, phase: string, round: number}}}
 */
export function captureAdvanceIntent(sceneUuid) {
  const state = projectEncounterState(sceneUuid);
  const combatId = String(state?.combatUuid ?? '').split('.').pop();
  if (state?.started !== true || !state.phase || !combatId) return { sceneUuid };
  return { sceneUuid, expected: { combatId, phase: String(state.phase), round: Number(state.round) } };
}

/**
 * Focus a roster token: the GM also selects it, while players only pan to it. Players take control of units
 * through the movement controls instead.
 * @param {object} token The row's Token placeable.
 * @param {object} [user] The clicking user.
 * @returns {boolean} Whether the unit was selected.
 */
export function focusTrackerUnit(token, user = globalThis.game?.user) {
  if (!token) return false;
  const staff = user?.isGM === true;
  const selected = staff && token.control?.({ releaseOthers: true }) === true;
  if (selected || !staff) globalThis.canvas?.animatePan?.(token.center);
  return selected;
}

/**
 * Ask the tracker to re-render. EmblemCombatTracker#render collapses a burst of these into one pass. Called from
 * the canvas and document hooks that change what the roster shows.
 */
export function rerenderTracker() {
  if (globalThis.ui?.combat?.rendered) void globalThis.ui.combat.render();
}

/** Re-render for a Token write, unless it touched only the fields no roster row reads. */
export function rerenderTrackerForTokenChange(changes) {
  if (tokenChangeAffectsRoster(changes)) rerenderTracker();
}

/** Re-render for an Actor write, unless it touched only the fields no roster row reads. */
export function rerenderTrackerForActorChange(changes) {
  if (actorChangeAffectsRoster(changes)) rerenderTracker();
}

// How many withRosterRenderHeld calls are running. While above zero, unforced renders of the open tracker are dropped.
let rosterRenderHeld = 0;

/**
 * Run `work` with roster renders refused, for Foundry core writes that re-render the tracker regardless of what
 * changed. A forced render still goes through.
 */
export function withRosterRenderHeld(work) {
  rosterRenderHeld += 1;
  try {
    return work();
  } finally {
    rosterRenderHeld -= 1;
  }
}

/** Re-render for a token refresh only when its visibility change adds or removes an enemy row. */
export function rerenderTrackerForTokenRefresh(token, flags) {
  if (!flags.refreshVisibility) return;
  if (globalThis.ui?.combat?.enemyListingChanged?.(token)) rerenderTracker();
}

/**
 * Re-render for a player's vision refresh only when an enemy isn't in the roster yet. Foundry raises
 * `sightRefresh` after asking every token to refresh its visibility, and rerenderTrackerForTokenRefresh already
 * handles each enemy the roster knows, so this only matters for an enemy placed since the roster last drew.
 */
export function rerenderTrackerForSightRefresh() {
  const tracker = globalThis.ui?.combat;
  if (typeof tracker?.enemyListingIncomplete !== 'function' || tracker.enemyListingIncomplete()) rerenderTracker();
}

/**
 * Recolour the sidebar's combat tab to match the state of the map, so the current state is readable
 * with the sidebar collapsed.
 */
export function refreshCombatTab() {
  const button = globalThis.document?.querySelector('#sidebar-tabs button[data-action="tab"][data-tab="combat"]')
    ?? globalThis.document?.querySelector('button[data-action="tab"][data-tab="combat"]');
  if (!button) return;
  const board = rosterBoard(globalThis.canvas?.scene);
  const traveling = !board?.started && board?.exploration === true;

  button.classList.remove('ect-tab-player', 'ect-tab-enemy', 'ect-tab-explore');
  button.classList.toggle('fa-swords', !traveling);
  button.classList.toggle('fa-person-hiking', traveling);
  if (board?.started && board.phase === ENCOUNTER_PHASES.PLAYER) button.classList.add('ect-tab-player');
  else if (board?.started && board.phase === ENCOUNTER_PHASES.ENEMY) button.classList.add('ect-tab-enemy');
  else if (traveling) button.classList.add('ect-tab-explore');
}

/** Debounced `refreshCombatTab`, for hooks that fire in bursts. */
export const refreshCombatTabDebounced = foundry.utils.debounce(refreshCombatTab, 50);

/* -------------------------------------------- */
/*  Scene lookups                               */
/* -------------------------------------------- */

function rosterBoard(scene) {
  return projectObjectiveBoard(scene, { terrain: false });
}

/**
 * The unit behind one exploration row, read fresh from the scene rather than from the rendered row, so the GM's
 * menu sees the actor's current data. Null when the token has left the map.
 */
function explorationUnit(row) {
  const tokenId = String(row?.dataset?.tokenId ?? '');
  const unit = rosterBoard(globalThis.canvas?.scene)?.units?.find(entry => entry.tokenId === tokenId);
  if (!unit) return null;
  return {
    actorUuid: unit.actorUuid,
    name: unit.tokenName || unit.actorName,
    commitment: unit.downtime,
    energy: unit.energy,
    energyMax: unit.energyMax
  };
}

/** Ask the GM before Reset Downtime. Resolves true only when Reset is pressed. */
async function confirmDowntimeReset() {
  const confirmed = await openBlockingDialog({
    title: 'Reset Downtime',
    width: 340,
    height: 'auto',
    content: RESET_DOWNTIME_PROMPT,
    buttons: [
      { action: 'reset', label: 'Reset', default: true, callback: () => true },
      { action: 'cancel', label: 'Cancel' }
    ]
  });
  return confirmed === true;
}

function currentSceneUuid() {
  return String((globalThis.canvas?.scene ?? globalThis.game?.scenes?.active)?.uuid ?? '');
}
