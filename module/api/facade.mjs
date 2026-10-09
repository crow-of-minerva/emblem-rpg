/** @layer api */
import { COMMAND_IDS, COMMAND_LANES, commandFrozenByPause, commandLane } from '../contracts/commands.mjs';
import {
  AUTHORITY_LEVELS, EXECUTION_LIFECYCLE, HOST_STATES, PROCESSING_CONTROL, requirePorts
} from '../contracts/protocol.mjs';
import { RESULT_CODES, refuse } from '../contracts/results.mjs';
import { EVENT_IDS } from '../contracts/events.mjs';
import { DEVELOPMENT_SCOPES } from '../contracts/domains/development.mjs';
import { GATHER_DESTINATIONS } from '../contracts/domains/downtime.mjs';
import {
  ENCOUNTER_PHASES, INCAPACITATING_STATUSES, MELEE_ELEVATION_REACH, THREAT_TIERS, enemyPhaseCameraMessage,
  isEnemyPhaseCameraMessage
} from '../contracts/domains/combat.mjs';
import { FACTION_GROUPS } from '../contracts/domains/characters.mjs';
import { SPAWN_BEHAVIORS, TERRAIN_SPAWN_BEHAVIOR_FLAG } from '../contracts/domains/terrain.mjs';
import {
  MAX_TOKEN_ART_TABS, TOKEN_ART_SLOTS, TOKEN_BASE_MAGNIFICATION, TOKEN_CONDITIONS
} from '../contracts/domains/tokens.mjs';

/**
 * The version of game.emblemRpg.api, published as `api.version`. Raise major and reset minor to 0 when a published
 * member, a field it returns, a published value, or a flag, `system.art` field or Item `system` field named in
 * api/types.mjs (such as the spawnBehavior and pixelArt flags) is removed, renamed or changes meaning; raise minor
 * when one is added. A module runs only against the major it was written for, at or above the minor it needs. The
 * Module API sections of CHANGELOG.md list what each version added or changed.
 * @type {import('./types.mjs').ApiVersion}
 */
const API_VERSION = Object.freeze({ major: 2, minor: 3 });

/**
 * Token-art slots, conditions, the class tab limit and the token magnification, published as `api.character.art`
 * for Studio. The magnification is how many times larger the map draws a token than the scale set in the Actor
 * Control Panel, so Studio's scale preview can draw the token at the same size.
 */
const TOKEN_ART_VOCABULARY = Object.freeze({
  slots: TOKEN_ART_SLOTS, conditions: TOKEN_CONDITIONS, maxClassTabs: MAX_TOKEN_ART_TABS,
  tokenMagnification: TOKEN_BASE_MAGNIFICATION
});

/**
 * The Actor flag (under the system's flags) that holds the behavior a spawn square gave a unit, and the choices it
 * may hold, published as `api.encounters.spawnBehaviors` for Enemy AI.
 */
const SPAWN_BEHAVIOR_VOCABULARY = Object.freeze({ flag: TERRAIN_SPAWN_BEHAVIOR_FLAG, choices: SPAWN_BEHAVIORS });

/* -------------------------------------------- */
/*  Public facade                               */
/* -------------------------------------------- */
/**
 * Build game.emblemRpg.api. init/system.mjs calls this once with every service it needs. Gameplay commands go through
 * CommandGateway, and each result is shown through the notification service before it's returned. Read and
 * presentation services are exposed without their repositories.
 */
export function createPublicFacade({
  gateway, executionSegments, processing, promotions, objectQueries, economyQueries, downtimeQueries, movements,
  itemAuthoring, partyService, authority, events, audio, tokenArt, controlPanel, presentationCamera, threatIndicators,
  drivenBoard, measurement, notifications, gradeThreat, combatCinematicEnabled, itemCinematicEnabled, currentSceneUuid,
  tableFrozen
}) {
  requirePorts('createPublicFacade', { gateway, executionSegments, processing, promotions, objectQueries,
    economyQueries, downtimeQueries, movements, itemAuthoring, partyService, authority, events, audio, tokenArt,
    controlPanel, presentationCamera, threatIndicators, drivenBoard, measurement, notifications, gradeThreat,
    combatCinematicEnabled, itemCinematicEnabled, currentSceneUuid, tableFrozen });
  const execute = async (commandId, payload = {}) => {
    const kind = commandLane(commandId) === COMMAND_LANES.INSPECT ? 'inspect' : 'gameplay';
    if (!processing.admitInput(kind)) {
      const blocked = refuse(RESULT_CODES.COMMAND_EXECUTION_BUSY);
      notifications.showResult(blocked);
      return blocked;
    }
    if (tableFrozen() && commandFrozenByPause(commandId)) {
      const paused = refuse(RESULT_CODES.COMMAND_TABLE_PAUSED);
      notifications.showResult(paused);
      return paused;
    }
    const result = await gateway.execute(commandId, payload);
    notifications.showResult(result);
    return result;
  };
  /** Build the gameplay methods around a command runner: CommandGateway, or an open execution segment (openSegment). */
  const gameplayDomains = run => ({
    character: characterApi({ promotions, execute: run, itemCinematicEnabled }),
    movement: movementApi({ movements, execute: run }),
    combat: combatApi({ execute: run, combatCinematicEnabled, gradeThreat }),
    items: itemApi({ itemAuthoring, authority, execute: run, itemCinematicEnabled }),
    encounters: encounterApi({ execute: run, currentSceneUuid, drivenBoard, authority, measurement }),
    objects: objectApi({ objectQueries, execute: run }),
    downtime: downtimeApi({ downtimeQueries, execute: run, currentSceneUuid }),
    economy: economyApi({ economyQueries, execute: run })
  });
  const protocol = protocolApi({ gateway, processing, executionSegments, notifications, measurement, gameplayDomains });

  const { character, movement, combat, items, encounters, objects, downtime, economy } = gameplayDomains(execute);
  const parties = partyApi({ partyService, authority });
  const presentation = presentationApi({
    audio, tokenArt, controlPanel, camera: presentationCamera, threat: threatIndicators
  });
  const recovery = recoveryApi(execute);
  const eventApi = eventApiFor(events);
  const development = developmentApi({ execute, currentSceneUuid });

  const measured = withMeasurement({ character, movement, combat, encounters, measurement });
  const api = Object.freeze({
    version: API_VERSION,
    character: measured.character,
    movement: measured.movement,
    combat: measured.combat,
    encounters: measured.encounters,
    ...measured.namespaces,
    items,
    objects,
    downtime,
    economy,
    recovery,
    parties,
    presentation,
    events: eventApi,
    protocol,
    development
  });
  return Object.freeze({ api });
}

/* -------------------------------------------- */
/*  Protocol                                    */
/* -------------------------------------------- */

/**
 * Build api.protocol around CommandGateway status queries and execution segments.
 * @param {object} ports The facade's gateway, the host's busy state, execution segments, notices, measurement and
 *   the gameplay methods a segment builds.
 * @returns {Readonly<object>} `api.protocol`.
 */
function protocolApi({ gateway, processing, executionSegments, notifications, measurement, gameplayDomains }) {
  return Object.freeze({
    /** The result codes and host states companion modules branch on, so they need not copy the vocabulary. */
    resultCodes: RESULT_CODES,
    hostStates: HOST_STATES,
    /** The host client's start-up states. A `status()` reply gives the current one as `data.lifecycle`. */
    lifecycleStates: EXECUTION_LIFECYCLE,
    /**
     * `{ATTRIBUTE, SEGMENT_STOP}`: put this attribute with this value on a module's own Stop button, and a GM or
     * Assistant GM can still press it while the host client is busy.
     */
    processingControl: PROCESSING_CONTROL,
    /**
     * Which client hosts commands, as this client sees it, read locally without asking anyone.
     * @returns {import('./types.mjs').HostView}
     */
    host: () => gateway.host(),
    status: () => gateway.status(),
    execution: () => processing.snapshot(),
    requestStatus: intent => gateway.requestStatus(String(intent?.requestId ?? '')),
    /**
     * Ask whoever holds the command lock (such as the Enemy AI) to stop, through CommandGateway.requestSegmentStop.
     * Only a GM or Assistant may ask. It stops before its next action; one already running finishes first.
     * @returns {Promise<{ok: boolean, code: string, data: object}>} `command.segment-stop-requested`, a refusal such
     *   as `command.segment-not-open` or `shared.gm-required`, or `command.outcome-unknown` past the status deadline.
     */
    requestSegmentStop: () => gateway.requestSegmentStop(),
    /**
     * Wait the given time with a timer that keeps running when the tab is in the background (for the Enemy AI).
     * @param {number} milliseconds How long to pause.
     * @returns {Promise<void>}
     */
    wait: milliseconds => paceOn(executionSegments, milliseconds),
    openExecutionSegment: intent => openSegment({ executionSegments, notifications, measurement, gameplayDomains,
      label: String(intent?.label ?? '') })
  });
}

/* -------------------------------------------- */
/*  Execution segments                          */
/* -------------------------------------------- */

/**
 * Let a module on the GM's client, such as the Enemy AI, hold the command lock for a run of actions (an execution
 * segment), and return gameplay methods that run inside it in data.segment.api. A refusal to open shows no notice,
 * but each action's result is shown as usual. The caller checks stopRequested between actions and closes the
 * segment when it's done.
 * @returns {Promise<object>} The opened segment in `data.segment`, or the refusal.
 */
async function openSegment({ executionSegments, notifications, measurement, gameplayDomains, label }) {
  const opened = await executionSegments.open({ label });
  if (!opened.ok) return opened;
  const { segment } = opened.data;
  const run = async (commandId, payload = {}) => {
    const result = await segment.run(commandId, payload);
    notifications.showResult(result);
    return result;
  };
  const domains = gameplayDomains(run);
  const measured = withMeasurement({ ...domains, measurement });
  const api = Object.freeze({ ...domains, character: measured.character, movement: measured.movement,
    combat: measured.combat, encounters: measured.encounters });
  return Object.freeze({ ...opened, data: Object.freeze({ segment: Object.freeze({
    api,
    get held() {
      return segment.held;
    },
    get closed() {
      return segment.closed;
    },
    get stopRequested() {
      return segment.stopRequested;
    },
    wait: milliseconds => segment.wait(milliseconds),
    release: () => segment.release(),
    reacquire: () => segment.reacquire(),
    close: () => segment.close()
  }) }) });
}

/** Wait on the timer init/system.mjs provides, which keeps time in a background tab. */
function paceOn(executionSegments, milliseconds) {
  return executionSegments.wait(Math.max(0, Number(milliseconds) || 0));
}

/**
 * Merge api/measurement.mjs reads into character, movement, combat and encounters, and return its terrain and board
 * namespaces separately. createPublicFacade adds those namespaces to the API, but a segment's api from
 * openSegment leaves them out. `character.factions` also carries the three faction groups.
 * @param {object} input The built domains plus the measurement API.
 * @returns {{character: object, movement: object, combat: object, encounters: object, namespaces: object}}
 */
function withMeasurement({ character, movement, combat, encounters, measurement }) {
  return {
    character: Object.freeze({
      ...character, factions: Object.freeze({ ...measurement.factions, groups: FACTION_GROUPS })
    }),
    movement: Object.freeze({ ...movement, ...measurement.movement }),
    combat: Object.freeze({ ...combat, ...measurement.combat }),
    encounters: Object.freeze({ ...encounters, ...measurement.encounters }),
    namespaces: Object.freeze({ terrain: measurement.terrain, board: measurement.board })
  };
}

/* -------------------------------------------- */
/*  Character domain                            */
/* -------------------------------------------- */
function characterApi({ promotions, execute, itemCinematicEnabled }) {
  return Object.freeze({
    art: TOKEN_ART_VOCABULARY,
    actions: Object.freeze({
      spendStandard: actorUuid => execute(
        COMMAND_IDS.CHARACTER.ACTIONS.SPEND_STANDARD,
        { actorUuid: actorUuid ?? '' }
      ),
      restoreStandard: actorUuid => execute(
        COMMAND_IDS.CHARACTER.ACTIONS.RESTORE_STANDARD,
        { actorUuid: actorUuid ?? '' }
      )
    }),
    setFreeTargeting: intent => execute(COMMAND_IDS.CHARACTER.TARGETING.SET_FREE_TARGETING, {
      actorUuid: intent?.actorUuid ?? '',
      enabled: intent?.enabled === true
    }),
    setPacifist: intent => execute(COMMAND_IDS.CHARACTER.COUNTER.SET_PACIFIST, {
      actorUuid: intent?.actorUuid ?? '',
      pacifist: intent?.pacifist === true
    }),
    skills: Object.freeze({
      roll: intent => execute(COMMAND_IDS.CHARACTER.SKILLS.ROLL, {
        actorUuid: intent?.actorUuid ?? '',
        skillKey: intent?.skillKey ?? '',
        mode: intent?.mode ?? '',
        dc: intent?.dc ?? null,
        effectName: intent?.effectName ?? '',
        targetName: intent?.targetName ?? ''
      })
    }),
    inventory: Object.freeze({
      toggleEquipment: intent => execute(COMMAND_IDS.CHARACTER.INVENTORY.TOGGLE_EQUIPMENT, {
        actorUuid: intent?.actorUuid ?? '',
        itemId: intent?.itemId ?? ''
      }),
      transfer: intent => execute(COMMAND_IDS.CHARACTER.INVENTORY.TRANSFER, {
        sourceActorUuid: intent?.sourceActorUuid ?? '',
        targetActorUuid: intent?.targetActorUuid ?? '',
        itemId: intent?.itemId ?? '',
        amount: intent?.amount ?? null
      })
    }),
    classes: Object.freeze({
      assign: intent => execute(COMMAND_IDS.CHARACTER.CLASSES.ASSIGN, {
        actorUuid: intent?.actorUuid ?? '',
        classData: intent?.classData ?? null
      }),
      selectFeatures: intent => execute(COMMAND_IDS.CHARACTER.CLASSES.SELECT_FEATURES, {
        classUuid: intent?.classUuid ?? '',
        bundleId: intent?.bundleId ?? '',
        selectedIndices: intent?.selectedIndices ?? []
      }),
      reopenBundle: intent => execute(COMMAND_IDS.CHARACTER.CLASSES.REOPEN_BUNDLE, {
        classUuid: intent?.classUuid ?? '',
        bundleId: intent?.bundleId ?? ''
      }),
      promote: intent => execute(COMMAND_IDS.CHARACTER.CLASSES.PROMOTE, {
        actorUuid: intent?.actorUuid ?? '',
        tokenUuid: intent?.tokenUuid ?? '',
        promotionId: intent?.promotionId ?? '',
        usedItemId: intent?.usedItemId ?? '',
        bypassItem: intent?.bypassItem === true,
        bypassRequirements: intent?.bypassRequirements === true,
        cinematic: intent?.cinematic !== false && itemCinematicEnabled(intent?.cinematicCategory)
      }),
      openPromotion: intent => promotions.openPreview({
        actorUuid: intent?.actorUuid ?? '',
        tokenUuid: intent?.tokenUuid ?? '',
        usedItemId: intent?.usedItemId ?? '',
        bypassItem: intent?.bypassItem === true,
        bypassRequirements: intent?.bypassRequirements === true
      })
    }),
    progression: Object.freeze({
      grantExperience: intent => execute(COMMAND_IDS.CHARACTER.PROGRESSION.GRANT_EXPERIENCE, {
        actorUuid: intent?.actorUuid ?? '',
        experience: intent?.experience ?? null
      }),
      levelUp: intent => execute(COMMAND_IDS.CHARACTER.PROGRESSION.LEVEL_UP, {
        actorUuid: intent?.actorUuid ?? '',
        quiet: intent?.quiet === true
      })
    }),
    support: Object.freeze({
      setPartners: intent => execute(COMMAND_IDS.CHARACTER.SUPPORT.SET_PARTNERS, {
        actorUuid: intent?.actorUuid ?? '',
        partners: intent?.partners ?? []
      })
    }),
    knowledge: Object.freeze({
      grantJournalAccess: intent => execute(COMMAND_IDS.CHARACTER.KNOWLEDGE.GRANT_JOURNAL_ACCESS, {
        actorUuid: intent?.actorUuid ?? '',
        journalUuid: intent?.journalUuid ?? ''
      })
    }),
    hotbar: Object.freeze({
      saveLayout: intent => execute(COMMAND_IDS.CHARACTER.HOTBAR.SAVE_LAYOUT, {
        actorUuid: String(intent?.actorUuid ?? ''),
        state: intent?.state ?? null,
        expectedRevision: Number(intent?.expectedRevision)
      })
    })
  });
}

/* -------------------------------------------- */
/*  Movement and combat domains                 */
/* -------------------------------------------- */
function movementApi({ movements, execute }) {
  return Object.freeze({
    getPlan: tokenUuid => movements.getSnapshot(tokenUuid, { hints: true }),
    getLock: () => movements.getLock(),
    getField: (intent = {}) => movements.getField(intent.tokenUuid ?? '', {
      nextTurn: intent.nextTurn === true,
      start: intent.start ?? null,
      maxCost: intent.maxCost ?? null,
      cellPenalties: intent.cellPenalties ?? null,
      ignoreTokenIds: intent.ignoreTokenIds ?? [],
      teleports: intent.teleports !== false,
      stationary: intent.stationary === true,
      attackReach: intent.attackReach !== false,
      reverse: intent.reverse === true
    }),
    crossings: (intent = {}) => movements.getCrossings(intent.tokenUuid ?? ''),
    begin: tokenUuid => execute(COMMAND_IDS.MOVEMENT.BEGIN, { tokenUuid: tokenUuid ?? '' }),
    commit: intent => execute(COMMAND_IDS.MOVEMENT.COMMIT, {
      tokenUuid: intent?.tokenUuid ?? '',
      resume: intent?.resume !== false
    }),
    drive: intent => execute(COMMAND_IDS.MOVEMENT.DRIVE, {
      tokenUuid: intent?.tokenUuid ?? '',
      path: Array.isArray(intent?.path) ? intent.path.map(cell => ({ x: cell?.x, y: cell?.y })) : [],
      then: intent?.then ?? '',
      restoreStance: intent?.restoreStance === true
    }),
    cancel: tokenUuid => execute(COMMAND_IDS.MOVEMENT.CANCEL, { tokenUuid: tokenUuid ?? '' }),
    rollback: tokenUuid => execute(COMMAND_IDS.MOVEMENT.ROLLBACK, { tokenUuid: tokenUuid ?? '' }),
    toggleFlight: tokenUuid => execute(COMMAND_IDS.MOVEMENT.TOGGLE_FLIGHT, { tokenUuid: tokenUuid ?? '' }),
    takeOff: tokenUuid => execute(COMMAND_IDS.MOVEMENT.TAKE_OFF, { tokenUuid: tokenUuid ?? '' }),
    setFlight: intent => execute(COMMAND_IDS.MOVEMENT.SET_FLIGHT, {
      tokenUuid: intent?.tokenUuid ?? '',
      grounded: intent?.grounded === true
    }),
    teleport: tokenUuid => execute(COMMAND_IDS.MOVEMENT.TELEPORT, { tokenUuid: tokenUuid ?? '' }),
    cross: intent => execute(COMMAND_IDS.MOVEMENT.CROSS, {
      tokenUuid: intent?.tokenUuid ?? '',
      destinationX: intent?.destinationX,
      destinationY: intent?.destinationY
    }),
  });
}

/**
 * Expose the two table-management commands the `/release` and `/unstuck` chat commands run, and the GM Macros
 * compendium reaches from the console. Each returns its command result, whose notice shows as for any command.
 */
function recoveryApi(execute) {
  return Object.freeze({
    clearLock: (intent = {}) => execute(COMMAND_IDS.RECOVERY.CLEAR_LOCK, {
      announcement: String(intent?.announcement ?? '')
    }),
    clearBusy: (intent = {}) => execute(COMMAND_IDS.RECOVERY.CLEAR_BUSY, { force: intent?.force === true })
  });
}

function combatApi({ execute, combatCinematicEnabled, gradeThreat }) {
  return Object.freeze({
    /**
     * Grade one matchup the way `game/combat/threat.mjs` does for the system's own threat overlay, so Enemy AI
     * scores a candidate attack against the same rule rather than its own copy.
     * @param {{matchup: object, targetHp: number, allowLethal?: boolean}} intent The projected matchup and target.
     * @returns {Readonly<{tier: string, damageOnHit: number}>}
     */
    gradeThreat: intent => gradeThreat({
      matchup: intent?.matchup ?? null,
      targetHp: Number(intent?.targetHp) || 0,
      allowLethal: intent?.allowLethal === true
    }),
    threatTiers: THREAT_TIERS,
    /** Lowercase status keys that leave a unit no attack on its turn, so its reach threatens nobody. */
    incapacitatingStatuses: INCAPACITATING_STATUSES,
    /** The largest floor difference an adjacent attack can cross and still count as melee. */
    meleeElevationReach: MELEE_ELEVATION_REACH,
    resolveExchange: intent => execute(COMMAND_IDS.COMBAT.RESOLVE_EXCHANGE, {
      sourceTokenUuid: intent?.sourceTokenUuid ?? '',
      targetTokenUuid: intent?.targetTokenUuid ?? '',
      itemUuid: intent?.itemUuid ?? '',
      damageType: intent?.damageType ?? '',
      skippedAttacks: intent?.skippedAttacks ?? [],
      previewFingerprint: intent?.previewFingerprint ?? '',
      weaponArtUuid: intent?.weaponArtUuid ?? '',
      cinematic: combatCinematicEnabled() !== false
    }),
    resolveContinuation: intent => execute(COMMAND_IDS.COMBAT.RESOLVE_CONTINUATION, {
      sourceTokenUuid: intent?.sourceTokenUuid ?? '',
      exchangeRequestId: intent?.exchangeRequestId ?? '',
      decision: intent?.decision ?? ''
    }),
    applyDamage: intent => execute(COMMAND_IDS.COMBAT.APPLY_DAMAGE, {
      actorUuid: intent?.actorUuid ?? '',
      tokenUuid: intent?.tokenUuid ?? '',
      amount: intent?.amount ?? null,
      damageType: intent?.damageType ?? 'slashing',
      stanceAmount: intent?.stanceDamage ?? intent?.stanceAmount ?? 0
    }),
    applyHealing: intent => execute(COMMAND_IDS.COMBAT.APPLY_HEALING, {
      actorUuid: intent?.actorUuid ?? '',
      tokenUuid: intent?.tokenUuid ?? '',
      amount: intent?.amount ?? null,
      stanceAmount: intent?.stanceHealing ?? intent?.stanceAmount ?? 0
    }),
  });
}

/* -------------------------------------------- */
/*  Authoring and party domains                 */
/* -------------------------------------------- */
function itemApi({ itemAuthoring, authority, execute, itemCinematicEnabled }) {
  return Object.freeze({
    activate: intent => execute(COMMAND_IDS.ITEMS.ACTIVATE, {
      sourceTokenUuid: intent?.sourceTokenUuid ?? '',
      itemUuid: intent?.itemUuid ?? '',
      targetTokenUuids: intent?.targetTokenUuids ?? [],
      aim: intent?.aim ?? null,
      placement: intent?.placement ?? null,
      params: intent?.params ?? {},
      cinematic: intent?.cinematic !== false && itemCinematicEnabled(intent?.cinematicCategory)
    }),
    retract: tokenUuid => execute(COMMAND_IDS.ITEMS.RETRACT, { tokenUuid: tokenUuid ?? '' }),
    authoring: Object.freeze({
      copyAsStaff: itemUuid => itemAuthoring.copyAsStaff(authority(), itemUuid),
      getTerrainPresets: () => itemAuthoring.terrainPresets()
    })
  });
}

function encounterApi({ execute, currentSceneUuid, drivenBoard, authority, measurement }) {
  const intentFor = sceneUuid => ({ sceneUuid: sceneUuid ?? currentSceneUuid() });
  return Object.freeze({
    /** The two phase names, `{PLAYER: 'Player', ENEMY: 'Enemy'}`, as an encounter's state reports them. */
    phases: ENCOUNTER_PHASES,
    spawnBehaviors: SPAWN_BEHAVIOR_VOCABULARY,
    driven: drivenBoardApi({ drivenBoard, authority }),
    create: sceneUuid => execute(COMMAND_IDS.ENCOUNTERS.CREATE, intentFor(sceneUuid)),
    begin: sceneUuid => execute(COMMAND_IDS.ENCOUNTERS.BEGIN, intentFor(sceneUuid)),
    advancePhase: intent => execute(
      COMMAND_IDS.ENCOUNTERS.ADVANCE_PHASE, advanceIntentFor(intent, intentFor, measurement)
    ),
    end: (sceneUuid, outcome = 'none') =>
      execute(COMMAND_IDS.ENCOUNTERS.END, { ...intentFor(sceneUuid), outcome }),
    cancel: sceneUuid => execute(COMMAND_IDS.ENCOUNTERS.CANCEL, intentFor(sceneUuid)),
    pause: sceneUuid => execute(COMMAND_IDS.ENCOUNTERS.PAUSE, intentFor(sceneUuid)),
    resume: sceneUuid => execute(COMMAND_IDS.ENCOUNTERS.RESUME, intentFor(sceneUuid)),
    discardPause: sceneUuid => execute(COMMAND_IDS.ENCOUNTERS.DISCARD_PAUSE, intentFor(sceneUuid)),
    setAutoAdvance: (sceneUuid, enabled) =>
      execute(COMMAND_IDS.ENCOUNTERS.SET_AUTO_ADVANCE, { ...intentFor(sceneUuid), enabled }),
    setCombatMusic: (sceneUuid, enabled) =>
      execute(COMMAND_IDS.ENCOUNTERS.SET_COMBAT_MUSIC, { ...intentFor(sceneUuid), enabled }),
    setExploration: (sceneUuid, enabled) =>
      execute(COMMAND_IDS.ENCOUNTERS.SET_EXPLORATION, { ...intentFor(sceneUuid), enabled }),
    setRound: (sceneUuid, round) =>
      execute(COMMAND_IDS.ENCOUNTERS.SET_ROUND, { ...intentFor(sceneUuid), round }),
    setObjectives: intent => execute(COMMAND_IDS.ENCOUNTERS.OBJECTIVES.AUTHOR, {
      ...intent,
      sceneUuid: intent?.sceneUuid ?? currentSceneUuid()
    }),
    endTurn: intent => execute(COMMAND_IDS.ENCOUNTERS.END_TURN, {
      tokenUuid: intent?.tokenUuid ?? '',
      restoreStance: intent?.restoreStance === true
    })
  });
}

/**
 * Attach the encounter, phase and round expected by the engine's Advance Phase command.
 * The engine can then reject a stale request rather than advance twice. If none are supplied,
 * read the encounter currently shown through api/measurement.mjs.
 */
function advanceIntentFor(intent, intentFor, measurement) {
  const named = intent !== null && typeof intent === 'object';
  const { sceneUuid } = intentFor(named ? intent.sceneUuid : intent);
  const expected = named && intent.expected
    ? boundedExpectation(intent.expected)
    : shownEncounter(measurement, sceneUuid);
  return expected ? { sceneUuid, expected } : { sceneUuid };
}

/** Read the displayed encounter identity through api/measurement.mjs for advanceIntentFor. */
function shownEncounter(measurement, sceneUuid) {
  const state = measurement.encounters.getState(sceneUuid);
  const combatId = String(state?.combatUuid ?? '').split('.').pop();
  if (state?.started !== true || !state.phase || !combatId) return null;
  return boundedExpectation({ combatId, phase: state.phase, round: state.round });
}

function boundedExpectation(expected) {
  return {
    combatId: String(expected?.combatId ?? ''),
    phase: String(expected?.phase ?? ''),
    round: Number(expected?.round)
  };
}

/**
 * Lets a module such as the Enemy AI mark the map as busy during its phase; other clients show a banner. Only a
 * full Gamemaster may take or release it.
 */
function drivenBoardApi({ drivenBoard, authority }) {
  const gamemaster = () => authority().level === AUTHORITY_LEVELS.GAMEMASTER;
  return Object.freeze({
    hold: async intent => (gamemaster() ? drivenBoard.hold(intent) : null),
    release: async () => (gamemaster() ? drivenBoard.release() : false),
    current: () => drivenBoard.current()
  });
}

/** Preview a locked Object's lock and try to open it. */
function objectApi({ objectQueries, execute }) {
  return Object.freeze({
    inspectLock: intent => objectQueries.inspectLock(intent),
    openLock: intent => execute(COMMAND_IDS.OBJECTS.OPEN_LOCK, {
      sourceTokenUuid: String(intent?.sourceTokenUuid ?? ''),
      lockTokenUuid: String(intent?.lockTokenUuid ?? ''),
      method: String(intent?.method ?? '')
    }),
    wieldArmament: intent => execute(COMMAND_IDS.OBJECTS.WIELD_ARMAMENT, {
      sourceTokenUuid: String(intent?.sourceTokenUuid ?? ''),
      armamentTokenUuid: String(intent?.armamentTokenUuid ?? '')
    }),
    releaseArmament: intent => execute(COMMAND_IDS.OBJECTS.RELEASE_ARMAMENT, {
      sourceTokenUuid: String(intent?.sourceTokenUuid ?? ''),
      restore: intent?.restore !== false
    }),
    dropItem: intent => execute(COMMAND_IDS.OBJECTS.DROP_ITEM, {
      ...(intent?.sourceActorUuid
        ? { sourceActorUuid: String(intent.sourceActorUuid) }
        : { sourceTokenUuid: String(intent?.sourceTokenUuid ?? '') }),
      itemId: String(intent?.itemId ?? ''),
      action: String(intent?.action ?? '')
    })
  });
}

function downtimeApi({ downtimeQueries, execute, currentSceneUuid }) {
  return Object.freeze({
    inspectGathering: intent => downtimeQueries.inspectGathering(intent),
    inspectCrafting: intent => downtimeQueries.inspectCrafting(intent),
    gather: intent => execute(COMMAND_IDS.DOWNTIME.GATHER, {
      cursorTokenUuid: String(intent?.cursorTokenUuid ?? ''),
      stationTokenUuid: String(intent?.stationTokenUuid ?? ''),
      performerUuid: String(intent?.performerUuid ?? ''),
      destination: String(intent?.destination ?? GATHER_DESTINATIONS.CONVOY)
    }),
    forge: intent => execute(COMMAND_IDS.DOWNTIME.FORGE, {
      cursorTokenUuid: String(intent?.cursorTokenUuid ?? ''),
      stationTokenUuid: String(intent?.stationTokenUuid ?? ''),
      performerUuid: String(intent?.performerUuid ?? ''),
      itemUuid: String(intent?.itemUuid ?? '')
    }),
    brew: intent => execute(COMMAND_IDS.DOWNTIME.BREW, {
      cursorTokenUuid: String(intent?.cursorTokenUuid ?? ''),
      stationTokenUuid: String(intent?.stationTokenUuid ?? ''),
      performerUuid: String(intent?.performerUuid ?? ''),
      recipeUuid: String(intent?.recipeUuid ?? '')
    }),
    inspectCooking: intent => downtimeQueries.inspectCooking(intent),
    cook: intent => execute(COMMAND_IDS.DOWNTIME.COOK, {
      cursorTokenUuid: String(intent?.cursorTokenUuid ?? ''),
      stationTokenUuid: String(intent?.stationTokenUuid ?? ''),
      performerUuid: String(intent?.performerUuid ?? ''),
      recipeId: String(intent?.recipeId ?? ''),
      specialName: String(intent?.specialName ?? ''),
      dinerUuids: Array.isArray(intent?.dinerUuids) ? intent.dinerUuids.map(String) : []
    }),
    inspectRecipeLibrary: () => downtimeQueries.inspectRecipeLibrary(),
    saveRecipeLibrary: intent => execute(COMMAND_IDS.DOWNTIME.SAVE_RECIPE_LIBRARY, {
      recipes: Array.isArray(intent?.recipes) ? intent.recipes : []
    }),
    inspectPerformance: intent => downtimeQueries.inspectPerformance(intent),
    perform: intent => execute(COMMAND_IDS.DOWNTIME.PERFORM, {
      cursorTokenUuid: String(intent?.cursorTokenUuid ?? ''),
      stationTokenUuid: String(intent?.stationTokenUuid ?? ''),
      performerUuid: String(intent?.performerUuid ?? ''),
      songId: String(intent?.songId ?? ''),
      accompanimentUuids: Array.isArray(intent?.accompanimentUuids) ? intent.accompanimentUuids.map(String) : []
    }),
    inspectRequisition: intent => downtimeQueries.inspectRequisition(intent),
    requisition: intent => execute(COMMAND_IDS.DOWNTIME.REQUISITION, {
      cursorTokenUuid: String(intent?.cursorTokenUuid ?? ''),
      stationTokenUuid: String(intent?.stationTokenUuid ?? ''),
      performerUuid: String(intent?.performerUuid ?? ''),
      factionId: String(intent?.factionId ?? ''),
      kind: String(intent?.kind ?? ''),
      demand: Number(intent?.demand ?? 0)
    }),
    inspectSocial: intent => downtimeQueries.inspectSocial(intent),
    socialize: intent => execute(COMMAND_IDS.DOWNTIME.SOCIALIZE, {
      cursorTokenUuid: String(intent?.cursorTokenUuid ?? ''),
      partnerTokenUuid: String(intent?.partnerTokenUuid ?? '')
    }),
    train: intent => execute(COMMAND_IDS.DOWNTIME.TRAIN, {
      cursorTokenUuid: String(intent?.cursorTokenUuid ?? ''),
      partnerTokenUuid: String(intent?.partnerTokenUuid ?? ''),
      proficiencyKey: String(intent?.proficiencyKey ?? '')
    }),
    inspectSongLibrary: () => downtimeQueries.inspectSongLibrary(),
    saveSongLibrary: intent => execute(COMMAND_IDS.DOWNTIME.SAVE_SONG_LIBRARY, {
      songs: Array.isArray(intent?.songs) ? intent.songs : [],
      removed: Array.isArray(intent?.removed) ? intent.removed.map(String) : []
    }),
    resetActivity: intent => execute(COMMAND_IDS.DOWNTIME.RESET_ACTIVITY, {
      actorUuid: String(intent?.actorUuid ?? '')
    }),
    restoreEnergy: intent => execute(COMMAND_IDS.DOWNTIME.RESTORE_ENERGY, {
      actorUuid: String(intent?.actorUuid ?? ''),
      amount: Math.floor(Number(intent?.amount)) || 0
    }),
    resetDowntime: intent => execute(COMMAND_IDS.DOWNTIME.RESET, {
      sceneUuid: String(intent?.sceneUuid || currentSceneUuid() || '')
    })
  });
}

function economyApi({ economyQueries, execute }) {
  const ids = value => (Array.isArray(value) ? value.map(String) : []);
  return Object.freeze({
    inspectTrade: intent => economyQueries.inspectTrade(intent),
    inspectShop: intent => economyQueries.inspectShop(intent),
    vendorPurchase: intent => execute(COMMAND_IDS.ECONOMY.VENDOR_PURCHASE, {
      buyerActorUuid: String(intent?.buyerActorUuid ?? ''),
      buyerTokenUuid: String(intent?.buyerTokenUuid ?? ''),
      vendorUuid: String(intent?.vendorUuid ?? ''),
      vendorTokenUuid: String(intent?.vendorTokenUuid ?? ''),
      itemId: String(intent?.itemId ?? ''),
      destinationUuid: String(intent?.destinationUuid ?? ''),
      quantity: Number(intent?.quantity ?? 1)
    }),
    vendorSell: intent => execute(COMMAND_IDS.ECONOMY.VENDOR_SELL, {
      sellerActorUuid: String(intent?.sellerActorUuid ?? ''),
      buyerTokenUuid: String(intent?.buyerTokenUuid ?? ''),
      vendorUuid: String(intent?.vendorUuid ?? ''),
      vendorTokenUuid: String(intent?.vendorTokenUuid ?? ''),
      itemId: String(intent?.itemId ?? ''),
      sourceUuid: String(intent?.sourceUuid ?? ''),
      quantity: Number(intent?.quantity ?? 1)
    }),
    vendorCheckout: intent => execute(COMMAND_IDS.ECONOMY.VENDOR_CHECKOUT, {
      mode: String(intent?.mode ?? ''),
      buyerActorUuid: String(intent?.buyerActorUuid ?? ''),
      buyerTokenUuid: String(intent?.buyerTokenUuid ?? ''),
      vendorUuid: String(intent?.vendorUuid ?? ''),
      vendorTokenUuid: String(intent?.vendorTokenUuid ?? ''),
      holdingUuid: String(intent?.holdingUuid ?? ''),
      lines: (Array.isArray(intent?.lines) ? intent.lines : []).map(line => ({
        itemId: String(line?.itemId ?? ''), quantity: Number(line?.quantity ?? 1)
      }))
    }),
    haggle: intent => execute(COMMAND_IDS.ECONOMY.HAGGLE, {
      buyerActorUuid: String(intent?.buyerActorUuid ?? ''),
      buyerTokenUuid: String(intent?.buyerTokenUuid ?? ''),
      vendorUuid: String(intent?.vendorUuid ?? ''),
      vendorTokenUuid: String(intent?.vendorTokenUuid ?? '')
    }),
    vendorMerchandise: intent => execute(COMMAND_IDS.ECONOMY.VENDOR_MERCHANDISE, {
      vendorUuid: String(intent?.vendorUuid ?? ''),
      changes: { ...(intent?.changes ?? {}) }
    }),
    inspectConvoys: actorUuid => economyQueries.inspectConvoys(actorUuid),
    convoyDeposit: intent => execute(COMMAND_IDS.ECONOMY.CONVOY_DEPOSIT, {
      sourceActorUuid: String(intent?.sourceActorUuid ?? ''),
      itemId: String(intent?.itemId ?? ''),
      convoyUuid: String(intent?.convoyUuid ?? ''),
      ...(intent?.amount === undefined || intent?.amount === null ? {} : { amount: Number(intent.amount) })
    }),
    convoyDeliver: intent => execute(COMMAND_IDS.ECONOMY.CONVOY_DELIVER, {
      convoyUuid: String(intent?.convoyUuid ?? ''),
      itemIds: ids(intent?.itemIds),
      gold: intent?.gold === true,
      all: intent?.all === true
    }),
    convoyWithdraw: intent => execute(COMMAND_IDS.ECONOMY.CONVOY_WITHDRAW, {
      targetActorUuid: String(intent?.targetActorUuid ?? ''),
      convoyUuid: String(intent?.convoyUuid ?? ''),
      amount: Number(intent?.amount)
    }),
    vendorStock: intent => execute(COMMAND_IDS.ECONOMY.VENDOR_STOCK, {
      sourceActorUuid: String(intent?.sourceActorUuid ?? ''),
      itemId: String(intent?.itemId ?? ''),
      vendorUuid: String(intent?.vendorUuid ?? ''),
      ...(intent?.amount === undefined || intent?.amount === null ? {} : { amount: Number(intent.amount) })
    }),
    trade: intent => execute(COMMAND_IDS.ECONOMY.TRADE, {
      sourceTokenUuid: String(intent?.sourceTokenUuid ?? ''),
      targetTokenUuid: String(intent?.targetTokenUuid ?? ''),
      giveItemIds: ids(intent?.giveItemIds),
      takeItemIds: ids(intent?.takeItemIds)
    }),
    steal: intent => execute(COMMAND_IDS.ECONOMY.STEAL, {
      sourceTokenUuid: String(intent?.sourceTokenUuid ?? ''),
      targetTokenUuid: String(intent?.targetTokenUuid ?? ''),
      itemIds: ids(intent?.itemIds)
    })
  });
}

function partyApi({ partyService, authority }) {
  const getState = () => partyService.snapshot(authority());
  const getActorCandidate = actorUuid => partyService.actorCandidate(authority(), actorUuid);
  return Object.freeze({
    getState,
    getActorCandidate,
    saveState: state => partyService.saveState(authority(), state),
    grantOwnership: (userId, actorUuid) => partyService.grantOwnership(authority(), userId, actorUuid),
    assignUnit: intent => partyService.assignUnit(authority(), intent),
    removeUnit: (userId, actorUuid) => partyService.removeUnit(authority(), userId, actorUuid),
    assignConvoy: (partyId, actorUuid) => partyService.assignConvoy(authority(), partyId, actorUuid)
  });
}

/* -------------------------------------------- */
/*  Presentation and event domains              */
/* -------------------------------------------- */
function presentationApi({ audio, tokenArt, controlPanel, camera, threat }) {
  return Object.freeze({
    audio: Object.freeze({ play: (soundId, options) => audio.play(soundId, options) }),
    controlPanel: Object.freeze({
      /**
       * Open a Character's Actor Control Panel on this client, or bring it to the front.
       * @param {string} actorUuid The Character's UUID.
       * @returns {boolean} False when the actor isn't a Character or this user may not edit it.
       */
      open: actorUuid => controlPanel.open(String(actorUuid ?? ''))
    }),
    camera: Object.freeze({
      enemyPhase: (intent = {}) => {
        const message = enemyPhaseCameraMessage(intent);
        return isEnemyPhaseCameraMessage(message) ? camera.broadcast(message) : Promise.resolve(false);
      }
    }),
    threat: Object.freeze({
      /** The provider is called as `provider(tokenUuid, {signal})`. See ThreatIndicators.setIntentProvider. */
      registerIntentProvider: provider => threat.setIntentProvider(provider)
    }),
    tokenArt: Object.freeze({
      refresh: async (actorUuid, options = {}) => {
        const refreshed = await tokenArt.refreshActorArt(actorUuid, options);
        tokenArt.refreshAuthoringPanel(actorUuid);
        return refreshed;
      },
      refreshAuthoringPanel: actorUuid => tokenArt.refreshAuthoringPanel(actorUuid),
      faceTargets: (sourceTokenUuid, targetTokenUuid) =>
        tokenArt.faceTargets(sourceTokenUuid, targetTokenUuid)
    })
  });
}

/** Subscribe to committed events, and publish the event ids so a companion module need not restate them. */
function eventApiFor(events) {
  return Object.freeze({ types: EVENT_IDS, on: (type, handler) => events.subscribe(type, handler) });
}

/* -------------------------------------------- */
/*  Development                                 */
/* -------------------------------------------- */

/**
 * Build api.development, the GM Macros compendium's route to `engine/development.mjs`. A Scene-scoped call with no
 * Scene named uses the caller's current Scene. The host re-reads every unit in reach before it writes.
 * @param {object} ports CommandGateway's execute and the caller's current Scene UUID.
 * @returns {Readonly<object>} `api.development`.
 */
function developmentApi({ execute, currentSceneUuid }) {
  const scoped = (intent = {}) => {
    const scope = String(intent.scope ?? DEVELOPMENT_SCOPES.SCENE);
    return {
      scope,
      sceneUuid: String(intent.sceneUuid ?? (scope === DEVELOPMENT_SCOPES.SCENE ? currentSceneUuid() : '')),
      actorUuids: intent.actorUuids ?? []
    };
  };
  return Object.freeze({
    restoreUnits: (intent = {}) => execute(COMMAND_IDS.DEVELOPMENT.RESTORE_UNITS, {
      ...scoped(intent), excludeRoles: intent.excludeRoles ?? []
    }),
    repairItems: (intent = {}) => execute(COMMAND_IDS.DEVELOPMENT.REPAIR_ITEMS, scoped(intent)),
    clearTerrainEffects: (intent = {}) => execute(COMMAND_IDS.DEVELOPMENT.CLEAR_TERRAIN_EFFECTS, {
      sceneUuid: String(intent.sceneUuid ?? currentSceneUuid())
    })
  });
}
