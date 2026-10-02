/** @layer contracts/domains */
import { FACTION_GROUPS } from './characters.mjs';
import { DAMAGE_TYPES, UNTYPED_DAMAGE_TYPE } from './damage.mjs';
import { boundedText, exactKeys, plainRecord } from '../protocol.mjs';

/* -------------------------------------------- */
/*  Persisted vocabulary                        */
/* -------------------------------------------- */

/**
 * The world's hit-chance setting. Karmic rerolls in a side's favour after bad luck and against it after good luck.
 * True RNG rolls one d20. Two Random Numbers averages two d20s, so middling results come up more often.
 */
export const HIT_CHANCE_MODELS = Object.freeze({
  KARMIC: 'karmic',
  TRUE_RANDOM: 'trueRng',
  TWO_RANDOM_NUMBERS: 'twoRn'
});

/**
 * Flyer targeting modes. Aerial keeps adjacency-only weapons from hitting airborne units. Classic lets them hit
 * within melee elevation reach.
 */
export const FLYER_TARGETING_MODES = Object.freeze({
  AERIAL: 'aerial',
  CLASSIC: 'classic'
});

export const KARMA_LEDGER_RESOURCE_KEY = 'world:karma-ledger';

export const COMBAT_HIT_RESULTS = Object.freeze({
  HIT: 'hit',
  CRITICAL: 'crit',
  MISS: 'miss'
});

export const COMBAT_SIDES = Object.freeze({ ATTACKER: 'attacker', DEFENDER: 'defender' });

/** The largest floor difference an adjacent blow can cross and still be melee. */
export const MELEE_ELEVATION_REACH = 1;

/**
 * What the attacking unit does after an exchange: keep exploring, attack again, choose whether to take an Extra
 * Action, take it, canter, use its bonus action, keep moving, or end its turn.
 */
export const COMBAT_CONTINUATIONS = Object.freeze({
  EXPLORATION: 'exploration',
  MULTIATTACK: 'multiattack',
  EXTRA_ACTION_CHOICE: 'extra-action-choice',
  EXTRA_ACTION: 'extra-action',
  CANTER: 'canter',
  BONUS_ACTION: 'bonus-action',
  MOVEMENT: 'movement',
  END_TURN: 'end-turn'
});

/** How dangerous an incoming attack is, from a unit that cannot act at all up to one that would kill outright. */
export const THREAT_TIERS = Object.freeze({ INERT: 'inert', MINOR: 'minor', SEVERE: 'severe', LETHAL: 'lethal' });

/**
 * Statuses, in lowercase, that leave a unit no attack on its turn (Fear still lets it move), so its reach threatens
 * nobody. No system status produces `stun` or `stasis`.
 */
export const INCAPACITATING_STATUSES = Object.freeze(['stunned', 'stun', 'stasis', 'fear', 'frozen']);

/** Share of the target's current HP that an attack's expected damage on a hit must exceed to count as severe. */
export const THREAT_SEVERE_HP_FRACTION = 0.30;

export const ENCOUNTER_PHASES = Object.freeze({ PLAYER: 'Player', ENEMY: 'Enemy' });

export const ENCOUNTER_PHASE_FACTIONS = Object.freeze({
  Player: FACTION_GROUPS.player,
  Enemy: FACTION_GROUPS.enemy
});

/** The Token flags that record a Guard bond on the guarded unit: who guards it, and its draw order before the bond. */
export const GUARD_BOND_FLAGS = Object.freeze({ GUARDER: 'guardedByTokenUuid', ORIGINAL_SORT: 'guardedOriginalSort' });

/** The status both halves of a Guard bond wear, and which half each effect marks. */
export const GUARD_BOND_EFFECT_NAME = 'Guarded';
export const GUARD_BOND_ROLES = Object.freeze({ GUARDER: 'guarder', GUARDEE: 'guardee' });

/**
 * Guard-bond ending reasons shared by the combat rules and their notices. A bond an ending encounter
 * clears breaks without a notice, since the end banner already tells the table.
 */
export const GUARD_BOND_BREAKS = Object.freeze({
  LEFT: 'left', FELL: 'fell', PARTNER_MISSING: 'partner-missing', ENCOUNTER_ENDED: 'encounter-ended'
});

/** The Token flag an illusion carries: its caster's actor uuid. Enemy AI's planner treats a unit with it as a lure. */
export const ILLUSION_CASTER_FLAG = 'illusionCaster';

/**
 * The Token flag every effect summon carries: the actor uuid of the unit whose effect placed it. An ending
 * encounter removes the Tokens that carry it and leaves every Token without it, whatever that Token shows.
 */
export const SUMMONED_BY_FLAG = 'summonedBy';

/** The Token flags a timed summon carries: the phases it has left, and the phase whose end counts them down. */
export const SUMMON_REMAINING_FLAG = 'summonRemaining';
export const SUMMON_TICKS_ON_FLAG = 'summonTicksOn';

export const ENCOUNTER_PHASE_FLAG = 'combatPhase';
export const ENCOUNTER_ROUND_FLAG = 'emblemRound';

/** The Scene flag a paused encounter waits in, holding the round a later resume reopens it on. */
export const PAUSED_ENCOUNTER_FLAG = 'pausedEncounter';
export const PAUSED_ENCOUNTER_RECORD_VERSION = 2;

/** The Scene flags naming each phase's music, as a Playlist or PlaylistSound uuid. */
export const ENCOUNTER_TRACK_FLAGS = Object.freeze({
  Player: 'playerPhaseTrack',
  Enemy: 'enemyPhaseTrack'
});

/**
 * The effect flags a phase change counts down in engine/combat/encounters/phases.mjs: at the start of the bearer's
 * own phase, at the end of it, or at the end of every phase whoever's it is. The last one lets a status applied to
 * an enemy expire when the phase it was applied in ends, at its default duration of one.
 */
export const ENCOUNTER_DECAY_FLAGS = Object.freeze({
  PHASE_BEGIN: 'removeOnFactionPhase',
  PHASE_END: 'removeOnFactionPhaseEnd',
  ANY_PHASE_END: 'removeOnAnyPhaseEnd'
});

export const OBJECTIVE_TYPES = Object.freeze(['defeat', 'rout', 'survive', 'arrive', 'defend']);
export const ROUT_FACTIONS = Object.freeze(['Enemy', 'Boss']);

export const OBJECTIVE_FLAGS = Object.freeze({
  CONFIG: 'objectives',
  TARGETS: 'objectiveTargets',
  PROGRESS: 'objectiveProgress',
  END_PENDING: 'objectiveEndPending',
  PHASE_PENDING: 'phaseTransitionPending',
  AUTO_ADVANCE: 'autoAdvance',
  COMBAT_MUSIC: 'combatMusic'
});

export const EXPLORATION_FLAG = 'explorationMode';

export const OBJECTIVE_END_REASONS = Object.freeze({
  PROTECTED_DEFEAT: 'protected-defeat',
  DEFEAT_OR_ROUT_VICTORY: 'defeat-or-rout-victory',
  ARRIVAL_VICTORY: 'arrival-victory',
  DEFEND_DEFEAT: 'defend-defeat',
  DEADLINE_VICTORY: 'deadline-victory',
  DEADLINE_DEFEAT: 'deadline-defeat',
  DECLARED_VICTORY: 'declared-victory',
  DECLARED_DEFEAT: 'declared-defeat',
  DECLARED_STOP: 'declared-stop'
});

/** When a delayed encounter end is checked again before it happens: straight away, or at a player or enemy phase. */
export const OBJECTIVE_END_CHECKPOINTS = Object.freeze({
  IMMEDIATE: 'immediate',
  PLAYER: 'player-phase',
  ENEMY: 'enemy-phase'
});

/**
 * What prompted an objective check: something changed on the map, the host client catching up after a reload, a
 * unit's turn ending, or a phase ending.
 */
export const OBJECTIVE_CHECK_KINDS = Object.freeze({
  IMMEDIATE: 'immediate',
  RECONCILE: 'reconcile',
  TURN_END: 'turn-end',
  PHASE_END: 'phase-end'
});

export const OBJECTIVE_END_RECORD_VERSION = 1;

export const OBJECTIVE_END_OUTCOMES = Object.freeze({
  [OBJECTIVE_END_REASONS.PROTECTED_DEFEAT]: 'defeat',
  [OBJECTIVE_END_REASONS.DEFEAT_OR_ROUT_VICTORY]: 'victory',
  [OBJECTIVE_END_REASONS.ARRIVAL_VICTORY]: 'victory',
  [OBJECTIVE_END_REASONS.DEFEND_DEFEAT]: 'defeat',
  [OBJECTIVE_END_REASONS.DEADLINE_VICTORY]: 'victory',
  [OBJECTIVE_END_REASONS.DEADLINE_DEFEAT]: 'defeat',
  [OBJECTIVE_END_REASONS.DECLARED_VICTORY]: 'victory',
  [OBJECTIVE_END_REASONS.DECLARED_DEFEAT]: 'defeat',
  [OBJECTIVE_END_REASONS.DECLARED_STOP]: 'none'
});

/* -------------------------------------------- */
/*  Intents                                     */
/* -------------------------------------------- */

const EXCHANGE_INTENT_KEYS = Object.freeze([
  'sourceTokenUuid', 'targetTokenUuid', 'itemUuid', 'damageType', 'skippedAttacks',
  'previewFingerprint', 'weaponArtUuid', 'cinematic'
]);

/** Check an attack request and return a frozen copy, or null if it's malformed. */
export function normalizeCombatExchangeIntent(payload = {}) {
  if (!plainRecord(payload) || !exactKeys(payload, EXCHANGE_INTENT_KEYS)) return null;
  const sourceTokenUuid = String(payload.sourceTokenUuid ?? '');
  const targetTokenUuid = String(payload.targetTokenUuid ?? '');
  const itemUuid = String(payload.itemUuid ?? '');
  const damageType = String(payload.damageType ?? '');
  const previewFingerprint = String(payload.previewFingerprint ?? '');
  const weaponArtUuid = String(payload.weaponArtUuid ?? '');
  const cinematic = payload.cinematic !== false;
  const skippedAttacks = Array.isArray(payload.skippedAttacks)
    ? [...new Set(payload.skippedAttacks.map(String).filter(value => /^A\d+$/.test(value)))]
    : [];
  if (!sourceTokenUuid || !targetTokenUuid || sourceTokenUuid === targetTokenUuid || !itemUuid) return null;
  if (damageType && damageType !== UNTYPED_DAMAGE_TYPE && !DAMAGE_TYPES.includes(damageType)) return null;
  return Object.freeze({
    sourceTokenUuid,
    targetTokenUuid,
    itemUuid,
    damageType,
    skippedAttacks: Object.freeze(skippedAttacks),
    previewFingerprint,
    weaponArtUuid,
    cinematic
  });
}

/** Check the player's answer to the Extra Action offer the host made. */
export function normalizeCombatContinuationIntent(payload = {}) {
  const sourceTokenUuid = String(payload.sourceTokenUuid ?? '');
  const exchangeRequestId = String(payload.exchangeRequestId ?? '');
  const decision = String(payload.decision ?? '');
  if (!sourceTokenUuid || !exchangeRequestId || !['extra-action', 'end-turn'].includes(decision)) return null;
  return Object.freeze({ sourceTokenUuid, exchangeRequestId, decision });
}

/** Check an encounter request naming a Scene and return a frozen copy, or null if it's malformed. */
export function normalizeEncounterIntent(payload = {}) {
  const sceneUuid = String(payload?.sceneUuid ?? '');
  if (!sceneUuid.startsWith('Scene.') || sceneUuid.length > 512) return null;
  return Object.freeze({ sceneUuid });
}

/** Check a GM's declared encounter ending and return a frozen copy, or null if it's malformed. */
export function normalizeEncounterEndIntent(payload = {}) {
  const intent = normalizeEncounterIntent(payload);
  if (!intent) return null;
  const outcome = String(payload?.outcome ?? 'none');
  if (!['victory', 'defeat', 'none'].includes(outcome)) return null;
  return Object.freeze({ sceneUuid: intent.sceneUuid, outcome });
}

/** Check an on/off encounter switch and return a frozen copy, or null if it's malformed. */
export function normalizeEncounterToggleIntent(payload = {}) {
  const intent = normalizeEncounterIntent(payload);
  if (!intent) return null;
  return Object.freeze({ sceneUuid: intent.sceneUuid, enabled: payload?.enabled === true });
}

/** The highest round a GM can set a running encounter to. */
export const ENCOUNTER_ROUND_MAX = 999;

/** Check a GM's round correction, a whole number from 1 to ENCOUNTER_ROUND_MAX, and return a frozen copy or null. */
export function normalizeEncounterRoundIntent(payload = {}) {
  const intent = normalizeEncounterIntent(payload);
  const round = Number(payload?.round);
  if (!intent || !Number.isInteger(round) || round < 1 || round > ENCOUNTER_ROUND_MAX) return null;
  return Object.freeze({ sceneUuid: intent.sceneUuid, round });
}

/** Check one authored objective card and return a frozen copy, or null if its type is unknown. */
export function normalizeObjectiveCard(raw = {}) {
  const type = String(raw?.type ?? '');
  if (!OBJECTIVE_TYPES.includes(type)) return null;
  return Object.freeze({
    type,
    defeatTargets: boundedRefList(raw.defeatTargets),
    routCount: positiveIntegerOrNull(raw.routCount),
    routIncludeSpawns: raw.routIncludeSpawns !== false,
    surviveTurns: positiveInteger(raw.surviveTurns, 1),
    arriveUnits: boundedRefList(raw.arriveUnits),
    arriveAnyPlayerUnit: raw.arriveAnyPlayerUnit === true,
    defendTurns: positiveInteger(raw.defendTurns, 1)
  });
}

/** Check the GM's win and defeat conditions for one Scene and return a frozen copy, or null if malformed. */
export function normalizeObjectiveAuthoringIntent(payload = {}) {
  const sceneUuid = String(payload?.sceneUuid ?? '');
  if (!sceneUuid.startsWith('Scene.') || sceneUuid.length > 512) return null;
  const cards = Array.isArray(payload?.objectives) ? payload.objectives : [];
  if (cards.length > 24) return null;
  const objectives = cards.map(normalizeObjectiveCard).filter(Boolean);
  if (objectives.length !== cards.length) return null;
  const loss = payload?.loss && typeof payload.loss === 'object' ? payload.loss : {};
  return Object.freeze({
    sceneUuid,
    objectives: Object.freeze(objectives),
    roundLimit: positiveInteger(payload?.roundLimit, 0),
    loss: Object.freeze({
      anyLordDefeat: loss.anyLordDefeat === true,
      protectedUnits: boundedRefList(loss.protectedUnits)
    })
  });
}

/** Check an objective check request the system raised from a Foundry hook, and return a frozen copy or null. */
export function normalizeObjectiveCheckIntent(payload = {}) {
  const sceneUuid = String(payload?.sceneUuid ?? '');
  if (!sceneUuid.startsWith('Scene.') || sceneUuid.length > 512) return null;
  const kind = String(payload?.kind ?? OBJECTIVE_CHECK_KINDS.IMMEDIATE);
  if (!Object.values(OBJECTIVE_CHECK_KINDS).includes(kind)) return null;
  const phase = String(payload?.phase ?? '');
  const roundEnded = Number(payload?.roundEnded);
  return Object.freeze({
    sceneUuid,
    kind,
    phase: Object.values(ENCOUNTER_PHASES).includes(phase) ? phase : '',
    actorUuid: String(payload?.actorUuid ?? ''),
    defeatedTokenId: String(payload?.defeatedTokenId ?? ''),
    defeatedActorType: String(payload?.defeatedActorType ?? ''),
    roundEnded: Number.isSafeInteger(roundEnded) && roundEnded >= 0 ? roundEnded : null,
    ...(payload?.autoAdvance === false ? { autoAdvance: false } : {})
  });
}

/* -------------------------------------------- */
/*  Refusals and receipts                       */
/* -------------------------------------------- */

/** Guard-bond refusal codes shared by game/combat rules and presentation notices. */
export const GUARD_BOND_REFUSALS = Object.freeze({
  SELF: 'effect.guard-self',
  GUARDER_BONDED: 'effect.guard-guarder-bonded',
  GUARDED_BONDED: 'effect.guard-guarded-bonded',
  OFF_MAP: 'effect.guard-off-map',
  GROUNDED: 'effect.guard-grounded',
  SMALLER: 'effect.guard-smaller'
});

/** The code a Guard step returns when its bond record could not be written. */
export const GUARD_BOND_RECORD_FAILED = 'effect.guard-record-failed';

/* -------------------------------------------- */
/*  Timing                                      */
/* -------------------------------------------- */

/**
 * Pauses the host client takes during an attack exchange so the clients' animations keep up, in milliseconds:
 * before the first blow (shorter against an object), after a weapon art, after pre-combat effects, between blows
 * (longer when the other side strikes next, shorter against an object), after the last blow, before each XP award,
 * and after the closing card.
 */
export const COMBAT_EXCHANGE_TIMING = Object.freeze({
  characterLeadIn: 1000,
  objectLeadIn: 250,
  weaponArtFlourish: 300,
  preCombatTail: 250,
  sameSideBlow: 500,
  sideChangeBlow: 1000,
  objectBlow: 200,
  postSequence: 250,
  experienceLeadIn: 400,
  cinematicTail: 250
});

/** The movement action effects move Tokens with. Like a teleport it costs nothing, but it's seen crossing squares. */
export const EFFECT_MOVE_ACTION = 'charge';

/** How fast that crossing plays, in grid squares per second: twice Foundry's walking pace. */
export const EFFECT_MOVE_ANIMATION = Object.freeze({ movementSpeed: 12 });

/**
 * Defaults for api.board.awaitSettled: how long no command may run before it resolves, how often to check, and when
 * to give up.
 */
export const SETTLE_BARRIER_TIMING = Object.freeze({ stableMs: 400, pollMs: 200, timeoutMs: 120000 });

/** How often a queued encounter end is retried when its write or cleanup failed, and when it gives up. */
export const OBJECTIVE_END_RETRY = Object.freeze({ maxAttempts: 6, baseMs: 250, maxMs: 5000 });

/** Timings of the phase-opening presentation (banner, status ticks and camera pans), in milliseconds. */
export const ENCOUNTER_PHASE_TIMING = Object.freeze({
  bannerHold: 1700,
  tickUnitStagger: 600,
  tickEffectStagger: 400,
  cameraPan: 800,
  cameraSettle: 200,
  focusPan: 800
});

/** How long each enemy-phase camera beat takes on the client that receives it, in milliseconds. */
const ENEMY_PHASE_CAMERA_TIMING = Object.freeze({ begin: 600, focus: 500, end: 600 });

/* -------------------------------------------- */
/*  Presentation messages                       */
/* -------------------------------------------- */

export const COMBAT_PRESENTATION_KIND = 'combat-exchange';
export const EFFECT_OPERATION_PRESENTATION_KIND = 'effect-operation';
export const BANNER_PRESENTATION_KIND = 'encounter-banner';
export const PHASE_CAMERA_PRESENTATION_KIND = 'phase-camera';
export const ENEMY_PHASE_CAMERA_PRESENTATION_KIND = 'enemy-phase-camera';

export const ENEMY_PHASE_CAMERA_BEATS = Object.freeze({ BEGIN: 'begin', FOCUS: 'focus', END: 'end' });

export const COMBAT_PRESENTATION_BEATS = Object.freeze({
  START: 'start',
  WEAPON_ART: 'weapon-art',
  ATTACK: 'attack',
  IMPACT: 'impact',
  NOTICE: 'notice',
  RANK_UP: 'rank-up',
  END: 'end'
});

export const BANNER_VARIANTS = Object.freeze({
  PLAYER: 'player',
  ENEMY: 'enemy',
  GENERIC: 'generic',
  EXPLORATION: 'exploration',
  VICTORY: 'victory',
  DEFEAT: 'defeat'
});

/** The widest cluster, in squares on either axis, that one phase-opening pan frames. */
export const PHASE_CAMERA_GROUP_SPAN = 12;

/** Build the message every client plays for one moment of an attack exchange. */
export function combatPresentationMessage(beat, data = {}) {
  if (!Object.values(COMBAT_PRESENTATION_BEATS).includes(beat)) {
    throw new TypeError(`Unknown combat presentation beat: ${beat}`);
  }
  return Object.freeze({ kind: COMBAT_PRESENTATION_KIND, beat, ...structuredClone(data) });
}

/** Check an attack exchange message received over the socket: a known moment, under the size cap. */
export function isCombatPresentationMessage(value) {
  if (!plainRecord(value) || value.kind !== COMBAT_PRESENTATION_KIND) return false;
  if (!Object.values(COMBAT_PRESENTATION_BEATS).includes(value.beat)) return false;
  try { return JSON.stringify(value).length <= 200000; } catch { return false; }
}

/** Check a display-only effect step received over the socket, with the token details it plays on. */
export function isEffectPresentationMessage(value) {
  if (!plainRecord(value) || value.kind !== EFFECT_OPERATION_PRESENTATION_KIND) return false;
  if (!plainRecord(value.operation) || value.operation.channel !== 'presentation') return false;
  if (!plainRecord(value.runtime)) return false;
  try { return JSON.stringify(value).length <= 200000; } catch { return false; }
}

/** Build one full-screen encounter banner message. */
export function bannerPresentationMessage(variant, text) {
  return Object.freeze({
    kind: BANNER_PRESENTATION_KIND,
    variant: String(variant),
    text: String(text)
  });
}

/** Check a banner message received over the socket. */
export function isBannerPresentationMessage(value) {
  if (!plainRecord(value) || value.kind !== BANNER_PRESENTATION_KIND) return false;
  if (!Object.values(BANNER_VARIANTS).includes(value.variant)) return false;
  return boundedText(value.text, 64);
}

/** Serialize one camera beat: a pan over a group of tokens, or each client's own party focus. */
export function phaseCameraPresentationMessage({ tokenUuids = [], focus = false } = {}) {
  return Object.freeze({
    kind: PHASE_CAMERA_PRESENTATION_KIND,
    tokenUuids: Object.freeze(tokenUuids.map(String)),
    focus: focus === true,
    duration: ENCOUNTER_PHASE_TIMING.cameraPan
  });
}

/** Check a camera pan message received over the socket. */
export function isPhaseCameraPresentationMessage(value) {
  if (!plainRecord(value) || value.kind !== PHASE_CAMERA_PRESENTATION_KIND) return false;
  if (typeof value.focus !== 'boolean' || !Array.isArray(value.tokenUuids) || value.tokenUuids.length > 64) return false;
  if (!Number.isFinite(value.duration) || value.duration < 0 || value.duration > 10000) return false;
  return value.tokenUuids.every(uuid => boundedText(uuid, 512));
}

/** Serialize one enemy-phase camera beat, whose zoom every client applies to its own view. */
export function enemyPhaseCameraMessage({ beat, tokenUuid = '', duration = null } = {}) {
  const named = String(beat ?? '');
  return Object.freeze({
    kind: ENEMY_PHASE_CAMERA_PRESENTATION_KIND,
    beat: named,
    tokenUuid: String(tokenUuid ?? ''),
    duration: positiveInteger(duration, ENEMY_PHASE_CAMERA_TIMING[named] ?? ENEMY_PHASE_CAMERA_TIMING.begin)
  });
}

/** Check an enemy-phase camera message received over the socket. */
export function isEnemyPhaseCameraMessage(value) {
  if (!plainRecord(value) || value.kind !== ENEMY_PHASE_CAMERA_PRESENTATION_KIND) return false;
  if (!exactKeys(value, ENEMY_PHASE_CAMERA_KEYS)) return false;
  if (!Object.values(ENEMY_PHASE_CAMERA_BEATS).includes(value.beat)) return false;
  if (!Number.isFinite(value.duration) || value.duration < 0 || value.duration > 10000) return false;
  return value.tokenUuid === '' || boundedText(value.tokenUuid, 512);
}

const ENEMY_PHASE_CAMERA_KEYS = Object.freeze(['kind', 'beat', 'tokenUuid', 'duration']);

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

function boundedRefList(list) {
  const refs = (Array.isArray(list) ? list : [])
    .map(value => String(value ?? '').trim())
    .filter(value => value.length > 0 && value.length <= 256)
    .slice(0, 64);
  return Object.freeze(refs);
}

function positiveInteger(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function positiveIntegerOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : null;
}
