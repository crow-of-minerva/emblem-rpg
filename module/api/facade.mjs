/** @layer api */
import { COMMAND_IDS, COMMAND_LANES, commandFrozenByPause, commandLane } from '../contracts/commands.mjs';
import { AUTHORITY_LEVELS, HOST_STATES, requirePorts } from '../contracts/protocol.mjs';
import { RESULT_CODES, refuse } from '../contracts/results.mjs';
import { EVENT_IDS } from '../contracts/events.mjs';
import { DEVELOPMENT_SCOPES } from '../contracts/domains/development.mjs';
import { GATHER_DESTINATIONS } from '../contracts/domains/downtime.mjs';
import {
  THREAT_TIERS, enemyPhaseCameraMessage, isEnemyPhaseCameraMessage
} from '../contracts/domains/combat.mjs';
import { MAX_TOKEN_ART_TABS, TOKEN_ART_SLOTS, TOKEN_CONDITIONS } from '../contracts/domains/tokens.mjs';

/** Published as `api.version`. Enemy AI's system bridge won't run against a lower version. */
const API_VERSION = 1;

/** Token-art slots, conditions and the class tab limit, published as `api.character.art` for Studio. */
const TOKEN_ART_VOCABULARY = Object.freeze({
  slots: TOKEN_ART_SLOTS, conditions: TOKEN_CONDITIONS, maxClassTabs: MAX_TOKEN_ART_TABS
});

/* -------------------------------------------- */
/*  Public facade                               */
/* -------------------------------------------- */
/**
 * Build game.emblemRpg.api. init/system.mjs calls this once with every port. Gameplay commands go through
 * CommandGateway, and each result is shown through the notification service before it's returned. Read and
 * presentation services are exposed without their repositories.
 */
export function createPublicFacade({
  gateway, executionSegments, processing, promotions, objectQueries, economyQueries, downtimeQueries, movements,
  itemAuthoring, partyService, authority, events, audio, tokenArt, presentationCamera, threatIndicators, drivenBoard,
  measurement, notifications, gradeThreat, combatCinematicEnabled, itemCinematicEnabled, currentSceneUuid, tableFrozen
}) {
  requirePorts('createPublicFacade', { gateway, executionSegments, processing, promotions, objectQueries,
    economyQueries, downtimeQueries, movements, itemAuthoring, partyService, authority, events, audio, tokenArt,
    presentationCamera, threatIndicators, drivenBoard, measurement, notifications, gradeThreat,
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
  /** Bind the same domain methods to CommandGateway or a CommandDispatcher execution segment. */
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
    audio, tokenArt, camera: presentationCamera, threat: threatIndicators
  });
  const recovery = recoveryApi(execute);
  const eventApi = eventApiFor(events);
  const development = developmentApi({ execute, currentSceneUuid });

  const measured = withMeasurement({ character, combat, encounters, measurement });
  const api = Object.freeze({
    version: API_VERSION,
    character: measured.character,
    movement,
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
 * Build api.protocol around CommandGateway status queries and CommandDispatcher execution segments.
 * @param {object} ports The facade's gateway, processing view, execution segments, notices, measurement and the
 *   gameplay domains a segment binds.
 * @returns {Readonly<object>} `api.protocol`.
 */
function protocolApi({ gateway, processing, executionSegments, notifications, measurement, gameplayDomains }) {
  return Object.freeze({
    /** The result codes and host states companion modules branch on, so they need not copy the vocabulary. */
    resultCodes: RESULT_CODES,
    hostStates: HOST_STATES,
    host: () => gateway.host(),
    status: () => gateway.status(),
    execution: () => processing.snapshot(),
    requestStatus: intent => gateway.requestStatus(String(intent?.requestId ?? '')),
    /**
     * Ask the open execution segment to stop, through CommandGateway.requestSegmentStop. Only a GM or Assistant
     * may ask. The driver stops at its next safe point, and an action already running finishes first.
     * @returns {Promise<{ok: boolean, code: string, data: object}>} `command.segment-stop-requested`, a refusal such
     *   as `command.segment-not-open` or `shared.gm-required`, or `command.outcome-unknown` past the status deadline.
     */
    requestSegmentStop: () => gateway.requestSegmentStop(),
    /**
     * Pause a host-local driver such as Enemy AI on the pacing clock from init/system.mjs, which keeps time even
     * in a hidden tab.
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
 * Open a CommandDispatcher execution segment for a host-local driver such as Enemy AI, and return domain methods
 * bound to it in data.segment.api. A refusal to open shows no notice, but each action's result is shown as usual.
 * The driver checks stopRequested between actions and closes the handle when it's done.
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
  const api = Object.freeze({ ...domains, character: measured.character, combat: measured.combat,
    encounters: measured.encounters });
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

/** Pause on the pacing clock init/system.mjs hands the execution segments, which a hidden page cannot slow. */
function paceOn(executionSegments, milliseconds) {
  return executionSegments.wait(Math.max(0, Number(milliseconds) || 0));
}

/**
 * Merge api/measurement.mjs reads into character, combat and encounters, and return its terrain and board
 * namespaces separately. createPublicFacade adds those namespaces to the API, but a segment's api from
 * openSegment leaves them out.
 * @param {object} input The built domains plus the measurement API.
 * @returns {{character: object, combat: object, encounters: object, namespaces: object}}
 */
function withMeasurement({ character, combat, encounters, measurement }) {
  return {
    character: Object.freeze({ ...character, factions: measurement.factions }),
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
    getPlan: tokenUuid => movements.getSnapshot(tokenUuid),
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
    authoring: Object.freeze({
      copyAsStaff: itemUuid => itemAuthoring.copyAsStaff(authority(), itemUuid),
      getTerrainPresets: () => itemAuthoring.terrainPresets()
    })
  });
}

function encounterApi({ execute, currentSceneUuid, drivenBoard, authority, measurement }) {
  const intentFor = sceneUuid => ({ sceneUuid: sceneUuid ?? currentSceneUuid() });
  return Object.freeze({
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
 * The board hold a driving module such as Enemy AI takes for its phase, which other clients show as a banner.
 * Only a full Gamemaster may take or release it.
 */
function drivenBoardApi({ drivenBoard, authority }) {
  const gamemaster = () => authority().level === AUTHORITY_LEVELS.GAMEMASTER;
  return Object.freeze({
    hold: async intent => (gamemaster() ? drivenBoard.hold(intent) : null),
    release: async () => (gamemaster() ? drivenBoard.release() : false),
    current: () => drivenBoard.current()
  });
}

/** Expose object projections and host commands for lock previews and attempts. */
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
function presentationApi({ audio, tokenArt, camera, threat }) {
  return Object.freeze({
    audio: Object.freeze({ play: (soundId, options) => audio.play(soundId, options) }),
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
