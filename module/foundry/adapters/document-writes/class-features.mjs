/** @layer foundry/adapters/document-writes */
import { SYSTEM_ID , recordDiagnostic } from '../../../contracts/protocol.mjs';
import { clone, forcedDeletion } from '../services/host.mjs';
import { PROMOTION_TURN_SPENT } from '../../../contracts/domains/progression.mjs';
import { classStateFingerprint, projectPromotionPreview } from '../projections/characters.mjs';
import { reportFoundryError , FoundryDiagnostics } from '../services/diagnostics.mjs';

const STRAY_ITEM_ID = /^Item\.([^.]+)$/;

/** The value a grant records under `classChoices` for every bundle it resolves. */
const RECORDED_CHOICE = true;

/* -------------------------------------------- */
/*  Class feature persistence                   */
/* -------------------------------------------- */
/**
 * Reads and writes a Character's Class, the features it grants and the items that promote it, for the class and
 * promotion commands in engine/character/progression.mjs.
 */
export class FoundryClassFeatureRepository {
  /**
   * The UUID of the Actor that owns a Class item, or '' if none does. The class commands call this while building
   * CommandDispatcher's lock keys, so it runs synchronously and never throws. A Class inside a compendium Actor
   * can't be read synchronously, so it reports no owner and the lock key falls back to the class UUID.
   */
  actorUuidForClass(classUuid) {
    let classItem = null;
    try {
      classItem = fromUuidSync(classUuid);
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'actorUuidForClass');
      return '';
    }
    return classItem?.documentName === 'Item' && classItem.type === 'Class'
      ? String(classItem.parent?.uuid ?? '')
      : '';
  }

  /**
   * What reconcileAutomaticClassFeatures needs to grant a Class's automatic features: the unit's level and items,
   * the bundles already recorded under `classChoices`, and the Class's bundles. null unless the Class is on a world
   * Character.
   */
  async getAutomaticGrantSnapshot(classUuid) {
    const classItem = await fromUuid(classUuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'classItem'); return null; });
    const actor = classItem?.parent;
    if (!classItem || classItem.documentName !== 'Item' || classItem.type !== 'Class') return null;
    if (!actor || actor.documentName !== 'Actor' || actor.type !== 'Character') return null;
    // Actors in compendiums are authoring stock, so only the world's units get automatic features.
    if (actor.pack) return null;
    return Object.freeze({
      actorUuid: actor.uuid,
      classUuid: classItem.uuid,
      classId: classItem.id,
      actorLevel: Number(actor.system?.progression?.level) || 1,
      actorItems: Object.freeze([...actor.items].map(itemProjection)),
      recordedBundles: Object.freeze(foundry.utils.deepClone(actor.flags?.[SYSTEM_ID]?.classChoices?.[classItem.id] ?? {})),
      bundles: Object.freeze(foundry.utils.deepClone(Array.from(classItem.system.features))),
      fingerprint: classStateFingerprint(actor)
    });
  }

  /**
   * What a player's pick from one feature bundle needs: the bundle, the picked indices, whether a choice is already
   * recorded, and the unit's level and items. null if the Class, its Character or the bundle is missing.
   */
  async getSelectionSnapshot(classUuid, bundleId, selectedIndices) {
    const classItem = await fromUuid(classUuid);
    const actor = classItem?.parent;
    if (!classItem || classItem.documentName !== 'Item' || classItem.type !== 'Class') return null;
    if (!actor || actor.documentName !== 'Actor' || actor.type !== 'Character') return null;
    const bundle = foundry.utils.deepClone(
      Array.from(classItem.system.features).find(entry => entry._id === bundleId)
    );
    if (!bundle) return null;
    return Object.freeze({
      actorUuid: actor.uuid,
      classUuid: classItem.uuid,
      classId: classItem.id,
      actorName: actor.name,
      actorLevel: Number(actor.system?.progression?.level) || 1,
      actorItems: Object.freeze([...actor.items].map(itemProjection)),
      choiceRecorded: Boolean(actor.flags?.[SYSTEM_ID]?.classChoices?.[classItem.id]?.[bundle._id]),
      selectedIndices: Object.freeze(Array.from(selectedIndices ?? [])),
      bundle: Object.freeze(bundle),
      fingerprint: classStateFingerprint(actor)
    });
  }

  /** What the unit's promotion depends on, from projectPromotionPreview, which the Promotion window also uses. */
  async getPromotionSnapshot(actorUuid, options = {}) {
    return projectPromotionPreview(actorUuid, options);
  }

  /** What swapping a unit's Class needs: its items, its current Class and that Class's bundles, and the new Class. */
  async getClassReplacementSnapshot(actorUuid, newClassData) {
    const actor = await fromUuid(actorUuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'actor'); return null; });
    if (!actor || actor.documentName !== 'Actor' || actor.type !== 'Character') return null;
    const oldClass = [...actor.items].find(item => item.type === 'Class') ?? null;
    return Object.freeze({
      actorUuid: actor.uuid,
      actorName: actor.name,
      actorItems: Object.freeze([...actor.items].map(itemProjection)),
      oldClass: oldClass ? Object.freeze({
        id: oldClass.id,
        name: oldClass.name,
        type: oldClass.type,
        system: Object.freeze({
          features: Object.freeze(foundry.utils.deepClone(Array.from(oldClass.system.features)))
        })
      }) : null,
      newClassData: Object.freeze(foundry.utils.deepClone(newClassData)),
      fingerprint: classStateFingerprint(actor)
    });
  }

  /**
   * Swap a unit's Class: remove the old Class and the features it granted, then create the new Class under an id
   * made here. Every removed item and the new id are saved on `plan.operation` (the command's undo record) before
   * the first write. Returns `stale: true` if the unit's class state changed since it was read.
   */
  async commitClassReplacement(plan) {
    const actor = await fromUuid(plan.actorUuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'actor'); return null; });
    if (!actor || actor.documentName !== 'Actor' || actor.type !== 'Character') {
      return Object.freeze({ ok: false, code: 'class.actor-missing' });
    }
    if (classStateFingerprint(actor) !== plan.expectedFingerprint) {
      return Object.freeze({ ok: false, stale: true, code: 'class.state-changed' });
    }
    const deleteIds = [...new Set([plan.oldClassId, ...(plan.removalIds ?? [])].filter(Boolean))];
    const removed = deleteIds.map(id => actor.items.get(id)).filter(Boolean);
    const removedFeatureNames = removed.filter(item => item.type !== 'Class').map(item => String(item.name ?? ''));
    const createdId = foundry.utils.randomID();
    const data = { ...clone(plan.newClassData), _id: createdId };
    await plan.operation?.capture({
      deleting: removed,
      creating: [{ parent: actor, documentName: 'Item', ids: [createdId] }]
    });
    let created = [];
    try {
      if (deleteIds.length) await actor.deleteEmbeddedDocuments('Item', deleteIds, {});
      created = await actor.createEmbeddedDocuments('Item', [clone(data)], { keepId: true });
      if (created.length !== 1) throw new Error('Class creation did not return one document.');
    } catch (diagnosticError) {
      const diagnostic = recordDiagnostic(new FoundryDiagnostics(), {
        sourcePath: 'foundry/adapters/document-writes/class-features.mjs', error: diagnosticError,
        detail: 'commitClassReplacement'
      });
      return Object.freeze({ ok: false, code: 'class.replacement-failed', diagnostic });
    }
    return Object.freeze({
      ok: true,
      actorUuid: actor.uuid,
      actorName: actor.name,
      classUuid: created[0].uuid,
      classId: created[0].id,
      className: created[0].name,
      removedFeatureNames: Object.freeze(removedFeatureNames)
    });
  }

  /** The source data of a Class item a promotion path points at, ready to be created on a unit. */
  async getClassSourceData(classUuid) {
    const classItem = await fromUuid(classUuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'classItem'); return null; });
    if (!classItem || classItem.documentName !== 'Item' || classItem.type !== 'Class') return null;
    return classItem.toObject();
  }

  /** Spend the Promotion item that opened the sequence: one use off a stack, or the whole item. */
  async consumePromotionItem(actorUuid, plan, operation = null) {
    const actor = await promotedActor(actorUuid);
    const item = plan?.itemId ? actor?.items.get(plan.itemId) : null;
    if (!item) return Object.freeze({ ok: false, code: 'promotion.item-missing' });
    await operation?.capture(plan.remove
      ? { deleting: [item] }
      : { documents: [{ document: item, paths: ['system.uses.current'] }] });
    try {
      if (plan.remove) await actor.deleteEmbeddedDocuments('Item', [item.id], {});
      else await item.update({ 'system.uses.current': plan.usesCurrent });
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'consumePromotionItem');
      return Object.freeze({ ok: false, code: 'promotion.consumption-failed' });
    }
    return Object.freeze({ ok: true });
  }

  /** Grant the features a player picked from one bundle and record the choice. Fails if none could be created. */
  async commitSelection(plan) {
    return commitGrant(plan, {
      featureRefs: plan.selectedFeatures,
      recordBundles: [plan.bundleId],
      requireCreated: true
    });
  }

  /** Grant a Class's automatic features and record the bundles resolved. Features that can't be found are listed. */
  async commitAutomaticGrant(plan) {
    return commitGrant(plan, {
      featureRefs: plan.featureRefs,
      recordBundles: plan.bundleIds,
      requireCreated: false
    });
  }

  /** Clear one bundle's record under `classChoices`, so the next automatic grant resolves it again. */
  async clearBundleRecord(plan) {
    const classItem = await fromUuid(plan.classUuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'classItem'); return null; });
    const actor = classItem?.parent;
    if (!classItem || actor?.documentName !== 'Actor') return Object.freeze({ ok: false, code: 'class.documents-missing' });
    if (classStateFingerprint(actor) !== plan.expectedFingerprint) {
      return Object.freeze({ ok: false, stale: true, code: 'class.state-changed' });
    }
    await plan.operation?.capture({ documents: [{ document: actor, paths: [`flags.${SYSTEM_ID}.classChoices`] }] });
    try {
      await actor.update(forcedDeletion(`flags.${SYSTEM_ID}.classChoices.${classItem.id}.${plan.bundleId}`));
    } catch (diagnosticError) {
      const diagnostic = recordDiagnostic(new FoundryDiagnostics(), {
        sourcePath: 'foundry/adapters/document-writes/class-features.mjs', error: diagnosticError,
        detail: 'clearBundleRecord'
      });
      return Object.freeze({ ok: false, code: 'class.commit-failed', diagnostic });
    }
    return Object.freeze({ ok: true });
  }

  /** Close the promoting unit's turn on its Actor, for a unit with no open movement plan to close instead. */
  async spendPromotionTurn(actorUuid, operation = null) {
    const actor = await promotedActor(actorUuid);
    if (!actor) return Object.freeze({ ok: false, code: 'promotion.actor-missing' });
    await operation?.capture({ documents: [{ document: actor, paths: Object.keys(PROMOTION_TURN_SPENT) }] });
    try {
      await actor.update({ ...PROMOTION_TURN_SPENT });
      return Object.freeze({ ok: true });
    } catch (diagnosticError) {
      reportFoundryError(import.meta.url, diagnosticError, 'spendPromotionTurn');
      return Object.freeze({ ok: false, code: 'promotion.turn-failed' });
    }
  }
}

/* -------------------------------------------- */
/*  Class feature helpers                       */
/* -------------------------------------------- */

/**
 * Grant a Class bundle's features: create the new items, remove the items they replace, then record the resolved
 * bundles under `classChoices`. All three are saved on `plan.operation` for undo before the first write.
 */
async function commitGrant(plan, { featureRefs, recordBundles, requireCreated }) {
  const classItem = await fromUuid(plan.classUuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'classItem'); return null; });
  const actor = classItem?.parent;
  if (!classItem || !actor || (plan.actorUuid && actor.uuid !== plan.actorUuid)) {
    return Object.freeze({ ok: false, code: 'class.documents-missing' });
  }
  if (classStateFingerprint(actor) !== plan.expectedFingerprint) {
    return Object.freeze({ ok: false, stale: true, code: 'class.state-changed' });
  }

  const prepared = await prepareFeatures(actor, featureRefs ?? []);
  if (requireCreated && !prepared.data.length) {
    return Object.freeze({
      ok: false,
      code: 'class.feature-unresolved',
      unresolved: Object.freeze(prepared.unresolved)
    });
  }
  if (classStateFingerprint(actor) !== plan.expectedFingerprint) {
    return Object.freeze({ ok: false, stale: true, code: 'class.state-changed' });
  }

  const removeIds = replacementIds(actor, prepared.refs);
  const removed = removeIds.map(id => actor.items.get(id)).filter(Boolean);
  const replacedFeatureNames = removed.map(item => String(item.name ?? ''));
  const choices = {};
  for (const bundleId of [...(recordBundles ?? [])].map(String).filter(Boolean)) {
    choices[`flags.${SYSTEM_ID}.classChoices.${classItem.id}.${bundleId}`] = RECORDED_CHOICE;
  }
  await plan.operation?.capture({
    documents: Object.keys(choices).length
      ? [{ document: actor, paths: [`flags.${SYSTEM_ID}.classChoices`] }]
      : [],
    deleting: removed,
    creating: prepared.data.length
      ? [{ parent: actor, documentName: 'Item', ids: prepared.data.map(entry => entry._id) }]
      : []
  });
  let created = [];
  try {
    if (prepared.data.length) created = await actor.createEmbeddedDocuments('Item', prepared.data, { keepId: true });
    if (removeIds.length) await actor.deleteEmbeddedDocuments('Item', removeIds, {});
    if (Object.keys(choices).length) await actor.update(choices);
  } catch (diagnosticError) {
    const diagnostic = recordDiagnostic(new FoundryDiagnostics(), {
      sourcePath: 'foundry/adapters/document-writes/class-features.mjs', error: diagnosticError, detail: 'commitGrant'
    });
    return Object.freeze({ ok: false, code: 'class.commit-failed', diagnostic });
  }

  return Object.freeze({
    ok: true,
    actorUuid: actor.uuid,
    actorName: actor.name,
    className: String(classItem.name ?? ''),
    classUuid: classItem.uuid,
    featureNames: Object.freeze(created.map(item => item.name)),
    createdItemIds: Object.freeze(created.map(item => item.id)),
    grantedMountItemId: created.find(item => item.type === 'Ability' && item.system?.itemType === 'Mount')?.id ?? '',
    replacedFeatureNames: Object.freeze(replacedFeatureNames),
    unresolvedFeatureNames: Object.freeze(prepared.unresolved),
    resolvedBundles: Object.freeze([...(recordBundles ?? [])])
  });
}

/**
 * Item data for each feature the unit doesn't already have, with at most one Mount in total. Current uses start at
 * the stored maximum, or 100 when the maximum is 0; the GM's item-arrival hook then sets them to the effective
 * maximum. Features that can't be found are returned as unresolved.
 */
async function prepareFeatures(actor, refs) {
  const data = [];
  const granted = [];
  const unresolved = [];
  const queued = new Set();
  let mountQueued = [...actor.items].some(item => item.type === 'Ability' && item.system?.itemType === 'Mount');
  for (const ref of refs) {
    if ([...actor.items].some(item => matchesRef(item, ref))) continue;
    const source = await resolveFeature(ref);
    if (!source) {
      unresolved.push(String(ref?.uuid ?? ref?.name ?? 'unknown'));
      continue;
    }
    const key = String(source.uuid || source.name).toLowerCase();
    if (queued.has(key)) continue;
    if (source.type === 'Ability' && source.system?.itemType === 'Mount') {
      if (mountQueued) continue;
      mountQueued = true;
    }
    queued.add(key);
    const sourceData = source.toObject();
    sourceData._id = foundry.utils.randomID();
    sourceData._stats ??= {};
    sourceData._stats.compendiumSource = source.uuid;
    if (sourceData.system?.uses) sourceData.system.uses.current = sourceData.system.uses.max || 100;
    data.push(sourceData);
    granted.push(ref);
  }
  return { data, refs: granted, unresolved };
}

function replacementIds(actor, refs) {
  const ids = [];
  for (const ref of refs) {
    if (!ref.replace?.uuid && !String(ref.replace?.name ?? '').trim()) continue;
    for (const item of actor.items) {
      if (item.type !== 'Class' && matchesRef(item, ref.replace) && !ids.includes(item.id)) ids.push(item.id);
    }
  }
  return ids;
}

function itemProjection(item) {
  return Object.freeze({
    id: item.id,
    uuid: item.uuid,
    compendiumSource: String(item._stats?.compendiumSource ?? ''),
    name: item.name,
    type: item.type,
    itemType: String(item.system?.itemType ?? '')
  });
}

/**
 * Resolve a class feature by UUID, then by Item id across compendia if it moved packs.
 * Fall back to its name in world Items, then compendia, so a world copy wins over a same-named pack copy.
 */
async function resolveFeature(ref) {
  const uuid = String(ref?.uuid ?? '');
  if (uuid) {
    const direct = await fromUuid(uuid).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'direct'); return null; });
    if (direct?.documentName === 'Item') return direct;
  }
  const packs = itemPacks();
  const strayId = STRAY_ITEM_ID.exec(uuid)?.[1] ?? '';
  if (strayId) {
    for (const pack of packs) {
      const index = await pack.getIndex();
      if (indexHas(index, strayId)) return pack.getDocument(strayId);
    }
  }
  const name = String(ref?.name ?? '').trim().toLowerCase();
  if (!name) return null;
  const world = game.items?.find?.(item => String(item.name ?? '').trim().toLowerCase() === name) ?? null;
  if (world) return world;
  for (const pack of packs) {
    const index = await pack.getIndex();
    const entry = [...index].find(candidate => String(candidate.name ?? '').trim().toLowerCase() === name);
    if (entry) return pack.getDocument(entry._id);
  }
  return null;
}

function itemPacks() {
  return [...(game.packs ?? [])].filter(pack => pack.documentName === 'Item' || pack.metadata?.type === 'Item');
}

function indexHas(index, id) {
  if (typeof index?.has === 'function') return index.has(id);
  return [...index].some(entry => entry._id === id);
}

function matchesRef(item, ref) {
  const uuid = String(ref?.uuid ?? '');
  if (uuid && (item.uuid === uuid || item._stats?.compendiumSource === uuid)) return true;
  const name = String(ref?.name ?? '').trim().toLowerCase();
  return Boolean(name && String(item.name).trim().toLowerCase() === name);
}

/* -------------------------------------------- */
/*  Promotion record helpers                    */
/* -------------------------------------------- */

async function promotedActor(actorUuid) {
  const actor = await fromUuid(String(actorUuid ?? '')).catch((diagnosticError) => { reportFoundryError(import.meta.url, diagnosticError, 'actor'); return null; });
  return actor?.documentName === 'Actor' && actor.type === 'Character' ? actor : null;
}
