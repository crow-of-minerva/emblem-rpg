/** @layer config */

/* -------------------------------------------- */
/*  Vocabulary                                  */
/* -------------------------------------------- */

/** How each effect trigger reads and the icon that stands for it, as `[label, icon]`. */
export const TRIGGER_PRESENTATION = Object.freeze({
  preCombat: ['Pre-Combat', 'fas fa-hourglass-start'], onHit: ['On Hit', 'fas fa-bullseye'],
  onCrit: ['On Crit', 'fas fa-burst'], onHitOrCrit: ['On Hit/Crit', 'fas fa-bolt'],
  onMiss: ['On Miss', 'fas fa-times-circle'], onStruck: ['On Struck', 'fas fa-shield-halved'],
  onEvade: ['On Evade', 'fas fa-person-running'], postCombat: ['Post-Combat', 'fas fa-hourglass-end'],
  onKill: ['On Kill', 'fas fa-skull'], onActivation: ['Activation', 'fas fa-wand-sparkles'],
  onFailedSave: ['Fail Save', 'fas fa-shield-slash'],
  onSucceedSave: ['Pass Save', 'fas fa-shield-halved'],
  onFailedCheck: ['Fail Check', 'fas fa-dice-d20'],
  onSucceedCheck: ['Pass Check', 'fas fa-dice-d20'],
  onPhaseBegin: ['Phase Begin', 'fas fa-play'],
  onPhaseEnd: ['Phase End', 'fas fa-stop'], onDeath: ['On Death', 'fas fa-skull'],
  onUseItem: ['On Use Item', 'fas fa-flask']
});

/** How a trigger reads, falling back to its own key for one with no presentation entry. */
export function triggerLabel(key) {
  return TRIGGER_PRESENTATION[key]?.[0] ?? key;
}

/** The icon that stands for a trigger, falling back to the generic bolt. */
export function triggerIcon(key) {
  return TRIGGER_PRESENTATION[key]?.[1] ?? 'fas fa-bolt';
}
