/** @layer foundry/adapters/document-writes */
import {
  BUDDING_TALENT,
  CHARACTER_EXPERIENCE_THRESHOLD,
  CHARACTER_MAX_LEVEL,
  LEVEL_UP_STAT_KEYS
} from '../../../contracts/domains/progression.mjs';
import { BUDDING_TALENT_ACTIONS } from '../../../contracts/domains/progression.mjs';
import { SYSTEM_ID , recordDiagnostic } from '../../../contracts/protocol.mjs';
import { resolveAvatarScale } from '../../../game/character/rules.mjs';
import { finite as finiteNumber, whole } from '../../../lib/core/runtime.mjs';
import { worldExperienceMultiplier } from '../services/settings-policy.mjs';
import { reportFoundryError , FoundryDiagnostics } from '../services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Character progression boundary              */
/* -------------------------------------------- */
/**
 * Reads and writes Character experience, levels, skill ranks and the Budding Talent for the progression commands
 * in engine/character/progression.mjs.
 */
export class FoundryProgressionRepository {
  constructor({ unitAudio = null, rollPercentile = foundryPercentile } = {}) {
    this.unitAudio = unitAudio;
    this.rollPercentile = rollPercentile;
  }

  /**
   * A Character's level, experience and per-stat growth values for the progression rules, with a fingerprint
   * commitSettlement uses to spot changes. null for anything but a Character.
   */
  async getCharacterSnapshot(actorUuid) {
    const actor = await fromUuid(actorUuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'actor'); return null; });
    if (!actor || actor.documentName !== 'Actor' || actor.type !== 'Character') return null;
    const stats = Object.fromEntries(LEVEL_UP_STAT_KEYS.map(statKey => {
      const attributeKey = statKey === 'hp' ? 'hpMax' : statKey;
      const attribute = actor.system?.stats?.[attributeKey] ?? {};
      const growth = actor.system?.growth?.[statKey] ?? {};
      const cap = actor.system?.caps?.[statKey] ?? {};
      return [statKey, Object.freeze({
        value: finiteNumber(attribute.base),
        total: finiteNumber(attribute.total, attribute.base),
        classContribution: finiteNumber(attribute.class),
        growthRate: finiteNumber(growth.total, growth.base),
        cap: finiteNumber(cap.total, cap.base)
      })];
    }));
    const buddingTalent = actor.items.find(item => normalizedName(item.name) === normalizedName(BUDDING_TALENT.name));
    const snapshot = {
      actorUuid: actor.uuid,
      actorName: String(actor.name ?? 'Character'),
      actorImage: String(actor.img ?? 'icons/svg/mystery-man.svg'),
      avatarScale: resolveAvatarScale(actor.system?.art?.avatarScale),
      currentLevel: Math.max(1, whole(actor.system?.progression?.level) || 1),
      maxLevel: whole(actor.system?.progression?.maxLevel) || CHARACTER_MAX_LEVEL,
      currentExperience: whole(actor.system?.progression?.experience),
      experienceThreshold: whole(actor.system?.progression?.experienceThreshold) || CHARACTER_EXPERIENCE_THRESHOLD,
      experienceMultiplier: finiteNumber(actor.system?.stats?.expMultiplier?.total, 100),
      worldExperienceMultiplier: worldExperienceMultiplier(),
      stats: Object.freeze(stats),
      hasBuddingTalent: Boolean(buddingTalent),
      classUuids: Object.freeze(actor.items.filter(item => item.type === 'Class').map(item => item.uuid))
    };
    return Object.freeze({ ...snapshot, fingerprint: progressionFingerprint(snapshot) });
  }

  /** One skill's earned rank (its saved base), current total and experience, for a skill experience grant. */
  async getSkillSnapshot(actorUuid, skillKey) {
    const actor = await fromUuid(actorUuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'actor'); return null; });
    if (!actor || actor.documentName !== 'Actor' || actor.type !== 'Character') return null;
    const node = actor.system?.skills?.[skillKey];
    if (!node) return null;
    return Object.freeze({
      actorUuid: actor.uuid,
      actorName: String(actor.name ?? 'Character'),
      skill: Object.freeze({
        base: whole(actor._source?.system?.skills?.[skillKey]?.base),
        total: whole(node.total),
        xp: whole(node.xp)
      })
    });
  }

  /** Save a skill's new earned rank and leftover experience after a grant. Returns whether the write succeeded. */
  async commitSkillExperience(actorUuid, skillKey, plan, { operation = null } = {}) {
    const actor = await fromUuid(actorUuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'actor'); return null; });
    if (!actor || actor.documentName !== 'Actor') return false;
    const changes = {
      [`system.skills.${skillKey}.base`]: plan.base,
      [`system.skills.${skillKey}.xp`]: plan.xp
    };
    await operation?.capture({ documents: [{ document: actor, paths: Object.keys(changes) }] });
    try {
      await actor.update(changes);
      return true;
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'commitSkillExperience');
      return false;
    }
  }

  /** Roll all eight growth checks through Foundry's configured dice engine. */
  async rollGrowths() {
    const entries = [];
    for (const statKey of LEVEL_UP_STAT_KEYS) entries.push([statKey, await this.rollPercentile()]);
    return Object.freeze(Object.fromEntries(entries));
  }

  /**
   * Save an experience gain, with a level-up if one happened. Returns `stale: true` if the Character changed since
   * the snapshot. The Actor fields and the Budding Talent item are recorded in the caller's undo record first, so a
   * failed write is undone when the command is refused.
   */
  async commitSettlement({ snapshot, experience, levelUp = null, operation = null }) {
    const actorUuid = snapshot?.actorUuid;
    const actor = await fromUuid(actorUuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'actor'); return null; });
    if (!actor || actor.documentName !== 'Actor' || actor.type !== 'Character') {
      return Object.freeze({ ok: false, code: 'progression.character-missing' });
    }
    const current = await this.getCharacterSnapshot(actorUuid);
    if (current?.fingerprint !== snapshot?.fingerprint) {
      return Object.freeze({ ok: false, stale: true, code: 'progression.state-changed' });
    }
    const updates = { 'system.progression.experience': whole(experience) };
    if (levelUp?.leveled) {
      updates['system.progression.level'] = whole(levelUp.level);
      for (const stat of levelUp.statUpdates ?? []) {
        const attributeKey = stat.statKey === 'hp' ? 'hpMax' : stat.statKey;
        updates[`system.stats.${attributeKey}.base`] = finiteNumber(stat.value);
      }
    }
    const talent = levelUp?.leveled ? planBuddingTalent(actor, String(levelUp.buddingTalent?.action ?? '')) : null;
    await operation?.capture({
      documents: [{ document: actor, paths: Object.keys(updates) }],
      deleting: talent?.removed ? [talent.removed] : [],
      creating: talent?.createdId ? [{ parent: actor, documentName: 'Item', ids: [talent.createdId] }] : []
    });
    try {
      await actor.update(updates, { emblemProgressionSettlement: true });
      await settleBuddingTalent(actor, talent);
    } catch (diagnosticError) {
      const diagnostic = recordDiagnostic(new FoundryDiagnostics(), {
        sourcePath: 'foundry/adapters/document-writes/progression.mjs', error: diagnosticError,
        detail: 'commitSettlement'
      });
      return Object.freeze({ ok: false, code: 'progression.commit-failed', diagnostic });
    }
    return Object.freeze({ ok: true });
  }

  /** The unit's approved level-up voice line, found by the unit audio service so the engine never sees the Actor. */
  async levelVoiceClip(actorUuid, quality) {
    const actor = await fromUuid(actorUuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'actor'); return null; });
    if (!actor || !this.unitAudio?.levelVoiceClip) return null;
    return this.unitAudio.levelVoiceClip(actor, quality);
  }
}

/* -------------------------------------------- */
/*  Progression persistence helpers             */
/* -------------------------------------------- */


function progressionFingerprint(snapshot) {
  return JSON.stringify({
    actorUuid: snapshot.actorUuid,
    currentLevel: snapshot.currentLevel,
    currentExperience: snapshot.currentExperience,
    stats: snapshot.stats,
    hasBuddingTalent: snapshot.hasBuddingTalent,
    classUuids: snapshot.classUuids
  });
}

/**
 * What a level-up does to the Budding Talent: the item it removes, or a new id for the one it grants. null if
 * nothing changes. commitSettlement records it for undo before it writes.
 */
function planBuddingTalent(actor, action) {
  const existing = actor.items.find(item => normalizedName(item.name) === normalizedName(BUDDING_TALENT.name));
  if (action === BUDDING_TALENT_ACTIONS.REMOVE && existing) return { removed: existing, createdId: '' };
  if (action === BUDDING_TALENT_ACTIONS.GAIN && !existing) {
    return { removed: null, createdId: foundry.utils.randomID() };
  }
  return null;
}

async function settleBuddingTalent(actor, talent) {
  if (talent?.removed) await actor.deleteEmbeddedDocuments('Item', [talent.removed.id], {});
  else if (talent?.createdId) {
    await actor.createEmbeddedDocuments('Item', [{ ...buddingTalentData(), _id: talent.createdId }], { keepId: true });
  }
}



function buddingTalentData() {
  return {
    name: BUDDING_TALENT.name,
    type: 'Ability',
    img: `systems/${SYSTEM_ID}/assets/abilities/passive/Budding Talent.png`,
    system: {
      itemType: 'Passive',
      description: BUDDING_TALENT.description
    }
  };
}

async function foundryPercentile() {
  const roll = await new Roll('1d100').evaluate();
  return Math.max(1, Math.min(100, whole(roll.total)));
}

function normalizedName(value) {
  return String(value ?? '').trim().toLowerCase();
}

