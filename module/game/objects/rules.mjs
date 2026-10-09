/** @layer game/objects */
import { DOWNTIME_STATION_ORDER } from '../../contracts/domains/downtime.mjs';
import {
  BRACKETED_OBJECT_TYPES, DROP_ACTIONS, EXPLORATION_ONLY_OBJECT_TYPES, LOCKABLE_OBJECT_TYPES, LOCK_METHODS,
  OBJECT_FIXTURE_TYPES
} from '../../contracts/domains/objects.mjs';
import { cellKeyOf } from '../../lib/core/geometry.mjs';
import { energyLaneBlock } from '../downtime/rules.mjs';
import { holdsProficiencyRank } from '../progression/rules.mjs';
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { RESULT_CODES } from '../../contracts/results.mjs';

/* -------------------------------------------- */
/*  Fixture vocabulary                          */
/* -------------------------------------------- */
const NAME_ONLY_FIXTURES = new Set(
  OBJECT_FIXTURE_TYPES.filter(type => type !== 'Chest' && type !== 'Armament')
);

/** Whether an Object subtype is a fixture that a player reads by name alone. */
export function objectIsNameOnlyFixture(objectType) {
  return NAME_ONLY_FIXTURES.has(String(objectType ?? ''));
}

/**
 * Whether an Object subtype is switched off ("bracketed") because its feature isn't finished.
 * `resolveInteractionTarget` skips it, and its sheet shows a notice in place of its authoring fields.
 * @param {string} objectType The Actor's `system.objectType`.
 * @returns {boolean}
 */
export function objectSubtypeBracketed(objectType) {
  return BRACKETED_OBJECT_TYPES.includes(String(objectType ?? ''));
}

/* -------------------------------------------- */
/*  Strike eligibility                          */
/* -------------------------------------------- */

/**
 * Target classes shared by attack, effect and terrain rules through resolveTargetKind.
 * Characters are units. Destructibles accept Integrity damage and automatically fail saves.
 * Other Objects, Vendors and Convoys are scenery reached only through their specific interaction.
 */
export const TARGET_KINDS = Object.freeze({ UNIT: 'unit', DESTRUCTIBLE: 'destructible', SCENERY: 'scenery' });

/**
 * Classify an Actor for targeting. A hidden fixture (fixtureHidden) is scenery, so a hidden Destructible can't be
 * struck.
 * @param {{documentType?: string, objectType?: string, hidden?: boolean}} facts The Actor's `type`, its
 *   `system.objectType`, and whether its Token is hidden.
 * @returns {string} One of `TARGET_KINDS`.
 */
export function resolveTargetKind({ documentType = '', objectType = '', hidden = false } = {}) {
  const type = String(documentType ?? '');
  if (type === 'Character') return TARGET_KINDS.UNIT;
  if (fixtureHidden({ documentType: type, hidden })) return TARGET_KINDS.SCENERY;
  if (type === 'Object' && String(objectType ?? '') === 'Destructible') return TARGET_KINDS.DESTRUCTIBLE;
  return TARGET_KINDS.SCENERY;
}

/* -------------------------------------------- */
/*  Hidden fixtures                             */
/* -------------------------------------------- */

/**
 * Whether a placed Actor is a fixture whose Token the GM has hidden. The rules treat it as absent until it is
 * revealed, for every user: nothing interacts with it, targets it, reaches it or counts it. Every Actor but a
 * Character is a fixture (an Object of any subtype, a Vendor or a Convoy). A hidden unit is not a fixture and keeps
 * its own rules. The one exception is fixtureHiddenFromMovement's.
 * @param {{documentType?: string, hidden?: boolean}} facts The Actor's `type`, and whether its Token is hidden.
 * @returns {boolean}
 */
export function fixtureHidden({ documentType = '', hidden = false } = {}) {
  const type = String(documentType ?? '');
  return hidden === true && type !== '' && type !== 'Character';
}

/**
 * Whether movement ignores a hidden fixture too. A hidden Destructible still blocks movement (pathfinding, move
 * validation and the Enemy AI's routes), so it is the one hidden fixture this leaves out.
 * @param {{documentType?: string, objectType?: string, hidden?: boolean}} facts
 * @returns {boolean}
 */
export function fixtureHiddenFromMovement(facts = {}) {
  if (!fixtureHidden(facts)) return false;
  return !(String(facts.documentType ?? '') === 'Object' && String(facts.objectType ?? '') === 'Destructible');
}

/* -------------------------------------------- */
/*  Lock rules                                  */
/* -------------------------------------------- */
/**
 * The lockpicking difficulty of a Chest or Door. A missing or non-numeric value falls back to 10, but null or an
 * empty string reads as 0, which makes the lock key-only.
 */
export function objectLockDifficulty(difficultyClass) {
  const difficulty = Number(difficultyClass);
  return Number.isFinite(difficulty) ? difficulty : 10;
}

/** Whether a lock can be picked at all, as opposed to opening only for its key. */
export function objectLockIsPickable(difficultyClass) {
  return objectLockDifficulty(difficultyClass) > 0;
}

/* -------------------------------------------- */
/*  Door sight rules                            */
/* -------------------------------------------- */

/** Whether a door blocks sight. A door with no lock state counts as locked. */
function doorBlocksSight(locked) {
  return locked !== false;
}

/**
 * The four wall segments boxing a door, for planDoorSightReconciliation. They block sight only, because
 * game/movement/pathfinding.mjs already decides movement through doors and movement walls would contradict it.
 * @param {object} footprint The door's pixel origin, its size in squares, and the grid size.
 * @returns {number[][]} One `[x0, y0, x1, y1]` coordinate array per segment.
 */
function planDoorSightWalls(footprint = {}) {
  const g = Number(footprint.gridSize);
  const x0 = Number(footprint.x);
  const y0 = Number(footprint.y);
  if (!(g > 0) || !Number.isFinite(x0) || !Number.isFinite(y0)) return [];
  const x1 = x0 + Math.max(1, Math.round(Number(footprint.width) || 1)) * g;
  const y1 = y0 + Math.max(1, Math.round(Number(footprint.height) || 1)) * g;
  return [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]];
}

/**
 * Plan the door-wall writes: a box for each locked door and none for an unlocked one. A box that still matches is
 * kept, a moved or resized one is rebuilt, and walls whose door is gone are removed.
 * @param {object} board The Scene's doors and its already-tagged walls, each with its coordinates.
 * @returns {{build: object[], removeTokenIds: string[], orphanWallIds: string[]}}
 */
export function planDoorSightReconciliation(board = {}) {
  const doors = Array.isArray(board.doors) ? board.doors : [];
  const tagged = Array.isArray(board.taggedWalls) ? board.taggedWalls : [];
  const walled = new Set([...(board.walledTokenIds ?? []), ...tagged.map(wall => wall.tokenId)].map(String));
  const known = new Set(doors.map(door => String(door.tokenId)));
  const build = [];
  const removeTokenIds = [];
  for (const door of doors) {
    const tokenId = String(door.tokenId);
    const wanted = doorBlocksSight(door.locked);
    const segments = planDoorSightWalls(door);
    if (!wanted) {
      if (walled.has(tokenId)) removeTokenIds.push(tokenId);
      continue;
    }
    if (!walled.has(tokenId)) build.push({ tokenId, segments });
    else if (!doorBoxStands(tagged.filter(wall => String(wall.tokenId) === tokenId), segments)) {
      removeTokenIds.push(tokenId);
      build.push({ tokenId, segments });
    }
  }
  const orphanWallIds = tagged
    .filter(wall => !known.has(String(wall.tokenId)))
    .map(wall => String(wall.wallId));
  return { build, removeTokenIds, orphanWallIds };
}

/** Whether a door's tagged walls are exactly the box its footprint plans, segment for segment. */
function doorBoxStands(walls, segments) {
  if (walls.length !== segments.length) return false;
  const standing = new Set(walls.map(wall => segmentKey(wall.c)));
  return standing.size === segments.length && segments.every(segment => standing.has(segmentKey(segment)));
}

function segmentKey(c) {
  return Array.isArray(c) && c.length === 4 ? c.map(Number).join(',') : '';
}

/* -------------------------------------------- */
/*  Interaction geometry                        */
/* -------------------------------------------- */

/** Whether two footprints share at least one square. */
function cellsOverlap(left = [], right = []) {
  const keys = new Set(left.map(cellKeyOf));
  return right.some(cell => keys.has(cellKeyOf(cell)));
}

/** The squares orthogonally next to a unit's footprint: the ring the interaction pick offers. */
export function interactionPickCells(unitCells = []) {
  const own = new Set(unitCells.map(cell => `${cell.x},${cell.y}`));
  const ring = new Map();
  for (const cell of unitCells) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const key = `${cell.x + dx},${cell.y + dy}`;
      if (!own.has(key) && !ring.has(key)) ring.set(key, { x: cell.x + dx, y: cell.y + dy });
    }
  }
  return [...ring.values()];
}

/** Whether two footprints touch, orthogonally or diagonally, or overlap. */
export function cellsAdjacent(left = [], right = []) {
  return left.some(mine => right.some(other => (
    Math.max(Math.abs(mine.x - other.x), Math.abs(mine.y - other.y)) <= 1
  )));
}

/**
 * The doors on a unit's interaction-pick ring, open ones included. Only a door the unit is known to see counts, so
 * unknown sight leaves it out, and a hidden door isn't there at all.
 */
export function doorsOnPickRing(unitCells = [], objects = [], doorVisible = () => true) {
  const ring = interactionPickCells(unitCells);
  return objects.filter(object => object.objectType === 'Door' && object.hidden !== true
    && cellsOverlap(ring, object.cells) && doorVisible(object) === true);
}

/**
 * Build the sight segment tested by doorSightBlocked from unit center to the nearest door face.
 * Stop one pixel short so the closed door's own wall cannot hide its near side.
 * @param {{unitCells: object[], doorCells: object[], gridSize: number}} input Footprints in cells, grid in pixels.
 * @returns {{origin: {x: number, y: number}, target: {x: number, y: number}}|null} Null when there is no line to test.
 */
export function doorSightLine({ unitCells = [], doorCells = [], gridSize = 0 } = {}) {
  const size = Number(gridSize) || 0;
  if (!unitCells.length || !doorCells.length || !(size > 0)) return null;
  const xs = cells => cells.map(cell => Number(cell.x) || 0);
  const ys = cells => cells.map(cell => Number(cell.y) || 0);
  const origin = {
    x: ((Math.min(...xs(unitCells)) + Math.max(...xs(unitCells)) + 1) / 2) * size,
    y: ((Math.min(...ys(unitCells)) + Math.max(...ys(unitCells)) + 1) / 2) * size
  };
  const nearest = {
    x: Math.min(Math.max(origin.x, Math.min(...xs(doorCells)) * size), (Math.max(...xs(doorCells)) + 1) * size),
    y: Math.min(Math.max(origin.y, Math.min(...ys(doorCells)) * size), (Math.max(...ys(doorCells)) + 1) * size)
  };
  const inset = 1;
  const dx = origin.x - nearest.x;
  const dy = origin.y - nearest.y;
  const length = Math.hypot(dx, dy);
  if (length <= inset) return null;
  return { origin, target: { x: nearest.x + (dx / length) * inset, y: nearest.y + (dy / length) * inset } };
}

/**
 * Whether any of the Scene's wall segments crosses doorSightLine's ray. Collinear walls do not cross the ray. A
 * missing ray counts as blocked, so unknown sight never grants access.
 * @param {{line: object, walls: number[][]}} input The sight line, and wall segments as `[x0, y0, x1, y1]`.
 * @returns {boolean}
 */
export function doorSightBlocked({ line = null, walls = [] } = {}) {
  if (!Number.isFinite(line?.origin?.x) || !Number.isFinite(line?.target?.x)) return true;
  return walls.some(wall => segmentsCross(line.origin, line.target,
    { x: wall[0], y: wall[1] }, { x: wall[2], y: wall[3] }));
}

/** Whether two segments cross. Touching at an end point counts; collinear segments do not. */
function segmentsCross(a, b, c, d) {
  const side = (p, q, r) => Math.sign(((q.x - p.x) * (r.y - p.y)) - ((q.y - p.y) * (r.x - p.x)));
  const first = side(a, b, c);
  const second = side(a, b, d);
  if (first === 0 && second === 0) return false;
  return first !== second && side(c, d, a) !== side(c, d, b);
}

/* -------------------------------------------- */
/*  Interaction target                          */
/* -------------------------------------------- */

/**
 * Choose what Interact offers. Hidden fixtures and switched-off subtypes are dropped first, and so are the
 * exploration-only subtypes outside free exploration, so a unit standing on one finds nothing.
 * Check Armament outside exploration, then station, loose loot, chest and visible locked doors touching the unit,
 * diagonals included (the door pick that follows offers only orthogonal squares). Doors require confirmed sight, and
 * every other interaction requires standing on the fixture.
 * @param {{unitCells: object[], objects: object[], exploring?: boolean, doorVisible?: Function}} input The placed
 *   Objects with their footprints, and whether the acting unit sees a given Door: true, false, or null when unknown.
 * @returns {{kind: string, object: object|null, doors: object[]}}
 */
export function resolveInteractionTarget({ unitCells = [], objects = [], exploring = false, doorVisible = () => true }) {
  const reachable = objects.filter(object => object.hidden !== true && !objectSubtypeBracketed(object.objectType)
    && (exploring || !EXPLORATION_ONLY_OBJECT_TYPES.includes(object.objectType)));
  const under = type => reachable.find(object => object.objectType === type && cellsOverlap(unitCells, object.cells));
  const armament = exploring ? null : under('Armament');
  if (armament) return { kind: 'armament', object: armament, doors: [] };
  const station = DOWNTIME_STATION_ORDER.map(under).find(Boolean) ?? null;
  if (station) return { kind: 'station', object: station, doors: [] };
  const loot = under('Loot');
  if (loot) return { kind: 'loot', object: loot, doors: [] };
  const chest = under('Chest');
  if (chest) return { kind: 'chest', object: chest, doors: [] };
  const doors = reachable.filter(object => object.objectType === 'Door' && object.locked !== false
    && cellsAdjacent(unitCells, object.cells) && doorVisible(object) === true);
  if (doors.length) return { kind: 'doors', object: null, doors };
  return { kind: 'none', object: null, doors: [] };
}

/* -------------------------------------------- */
/*  Lock opening                                */
/* -------------------------------------------- */

/** The Energy each Locktouch attempt costs in free exploration, pass or fail. */
const LOCKPICK_ENERGY_COST = 1;

/**
 * Plan opening a lock.
 * Check sight before revealing lock state or spending costs. A key opens the lock outright, while Locktouch
 * requires a pickable lock and a roll. Encounter attempts also require an available action. A Locktouch attempt in
 * free exploration costs Energy (energyLaneBlock in game/downtime/rules.mjs), so a unit that took its Downtime
 * Action or has no Energy left is refused with the reason in `blocked`.
 * @param {object} facts The lock and the unit. `visible` is true only when the unit is known to see the lock, and
 *   `downtime` holds the unit's `commitment` and `energy` while exploring.
 * @returns {{ok: boolean, code?: string, blocked?: string, consumesKey?: boolean, rollsCheck?: boolean,
 *   energyCost?: number}}
 */
export function planLockOpening(facts) {
  if (!LOCKABLE_OBJECT_TYPES.includes(String(facts.objectType ?? ''))) return refusal(RESULT_CODES.OBJECT_LOCK_UNAVAILABLE);
  if (facts.visible !== true) return refusal(RESULT_CODES.OBJECT_NOT_VISIBLE);
  if (facts.locked !== true) return refusal(RESULT_CODES.OBJECT_LOCK_ALREADY_OPEN);
  if (!facts.inReach) return refusal(RESULT_CODES.OBJECT_OUT_OF_REACH);
  if (facts.claimsAction && !facts.standardAvailable) return refusal(RESULT_CODES.OBJECT_ACTION_UNAVAILABLE);
  if (facts.method === LOCK_METHODS.KEY) {
    if (!facts.keyName || !facts.carriesKey) return refusal(RESULT_CODES.OBJECT_KEY_MISSING);
    return { ok: true, method: facts.method, consumesKey: true, rollsCheck: false };
  }
  if (facts.method !== LOCK_METHODS.LOCKTOUCH || !facts.hasLocktouch) return refusal(RESULT_CODES.OBJECT_LOCK_UNPICKABLE);
  if (!objectLockIsPickable(facts.difficultyClass)) return refusal(RESULT_CODES.OBJECT_LOCK_UNPICKABLE);
  const energyCost = facts.exploring === true ? LOCKPICK_ENERGY_COST : 0;
  const blocked = energyCost ? energyLaneBlock(facts.downtime, energyCost) : '';
  if (blocked) return { ok: false, code: RESULT_CODES.OBJECT_LOCKPICK_BLOCKED, blocked };
  return { ok: true, method: facts.method, consumesKey: false, rollsCheck: true, energyCost };
}

/* -------------------------------------------- */
/*  Armament take-up                            */
/* -------------------------------------------- */

/**
 * Validate Armament use. Require overlap, an unmounted wielder, the proficiency rank and usable durability. Free
 * Exploration forbids firing.
 * @param {object} facts The unit and the Armament.
 * @returns {{ok: boolean, code?: string}}
 */
export function planArmamentWield(facts) {
  if (String(facts.objectType ?? '') !== 'Armament') return refusal(RESULT_CODES.ARMAMENT_UNAVAILABLE);
  if (facts.exploring === true) return refusal(RESULT_CODES.ARMAMENT_EXPLORING);
  if (!facts.inReach) return refusal(RESULT_CODES.ARMAMENT_UNAVAILABLE);
  if (facts.mounted === true) return refusal(RESULT_CODES.ARMAMENT_MOUNTED);
  if (!armamentProficiencyMet(facts)) return refusal(RESULT_CODES.ARMAMENT_PROFICIENCY);
  if (!armamentUsable(facts.durability)) return refusal(RESULT_CODES.ARMAMENT_BROKEN);
  return { ok: true };
}

/**
 * Whether the wielder's rank in the Armament's proficiency reaches what it demands, asked of holdsProficiencyRank
 * in game/progression/rules.mjs. No demand always passes, and a proficiency the wielder has no total for refuses.
 */
function armamentProficiencyMet(facts) {
  return holdsProficiencyRank(facts.proficiencies ?? {}, facts.requiredProficiency, Number(facts.requiredRank) || 0);
}

/** Whether an Armament still has durability to fire with. */
function armamentUsable(durability = {}) {
  if (durability.type === 'infinite') return true;
  return (Number(durability.value) || 0) > 0;
}

/** Whether a wielder still overlaps the Armament it borrowed. Stepping fully off hands the Armament back. */
export function armamentStillOccupied(unitCells = [], armamentCells = []) {
  return cellsOverlap(unitCells, armamentCells);
}

/* -------------------------------------------- */
/*  Item drops                                  */
/* -------------------------------------------- */
/** The Item types a unit carries as goods. */
const DROPPABLE_ITEM_TYPES = new Set(['Equipment', 'Consumable', 'Miscellaneous', 'Resource']);
const DROP_PILE_NAME = 'Loot';

/** Whether an Item is a possession a unit may set down: carried goods, never a feature or an innate grant. */
export function isDroppableItem(item) {
  return DROPPABLE_ITEM_TYPES.has(String(item?.type ?? '')) && item?.innate !== true;
}

/** Validate an item drop. Discard requires only a droppable item. */
export function planItemDrop(facts) {
  if (!facts.item) return refusal(RESULT_CODES.DROP_UNAVAILABLE);
  if (!isDroppableItem(facts.item)) return refusal(RESULT_CODES.DROP_ITEM_REFUSED);
  if (facts.action === DROP_ACTIONS.DISCARD) return { ok: true, action: facts.action, commitsSquare: false };
  if (facts.action !== DROP_ACTIONS.GROUND || !facts.placed) return refusal(RESULT_CODES.DROP_UNAVAILABLE);
  return {
    ok: true,
    action: facts.action,
    commitsSquare: facts.exploring !== true && facts.movementPlanning === true
  };
}

/** What a dropped pile looks like: every pile reads as Loot, and a lone item shows its own art. */
export function dropChestPresentation(payloads = [], bagImage = '') {
  const image = payloads.length === 1 ? String(payloads[0].img ?? bagImage) : String(bagImage);
  return { name: DROP_PILE_NAME, image };
}

/** An Item's chance to drop as a whole percent from 0 to 100. A blank chance is a certain drop. */
export function dropChancePercent(chance) {
  if (chance === null || chance === undefined || chance === '') return 100;
  const value = Number(chance);
  return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 100;
}

/** The Items a defeated unit may leave behind: flagged to drop, a chance above 0, and not in hand, worn or equipped. */
export function defeatedLootPayloads(items = []) {
  return items.filter(item => item.stealableFlag === 'Drops' && dropChancePercent(item.dropChance) > 0
    && item.isEquipped !== true && isDroppableItem(item));
}

/** The Items a defeated unit does leave behind: each candidate drops when its roll in [0, 1) is under its chance. */
export function rollDefeatedLoot(items = [], rolls = []) {
  return defeatedLootPayloads(items)
    .filter((item, index) => (Number(rolls[index]) || 0) * 100 < dropChancePercent(item.dropChance));
}

/** The odds band, as a CSS class, that lock and crossing offers colour a success chance with. */
export function successChanceBand(successPercent) {
  const failure = 100 - successPercent;
  if (failure >= 56) return 'low-chance';
  if (failure >= 31) return 'medium-chance';
  if (failure >= 11) return 'high-chance';
  return 'very-high-chance';
}

function refusal(code) {
  return { ok: false, code };
}

/* -------------------------------------------- */
/*  Art states                                  */
/* -------------------------------------------- */
const ART_ROOT = `systems/${SYSTEM_ID}/assets`;

/** A fully transparent sprite, for an Object that must hold a square while showing nothing. */
const EMPTY_ART = `${ART_ROOT}/ui/empty.png`;

/**
 * The animated glint a Gathering Node shows where the JB2A Patreon module (`jb2a_patreon`) is active. Without it,
 * free JB2A included, the node is unmarked.
 */
const GATHERING_NODE_GLINT =
  'modules/jb2a_patreon/Library/Generic/Item/GlintFew01_01_Regular_Yellow_200x200.webm';

/** The subtypes whose token art has two states, each with its own source, scale, tint and sprite offset. */
const ART_STATE_TYPES = Object.freeze(['Destructible', 'Chest', 'Door']);

/** The art a subtype starts with when it has none of its own, keyed by the field that holds it. */
const OBJECT_ART_DEFAULTS = Object.freeze({
  Destructible: Object.freeze({ img: `${ART_ROOT}/object/Destructible.png`, altered: EMPTY_ART, state: 'destroyed' }),
  Chest: Object.freeze({ img: `${ART_ROOT}/object/chest.png`, altered: `${ART_ROOT}/object/chestOpen.png`,
    state: 'opened' }),
  Door: Object.freeze({ img: `${ART_ROOT}/object/Door.png`, altered: EMPTY_ART, state: 'opened' }),
  Armament: Object.freeze({ img: `${ART_ROOT}/object/Armament.png`, altered: '', state: '' }),
  Loot: Object.freeze({ img: `${ART_ROOT}/object/loot.png`, altered: '', state: '' }),
  'Gathering Node': Object.freeze({ img: EMPTY_ART, altered: '', state: '' }),
  'Cooking Pot': Object.freeze({ img: `${ART_ROOT}/object/Cooking Station.png`, altered: '', state: '' }),
  Instrument: Object.freeze({ img: `${ART_ROOT}/object/Instrument.png`, altered: '', state: '' }),
  Stationary: Object.freeze({ img: `${ART_ROOT}/object/stationary.png`, altered: '', state: '' }),
  Altar: Object.freeze({ img: `${ART_ROOT}/object/altar.png`, altered: '', state: '' }),
  Workshop: Object.freeze({ img: `${ART_ROOT}/object/Smithy.png`, altered: '', state: '' }),
  Laboratory: Object.freeze({ img: `${ART_ROOT}/object/Laboratory.png`, altered: '', state: '' })
});

/** The portrait and token art a Convoy Actor starts with. The party's shared store ships with art of its own. */
const CONVOY_ART = `${ART_ROOT}/object/Convoy.png`;

/** The prototype scale a subtype starts at: full size for the map structures, half for every other subtype. */
const FULL_SCALE_OBJECT_TYPES = Object.freeze(['Door', 'Destructible', 'Armament']);
const OBJECT_DEFAULT_SCALE = 0.5;

const SEEDED_ART = new Set([
  ...Object.values(OBJECT_ART_DEFAULTS).flatMap(entry => [entry.img, entry.altered]).filter(Boolean),
  GATHERING_NODE_GLINT
]);
const SEEDED_SCALES = new Set([OBJECT_DEFAULT_SCALE]);
const DEFAULT_TINT = '#ffffff';

/** Whether an Object subtype draws two art states rather than one appearance. */
export function objectHasArtStates(objectType) {
  return ART_STATE_TYPES.includes(String(objectType ?? ''));
}

/** Which art state an Object is in by its data, or an empty string for a single-state subtype. */
function objectArtState(facts = {}) {
  const objectType = String(facts.objectType ?? '');
  if (!objectHasArtStates(objectType)) return '';
  if (objectType === 'Destructible') return facts.destroyed === true ? 'destroyed' : 'intact';
  return facts.locked === false ? 'opened' : 'closed';
}

/**
 * The art a subtype seeds. A field is written only while it is unset, Foundry's placeholder or an earlier default,
 * so art a GM chose survives a subtype change. A dropped loot bag keeps the art its contents gave it.
 * @param {object} facts The Object's current art and subtype.
 * @returns {object} Dot-path writes, empty when nothing needs seeding.
 */
export function objectArtDefaults(facts = {}, objectType = '') {
  const defaults = OBJECT_ART_DEFAULTS[String(objectType ?? '')];
  if (!defaults || facts.isDropChest === true) return {};
  const seeds = { img: defaults.img };
  if (defaults.altered) {
    seeds[defaults.state === 'destroyed' ? 'system.art.destroyedImagePath' : 'system.art.altImagePath']
      = defaults.altered;
  }
  if (objectType === 'Gathering Node' && facts.jb2a === true) {
    seeds['prototypeToken.texture.src'] = GATHERING_NODE_GLINT;
  }
  const writes = {};
  for (const [field, path] of Object.entries(seeds)) {
    const current = String(facts.current?.[field] ?? '');
    const unset = !current || current === facts.placeholderArt || SEEDED_ART.has(current);
    if (unset && current !== path) writes[field] = path;
  }
  return writes;
}

/**
 * Seed a Convoy's own art, only where it still carries Foundry's placeholder or nothing at all. A portrait the owner
 * chose is never replaced.
 * @param {{img?: string, prototypeSrc?: string, placeholderArt?: string}} facts The Convoy's current art.
 * @returns {object} Dot-path writes, empty when the Convoy already shows art of its own.
 */
export function convoyArtDefaults(facts = {}) {
  const placeholder = String(facts.placeholderArt ?? '');
  const writes = {};
  const img = String(facts.img ?? '');
  if (!img || img === placeholder) writes.img = CONVOY_ART;
  const prototypeSrc = String(facts.prototypeSrc ?? '');
  if (!prototypeSrc || prototypeSrc === placeholder) writes['prototypeToken.texture.src'] = CONVOY_ART;
  return Object.freeze(writes);
}

/**
 * The prototype-token scale a subtype seeds. Only an untouched scale, or one this table seeded, is rewritten, and
 * the sign carries over so a mirrored sprite stays mirrored.
 */
export function objectScaleDefaults(currentScaleX, objectType = '') {
  const current = Number(currentScaleX ?? 1);
  if (!Number.isFinite(current) || current === 0) return {};
  const magnitude = Math.abs(current);
  if (magnitude !== 1 && !SEEDED_SCALES.has(magnitude)) return {};
  const target = FULL_SCALE_OBJECT_TYPES.includes(String(objectType ?? '')) ? 1 : OBJECT_DEFAULT_SCALE;
  if (magnitude === target) return {};
  return {
    'prototypeToken.texture.scaleX': (current < 0 ? -1 : 1) * target,
    'prototypeToken.texture.scaleY': target
  };
}

/**
 * Choose the texture, scale and tint an Object's token shows. Portrait art wins over prototype art, then the
 * subtype's state art applies. A null scale keeps the prototype's. A state with no tint takes the prototype's tint,
 * then white.
 * @param {object} facts The Object's art fields, subtype and state.
 * @returns {{src: string, scale: number|null, tint: string|null, state: string}}
 */
export function objectTokenAppearance(facts = {}) {
  const avatar = facts.img && facts.img !== EMPTY_ART ? String(facts.img) : '';
  const base = avatar || String(facts.prototypeSrc ?? '') || String(facts.img ?? '');
  const objectType = String(facts.objectType ?? '');
  const alt = String(facts.altImagePath ?? '');
  const destroyed = String(facts.destroyedImagePath ?? '');
  let src = base;
  if ((objectType === 'Chest' || objectType === 'Door') && facts.locked === false && alt) src = alt;
  else if (destroyed && facts.destroyed === true) src = destroyed;
  const state = objectArtState(facts);
  const authored = state ? (facts.states?.[state] ?? {}) : {};
  const tint = state ? stateTint(authored.tint) ?? stateTint(facts.prototypeTint) ?? DEFAULT_TINT : null;
  return { src, state, scale: stateScale(authored.scale), tint };
}

/** The per-state sprite offset, in pixels, applied on top of whatever position the core last set. */
export function objectSpriteOffset(facts = {}) {
  const state = objectArtState(facts);
  const authored = state ? (facts.states?.[state] ?? {}) : {};
  return { x: Number(authored.offsetX) || 0, y: Number(authored.offsetY) || 0 };
}

function stateScale(raw) {
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function stateTint(raw) {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}
