/** @layer foundry/adapters/projections */
/*
 * Reads tokens and Actors for attack targeting and hands the rules in game/ plain data.
 *
 * The first half serves the targeting controls in ui/controls/targeting.mjs while a player attacks from the
 * hotbar: which weapon is in use, the range grid, the clicked target, the local aim facing, and the Combat and
 * Destructible previews built from the attack data the exchange itself uses. Marking the active item and turning
 * the aiming unit change in-memory state on this client only; nothing is saved. The second half answers questions
 * about imagined attacks without saving anything. The threat overlay asks how hard each hostile could hit the
 * selected unit, and the Enemy AI asks about matchups, sight, flanking and usable items from squares it's
 * considering (game.emblemRpg.api.combat).
 */
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { DAMAGE_TYPES } from '../../../contracts/domains/damage.mjs';
import {
  averageFormulaValue,
  calculateAttackPreview,
  stanceBreaksUnderAttacks
} from '../../../game/combat/attack-preview.mjs';
import { combatAttackCount, combatDamageTypes, damageTypeRollFor } from '../../../game/combat/exchange.mjs';
import {
  airborneBeyondMelee,
  footprintHeightBlocked,
  isInMeleeRange,
  parseAttackRange,
  resolveEngagement
} from '../../../game/targeting/attack-grid.mjs';
import { engagementDistance, weaponUsableForThreat } from '../../../game/combat/threat.mjs';
import { resolveActionLosRule, unitIgnoresLineOfSight } from '../../../game/character/rules.mjs';
import { evaluateActivationRange, requirementPlacement, resolveSpellRank } from '../../../game/items/activation.mjs';
import { itemSanctuaryAim, sanctuaryBlocksPick } from '../../../game/targeting/sanctuary.mjs';
import { checkCaster, checkTargets } from '../../../game/effects/requirements.mjs';
import { hasOnHitDebuff } from '../../../game/effects/statuses.mjs';
import { compileCharacterAs, projectWeaponChoicesAs } from './characters.mjs';
import { projectMovementSnapshot } from './movement.mjs';
import { readTerrainElevations } from './terrain.mjs';
import { projectAuraFieldsAt, projectTerrainModifiersAt } from './board.mjs';
import {
  footprintTerrainElevation,
  isAirborneActor,
  isArmamentWeapon,
  isAttackItem,
  isDestructibleActor,
  isMagicItemDocument,
  markedAllyBonus,
  projectActorStatusKeys,
  projectCombatRuleFacts,
  projectFlightReach,
  projectFoundryCombatActorContext,
  projectHypotheticalFlanking,
  projectMatchupCombatContexts,
  projectProficiency,
  projectProficiencyTotals,
  projectRequirementFacts,
  projectWeapon,
  projectWieldedArmament,
  tauntedByActorUuid,
  tokenCells,
  tokenTerrainElevation,
  withExchangeFlanking,
  withMarkedBonus,
  withSharedProjections,
  wornArmor
} from './combat-context.mjs';
import { redirectFoundryFixtureToken } from './tokens.mjs';
import { FACING_FLIP_MS, facingScaleToward, savedFacingScale } from '../document-writes/tokens.mjs';
import {
  clone, persistedTokenCenter, resolveToken, testSceneWallCollision, tokenGridSize
} from '../services/host.mjs';
import { footprintCells } from '../../../lib/core/geometry.mjs';
import { collectionValues, finite } from '../../../lib/core/runtime.mjs';
import { reportFoundryError } from '../services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Hotbar activation                           */
/* -------------------------------------------- */
/**
 * Collect what's needed to start an attack from a hotbar slot: the controlled token, the weapon, and the values
 * validateAttackActivation checks before the targeting grid opens. A Weapon Art attacks through the unit's
 * wielded weapon, or through the Armament it has borrowed. Called through projectAttackEntry in
 * ui/controls/targeting.mjs, for a hotbar press and for a weapon picked in the Combat Preview.
 * @param {string} itemUuid UUID of the item in the clicked BG3 hotbar slot.
 * @param {object|null} movementPlan The movement plan currently open on this client, if any.
 * @param {{weaponId?: string}} [options] A carried weapon to judge a Weapon Art with in place of the wielded one.
 * @returns {Promise<object|null>} null if no token is controlled or the slot holds nothing to attack with.
 */
export async function projectHotbarAttackActivation(itemUuid, movementPlan, { weaponId = '' } = {}) {
  const token = globalThis.canvas?.tokens?.controlled?.[0] ?? null;
  const actor = token?.actor ?? null;
  const borrowed = actor ? projectWieldedArmament(actor) : null;
  const activatedItem = borrowed && borrowed.token.uuid === String(itemUuid ?? '')
    ? borrowed.weapon : await fromUuid(itemUuid);
  const activatedActor = activatedItem?.actor
    ?? (activatedItem?.parent?.documentName === 'Actor' ? activatedItem.parent : null);
  if (!token || !actor || (activatedItem?.documentName !== 'Item' && !isArmamentWeapon(activatedItem))) return null;
  const weaponArt = activatedItem.system.itemType === 'Weapon Art' ? activatedItem : null;
  const item = !weaponArt ? activatedItem : weaponId ? actor.items.get(weaponId) : borrowed?.weapon
    ?? collectionValues(actor.items).find(candidate => candidate.system?.isWielded === true && isAttackItem(candidate));
  const itemActor = item?.actor ?? (item?.parent?.documentName === 'Actor' ? item.parent : null);
  if (!item?.uuid) return null;
  const armament = isArmamentWeapon(item);
  const armamentHeld = armament && standsOn(token, borrowed.token);
  const proficiencies = Object.fromEntries(Object.entries(actor.system?.prof ?? {})
    .map(([key, value]) => [key, Number(value?.total) || 0]));
  const tokenUuid = String(token.document?.uuid ?? token.uuid ?? '');
  const artFacts = projectWeaponArtFacts(weaponArt, item, token, actor);
  return Object.freeze({
    tokenUuid,
    actorUuid: String(actor.uuid ?? ''),
    itemUuid: String(item.uuid),
    itemId: String(item.id ?? ''),
    activationItemUuid: String(activatedItem.uuid ?? ''),
    weaponArtUuid: String(weaponArt?.uuid ?? ''),
    weaponArtId: String(weaponArt?.id ?? ''),
    notificationData: Object.freeze({ itemName: String(item.name ?? ''), weaponArtName: String(weaponArt?.name ?? '') }),
    facts: Object.freeze({
      controlled: token.controlled === true || globalThis.game?.user?.isGM === true,
      movementPlanning: actor.system?.turn?.movementPlanning === true,
      planMatches: movementPlan?.tokenUuid === tokenUuid
        && (movementPlan?.inputReady === true || movementPlan?.suspended === true),
      itemOwned: (armament ? armamentHeld : String(itemActor?.uuid ?? '') === String(actor.uuid ?? ''))
        && (isArmamentWeapon(activatedItem) ? armamentHeld
          : String(activatedActor?.uuid ?? '') === String(actor.uuid ?? '')),
      itemType: String(item.system.itemType ?? ''),
      standardAvailable: actor.system?.turn?.actionAvailable === true,
      stanceAvailable: Number(actor.system?.resources?.stn?.value) > 0,
      magicBlocked: actorSilenced(actor) && isMagicItemDocument(activatedItem),
      itemUses: Number(item.system.uses?.current) || 0,
      itemInfinite: item.system.uses?.type === 'infinite',
      requiredProficiency: String(item.system.weapon?.req ?? ''),
      requiredRank: Number(item.system.weapon?.rank) || 0,
      proficiencies: Object.freeze(proficiencies),
      ...artFacts
    }),
    needsWield: !armament && item.system.isWielded !== true,
    armament
  });
}

/**
 * Look up the weapon the player picked from the Combat Preview's weapon list, to swap to it or check it can be used
 * (ui/controls/targeting.mjs). Returns null if the actor doesn't own that item or it isn't an attack.
 */
export async function projectFoundryAttackItem(actorUuid, itemId) {
  const actor = await fromUuid(String(actorUuid ?? ''));
  const item = actor?.documentName === 'Actor' ? actor.items?.get?.(String(itemId ?? '')) : null;
  if (!item || !isAttackItem(item)) return null;
  return Object.freeze({
    actorUuid: String(actor.uuid),
    itemUuid: String(item.uuid),
    itemId: String(item.id),
    wielded: item.system?.isWielded === true
  });
}

/**
 * Mark the item the unit is about to use as its active item (in memory only, never saved) and re-prepare the
 * actor so its stats reflect that item, a Weapon Art's bonuses for example. Also refreshes the BG3 hotbar so it
 * marks the slot in use. Called by the targeting controls when targeting starts or the weapon changes, and by
 * ui/controls/interaction.mjs while a unit pick such as Steal is open. clearFoundryActiveItem undoes it.
 */
export async function stageFoundryActiveItem(context) {
  const live = await resolveContext(context);
  if (!live) return false;
  live.actor.activeItem = live.activatedItem;
  live.actor.activeItemCell = String(context?.cellId ?? '');
  live.actor.reset?.();
  refreshBg3Hud();
  return true;
}

/** Undo stageFoundryActiveItem when targeting or the pick ends, unless a newer activation has replaced the item. */
export async function clearFoundryActiveItem(context) {
  const source = await resolveSource(context);
  if (!source || source.actor.activeItem?.uuid !== (context.activationItemUuid || context.itemUuid)) return false;
  delete source.actor.activeItem;
  delete source.actor.activeItemCell;
  source.actor.reset?.();
  refreshBg3Hud();
  return true;
}

/* -------------------------------------------- */
/*  Aim facing                                  */
/* -------------------------------------------- */
/** The Tokens this client turned while aiming, until restoreFoundryAimFacing turns them back. */
const aimFacings = new Set();

/**
 * Turn the aiming unit toward its target on this client only. Nothing is saved, though Foundry's animation leaves the
 * new facing in this client's copy of the TokenDocument until restoreFoundryAimFacing turns it back. The host client
 * saves the real facing for everyone when the attack is confirmed (faceTokensTowardEachOther in
 * document-writes/tokens.mjs).
 * @param {string} sourceTokenUuid The aiming unit's Token.
 * @param {string} targetTokenUuid The Token it aims at.
 * @returns {Promise<boolean>} Whether the unit turned.
 */
export async function turnFoundryAimFacing(sourceTokenUuid, targetTokenUuid) {
  if (!sourceTokenUuid || !targetTokenUuid || sourceTokenUuid === targetTokenUuid) return false;
  const [source, target] = await Promise.all([resolveToken(sourceTokenUuid), resolveToken(targetTokenUuid)]);
  const scaleX = source && target ? facingScaleToward(source, target) : null;
  if (scaleX === null) return false;
  aimFacings.add(source.uuid);
  return animateLocalFacing(source, scaleX);
}

/**
 * Turn a unit this client turned while aiming back to its saved facing. If the host client has already saved a turn
 * the same way, nothing moves.
 */
export async function restoreFoundryAimFacing(tokenUuid) {
  if (!aimFacings.delete(tokenUuid)) return false;
  const token = await resolveToken(tokenUuid);
  return token ? animateLocalFacing(token, savedFacingScale(token)) : false;
}

/**
 * Animate a placed Token's facing on this client only, as Foundry animates a saved turn. Foundry copies each
 * animation frame into the live TokenDocument, so `texture.scaleX` here is the facing on screen, while `_source`
 * keeps the saved one.
 */
function animateLocalFacing(tokenDocument, scaleX) {
  const token = tokenDocument.object;
  if (!token || Math.abs((Number(tokenDocument.texture?.scaleX) || 1) - scaleX) < 1e-6) return false;
  token.animate({ texture: { scaleX } }, { duration: FACING_FLIP_MS })
    .catch(error => reportFoundryError(import.meta.url, error, 'animateLocalFacing'));
  return true;
}

/* -------------------------------------------- */
/*  Targeting grid and clicked targets          */
/* -------------------------------------------- */
/**
 * Gather the range, shape and map details buildAttackTargetingGrid needs to draw the attack grid for the active
 * weapon. The targeting controls call this when the grid opens, when other tokens move, and again just before a
 * preview to make sure the grid is still current.
 * @param {object} context The aimed token, actor and item UUIDs.
 * @param {object} movementSnapshot The unit's movement state from api.movement.getPlan.
 * @returns {Promise<object|null>} null if the aim has gone stale or the movement state is for another token.
 */
export async function projectFoundryAttackGrid(context, movementSnapshot) {
  const live = await resolveContext(context);
  if (!live || movementSnapshot?.tokenUuid !== context.tokenUuid) return null;
  const weapon = live.item.system?.weapon ?? {};
  const effect = live.item.system?.effectData ?? {};
  const elevations = movementSnapshot.terrainElevations ?? Object.freeze({});
  return Object.freeze({
    range: String(live.actor.system?.stats?.rng?.total ?? weapon.rng ?? ''),
    columns: Number(movementSnapshot.columns) || 0,
    rows: Number(movementSnapshot.rows) || 0,
    source: Object.freeze({ ...movementSnapshot.current }),
    footprint: Object.freeze({ ...movementSnapshot.footprint }),
    square: weapon.targetShape === 'Square',
    cone: weapon.targetShape === 'Cone',
    area: weapon.targetArea && typeof weapon.targetArea === 'object'
      ? Object.freeze({ ...weapon.targetArea }) : null,
    elevations,
    losRule: resolveActionLosRule(effect.losRule, unitIgnoresLineOfSight(live.actor.flags?.[SYSTEM_ID])),
    // A borrowed Armament at range 1 is not held to melee height reach on the grid. The clicked-target check below
    // has no such exception.
    meleeOnly: !isArmamentWeapon(live.item) && String(weapon.rng ?? '').trim() === '1',
    sourceElevation: tokenTerrainElevation(live.token, Number(movementSnapshot.gridSize) || 0, elevations),
    gridColor: live.weaponArt ? 'Purple' : String(effect.gridColor ?? ''),
    airborne: movementSnapshot.airborne === true,
    gridSize: Number(movementSnapshot.gridSize) || 0,
    sceneUuid: String(movementSnapshot.sceneUuid ?? '')
  });
}

/**
 * Gather what the attack rules need about a token the player clicked while aiming: its faction, whether it's
 * hidden or already down, and whether walls or terrain block sight to it. A click on an object counts as a click
 * on a unit sharing its square. Called from openPreviewForTarget (ui/controls/targeting.mjs), which runs
 * validateAttackTarget on the result before opening a Combat or Destructible preview.
 * @returns {Promise<object|null>} null if the click isn't on a unit or Destructible, or the aim has gone stale.
 */
export async function projectFoundryAttackTarget(context, targetToken) {
  const live = await resolveContext(context);
  const fixture = redirectFoundryFixtureToken(targetToken);
  if (fixture.refused) return null;
  if (fixture.redirected) targetToken = fixture.token?.object ?? fixture.token;
  const objectTarget = isDestructibleActor(targetToken?.actor);
  if (!live || !targetToken?.actor || (targetToken.actor.type !== 'Character' && !objectTarget)) return null;
  const gridSize = tokenGridSize(live.token, 0);
  const sourceCells = tokenCells(live.token, gridSize);
  const targetCells = tokenCells(targetToken, gridSize);
  const sourceCenter = persistedTokenCenter(live.token, gridSize);
  const targetCenter = persistedTokenCenter(targetToken, gridSize);
  const losRule = resolveActionLosRule(
    live.item.system?.effectData?.losRule, unitIgnoresLineOfSight(live.actor.flags?.[SYSTEM_ID])
  );
  const { sourceAirborne, targetAirborne, targetStanceBroken, classicFlyers, flightForbidden } =
    projectFlightReach(live.token, targetToken);
  const sightBlocked = losRule !== 'ignoreLoS'
    && (testSceneWallCollision(sceneOf(live.token), sourceCenter, targetCenter) !== false
      || footprintHeightBlocked({
        losRule,
        sourceCells,
        targetCells,
        airborne: sourceAirborne || targetAirborne,
        elevations: readTerrainElevations(live.token.document?.parent)
      }));
  return Object.freeze({
    sourceTokenUuid: String(live.token.document?.uuid ?? live.token.uuid ?? ''),
    targetTokenUuid: String(targetToken.document?.uuid ?? targetToken.uuid ?? ''),
    sourceActorUuid: String(live.actor.uuid ?? ''),
    targetActorUuid: String(targetToken.actor.uuid ?? ''),
    targetPresent: true,
    targetHidden: targetToken.document?.hidden === true,
    targetDestroyed: objectTarget
      ? Number(targetToken.actor.system?.resources?.stn?.value) < 1
      : Number(targetToken.actor.system?.resources?.hp?.value) < 1,
    targetObject: objectTarget,
    sourceTurnOver: live.actor.system?.turn?.actionAvailable === false,
    sourceTauntedByActorUuid: tauntedByActorUuid(live.actor),
    targetSanctuary: actorInSanctuary(targetToken.actor),
    sourceAirborne,
    targetAirborne,
    targetStanceBroken,
    meleeOnly: String(live.item.system?.weapon?.rng ?? '').trim() === '1',
    classicFlyers,
    flightForbidden,
    sourceFaction: String(live.actor.system?.faction?.role ?? 'Neutral'),
    targetFaction: String(targetToken.actor.system?.faction?.role ?? 'Neutral'),
    targetCells: Object.freeze(targetCells.map(cell => Object.freeze(cell))),
    sightBlocked,
    freeTargeting: targetToken.document?.getFlag?.(SYSTEM_ID, 'freeTargeting') === true
  });
}

/* -------------------------------------------- */
/*  Combat and Destructible previews            */
/* -------------------------------------------- */
/**
 * Build the Combat Preview from the attack data (`snapshot`) the exchange itself uses, so the player sees the
 * numbers the attack will use. Nothing is rolled here; the real exchange rolls damage types attack by attack. Names
 * and art come from the snapshot's tokens, which may be a guarder a Guard bond swapped in for the unit clicked. The
 * weapon switcher offers a borrowed Armament alone, or every attack Item with the reach it would have here. A damage
 * type picked for a weapon that rolls its type is shown as the one rolled.
 * @param {object|null} snapshot FoundryCombatStateRepository's snapshot of this attack.
 * @param {string|null} [damageType] The damage type picked in the preview, if any.
 * @returns {Promise<object|null>} null for a Destructible target or when either token is gone.
 */
export async function projectFoundryCombatPreview(snapshot, damageType = null) {
  if (!snapshot || snapshot.target.destructible === true) return null;
  const [sourceToken, targetToken] = await Promise.all([
    resolveToken(snapshot.sourceTokenUuid), resolveToken(snapshot.targetTokenUuid)
  ]);
  if (!sourceToken?.actor || !targetToken?.actor) return null;
  const { weapon, weaponArt: art } = snapshot.source;
  const validWeapons = weapon.fixed ? [weapon] : projectWeaponChoicesAs(sourceToken.actor, weapon.id, {
    activeItem: art ? collectionValues(sourceToken.actor.items).find(item => item.uuid === art.uuid) : null,
    target: targetToken.actor, combatDistance: snapshot.boardDistance, combatEngagement: snapshot.boardEngagement,
    isAttacking: true
  });
  const preview = calculateAttackPreview({
    attacker: { ...snapshot.source, ...projectPreviewDisplay(sourceToken), validWeapons },
    defender: { ...snapshot.target, ...projectPreviewDisplay(targetToken) },
    distance: snapshot.distance,
    engagement: snapshot.engagement,
    reachDistance: snapshot.reachDistance,
    reachEngagement: snapshot.reachEngagement,
    damageType,
    attackerDamageTypeRoll: damageTypeRollFor(snapshot.source, snapshot.target, damageType)
  });
  if (!art) return preview;
  return Object.freeze({ ...preview, weaponArt: Object.freeze({ name: art.name, image: art.image }) });
}

/**
 * Work out what the Destructible preview shows when the player aims at an object, from the attack data: the
 * attacker's break damage against its Integrity, the damage type and number of attacks, whether it's vulnerable,
 * resistant or immune, and the weapon's name, art and uses. Called by openPreviewForTarget.
 * @param {object|null} snapshot FoundryCombatStateRepository's snapshot of an attack on a Destructible.
 * @returns {Promise<object|null>} null unless the target is a Destructible whose token still exists.
 */
export async function projectFoundryDestructiblePreview(snapshot) {
  if (snapshot?.target?.destructible !== true) return null;
  const token = await resolveToken(snapshot.targetTokenUuid);
  if (!token?.actor) return null;
  const { name, image } = projectPreviewDisplay(token);
  const combat = snapshot.sourceCombat;
  const weapon = snapshot.source.weapon;
  const art = snapshot.source.weaponArt;
  return Object.freeze({
    name,
    image,
    integrity: `${snapshot.target.stance.value}/${snapshot.target.stance.max}`,
    weapon: Object.freeze({
      name: weapon.name,
      image: weapon.image,
      usesCurrent: weapon.uses.current,
      usesMax: weapon.uses.max,
      infinite: weapon.uses.infinite
    }),
    weaponArt: art ? Object.freeze({ name: art.name, image: art.image }) : null,
    damageType: String(combat.damageType || 'none'),
    breakDamage: Number(combat.breakDamage) || 0,
    attackCount: combatAttackCount(snapshot.source, snapshot.target),
    brkVulnerable: combat.affinity === 'effective',
    brkResisted: combat.affinity === 'ineffective',
    brkImmune: combat.affinity === 'immune'
  });
}

/**
 * What a preview shows of a unit beyond the rules: its name and its Token's art and size.
 * @param {TokenDocument|Token} token The unit's Token.
 */
function projectPreviewDisplay(token) {
  const document = token.document ?? token;
  const actor = document.actor ?? token.actor;
  return {
    name: String(actor.name ?? document.name ?? ''),
    image: String(document.texture?.src ?? actor.img ?? ''),
    tokenWidth: Number(document.width) || 1,
    tokenHeight: Number(document.height) || 1,
    textureScale: Math.abs(Number(document.texture?.scaleX) || 1)
  };
}

/**
 * One unit's side of an imagined attack: its combat stats (projectCombatRuleFacts), its HP, stance, protections and
 * damage types from the compiled `system`, and its name and art. `conditionSelf` is its condition data for this
 * attack.
 */
function projectCombatSide(token, actor, weapon, system, conditionSelf) {
  const facts = projectCombatRuleFacts(actor, weapon, null, system, conditionSelf);
  return Object.freeze({
    ...facts,
    ...projectPreviewDisplay(token),
    hp: Object.freeze({
      value: Number(system.resources?.hp?.value) || 0,
      max: Number(system.resources?.hp?.max) || 0
    }),
    stance: Object.freeze({
      value: Number(system.resources?.stn?.value) || 0,
      max: Number(system.resources?.stn?.max) || 0
    }),
    protections: Object.freeze({ ...(system.equipment?.prots ?? {}) }),
    vulnerabilities: Object.freeze(wornArmor(actor)
      ? { ...(system.equipment?.vulns ?? {}) }
      : Object.fromEntries(DAMAGE_TYPES.map(type => [type, true]))),
    immunities: Object.freeze(Object.entries(system.equipment?.imms ?? {})
      .filter(([, on]) => on === true).map(([key]) => key)),
    proficiencies: projectProficiencyTotals(system),
    damageTypes: Object.freeze(Object.entries(system.equipment?.damageTypes ?? {})
      .filter(([, active]) => active === true).map(([type]) => type))
  });
}

/* -------------------------------------------- */
/*  Threat overlay                              */
/* -------------------------------------------- */
/**
 * How hard each weapon a hostile carries would hit the selected unit, for the threat overlay. Each weapon is
 * measured as if the hostile had it in hand and had closed to its range. createThreatAssessment
 * (engine/combat/threat.mjs) turns the matchups into a threat level. Both units are compiled several times per call,
 * so their condition values and Item copies are cached for the call (withSharedProjections in combat-context.mjs).
 * @param {string} hostileTokenUuid The unit that might attack.
 * @param {string} targetTokenUuid The unit it would attack.
 * @returns {Readonly<object>|null} The target's HP, the hostile's stance and statuses, and one matchup per weapon.
 */
export function projectThreatMatchups(hostileTokenUuid, targetTokenUuid) {
  return withSharedProjections(() => measureThreatMatchups(hostileTokenUuid, targetTokenUuid));
}

function measureThreatMatchups(hostileTokenUuid, targetTokenUuid) {
  const hostileToken = placedToken(hostileTokenUuid);
  const targetToken = placedToken(targetTokenUuid);
  const hostile = hostileToken?.actor;
  const target = targetToken?.actor;
  if (!hostile || !target || hostile.type !== 'Character' || target.type !== 'Character') return null;
  const gridSize = tokenGridSize(hostileToken, 1);
  const gap = footprintDistance(tokenCells(hostileToken, gridSize), tokenCells(targetToken, gridSize));
  // We don't know which square the hostile would attack from, so each weapon is measured at the distance within its
  // range nearest the current gap (engagementDistance). A hostile already at that distance attacks from where it
  // stands. One that has to move in is measured from the target's elevation, since only a melee weapon closes all
  // the way in, and melee reaches across one level of elevation.
  const board = tokenReach(hostileToken, targetToken, gap, gridSize);
  const targetWeapon = collectionValues(target.items)
    .find(item => item.system?.isWielded === true && isAttackItem(item)) ?? null;
  const unit = threatWeaponFacts(hostile);
  const matchups = [];
  const defenderAt = new Map();
  for (const weapon of collectionValues(hostile.items)) {
    if (!weaponUsableForThreat(threatWeapon(weapon), unit)) continue;
    const distance = engagementDistance(gap,
      parseAttackRange(projectWeapon(hostile, weapon, wieldingSystem(hostile, weapon)).range));
    const floor = distance === gap ? board.sourceElevation : board.targetElevation;
    const blow = { ...board, distance, sourceElevation: floor };
    const reach = { engagement: resolveEngagement(blow), inMeleeRange: isInMeleeRange(blow) };
    const engaged = { combatDistance: distance, combatEngagement: reach.engagement, inMeleeRange: reach.inMeleeRange };
    const attackerCompiled = compileCharacterAs(hostile, {
      wieldedItemId: weapon.id, target, ...engaged, isAttacking: true
    });
    // The defender's compile doesn't depend on the hostile's weapon, so compile it once per distance.
    if (!defenderAt.has(distance)) {
      defenderAt.set(distance, compileCharacterAs(target, { target: hostile, ...engaged, isDefending: true }));
    }
    const defenderSystem = compiledSystem(target, defenderAt.get(distance));
    const [attackerSide, defenderSide] = hypotheticalSides(
      { token: hostileToken, actor: hostile, item: weapon, system: compiledSystem(hostile, attackerCompiled) },
      { token: targetToken, actor: target, item: targetWeapon, system: defenderSystem },
      { distance, ...reach }
    );
    const preview = calculateAttackPreview({
      attacker: attackerSide, defender: defenderSide, distance, engagement: reach.engagement
    });
    matchups.push(Object.freeze({
      weaponId: String(weapon.id ?? ''),
      damage: preview.attacker.damage,
      hitChance: preview.attacker.hitChance,
      critChance: preview.attacker.critChance,
      attackCount: preview.attacker.attackCount,
      critMultiplier: finite(attackerCompiled.stats?.critDmg?.total) || 2
    }));
  }
  return Object.freeze({
    targetHp: finite(target.system.resources.hp.value),
    stance: finite(hostile.system.resources.stn.value),
    statuses: Object.freeze([...projectActorStatusKeys(hostile)]),
    matchups: Object.freeze(matchups)
  });
}

/** The token for a UUID: its canvas object if this client has the scene drawn, otherwise the document. */
function placedToken(tokenUuid) {
  let document = null;
  try {
    document = fromUuidSync(tokenUuid) ?? null;
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'placedToken');
    document = null;
  }
  if (document?.documentName !== 'Token') return null;
  return document.object ?? document;
}

function threatWeaponFacts(actor) {
  return {
    silenced: actorSilenced(actor),
    proficiencies: Object.fromEntries(Object.entries(actor.system?.prof ?? {})
      .map(([key, value]) => [key, Number(value?.total) || 0]))
  };
}

function threatWeapon(item) {
  const system = item?.system ?? {};
  return {
    type: String(item?.type ?? ''),
    itemType: String(system.itemType ?? ''),
    range: system.weapon?.rng,
    uses: finite(system.uses?.current),
    infinite: system.uses?.type === 'infinite',
    proficiency: String(system.weapon?.req ?? ''),
    rank: Number(system.weapon?.rank) || 0
  };
}

/**
 * The unit's stats as they'd be with this weapon in hand, including bonuses that depend on the weapon. Planning
 * reads weapon ranges from here, not from whatever the unit has equipped right now.
 */
function wieldingSystem(actor, item) {
  return compiledSystem(actor, compileCharacterAs(actor, { wieldedItemId: item.id }));
}

/** The actor's live system data with the stats, equipment and resources of an imagined compile laid over it. */
function compiledSystem(actor, compiled) {
  const live = actor.system ?? {};
  return Object.freeze({
    ...live,
    stats: compiled.stats,
    equipment: compiled.equipment,
    prof: compiled.prof,
    unitType: compiled.unitType,
    combat: compiled.combat,
    statuses: { ...(live.statuses ?? {}), ...compiled.statuses },
    resources: {
      ...(live.resources ?? {}),
      hp: { ...(live.resources?.hp ?? {}), ...compiled.resources.hp },
      stn: { ...(live.resources?.stn ?? {}), ...compiled.resources.stn }
    }
  });
}

/* -------------------------------------------- */
/*  Planning API: matchups                      */
/* -------------------------------------------- */
/**
 * The full exchange forecast if the attacker used this weapon from a square it's considering, for the Enemy AI
 * planner (game.emblemRpg.api.combat.measure, called through the Enemy AI's foundry/system-bridge.mjs). Both units
 * are compiled in memory with that square's terrain and aura effects. Nothing is written.
 * @param {object} [intent] Attacker and defender token UUIDs, weaponId, distance, damageType, the `standing`
 *   square, whether each side is flanked, and optionally the square's `terrainModifiers` and `auraFields` if the
 *   caller has already read them.
 * @returns {Readonly<object>|null} null if either token or the weapon can't be found.
 */
export function projectMeasuredMatchup(intent = {}) {
  const attackerToken = placedToken(intent.attackerTokenUuid);
  const defenderToken = placedToken(intent.defenderTokenUuid);
  const attacker = attackerToken?.actor ?? null;
  const defender = defenderToken?.actor ?? null;
  const weapon = attacker?.items?.get?.(String(intent.weaponId ?? '')) ?? null;
  if (!attacker || !defender || !weapon) return null;
  const gridSize = tokenGridSize(attackerToken, 1);
  const distance = Math.max(0, Math.floor(finite(intent.distance)));
  const footprint = standingFootprint(attackerToken, intent.standing, gridSize);
  const reach = standingReach(attackerToken, footprint, defenderToken, distance, gridSize);
  const attackerCompiled = compileCharacterAs(attacker, {
    wieldedItemId: weapon.id,
    target: defender,
    combatDistance: distance,
    combatEngagement: reach.engagement,
    inMeleeRange: reach.inMeleeRange,
    isAttacking: true,
    ...hypotheticalGround(intent)
  });
  const defenderCompiled = compileCharacterAs(defender, {
    wieldedItemId: intent.defenderWeaponId,
    target: attacker,
    combatDistance: distance,
    combatEngagement: reach.engagement,
    inMeleeRange: reach.inMeleeRange,
    isDefending: true
  });
  const defenderWeapon = measuredDefenderWeapon(defender, intent.defenderWeaponId);
  const [attackerBase, defenderBase] = hypotheticalSides(
    { token: attackerToken, actor: attacker, item: weapon, system: compiledSystem(attacker, attackerCompiled) },
    { token: defenderToken, actor: defender, item: defenderWeapon, system: compiledSystem(defender, defenderCompiled) },
    { distance, ...reach }
  );
  const attackerSide = withExchangeFlanking(attackerBase, intent.attackerFlanked === true);
  const defenderSide = withExchangeFlanking(defenderBase, intent.targetFlanked === true);
  return shapeMeasuredMatchup(weapon, attackerSide, defenderSide, { attackerCompiled, defenderCompiled }, {
    attacker: attackerSide, defender: defenderSide, distance, engagement: reach.engagement,
    damageType: intent.damageType ?? null
  });
}

/**
 * Both sides of an imagined attack. Each unit is `{token, actor, item, system}`, where `system` was compiled for
 * this matchup. `blow` is the attack's distance, engagement and whether the two are in melee reach;
 * projectMatchupCombatContexts turns it into each side's condition data.
 */
function hypotheticalSides(attacker, defender, blow) {
  const contexts = projectMatchupCombatContexts({ attacker, defender, ...blow });
  const side = (unit, foe, context) => withMarkedBonus(
    projectCombatSide(unit.token, unit.actor, unit.item, unit.system, context),
    markedAllyBonus(unit.actor, foe.actor)
  );
  return [side(attacker, defender, contexts.attacker), side(defender, attacker, contexts.defender)];
}

/**
 * Run calculateAttackPreview and return only the fields the Enemy AI reads. Each side's damage types, protections,
 * vulnerabilities and immunities are included so it can weigh a counter's damage type against its own.
 */
function shapeMeasuredMatchup(weapon, attackerSide, defenderSide, compiled, previewInput) {
  const preview = calculateAttackPreview(previewInput);
  const attack = preview.attacker;
  const answer = preview.defender;
  return Object.freeze({
    weaponId: String(weapon.id ?? ''),
    damageType: String(attack.selectedDamageType ?? ''),
    validDamageTypes: Object.freeze([...combatDamageTypes(attackerSide, defenderSide)]),
    randomizeDamageType: attack.randomizeDamageType === true,
    attackerProtections: damageTypeList(attackerSide.protections),
    attackerVulnerabilities: damageTypeList(attackerSide.vulnerabilities),
    attackerImmunities: damageTypeList(attackerSide.immunities),
    defenderProtections: damageTypeList(defenderSide.protections),
    defenderVulnerabilities: damageTypeList(defenderSide.vulnerabilities),
    defenderImmunities: Object.freeze([...(defenderSide.immunities ?? [])]),
    hitChance: attack.hitChance,
    critChance: attack.critChance,
    damage: String(attack.damage),
    attackCount: attack.attackCount,
    critMultiplier: finite(compiled.attackerCompiled.stats?.critDmg?.total) || 2,
    breakDamage: attack.breakDamage,
    breakVulnerable: attack.damageAffinity === 'effective',
    breakResisted: attack.damageAffinity === 'ineffective',
    effective: attack.effective === true,
    advantage: attack.advantage === true,
    disadvantage: attack.disadvantage === true,
    defender: Object.freeze({
      damageType: String(answer.selectedDamageType ?? ''),
      validDamageTypes: Object.freeze([...combatDamageTypes(defenderSide, attackerSide)]),
      randomizeDamageType: answer.randomizeDamageType === true,
      breakVulnerable: answer.damageAffinity === 'effective',
      breakResisted: answer.damageAffinity === 'ineffective',
      hitChance: answer.hitChance,
      critChance: answer.critChance,
      damage: String(answer.damage),
      attackCount: answer.attackCount,
      critMultiplier: finite(compiled.defenderCompiled.stats?.critDmg?.total) || 2,
      stance: answer.stance.value,
      stanceMax: answer.stance.max,
      hp: answer.hp.value,
      hpMax: answer.hp.max
    }),
    defenderCanRespond: preview.defenderCanRespond === true,
    attackSequence: String(preview.attackSequence ?? ''),
    willBreak: stanceBreaksUnderAttacks({
      breakDamage: attack.breakDamage, stance: answer.stance.value, attackCount: attack.attackCount
    }),
    attackerHp: attack.hp.value,
    attackerHpMax: attack.hp.max
  });
}

/**
 * Terrain and aura effects for the square the attacker is considering, or {} when it stays where it is. Values the
 * caller already read are used as given, and only missing ones are read here, because reading the scene's auras
 * costs more than the measurement itself.
 */
function hypotheticalGround(intent) {
  if (!intent.standing) return {};
  const request = { tokenUuid: String(intent.attackerTokenUuid ?? ''), standing: intent.standing };
  return {
    terrainModifiers: intent.terrainModifiers ?? projectTerrainModifiersAt(request),
    auraFields: intent.auraFields ?? projectAuraFieldsAt(request)
  };
}

/** The weapon the intent names for the defender, its wielded weapon if none is named, or no weapon for null. */
function measuredDefenderWeapon(defender, defenderWeaponId) {
  if (defenderWeaponId === undefined) {
    return collectionValues(defender.items).find(item => item.system?.isWielded === true && isAttackItem(item)) ?? null;
  }
  return defender.items?.get?.(String(defenderWeaponId ?? '')) ?? null;
}

/* -------------------------------------------- */
/*  Planning API: engagement, sight, flanking   */
/* -------------------------------------------- */
/**
 * Whether the unit could attack the target from a square it's considering, and at what distance. Checks range,
 * melee against flyers, elevation for melee, then line of sight, by the same rules as a real attack. For the
 * Enemy AI planner as game.emblemRpg.api.combat.canEngage.
 * @param {object} [intent] tokenUuid, the `standing` square, targetTokenUuid, the weapon's `range`
 *   ({minRange, maxRange}) and the `losRule`.
 * @returns {number|null} The distance it would attack from, or null if it can't attack from there.
 */
export function projectEngagementFrom({
  tokenUuid = '', standing = null, targetTokenUuid = '', range = null, losRule = 'normal'
} = {}) {
  const token = placedToken(tokenUuid);
  const targetToken = placedToken(targetTokenUuid);
  const band = measuredRangeBand(range);
  if (!token?.actor || !targetToken?.actor || !band) return null;
  const gridSize = tokenGridSize(token, 1);
  const footprint = standingFootprint(token, standing, gridSize);
  const distance = footprintDistance(
    footprintCells(footprint.x, footprint.y, footprint.width, footprint.height),
    tokenCells(targetToken, gridSize)
  );
  if (distance < band.minRange || distance > band.maxRange) return null;
  const melee = band.maxRange <= 1;
  const flight = projectFlightReach(token, targetToken);
  if (melee && airborneBeyondMelee(flight)) return null;
  if (melee && !flight.sourceAirborne) {
    const elevations = readTerrainElevations(sceneOf(token));
    const grounded = isInMeleeRange({
      distance: 1,
      sourceElevation: footprintTerrainElevation(footprint, elevations),
      targetElevation: tokenTerrainElevation(targetToken, gridSize, elevations)
    });
    if (!grounded) return null;
  }
  if (projectSightBlockedFrom({ tokenUuid, standing, targetTokenUuid, losRule }) !== false) return null;
  return distance;
}

/**
 * Whether walls or terrain height would block sight to the target from a square the unit is considering. It's
 * the same check projectFoundryAttackTarget makes for a clicked token. Used by projectEngagementFrom, and by the
 * Enemy AI planner as game.emblemRpg.api.combat.sightBlocked.
 * @returns {boolean|null} null if either token can't be found or this client can't test that scene's walls.
 */
export function projectSightBlockedFrom({
  tokenUuid = '', standing = null, targetTokenUuid = '', losRule = 'normal'
} = {}) {
  const token = placedToken(tokenUuid);
  const targetToken = placedToken(targetTokenUuid);
  if (!token?.actor || !targetToken?.actor) return null;
  const rule = resolveActionLosRule(losRule, unitIgnoresLineOfSight(token.actor.flags?.[SYSTEM_ID]));
  if (rule === 'ignoreLoS') return false;
  const gridSize = tokenGridSize(token, 1);
  const footprint = standingFootprint(token, standing, gridSize);
  const sourceCenter = {
    x: (footprint.x + (footprint.width / 2)) * gridSize,
    y: (footprint.y + (footprint.height / 2)) * gridSize
  };
  const walls = testSceneWallCollision(sceneOf(token), sourceCenter, persistedTokenCenter(targetToken, gridSize));
  if (walls !== false) return walls;
  return footprintHeightBlocked({
    losRule: rule,
    sourceCells: footprintCells(footprint.x, footprint.y, footprint.width, footprint.height),
    targetCells: tokenCells(targetToken, gridSize),
    airborne: isAirborneActor(token.actor) || isAirborneActor(targetToken.actor),
    elevations: readTerrainElevations(sceneOf(token))
  });
}

/**
 * Whether the unit would flank its target from a square it's considering, and whether it would be flanked there
 * itself. For the Enemy AI planner as game.emblemRpg.api.combat.flanking.
 * @returns {Readonly<{flanks: boolean, flanked: boolean}>|null} null if the unit's token can't be found.
 */
export function projectFlankingFrom({ tokenUuid = '', standing = null, targetTokenUuid = '' } = {}) {
  const token = placedToken(tokenUuid);
  if (!token?.actor) return null;
  const gridSize = tokenGridSize(token, 1);
  return projectHypotheticalFlanking({
    token,
    standing: standingFootprint(token, standing, gridSize),
    targetToken: placedToken(targetTokenUuid),
    gridSize
  });
}

/* -------------------------------------------- */
/*  Planning API: loadout and usability         */
/* -------------------------------------------- */
/**
 * Everything a unit carries, for the Enemy AI planner (game.emblemRpg.api.combat.loadout). `weapons` lists the
 * attacks it could make, with their ranges and whether each is usable now. `items` lists every item with its
 * targeting, range, uses and usability.
 * @returns {Readonly<{weapons: readonly object[], items: readonly object[]}>|null} null if the token can't be found.
 */
export function projectUnitLoadout(tokenUuid = '') {
  const token = placedToken(tokenUuid);
  const actor = token?.actor ?? null;
  if (!actor) return null;
  const gridSize = tokenGridSize(token, 1);
  const movement = projectMovementSnapshot(token.document ?? token);
  const unit = threatWeaponFacts(actor);
  const weapons = [];
  const items = [];
  for (const item of collectionValues(actor.items)) {
    const usable = shapeUsability(measuredRequirementFacts({
      token, actor, item, targetToken: null, gridSize, movement
    }), spellRankMet(actor, item));
    const weapon = projectLoadoutWeapon(actor, item, unit, usable);
    if (weapon) weapons.push(weapon);
    items.push(projectLoadoutItem(actor, item, usable));
  }
  return Object.freeze({ weapons: Object.freeze(weapons), items: Object.freeze(items) });
}

function projectLoadoutWeapon(actor, item, unit, usable) {
  if (!isAttackItem(item)) return null;
  const projected = projectWeapon(actor, item, wieldingSystem(actor, item));
  const band = parseAttackRange(projected.range);
  if (!band) return null;
  const system = item.system ?? {};
  const uses = system.uses ?? {};
  return Object.freeze({
    id: String(item.id ?? ''),
    uuid: String(item.uuid ?? ''),
    name: String(item.name ?? ''),
    itemType: String(system.itemType ?? ''),
    wielded: system.isWielded === true,
    range: Object.freeze({ minRange: band.minRange, maxRange: band.maxRange }),
    breakDamage: finite(system.weapon?.brk),
    usable: weaponUsableForThreat(threatWeapon(item), unit) && usable.casterOk === true,
    hasUses: uses.type === 'infinite' || finite(uses.current) > 0,
    damageTypes: Object.freeze(enabledFlags(system.weapon?.dmgTypes).filter(type => type !== 'randomize')),
    randomizeDamageType: system.weapon?.dmgTypes?.randomize === true,
    effectiveAgainst: Object.freeze(enabledFlags(system.weapon?.effectiveAgainst)),
    onHitDebuff: hasOnHitDebuff(system.effects ?? [])
  });
}

/**
 * One carried item as the Enemy AI reads it. `range` is {minRange, maxRange}, parsed by parseAttackRange from the
 * range evaluateActivationRange works out for this unit, or null when that range doesn't parse.
 * projectLoadoutWeapon gives a weapon's range the same way.
 */
function projectLoadoutItem(actor, item, usable) {
  const system = item.system ?? {};
  const effect = system.effectData ?? {};
  const uses = system.uses ?? {};
  const band = parseAttackRange(String(evaluateActivationRange(actor.system, effect, item)));
  return Object.freeze({
    id: String(item.id ?? ''),
    uuid: String(item.uuid ?? ''),
    name: String(item.name ?? ''),
    type: String(item.type ?? ''),
    itemType: String(system.itemType ?? ''),
    actionType: String(system.actionType ?? ''),
    targetType: String(effect.targetType ?? ''),
    rangeType: String(effect.rngType ?? ''),
    range: band ? Object.freeze({ minRange: band.minRange, maxRange: band.maxRange }) : null,
    losRule: resolveActionLosRule(effect.losRule, unitIgnoresLineOfSight(actor.flags?.[SYSTEM_ID])),
    usesCurrent: finite(uses.current),
    usesInfinite: uses.type === 'infinite',
    hasUses: uses.type === 'infinite' || finite(uses.current) > 0,
    healAverage: activationHealAverage(system.effects),
    usable: usable.casterOk === true,
    flags: detachedFlags(item.flags)
  });
}

/**
 * Whether a unit can use one of its items, optionally on a given target, for the Enemy AI planner
 * (game.emblemRpg.api.combat.canUse). Checks the item's caster and target requirements and the Spell rank check.
 * A target that Sanctuary protects from this item (sanctuaryBlocksPick in game/targeting/sanctuary.mjs) fails
 * `targetOk`.
 * @returns {Readonly<{ok: boolean, casterOk: boolean, targetOk: boolean, silenced: boolean}>|null} null if the
 *   token or the item can't be found.
 */
export function projectItemUsability({ tokenUuid = '', itemId = '', targetTokenUuid = null } = {}) {
  const token = placedToken(tokenUuid);
  const actor = token?.actor ?? null;
  const item = actor?.items?.get?.(String(itemId ?? '')) ?? null;
  if (!actor || !item) return null;
  const targetToken = targetTokenUuid ? placedToken(targetTokenUuid) : null;
  const gridSize = tokenGridSize(token, 1);
  const shielded = Boolean(targetToken?.actor) && sanctuaryBlocksPick(itemSanctuaryAim(item), actor.uuid, {
    actorUuid: targetToken.actor.uuid, sanctuary: actorInSanctuary(targetToken.actor),
    objectTarget: isDestructibleActor(targetToken.actor)
  });
  const usable = shapeUsability(measuredRequirementFacts({
    token,
    actor,
    item,
    targetToken,
    gridSize,
    movement: projectMovementSnapshot(token.document ?? token)
  }), spellRankMet(actor, item));
  return shielded ? Object.freeze({ ...usable, ok: false, targetOk: false }) : usable;
}

/**
 * Whether the unit's rank in a Spell's school is high enough to cast it, the same check
 * validateActivationLegality makes.
 */
function spellRankMet(actor, item) {
  return resolveSpellRank({
    item: { type: item.type, name: item.name, system: item.system },
    proficiencyTotal: projectProficiency(actor, item).total
  }).ok;
}

/** Check the item's authored caster and target requirements, counting the Spell rank check as a caster one. */
function shapeUsability(facts, rankMet = true) {
  const placement = requirementPlacement(facts.source);
  const caster = checkCaster({
    requirements: facts.requirements,
    caster: facts.source?.conditionSelf ?? null,
    item: { type: facts.itemType, requiredProficiency: facts.requiredProficiency },
    casterPlacement: placement,
    resolveTerrainGeometry: facts.resolveTerrainGeometry
  });
  const targets = checkTargets({
    requirements: facts.requirements,
    caster: facts.source?.conditionSelf ?? null,
    casterPlacement: placement,
    resolveTerrainGeometry: facts.resolveTerrainGeometry,
    targets: facts.targets.map(target => ({
      id: target.tokenUuid,
      name: target.tokenName,
      actor: target.conditionSelf,
      placement: requirementPlacement(target)
    }))
  });
  return Object.freeze({
    ok: caster.ok === true && rankMet && targets.ok === true,
    casterOk: caster.ok === true && rankMet,
    targetOk: targets.ok === true,
    silenced: caster.silenced === true
  });
}

function measuredRequirementFacts({ token, actor, item, targetToken, gridSize, movement }) {
  return projectRequirementFacts({
    item,
    source: measuredRequirementSide(token, actor, item),
    target: targetToken?.actor ? measuredRequirementSide(targetToken, targetToken.actor, null) : null,
    sourceToken: token,
    targetToken,
    movement,
    targetMovement: targetToken ? () => projectMovementSnapshot(targetToken.document ?? targetToken) : null,
    gridSize
  });
}

function measuredRequirementSide(token, actor, item) {
  return {
    conditionSelf: projectFoundryCombatActorContext(actor),
    tokenUuid: String((token.document ?? token).uuid ?? ''),
    actorName: String(actor?.name ?? ''),
    weapon: projectWeapon(actor, item)
  };
}

/** Average healing of the item's first on-use heal step, so the planner can rank healing items without rolling. */
function activationHealAverage(entries) {
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (String(entry?.trigger ?? '') !== 'onActivation') continue;
    for (const step of entry?.action?.steps ?? []) {
      if (step?.kind !== 'heal') continue;
      const average = averageFormulaValue(step.formula);
      if (average !== null) return average;
    }
  }
  return null;
}

/** A frozen copy of the item's flags, so a planner module can read its own flag scope without touching the item. */
function detachedFlags(flags) {
  const copy = clone(flags) ?? {};
  for (const scope of Object.values(copy)) {
    if (scope && typeof scope === 'object') Object.freeze(scope);
  }
  return Object.freeze(copy);
}

function enabledFlags(record) {
  return Object.entries(record ?? {}).filter(([, enabled]) => enabled === true).map(([key]) => key);
}

/** The damage types a side's list or true-flag map names, in the order DAMAGE_TYPES gives them. */
function damageTypeList(value) {
  const named = new Set(Array.isArray(value) ? value : enabledFlags(value));
  return Object.freeze(DAMAGE_TYPES.filter(type => named.has(type)));
}

/**
 * The caller's {minRange, maxRange} as whole numbers, checked by parseAttackRange like any item range, so a range
 * such as 5-2 comes back null instead of slipping past the range check.
 */
function measuredRangeBand(range) {
  const minRange = Math.max(0, Math.floor(finite(range?.minRange)));
  const maxRange = Math.max(0, Math.floor(finite(range?.maxRange)));
  return parseAttackRange(`${minRange}-${maxRange}`);
}

/**
 * The unit's footprint in grid cells, moved to the square it's considering, or where it stands if none is given.
 * Dividing pixels by the grid size by hand is safe because hooks/scene.mjs keeps every Scene at padding 0 on a
 * square or gridless grid; the size is the token's own Scene's (tokenGridSize), not canvas.grid.
 */
function standingFootprint(token, standing, gridSize) {
  const document = token?.document ?? token;
  const width = Math.max(1, Math.round(finite(document?.width) || 1));
  const height = Math.max(1, Math.round(finite(document?.height) || 1));
  if (!standing) {
    return {
      x: Math.floor(finite(document?.x) / gridSize),
      y: Math.floor(finite(document?.y) / gridSize),
      width,
      height
    };
  }
  return { x: Math.floor(finite(standing.x)), y: Math.floor(finite(standing.y)), width, height };
}

/** Engagement and melee reach for an attack made from the square the unit is considering. */
function standingReach(token, footprint, targetToken, distance, gridSize) {
  const elevations = readTerrainElevations(sceneOf(token) ?? sceneOf(targetToken));
  const facts = {
    distance,
    sourceElevation: footprintTerrainElevation(footprint, elevations),
    targetElevation: tokenTerrainElevation(targetToken, gridSize, elevations),
    ...projectFlightReach(token, targetToken)
  };
  return { engagement: resolveEngagement(facts), inMeleeRange: isInMeleeRange(facts) };
}

function sceneOf(token) {
  const document = token?.document ?? token;
  return document?.parent ?? null;
}

/* -------------------------------------------- */
/*  Shared helpers                              */
/* -------------------------------------------- */
/**
 * Look up the live token, actor, weapon and activated item from a targeting context's UUIDs, and check they still
 * belong together: the actor still owns the items, or still stands on the Armament it's using. Returns null if
 * anything has changed since targeting started.
 */
async function resolveContext(context) {
  const source = await resolveSource(context);
  const token = source?.token ?? null;
  const actor = source?.actor ?? null;
  if (!token || !actor || String(actor.uuid ?? '') !== String(context.actorUuid ?? '')) return null;
  const borrowed = projectWieldedArmament(actor);
  const resolveWeapon = async uuid => (borrowed && borrowed.token.uuid === String(uuid ?? '')
    ? borrowed.weapon : fromUuid(uuid));
  const [item, activatedItem] = await Promise.all([
    resolveWeapon(context.itemUuid),
    resolveWeapon(context.activationItemUuid || context.itemUuid)
  ]);
  for (const candidate of [item, activatedItem]) {
    if (isArmamentWeapon(candidate)) {
      if (!standsOn(token, borrowed.token)) return null;
      continue;
    }
    if (candidate?.documentName !== 'Item') return null;
    const owner = candidate.actor ?? (candidate.parent?.documentName === 'Actor' ? candidate.parent : null);
    if (String(owner?.uuid ?? '') !== String(actor.uuid ?? '')) return null;
  }
  const weaponArt = activatedItem.system.itemType === 'Weapon Art' ? activatedItem : null;
  return { token, actor, item, activatedItem, weaponArt };
}

/** Whether the unit still stands on (overlaps) the Armament token it's using. */
function standsOn(token, placedToken) {
  const gridSize = tokenGridSize(token, 0);
  const mine = new Set(tokenCells(token, gridSize).map(cell => `${cell.x},${cell.y}`));
  return tokenCells(placedToken?.object ?? placedToken, gridSize).some(cell => mine.has(`${cell.x},${cell.y}`));
}

/** Weapon Art checks for validateAttackActivation: fits the weapon, has uses, is affordable, caster qualifies. */
function projectWeaponArtFacts(art, weapon, token, actor) {
  if (!art) return Object.freeze({ weaponArtPresent: false });
  const data = art.system?.wepArtData ?? {};
  const family = String(weapon?.system?.weapon?.req ?? '').toLowerCase();
  const cost = Math.max(0, Math.floor(Number(data.cost) || 0));
  const artUses = art.system?.uses ?? {};
  const weaponUses = weapon?.system?.uses ?? {};
  return Object.freeze({
    weaponArtPresent: true,
    weaponArtCompatible: data[family] === true,
    weaponArtUsable: artUses.type === 'infinite' || Number(artUses.current) > 0,
    weaponArtAffordable: weaponUses.type === 'infinite' || Number(weaponUses.current) > cost,
    weaponArtCasterMet: weaponArtCasterMet(token, actor, art, weapon),
    weaponArtCost: cost
  });
}

/**
 * Whether the unit meets the Weapon Art's caster requirements, checked the same way projectAttackRequirements
 * checks them for the exchange, so validateAttackActivation can refuse the art before the grid opens. Target
 * requirements wait until a target is clicked.
 */
function weaponArtCasterMet(token, actor, art, weapon) {
  return shapeUsability(projectRequirementFacts({
    item: art,
    source: measuredRequirementSide(token, actor, weapon),
    target: null,
    sourceToken: token,
    targetToken: null,
    movement: () => projectMovementSnapshot(token.document ?? token),
    gridSize: tokenGridSize(token, 1)
  })).casterOk === true;
}

/** The live token and actor for a targeting context, or null if the token now holds a different actor. */
async function resolveSource(context) {
  const tokenDocument = await fromUuid(context?.tokenUuid);
  const token = tokenDocument?.object ?? tokenDocument;
  const actor = token?.actor ?? null;
  if (!token || !actor || String(actor.uuid ?? '') !== String(context?.actorUuid ?? '')) return null;
  return { token, actor };
}

/** Distance, elevation and flight details for resolveEngagement and isInMeleeRange, between two placed tokens. */
function tokenReach(sourceToken, targetToken, distance, gridSize) {
  const elevations = readTerrainElevations(sourceToken.document?.parent ?? targetToken.document?.parent);
  return {
    distance,
    sourceElevation: tokenTerrainElevation(sourceToken, gridSize, elevations),
    targetElevation: tokenTerrainElevation(targetToken, gridSize, elevations),
    ...projectFlightReach(sourceToken, targetToken)
  };
}

/** Grid distance, in orthogonal steps, between the closest cells of two footprints. */
function footprintDistance(sourceCells, targetCells) {
  let distance = Infinity;
  for (const source of sourceCells) {
    for (const target of targetCells) {
      distance = Math.min(distance, Math.abs(source.x - target.x) + Math.abs(source.y - target.y));
    }
  }
  return Number.isFinite(distance) ? distance : 0;
}

function actorSilenced(actor) {
  return actor?.system?.statuses?.silenced === true || projectActorStatusKeys(actor).has('silenced');
}

function actorInSanctuary(actor) {
  return actor?.system?.statuses?.sanctuary === true || projectActorStatusKeys(actor).has('sanctuary');
}

function refreshBg3Hud() {
  void globalThis.ui?.BG3HUD_APP?.refresh?.({ tokenSwap: true });
}
