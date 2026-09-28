/** @layer engine/effects */
import { effectAttributeShorthands } from '../../game/effects/planning.mjs';

/**
 * Build the actor, target and position runtime passed to EffectExecutionService. The phase change
 * (encounters/phases.mjs), the combat exchange (exchanges/settlement.mjs) and item activation build one.
 *
 * `operation` is the dispatcher operation the calling command holds (`context.operation`). Every effect writer in
 * foundry/adapters/document-writes/effect-execution.mjs captures through it before it changes anything.
 *
 * `slainActorUuids` names the units a killing blow has just claimed. EffectExecutionService spares them every write.
 * @param {object} input Scene, both sides, and the placement facts an authored step may read.
 * @returns {Readonly<object>}
 */
export function effectRuntime({
  sceneUuid,
  operation = null,
  self,
  target = null,
  targetLocation = null,
  effectTiles = null,
  prePickedPlacement = null,
  effectRange = 0,
  healEchoes = null,
  activatedItemUuid = '',
  slainActorUuids = null
}) {
  return Object.freeze({
    sceneUuid,
    operation,
    self: Object.freeze({ actorUuid: self.actorUuid ?? '', tokenUuid: self.tokenUuid ?? '' }),
    target: Object.freeze({
      actorUuid: target?.actorUuid ?? self.actorUuid ?? '',
      tokenUuid: target?.tokenUuid ?? self.tokenUuid ?? ''
    }),
    targetLocation,
    effectTiles,
    prePickedPlacement,
    effectRange: Number(effectRange) || 0,
    healEchoes: healEchoes ?? Object.freeze([]),
    activatedItemUuid: String(activatedItemUuid ?? ''),
    slainActorUuids: Object.freeze((slainActorUuids ?? []).map(String).filter(Boolean))
  });
}

/**
 * Build the DSL aliases and shorthand values consumed by effect planning and execution.
 * @param {object|null} selfActor Acting unit's condition facts.
 * @param {object|null} targetActor Target's condition facts.
 * @param {object|null} item Item the effect is running from.
 * @param {object} [extra] Caller-specific facts, which win over the shorthands.
 * @returns {Readonly<object>}
 */
export function effectContext(selfActor, targetActor, item, extra = {}) {
  return Object.freeze({
    ...(selfActor ?? {}),
    self: selfActor,
    target: targetActor ?? selfActor?.target ?? null,
    caster: selfActor,
    actor: selfActor,
    item,
    ...effectAttributeShorthands(selfActor, targetActor),
    ...extra
  });
}
