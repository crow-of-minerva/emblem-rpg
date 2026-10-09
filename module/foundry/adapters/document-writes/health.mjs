/** @layer foundry/adapters/document-writes */
import { DEFEAT_STATUSES, DAMAGE_TYPES } from '../../../contracts/domains/damage.mjs';
import { GUARD_BOND_BREAKS } from '../../../contracts/domains/combat.mjs';
import { SYSTEM_ID, recordDiagnostic, diagnosticData } from '../../../contracts/protocol.mjs';
import { resolveArmorWear } from '../../../game/combat/damage.mjs';
import { resolveTargetKind, TARGET_KINDS } from '../../../game/objects/rules.mjs';
import { wornArmor } from '../projections/combat-context.mjs';
import { beforeImage, forcedDeletion, resolveActor, resolveItem } from '../services/host.mjs';
import { worldPlayerCriticalBonusScale } from '../services/settings-policy.mjs';
import { finite, roundToHalf, structurallyEqual, whole } from '../../../lib/core/runtime.mjs';
import { reportFoundryError , FoundryDiagnostics } from '../services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Defeat persistence                          */
/* -------------------------------------------- */
const DEFEAT_PENDING_FLAG = 'defeatPending';
const settlementOptions = () => ({ emblemHealthSettlement: true });

/** Armor wear is the only field a health write touches on the worn Item, so only that field is saved for undo. */
const ARMOR_WEAR_PATHS = Object.freeze(['system.uses']);


/* -------------------------------------------- */
/*  Actor health boundary                       */
/* -------------------------------------------- */
/**
 * Reads a unit's health and writes damage, healing and defeat, by Actor and Token UUID, for combat, effects and the
 * damage and healing commands.
 *
 * Every write first saves the old values on the `operation` its caller passes (the command's undo record), and
 * CommandDispatcher keeps or undoes them. Without an operation, the writes go ahead with no undo.
 */
export class FoundryHealthRepository {
  constructor({ tokens, unitAudio = null, guardBonds = null }) {
    this.tokens = tokens;
    this.unitAudio = unitAudio;
    this.guardBonds = guardBonds;
  }

  /**
   * The unit's resources, defenses and worn armor as plain rule input, with a fingerprint the writes use to spot
   * changes. null if the Token doesn't belong to the Actor, or the Actor is scenery.
   */
  async getSnapshot(actorUuid, tokenUuid) {
    const actor = await resolveActor(actorUuid);
    const token = await this.tokens.document(tokenUuid);
    if (!actor || !token || token.actor?.uuid !== actor.uuid || !supportedActor(actor, token)) return null;

    const armor = actor.type === 'Character' ? wornArmor(actor) : null;
    const target = targetProjection(actor, armor);
    const armorProjection = armor ? Object.freeze({
      itemUuid: armor.uuid,
      current: whole(armor.system?.uses?.current),
      maximum: whole(armor.system?.uses?.max),
      limited: armor.system?.uses?.type !== 'infinite',
      vulnerabilities: Object.freeze(enabledKeys(armor.system?.armor?.vulns))
    }) : null;
    const snapshot = {
      actorUuid: actor.uuid,
      actorName: String(actor.name ?? 'Actor'),
      tokenUuid: token.uuid,
      target,
      armor: armorProjection,
      extraLives: actor.type === 'Character' ? whole(actor.system?.special?.extraLives?.value) : 0,
      defeatPending: token.getFlag(SYSTEM_ID, DEFEAT_PENDING_FLAG) === true
    };
    return Object.freeze({ ...snapshot, fingerprint: fingerprint(snapshot) });
  }

  /** Save damage and armor wear, after saving the Actor, its armor and its Token on the operation for undo. */
  async commitDamage(snapshot, resolution, settlement = null) {
    const aggregate = await this.#aggregate(snapshot);
    if (aggregate.failure) return aggregate.failure;
    const { actor, token, armor } = aggregate;

    const armorCurrent = snapshot.armor ? resolveArmorWear({
      damage: resolution.amount,
      damageType: resolution.damageType,
      armor: snapshot.armor
    }) : null;
    const defeatStatus = resolution.defeated === true && snapshot.defeatPending !== true
      ? (snapshot.extraLives > 0 ? DEFEAT_STATUSES.EXTRA_LIFE : DEFEAT_STATUSES.CLAIMED)
      : null;
    const finalResources = defeatStatus === DEFEAT_STATUSES.EXTRA_LIFE
      ? {
          hp: snapshot.target.hpMax,
          stance: snapshot.target.stanceMax,
          shield: resolution.shieldAfter,
          extraLives: snapshot.extraLives - 1
        }
      : {
          hp: resolution.hpAfter,
          stance: resolution.stanceAfter,
          shield: resolution.shieldAfter,
          extraLives: snapshot.extraLives
        };
    const plan = {
      resources: healthResourceUpdates(actor, finalResources),
      armorCurrent: armor && armorCurrent !== snapshot.armor.current ? armorCurrent : null,
      defeatPending: snapshot.defeatPending === true || defeatStatus === DEFEAT_STATUSES.CLAIMED
    };
    const opened = await this.#open(snapshot, aggregate, plan, settlement);
    if (opened.ok !== true) return opened;

    try {
      await actor.update(plan.resources, settlementOptions());
      if (plan.armorCurrent !== null) {
        await armor.update({ 'system.uses.current': plan.armorCurrent }, settlementOptions());
      }
      // The defeat flag goes on the Token, since the Token is what finishDefeat removes once the defeat is shown.
      if (plan.defeatPending && !snapshot.defeatPending) {
        await token.update({ [`flags.${SYSTEM_ID}.${DEFEAT_PENDING_FLAG}`]: true });
      }
      if (!healthWritesApplied(actor, token, armor, plan)) throw new Error('health.damage-write-refused');
      return Object.freeze({
        ok: true,
        armorCurrent,
        defeatStatus,
        defeatVoice: defeatStatus === DEFEAT_STATUSES.CLAIMED ? await this.#defeatVoice(actor.uuid) : '',
        hpAfter: finalResources.hp,
        stanceAfter: finalResources.stance,
        extraLivesAfter: finalResources.extraLives
      });
    } catch (diagnosticError) {
      const diagnostic = recordDiagnostic(new FoundryDiagnostics(), {
        sourcePath: 'foundry/adapters/document-writes/health.mjs', error: diagnosticError, detail: 'commitDamage'
      });
      return failed('health.damage-commit-failed', diagnostic);
    }
  }

  /** The slain unit's defeat line, chosen on the host so every client hears the same clip. */
  async #defeatVoice(actorUuid) {
    try {
      return String(await this.unitAudio?.voiceCategoryClip?.(actorUuid, 'defeat') ?? '');
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'defeatVoice');
      return '';
    }
  }

  /** Save a clamped heal, after checking the unit's health hasn't changed since it was read. */
  async commitHealing(snapshot, resolution, settlement = null) {
    const aggregate = await this.#aggregate(snapshot, false);
    if (aggregate.failure) return aggregate.failure;
    const { actor, token } = aggregate;

    const plan = {
      resources: healthResourceUpdates(actor, {
        hp: resolution.hpAfter,
        stance: resolution.stanceAfter,
        shield: snapshot.target.shield,
        extraLives: snapshot.extraLives
      }),
      armorCurrent: null,
      defeatPending: snapshot.defeatPending === true && !(resolution.hpAfter > 0)
    };
    const opened = await this.#open(snapshot, aggregate, plan, settlement);
    if (opened.ok !== true) return opened;

    try {
      await actor.update(plan.resources, settlementOptions());
      if (snapshot.defeatPending && resolution.hpAfter > 0) {
        await token.update(forcedDeletion(`flags.${SYSTEM_ID}.${DEFEAT_PENDING_FLAG}`));
      }
      if (!healthWritesApplied(actor, token, null, plan)) throw new Error('health.heal-write-refused');
      return Object.freeze({ ok: true });
    } catch (diagnosticError) {
      const diagnostic = recordDiagnostic(new FoundryDiagnostics(), {
        sourcePath: 'foundry/adapters/document-writes/health.mjs', error: diagnosticError, detail: 'commitHealing'
      });
      return failed('health.heal-commit-failed', diagnostic);
    }
  }

  /** Check a pending defeat again after the hit is shown, and clear it if the unit has since risen above 0 HP. */
  async revalidateDefeat(actorUuid, tokenUuid, { operation = null } = {}) {
    const actor = await resolveActor(actorUuid);
    const token = await this.tokens.document(tokenUuid);
    if (!token) return Object.freeze({ ok: true, status: DEFEAT_STATUSES.ALREADY_DEFEATED });
    if (!actor || token.actor?.uuid !== actor.uuid) return failed('health.defeat-aggregate-missing');
    const pending = token.getFlag(SYSTEM_ID, DEFEAT_PENDING_FLAG) === true;
    if (resourceHp(actor) > 0) {
      if (pending) {
        try {
          await operation?.capture({ documents: [token] });
          await token.update(forcedDeletion(`flags.${SYSTEM_ID}.${DEFEAT_PENDING_FLAG}`));
        } catch (diagnosticError) {
          reportFoundryError(import.meta.url, diagnosticError, 'revalidateDefeat');
          return failed('health.defeat-release-failed');
        }
      }
      return Object.freeze({ ok: true, status: DEFEAT_STATUSES.SURVIVED });
    }
    return Object.freeze({
      ok: true,
      status: pending ? DEFEAT_STATUSES.CLAIMED : DEFEAT_STATUSES.ALREADY_DEFEATED
    });
  }

  /**
   * Remove a Token that is still defeated once its defeat has been shown. The Guard bond effects on both partners
   * and the Token itself are saved for undo on the caller's operation in one call
   * (FoundryGuardBondRepository.breakCaptures lists them), so a refused command puts the unit back exactly as it
   * stood and the bond break needs no undo save of its own.
   */
  async finishDefeat(actorUuid, tokenUuid, { operation = null } = {}) {
    const actor = await resolveActor(actorUuid);
    const token = await this.tokens.document(tokenUuid);
    if (!token) return Object.freeze({ ok: true, status: DEFEAT_STATUSES.ALREADY_DEFEATED, removed: true });
    if (!actor || token.actor?.uuid !== actor.uuid) return failed('health.defeat-aggregate-missing');
    if (resourceHp(actor) > 0) {
      try {
        if (token.getFlag(SYSTEM_ID, DEFEAT_PENDING_FLAG) === true) {
          await operation?.capture({ documents: [token] });
          await token.update(forcedDeletion(`flags.${SYSTEM_ID}.${DEFEAT_PENDING_FLAG}`));
        }
      } catch (diagnosticError) {
        reportFoundryError(import.meta.url, diagnosticError, 'finishDefeat');
        return failed('health.defeat-release-failed');
      }
      return Object.freeze({ ok: true, status: DEFEAT_STATUSES.SURVIVED, removed: false });
    }
    if (token.getFlag(SYSTEM_ID, DEFEAT_PENDING_FLAG) !== true) {
      return Object.freeze({ ok: true, status: DEFEAT_STATUSES.ALREADY_DEFEATED, removed: false });
    }
    try {
      const bond = this.guardBonds?.breakCaptures?.(token) ?? { documents: [], deleting: [] };
      await operation?.capture({ documents: bond.documents, deleting: [...bond.deleting, token] });
      await this.guardBonds?.breakFor(token.uuid, GUARD_BOND_BREAKS.FELL, { operation });
      await token.delete();
      if (await this.tokens.document(tokenUuid)) return failed('health.defeat-removal-failed');
      return Object.freeze({ ok: true, status: DEFEAT_STATUSES.CLAIMED, removed: true });
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'finishDefeat');
      return failed('health.defeat-removal-failed');
    }
  }

  /* ---------------------------------------- */
  /*  Re-read and undo                        */
  /* ---------------------------------------- */

  async #aggregate(snapshot, withArmor = true) {
    const current = await this.getSnapshot(snapshot.actorUuid, snapshot.tokenUuid);
    if (!current) return { failure: failed('health.actor-or-token-missing') };
    if (current.fingerprint !== snapshot.fingerprint) return { failure: Object.freeze({ ok: false, stale: true }) };
    const actor = await resolveActor(snapshot.actorUuid);
    const token = await this.tokens.document(snapshot.tokenUuid);
    const armor = withArmor && snapshot.armor?.itemUuid ? await resolveItem(snapshot.armor.itemUuid) : null;
    if (!actor || !token) return { failure: failed('health.aggregate-missing') };
    if (withArmor && snapshot.armor && !armor) return { failure: failed('health.aggregate-missing') };
    return { actor, token, armor };
  }

  /**
   * Save for undo, in one call, the old values of what this hit or heal writes: the Actor, the worn armor's uses when
   * they change, and the Token when its defeat flag changes. Always returns ok. A failed save throws.
   */
  async #open(snapshot, aggregate, plan, settlement) {
    const documents = [aggregate.actor];
    if (plan.armorCurrent !== null && aggregate.armor) {
      documents.push({ document: aggregate.armor, paths: ARMOR_WEAR_PATHS });
    }
    if (plan.defeatPending !== (snapshot.defeatPending === true)) documents.push(aggregate.token);
    await settlement?.operation?.capture({ documents });
    return { ok: true };
  }
}

/* -------------------------------------------- */
/*  Health data                                 */
/* -------------------------------------------- */
/**
 * The health values a blow on this unit is resolved against, read off the Actor as it is prepared right now.
 * getSnapshot reads them outside any combat context, for the write and its fingerprint.
 * projections/combat-exchange.mjs reads them again under withFoundryCombatContext, so a maximum, protection or
 * immunity that holds only in the fight counts there.
 * @param {Actor} actor A Character or a Destructible.
 * @returns {Readonly<object>}
 */
export function projectHealthTarget(actor) {
  return targetProjection(actor, actor.type === 'Character' ? wornArmor(actor) : null);
}

function targetProjection(actor, armor) {
  if (actor.type === 'Object') {
    return Object.freeze({
      actorType: String(actor.system?.faction?.role ?? ''),
      destructible: actor.system?.objectType === 'Destructible',
      hp: whole(actor.system?.resources?.hp?.value),
      hpMax: whole(actor.system?.resources?.hp?.max),
      stance: roundToHalf(actor.system?.resources?.stn?.value),
      stanceMax: roundToHalf(actor.system?.resources?.stn?.max),
      shield: 0,
      lastStand: lastStandRaised(actor),
      healingBlocked: hasStatus(actor, 'CorpseRot'),
      protections: Object.freeze(enabledKeys(actor.system?.prots)),
      vulnerabilities: Object.freeze(enabledKeys(actor.system?.vulns)),
      authoredVulnerabilities: Object.freeze(enabledKeys(actor.system?.vulns)),
      immunities: Object.freeze(enabledKeys(actor.system?.imms)),
      breakReduction: 0,
      defenseTotal: finite(actor.system?.stats?.def?.total),
      defenseArmor: 0,
      resistanceTotal: finite(actor.system?.stats?.res?.total),
      resistanceArmor: 0,
      hasArmor: false,
      armorDefense: 0,
      armorResistance: 0
    });
  }

  const protections = enabledKeys(actor.system?.equipment?.prots);
  const authoredVulnerabilities = enabledKeys(actor.system?.equipment?.vulns);
  const vulnerabilities = armor ? authoredVulnerabilities : [...DAMAGE_TYPES];
  return Object.freeze({
    actorType: String(actor.system?.faction?.role ?? ''),
    destructible: false,
    hp: whole(actor.system?.resources?.hp?.value),
    hpMax: whole(actor.system?.resources?.hp?.max),
    stance: roundToHalf(actor.system?.resources?.stn?.value),
    stanceMax: roundToHalf(actor.system?.resources?.stn?.max),
    shield: whole(actor.system?.resources?.shields?.value),
    lastStand: lastStandRaised(actor),
    healingBlocked: hasStatus(actor, 'CorpseRot'),
    protections: Object.freeze(protections),
    vulnerabilities: Object.freeze(vulnerabilities),
    authoredVulnerabilities: Object.freeze(authoredVulnerabilities),
    immunities: Object.freeze(enabledKeys(actor.system?.equipment?.imms)),
    breakReduction: finite(actor.system?.stats?.brkRed?.total),
    defenseTotal: finite(actor.system?.stats?.def?.total),
    defenseArmor: finite(armor?.system?.armor?.def),
    resistanceTotal: finite(actor.system?.stats?.res?.total),
    resistanceArmor: finite(armor?.system?.armor?.res),
    hasArmor: Boolean(armor),
    armorDefense: finite(armor?.system?.armor?.def),
    armorResistance: finite(armor?.system?.armor?.res),
    criticalBonusScale: worldPlayerCriticalBonusScale()
  });
}

function lastStandRaised(actor) {
  return actor.system?.statuses?.lastStand === true || hasStatus(actor, 'LastStand');
}

function hasStatus(actor, statusId) {
  const normalized = String(statusId).toLowerCase();
  return [...actor.effects].some(effect => !effect.disabled
    && [...effect.statuses].some(status => String(status).toLowerCase() === normalized));
}

/* -------------------------------------------- */
/*  Foundry lookup                              */
/* -------------------------------------------- */

/**
 * Only a Character or a Destructible has health the system tracks. Every other Actor is scenery, and so is a
 * Destructible whose Token is hidden, which nothing damages until it is revealed.
 */
function supportedActor(actor, token = null) {
  return resolveTargetKind({
    documentType: actor?.type, objectType: actor?.system?.objectType, hidden: token?.hidden === true
  }) !== TARGET_KINDS.SCENERY;
}

/** Whether the planned values were saved. A preUpdate hook can veto a write without throwing, so each is read back. */
function healthWritesApplied(actor, token, armor, plan) {
  return structurallyEqual(beforeImage(actor, Object.keys(plan.resources)), plan.resources)
    && (plan.armorCurrent === null || armor?._source?.system?.uses?.current === plan.armorCurrent)
    && (token.getFlag(SYSTEM_ID, DEFEAT_PENDING_FLAG) === true) === plan.defeatPending;
}

function resourceHp(actor) {
  return whole(actor.system?.resources?.hp?.value);
}

function enabledKeys(map) {
  return Object.entries(map ?? {}).filter(([, enabled]) => enabled === true).map(([key]) => key);
}

function fingerprint(snapshot) {
  return JSON.stringify({
    target: snapshot.target,
    armor: snapshot.armor,
    tokenUuid: snapshot.tokenUuid,
    extraLives: snapshot.extraLives,
    defeatPending: snapshot.defeatPending
  });
}

function failed(code, diagnostic = null) {
  return Object.freeze({ ...diagnosticData(diagnostic), ok: false, code });
}

/** The resource paths one hit or heal writes: a Destructible carries neither shields nor Extra Lives. */
function healthResourceUpdates(actor, values) {
  if (actor.type === 'Character') {
    return {
      'system.resources.hp.value': values.hp,
      'system.resources.stn.value': values.stance,
      'system.resources.shields.value': values.shield,
      'system.special.extraLives.value': values.extraLives
    };
  }
  return {
    'system.resources.hp.value': values.hp,
    'system.resources.stn.value': values.stance
  };
}
