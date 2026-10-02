/** @layer engine/character */
import { recordAbsorbed } from '../feedback.mjs';

/**
 * Grant skill XP through the GRANT_SKILL_EXPERIENCE child command (`services.skills`, wired in init/system.mjs).
 * A failure is recorded and doesn't undo the action that earned the XP.
 * @param {object} services The calling command's services; only `skills` and `diagnostics` are read.
 * @param {string} actorUuid The unit earning the XP.
 * @param {string} skillKey The skill it goes to.
 * @param {number|{amount: number}} [share] A fraction of the current rank bar, or `{ amount }` for a flat XP amount.
 *   Left out, the child command grants its standard per-roll amount.
 * @param {object} [context] The running command's context, so the grant shares its undo record.
 * @returns {Promise<boolean>} Whether the grant went through.
 */
export async function grantSkillExperience(services, actorUuid, skillKey, share = undefined, context = {}) {
  if (!skillKey) return false;
  const detail = `skill-experience:${skillKey}`;
  try {
    const granted = await services.skills.grant({ actorUuid, skillKey, ...experienceShare(share) }, context);
    if (granted.ok !== false) return true;
    recordAbsorbed(services, new Error(`skill-experience.refused:${String(granted.code ?? '')}`), detail);
    return false;
  } catch (error) {
    recordAbsorbed(services, error, detail);
    return false;
  }
}

/** The share as the child command in engine/character/progression.mjs reads it: `fraction` or a flat `amount`. */
function experienceShare(share) {
  if (share === undefined) return {};
  if (share !== null && typeof share === 'object') return { amount: share.amount };
  return { fraction: share };
}
