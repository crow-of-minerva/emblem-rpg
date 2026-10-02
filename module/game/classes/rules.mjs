/** @layer game/classes */
import { RESULT_CODES, accept, refuse } from '../../contracts/results.mjs';

/* -------------------------------------------- */
/*  Class rules                                 */
/* -------------------------------------------- */
/** Determine which bundle entries the Actor already owns. */
function classFeatureOwnership(items, bundleItems) {
  return bundleItems.map(ref => items.some(item => matchesRef(item, ref)));
}

/**
 * Which of a bundle's entries the unit may pick, for resolveClassFeatureSelection and resolveClassBundleStates.
 * An upgrade (an entry with `replace`) is eligible only when the unit owns the feature it replaces. Every other
 * entry is always eligible.
 * @param {object[]} items The unit's items as plain records (name, uuid, compendiumSource).
 * @param {object[]} bundleItems The bundle's authored entries.
 * @returns {boolean[]} One flag per entry.
 */
function classFeatureEligibility(items, bundleItems) {
  return bundleItems.map(ref => !isUpgrade(ref) || items.some(item => matchesRef(item, ref.replace)));
}

/** Whether a bundle entry names a feature it replaces. */
function isUpgrade(ref) {
  const target = ref?.replace;
  return Boolean(target && (String(target.uuid ?? '').trim() || normal(target.name)));
}

/**
 * Check a player's pick from a choice bundle: not chosen before, level reached, and exactly the required number of
 * eligible, unowned entries picked. Called by engine/character/progression.mjs, which commits the picked features.
 */
export function resolveClassFeatureSelection(snapshot) {
  const bundle = snapshot?.bundle;
  if (!bundle || bundle.acquisitionType !== 'choice') return refuse(RESULT_CODES.CLASS_BUNDLE_INVALID);
  if (snapshot.choiceRecorded) return refuse(RESULT_CODES.CLASS_BUNDLE_ALREADY_SELECTED);
  if (Number(snapshot.actorLevel) < Math.max(1, Number(bundle.lvl) || 1)) {
    return refuse(RESULT_CODES.CLASS_BUNDLE_LEVEL_REQUIRED);
  }

  const ownership = classFeatureOwnership(snapshot.actorItems ?? [], bundle.items ?? []);
  const eligibility = classFeatureEligibility(snapshot.actorItems ?? [], bundle.items ?? []);
  const selectable = ownership.flatMap((owned, index) => owned || !eligibility[index] ? [] : [index]);
  const required = Math.min(Math.max(1, Number(bundle.choiceCount) || 1), selectable.length);
  const selected = [...new Set((snapshot.selectedIndices ?? []).map(Number))];
  if (selected.length !== required || selected.some(index => !selectable.includes(index))) {
    return refuse(RESULT_CODES.CLASS_FEATURE_CHOICE_INVALID, { required });
  }

  const selectedFeatures = selected.map(index => ({ index, ...bundle.items[index] }));
  return accept(RESULT_CODES.CLASS_FEATURE_SELECTION_READY, {
    actorUuid: snapshot.actorUuid,
    classUuid: snapshot.classUuid,
    bundleId: bundle._id,
    selectedFeatures,
    expectedFingerprint: snapshot.fingerprint
  });
}

/**
 * The features to grant from each automatic bundle the unit's level has reached and no record marks as granted,
 * leaving out features it already owns. An upgrade is skipped unless the unit owns the feature it replaces, and its
 * bundle is still recorded. When this pass would grant both the feature and its upgrade, only the upgrade is granted.
 * Called by reconcileAutomaticClassFeatures in engine/character/progression.mjs. The class-features writer
 * (commitAutomaticGrant) resolves the UUIDs and creates the items.
 */
export function resolveAutomaticClassFeatureGrant(snapshot) {
  const actorItems = snapshot?.actorItems ?? [];
  const actorLevel = Math.max(0, Number(snapshot?.actorLevel) || 0);
  const recorded = snapshot?.recordedBundles ?? {};
  const featureRefs = [];
  const bundleIds = [];
  const queued = new Set();

  for (const bundle of snapshot?.bundles ?? []) {
    if (!bundle?._id || bundle.acquisitionType === 'choice') continue;
    if (Math.max(1, Number(bundle.lvl) || 1) > actorLevel || recorded[bundle._id]) continue;
    bundleIds.push(bundle._id);
    for (const ref of bundle.items ?? []) {
      if (actorItems.some(item => matchesRef(item, ref))) continue;
      const keys = [String(ref?.uuid ?? '').trim(), normal(ref?.name)].filter(Boolean);
      if (!keys.length || keys.some(key => queued.has(key))) continue;
      if (isUpgrade(ref) && !actorItems.some(item => matchesRef(item, ref.replace))) {
        const base = featureRefs.findIndex(queuedRef =>
          matchesRef({ uuid: queuedRef.uuid, name: queuedRef.name }, ref.replace));
        if (base < 0) continue;
        featureRefs.splice(base, 1);
      }
      for (const key of keys) queued.add(key);
      featureRefs.push(ref);
    }
  }
  return { featureRefs, bundleIds };
}

/* -------------------------------------------- */
/*  Bundle availability                         */
/* -------------------------------------------- */

/**
 * Each bundle's state for the Class sheet (ui/apps/sheets/class/sheet.mjs): `edit`, `locked`, `ready` or
 * `granted`. A choice bundle whose level is reached is `ready` while an eligible, unowned option remains, and
 * `granted` once a pick is recorded or none remains. pendingFeatureChoiceIds lists the `ready` ones. `skipped`
 * flags the upgrades a recorded automatic bundle closed without granting.
 * @param {object} snapshot Detached class data: `bundles`, `actorItems`, `actorLevel`, `recordedBundles`.
 * @param {{owned?: boolean}} [options] `owned` false when no unit holds the Class, which puts every bundle in edit.
 * @returns {Array<{id: string, state: string, ownership: boolean[], eligibility: boolean[], skipped: boolean[]}>}
 */
export function resolveClassBundleStates(snapshot, { owned = true } = {}) {
  const actorItems = snapshot?.actorItems ?? [];
  const actorLevel = Math.max(0, Number(snapshot?.actorLevel) || 0);
  const recorded = snapshot?.recordedBundles ?? {};
  return (snapshot?.bundles ?? []).map(bundle => {
    const ownership = classFeatureOwnership(actorItems, bundle?.items ?? []);
    const eligibility = classFeatureEligibility(actorItems, bundle?.items ?? []);
    const open = ownership.some((taken, index) => !taken && eligibility[index]);
    const levelMet = actorLevel >= Math.max(1, Number(bundle?.lvl) || 1);
    const granted = Boolean(recorded[bundle?._id]);
    const closedAutomatic = owned && granted && bundle?.acquisitionType !== 'choice';
    const skipped = (bundle?.items ?? []).map((ref, index) => closedAutomatic && !ownership[index] && isUpgrade(ref));
    let state = 'edit';
    if (owned && bundle?.acquisitionType === 'choice') {
      if (granted || (levelMet && !open)) state = 'granted';
      else state = levelMet ? 'ready' : 'locked';
    } else if (owned) {
      state = granted || levelMet ? 'granted' : 'locked';
    }
    return { id: String(bundle?._id ?? ''), state, ownership, eligibility, skipped };
  });
}

/**
 * Check a GM's request to reopen an automatic bundle: it must be recorded and hold an upgrade it skipped. Clearing
 * the record lets reconcileAutomaticClassFeatures in engine/character/progression.mjs grant the bundle again.
 * @param {object} snapshot The bundle's Class data, as resolveAutomaticClassFeatureGrant reads it.
 * @param {string} bundleId The bundle to reopen.
 * @returns {object|null} The refusal, or null when the bundle may reopen.
 */
export function classBundleReopenRefusal(snapshot, bundleId) {
  const bundle = (snapshot?.bundles ?? []).find(entry => entry?._id === bundleId);
  if (!bundle) return refuse(RESULT_CODES.CLASS_BUNDLE_NOT_FOUND);
  const [state] = resolveClassBundleStates({ ...snapshot, bundles: [bundle] });
  return state.skipped.some(Boolean) ? null : refuse(RESULT_CODES.CLASS_BUNDLE_INVALID);
}

/** Ids of the choice bundles waiting for a pick, for the BG3 HUD's feature alert (external/bg3-hud). */
export function pendingFeatureChoiceIds(snapshot) {
  return resolveClassBundleStates(snapshot)
    .filter(entry => entry.state === 'ready')
    .map(entry => entry.id);
}

/* -------------------------------------------- */
/*  Class replacement                           */
/* -------------------------------------------- */
/**
 * The features to remove when a Character leaves a Class: the items of the old Class's unique bundles, except
 * bundles that list the new Class as an exception. Called by engine/character/progression.mjs for class
 * replacement and promotion.
 * @param {Iterable<object>} items The unit's items as plain records (id, type, name, uuid, compendiumSource).
 * @param {object|null} oldClass The Class being left, as plain data.
 * @param {string} newClassName Class being entered.
 * @returns {string[]} Embedded Item IDs to remove.
 */
export function classReplacementRemovalIds(items, oldClass, newClassName) {
  if (!oldClass || oldClass.type !== 'Class') return [];
  const oldName = normal(oldClass.name);
  const newName = normal(newClassName);
  if (newName && newName === oldName) return [];

  const removals = [];
  const actorItems = Array.from(items ?? []);
  for (const bundle of oldClass.system?.features ?? []) {
    if (bundle.unique !== true || exceptionNames(bundle.exceptions).includes(newName)) continue;
    for (const ref of bundle.items ?? []) {
      for (const item of actorItems) {
        if (item.type === 'Class' || !matchesRef(item, ref) || removals.includes(item.id)) continue;
        removals.push(item.id);
      }
    }
  }
  return removals;
}

/* -------------------------------------------- */
/*  Class rule helpers                          */
/* -------------------------------------------- */
function normal(value) {
  return String(value ?? '').trim().toLowerCase();
}

function matchesRef(item, ref) {
  const uuid = String(ref?.uuid ?? '');
  if (uuid && (item.uuid === uuid || item.compendiumSource === uuid)) return true;
  return Boolean(normal(ref?.name) && normal(item.name) === normal(ref.name));
}

function exceptionNames(value) {
  return String(value ?? '').split(',').map(normal).filter(Boolean);
}
