/** @layer config */

/* -------------------------------------------- */
/*  Vocabulary                                  */
/* -------------------------------------------- */

/** How each effect trigger reads on the item sheet and in the effect editor. */
export const TRIGGER_LABELS = Object.freeze({
  preCombat: 'Pre-Combat', onHit: 'On Hit', onCrit: 'On Crit', onHitOrCrit: 'On Hit/Crit', onMiss: 'On Miss',
  onStruck: 'On Struck', onEvade: 'On Evade', postCombat: 'Post-Combat', onKill: 'On Kill',
  onActivation: 'Activation', onFailedSave: 'Fail Save', onSucceedSave: 'Pass Save', onFailedCheck: 'Fail Check',
  onSucceedCheck: 'Pass Check', onPhaseBegin: 'Phase Begin', onPhaseEnd: 'Phase End', onDeath: 'On Death',
  onUseItem: 'On Use Item'
});

/** How a trigger reads, falling back to its own key for one with no label. */
export function triggerLabel(key) {
  return TRIGGER_LABELS[key] ?? key;
}
