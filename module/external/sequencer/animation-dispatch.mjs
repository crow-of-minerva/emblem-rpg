/** @layer external/sequencer */
import { isPopulated } from '../../contracts/dsl/animations.mjs';
import { planAnimationSteps } from '../../game/effects/animation-planning.mjs';
import { SequencerRuntime, audioChannelReady, transientSoundsAudible } from './runtime.mjs';
import { collectionValues, waitFor } from '../../lib/core/runtime.mjs';
import { reportFoundryError, reportFoundryValidation } from '../../foundry/adapters/services/diagnostics.mjs';
import { isActiveGm } from '../../foundry/adapters/services/host.mjs';
import { pageHidden } from '../../lib/dom/visibility.mjs';

/* -------------------------------------------- */
/*  Public API                                  */
/* -------------------------------------------- */
/**
 * Play an authored animation through Sequencer. By default every client runs the same call at once, as when a
 * presentation message reaches the table. Pass `broadcast` when only this client runs it and Sequencer should show
 * it to everyone, `preview` for the animation editor (this client only, nothing saved), and `await` to wait for
 * the effects to finish. Used by CombatPresentation, DowntimePresentation and the item animation editor.
 */
export class AnimationDispatcher {
  static play(anim, ctx, opts = {}) {
    return playAnimation(anim, ctx, opts);
  }
}

/**
 * Play the equipped Mount's activation animation for the whole table: its melee slot for taking off or mounting,
 * its ranged slot for landing or dismounting. Nothing plays when that slot is empty or the unit has no token on
 * the canvas. It resolves once the animation starts, so it never holds up the state change.
 * @param {object} actor The unit, with its equipped Mount among its items.
 * @param {object} [options] `dismount` picks the ranged slot over the melee one.
 * @returns {Promise<boolean>} Whether an animation was started.
 */
export async function playMountFlourish(actor, { dismount = false } = {}) {
  const mount = collectionValues(actor?.items)
    .find(item => item?.system?.itemType === 'Mount' && item?.system?.isEquipped === true);
  const payload = dismount ? mount?.system?.anim?.activation?.ranged : mount?.system?.anim?.activation?.melee;
  if (!isPopulated(payload)) return false;
  const token = actor.getActiveTokens()[0] ?? null;
  if (!token) return false;
  try {
    await playAnimation(payload, { token, target: token, distance: 1 }, { broadcast: true });
    return true;
  } catch (error) {
    reportFoundryError(import.meta.url, error, 'emblem-rpg | Mount flourish failed');
    return false;
  }
}

/** The destruction smoke, written as animation DSL steps. */
const DESTRUCTION_SMOKE = Object.freeze({
  steps: Object.freeze([Object.freeze({
    kind: 'effect',
    file: 'animated-spell-effects-cartoon.smoke.11',
    attachTo: 'token',
    layer: 'aboveInterface',
    scaleToObject: 3.65,
    playbackRate: 0.8,
    fadeOut: 300
  })])
});
const SMOKE_WARMUP_MS = 1500;
let smokeWarmup = null;

/**
 * Play the destruction smoke over a token on this client. ObjectInteractionPresentation plays it with the
 * destruction sounds. Returns false when nothing will show (a hidden page, or the file isn't in Sequencer's
 * database). The first call preloads the file but waits at most 1.5 seconds, so a slow download only delays the
 * smoke.
 */
export async function playDestructionSmoke(token) {
  const file = DESTRUCTION_SMOKE.steps[0].file;
  if (!token || pageHidden() || !SequencerRuntime.available || !SequencerRuntime.databaseEntryExists(file)) return false;
  const resolved = SequencerRuntime.resolveSoundPath(file);
  smokeWarmup ??= Promise.race([
    SequencerRuntime.preload(resolved ? [resolved] : []),
    new Promise(resolve => setTimeout(resolve, SMOKE_WARMUP_MS))
  ]);
  await smokeWarmup;
  try {
    await playAnimation(DESTRUCTION_SMOKE, { token }, { await: false });
    return true;
  } catch (error) {
    reportFoundryError(import.meta.url, error, 'emblem-rpg | Destruction smoke failed');
    return false;
  }
}

/* -------------------------------------------- */
/*  Sequencer Access                            */
/* -------------------------------------------- */

/** Sequencer's Sequence class. The module sets it as a global, so it's read through SequencerRuntime. */
function _Sequence() {
  return SequencerRuntime.SequenceClass;
}

/**
 * How much to shrink a rotated effect on a 2x2 token. `scaleToObject` sizes the effect against the token's
 * bounding square, which on a large token is twice as wide as the square the effect was authored for. This factor
 * keeps a rotated effect the size the author intended.
 */
const LARGE_TOKEN_ROTATED_SCALE_MULTIPLIER = 4 / 7;

/**
 * Whether a resolved location is a 2x2 token. It may be a placeable or a document, since `resolveLocation` can
 * return either.
 */
function isTwoByTwoToken(loc) {
  const doc = loc?.document ?? loc;
  return doc?.width === 2 && doc?.height === 2;
}

/**
 * The step's `scaleToObject`, shrunk when the effect rotates towards something and sits on a 2x2 token. Every
 * other step keeps its authored value.
 */
function adjustScaleForRotatedLargeToken(step, ctx) {
  if (!step.rotateTowards) return step.scaleToObject;
  const ref = step.attachTo ?? step.atLocation;
  if (!ref) return step.scaleToObject;
  const loc = resolveLocation(ref, ctx);
  if (!isTwoByTwoToken(loc)) return step.scaleToObject;
  return step.scaleToObject * LARGE_TOKEN_ROTATED_SCALE_MULTIPLIER;
}

/* -------------------------------------------- */
/*  Location resolution                         */
/* -------------------------------------------- */

/** The first target when the context holds several, for steps that can only point at one. */
function singleTarget(target) {
  if (Array.isArray(target)) return target.find(Boolean) ?? null;
  return target ?? null;
}

/**
 * Turn an authored location name ('token', 'target', 'target-location' and so on) into something Sequencer can
 * place an effect at: a token, or the pixel center of a grid square. 'target-location' uses the target token when
 * the context has no square. 'target-endpoint' reads a targeting line end point that nothing sets at present, so
 * it always uses the target token too.
 */
function resolveLocation(ref, ctx) {
  if (!ref) return null;
  switch (ref) {
    case 'token': return ctx.token;
    case 'target': return singleTarget(ctx.target);
    case 'target-location': {

      const loc = ctx.targetLocation;
      if (loc && typeof loc.x === 'number' && typeof loc.y === 'number') {
        const gs = canvas?.grid?.size ?? 100;
        return { x: loc.x * gs + gs / 2, y: loc.y * gs + gs / 2 };
      }
      return singleTarget(ctx.target);
    }
    case 'token-facing-target': return ctx.token;

    case 'lastSpawned': return ctx.lastSpawnedToken ?? ctx.lastSpawnedTokenDoc?.object ?? null;
    case 'target-endpoint': {
      const ep = ctx.token?._targetingGraphLineEndPoint;
      if (!ep) return singleTarget(ctx.target);
      const gs = canvas?.grid?.size ?? 100;
      return { x: ep.x * gs + gs / 2, y: ep.y * gs + gs / 2 };
    }
    default: return null;
  }
}

/* -------------------------------------------- */
/*  Step Builders                               */
/* -------------------------------------------- */

/**
 * Add a token animation step, which changes the token itself (opacity, rotation, fades) rather than drawing an
 * effect over it. Skipped when the reference doesn't resolve to a placed token.
 */
function applyTokenAnimStep(seq, step, ctx) {
  const target = resolveLocation(step.target ?? 'token', ctx);

  if (!target || !target.document) return seq;
  let chain = seq.animation().on(target);
  if (typeof step.opacity === 'number')  chain = chain.opacity(step.opacity);
  if (typeof step.rotation === 'number') chain = chain.rotate(step.rotation);
  if (typeof step.fadeIn === 'number')   chain = chain.fadeIn(step.fadeIn);
  if (typeof step.fadeOut === 'number')  chain = chain.fadeOut(step.fadeOut);
  if (typeof step.duration === 'number') chain = chain.duration(step.duration);
  if (typeof step.delay === 'number')    chain = chain.delay(step.delay);
  if (step.waitUntilFinished === true) chain = chain.waitUntilFinished();
  else if (typeof step.waitUntilFinished === 'number') chain = chain.waitUntilFinished(step.waitUntilFinished);
  return chain;
}

/**
 * Add an effect step, copying each authored field onto Sequencer's effect. Scale accepts a number, a pair or an
 * x/y object. A cone file is sized by planAnimationSteps from the active item's range. `tieToEffectName` ties the
 * effect to the token and to its active effect of that name, so it ends when either is deleted.
 * @param {object} [options] `local` keeps the effect off other clients.
 */
function applyEffectStep(seq, step, ctx, { local = false } = {}) {
  let chain = seq.effect();
  if (local) chain = chain.locally();

  const file = step.file;
  if (file) chain = chain.file(file);

  if (step.atLocation) {
    const loc = resolveLocation(step.atLocation, ctx);
    if (loc) chain = chain.atLocation(loc);
  }
  if (step.attachTo) {
    const loc = resolveLocation(step.attachTo, ctx);
    if (loc) chain = chain.attachTo(loc);
  }
  if (step.stretchTo) {
    const loc = resolveLocation(step.stretchTo, ctx);
    if (loc) chain = chain.stretchTo(loc);
  }
  if (step.rotateTowards) {
    const loc = resolveLocation(step.rotateTowards, ctx);
    if (loc) chain = chain.rotateTowards(loc);
  }
  if (typeof step.rotate === 'number') chain = chain.rotate(step.rotate);
  if (step.moveTowards) {
    const loc = resolveLocation(step.moveTowards, ctx);
    if (loc) chain = chain.moveTowards(loc);
  }
  if (typeof step.moveSpeed === 'number') chain = chain.moveSpeed(step.moveSpeed);
  if (step.snapToGrid === true) chain = chain.snapToGrid();

  if (step.spriteOffset && typeof step.spriteOffset === 'object') {
    const { x, y, gridUnits, local, ...rest } = step.spriteOffset;
    const offsetArg = { x: x ?? 0, y: y ?? 0, ...rest };
    const optsArg = { gridUnits: gridUnits ?? true };
    if (local !== undefined) optsArg.local = local;
    chain = chain.spriteOffset(offsetArg, optsArg);
  }

  if (typeof step.scale === 'number') {
    chain = chain.scale(step.scale);
  } else if (Array.isArray(step.scale) && step.scale.length === 2
             && typeof step.scale[0] === 'number' && typeof step.scale[1] === 'number') {
    chain = chain.scale(step.scale[0], step.scale[1]);
  } else if (step.scale && typeof step.scale === 'object'
             && typeof step.scale.x === 'number' && typeof step.scale.y === 'number') {
    chain = chain.scale({ x: step.scale.x, y: step.scale.y });
  }

  if (typeof step.coneScaleToObject === 'number') {
    chain = chain.scaleToObject(step.coneScaleToObject);
  } else if (typeof step.scaleToObject === 'number') {
    chain = chain.scaleToObject(adjustScaleForRotatedLargeToken(step, ctx));
  }
  if (typeof step.playbackRate === 'number') chain = chain.playbackRate(step.playbackRate);
  if (typeof step.opacity === 'number') chain = chain.opacity(step.opacity);
  if (step.tint) chain = chain.tint(step.tint);
  if (typeof step.hue === 'number') chain = chain.filter('ColorMatrix', { hue: step.hue });
  if (typeof step.zIndex === 'number') chain = chain.zIndex(step.zIndex);
  if (step.center === true) chain = chain.center();

  if (step.mirrorX) chain = chain.mirrorX();
  if (step.mirrorY) chain = chain.mirrorY();
  if (step.randomizeMirrorX) chain = chain.randomizeMirrorX();
  if (step.randomizeMirrorY) chain = chain.randomizeMirrorY();
  if (step.randomRotation) chain = chain.randomRotation();

  if (step.layer === 'aboveInterface') chain = chain.aboveInterface();
  else if (step.layer === 'aboveLighting') chain = chain.aboveLighting();
  else if (step.layer === 'belowTokens') chain = chain.belowTokens();

  if (typeof step.fadeIn === 'number') chain = chain.fadeIn(step.fadeIn);
  if (typeof step.fadeOut === 'number') chain = chain.fadeOut(step.fadeOut);
  if (step.rotateIn) chain = chain.rotateIn(step.rotateIn.value ?? 0, step.rotateIn.ms ?? 500,
    step.rotateIn.ease ? { ease: step.rotateIn.ease } : undefined);
  if (step.rotateOut) chain = chain.rotateOut(step.rotateOut.value ?? 0, step.rotateOut.ms ?? 500,
    step.rotateOut.ease ? { ease: step.rotateOut.ease } : undefined);

  if (typeof step.startTime === 'number') chain = chain.startTime(step.startTime);
  if (typeof step.endTime === 'number') chain = chain.endTime(step.endTime);
  if (step.timeRange) chain = chain.timeRange(step.timeRange.from ?? 0, step.timeRange.to ?? 0);

  const filters = Array.isArray(step.filter) ? step.filter : (step.filter ? [step.filter] : []);
  for (const f of filters) {
    if (f?.type) chain = chain.filter(f.type, f.params ?? {});
  }

  if (step.name) chain = chain.name(step.name);
  if (step.persist === true) {
    chain = chain.persist(true, { persistTokenPrototype: true });
  } else if (step.persist && typeof step.persist === 'object') {
    chain = chain.persist(true, step.persist);
  }
  if (step.tieToEffectName) {
    const tieTarget = step.attachTo
      ? resolveLocation(step.attachTo, ctx)
      : (step.atLocation ? resolveLocation(step.atLocation, ctx) : null);
    const tieActor = tieTarget?.actor ?? tieTarget;
    const ae = tieActor?.effects?.find?.(e => e?.name === step.tieToEffectName);

    const tieTokenDoc = tieTarget?.document ?? null;
    const tieDocs = [tieTokenDoc, ae].filter(Boolean);
    if (tieDocs.length > 0) chain = chain.tieToDocuments(tieDocs);
  }

  if (typeof step.delay === 'number') chain = chain.delay(step.delay);
  if (typeof step.duration === 'number') chain = chain.duration(step.duration);

  if (step.repeats && typeof step.repeats.count === 'number') {
    const args = [step.repeats.count];
    if (typeof step.repeats.delayMin === 'number') args.push(step.repeats.delayMin);
    if (typeof step.repeats.delayMax === 'number') args.push(step.repeats.delayMax);
    chain = chain.repeats(...args);
  }

  if (step.waitUntilFinished === true) chain = chain.waitUntilFinished();
  else if (typeof step.waitUntilFinished === 'number') chain = chain.waitUntilFinished(step.waitUntilFinished);

  return chain;
}

/**
 * Add a sound step. An authored channel this client hasn't opened yet (before its first click) is left off, so the
 * sound plays on Sequencer's default channel instead of Sequencer throwing an error.
 * @param {object} [options] `local` keeps the sound off other clients.
 */
function applySoundStep(seq, step, { local = false } = {}) {
  let chain = seq.sound();
  if (local) chain = chain.locally();
  const file = step.file;
  if (file) chain = chain.file(file);
  if (step.audioChannel && audioChannelReady(step.audioChannel)) chain = chain.audioChannel(step.audioChannel);
  if (typeof step.volume === 'number') chain = chain.volume(step.volume);
  if (typeof step.fadeInAudio === 'number') chain = chain.fadeInAudio(step.fadeInAudio);
  if (typeof step.fadeOutAudio === 'number') chain = chain.fadeOutAudio(step.fadeOutAudio);
  if (typeof step.startTime === 'number') chain = chain.startTime(step.startTime);
  if (typeof step.endTime === 'number') chain = chain.endTime(step.endTime);
  if (step.timeRange) chain = chain.timeRange(step.timeRange.from ?? 0, step.timeRange.to ?? 0);
  if (typeof step.delay === 'number') chain = chain.delay(step.delay);
  if (typeof step.duration === 'number') chain = chain.duration(step.duration);
  if (step.repeats && typeof step.repeats.count === 'number') {
    const args = [step.repeats.count];
    if (typeof step.repeats.delayMin === 'number') args.push(step.repeats.delayMin);
    if (typeof step.repeats.delayMax === 'number') args.push(step.repeats.delayMax);
    chain = chain.repeats(...args);
  }
  if (step.waitUntilFinished === true) chain = chain.waitUntilFinished();
  else if (typeof step.waitUntilFinished === 'number') chain = chain.waitUntilFinished(step.waitUntilFinished);
  return chain;
}

function applyWaitStep(seq, step) {
  return seq.wait(step.ms ?? 0);
}

/* -------------------------------------------- */
/*  Sequence Assembly                           */
/* -------------------------------------------- */

/**
 * Build a Sequence from authored steps. planAnimationSteps (game/effects/animation-planning.mjs) drops steps whose
 * condition is false and picks a file where a step lists several, and playbackRole decides which of the rest this
 * client plays. An invalid condition or an unknown step kind shows a warning and skips that step, so content with
 * an outdated step still plays the rest.
 * @returns {Sequence|null} null if the Sequence class is missing.
 */
function buildSequence(steps, ctx, opts = {}) {
  const Seq = _Sequence();
  if (!Seq) {
    reportFoundryError(import.meta.url, null, 'emblem-rpg | AnimationDispatcher: Sequencer not active, skipping animation');
    return null;
  }
  let seq = new Seq();
  const role = playbackRole(opts);
  const plan = planAnimationSteps(steps, projectAnimationFacts(ctx), steps.map(() => Math.random()));
  for (const error of plan.errors) {
    reportFoundryValidation(import.meta.url, JSON.stringify(error), `Animation step ${error.index + 1} has an invalid condition expression.`);
  }
  for (const step of plan.steps) {
    switch (step.kind) {
      case 'effect':
        if (step.persist && !role.syncs && !role.preview) break;
        if (!step.persist && !role.draws) break;
        seq = role.preview
          ? applyEffectStep(seq, { ...step, persist: false, tieToEffectName: undefined }, ctx, { local: true })
          : applyEffectStep(seq, step, ctx, { local: role.local && !step.persist });
        break;
      case 'sound':
        if (role.draws && transientSoundsAudible()) seq = applySoundStep(seq, step, { local: role.local });
        break;
      case 'wait':      seq = applyWaitStep(seq, step);        break;
      case 'tokenAnim':
        if (role.syncs && !role.preview) seq = applyTokenAnimStep(seq, step, ctx);
        else if (role.draws) seq = holdForTokenAnimStep(seq, step);
        break;
      default:
        reportFoundryValidation(import.meta.url, null, `Animation step type "${step.kind}" is not supported.`);
    }
  }
  return seq;
}

/**
 * Decide what this client plays. By default every client runs the animation, so each draws its own copy of the
 * passing effects and sounds, and only the active GM plays persistent effects and token animations, which
 * Sequencer syncs to everyone. With `broadcast`, only this client runs it, so it plays everything and Sequencer
 * shows it to the others. A `preview` plays on this client only, with persistent effects made temporary and token
 * animations left out. A hidden page skips the passing effects and sounds.
 * @returns {{local: boolean, syncs: boolean, draws: boolean, preview: boolean}}
 */
function playbackRole(opts) {
  const draws = !pageHidden();
  if (opts.preview === true) return { local: true, syncs: false, draws, preview: true };
  if (opts.broadcast === true) return { local: false, syncs: true, draws, preview: false };
  return { local: true, syncs: isActiveGm(), draws, preview: false };
}

/**
 * Hold this client's sequence while the active GM plays a token animation that is waited on, so the steps after it
 * land together on every client.
 */
function holdForTokenAnimStep(seq, step) {
  if (!step.waitUntilFinished) return seq;
  const span = (Number(step.delay) || 0)
    + Math.max(Number(step.duration) || 0, Number(step.fadeIn) || 0, Number(step.fadeOut) || 0)
    + (typeof step.waitUntilFinished === 'number' ? step.waitUntilFinished : 0);
  return span > 0 ? seq.wait(span) : seq;
}

/**
 * Plain copies of the token, its actor, the targets and the active item, which planAnimationSteps checks authored
 * step conditions against.
 */
function projectAnimationFacts(ctx) {
  const token = projectToken(ctx?.token);
  return Object.freeze({
    actor: token?.actor ?? null,
    token,
    target: Array.isArray(ctx?.target) ? ctx.target.map(projectToken) : projectToken(ctx?.target),
    activeItem: projectItem(ctx?.token?.actor?.activeItem)
  });
}

function projectToken(token) {
  if (!token) return null;
  const document = token.document ?? token;
  return Object.freeze({
    id: String(token.id ?? document.id ?? ''),
    name: String(token.name ?? document.name ?? ''),
    x: Number(token.x ?? document.x) || 0,
    y: Number(token.y ?? document.y) || 0,
    document: Object.freeze({
      width: Number(document.width) || 1,
      height: Number(document.height) || 1,
      x: Number(document.x) || 0,
      y: Number(document.y) || 0
    }),
    actor: projectActor(token.actor ?? document.actor)
  });
}

function projectActor(actor) {
  if (!actor) return null;
  return Object.freeze({
    id: String(actor.id ?? ''),
    uuid: String(actor.uuid ?? ''),
    name: String(actor.name ?? ''),
    type: String(actor.type ?? ''),
    system: foundry.utils.deepClone(actor.system ?? {}),
    activeItem: projectItem(actor.activeItem),
    effects: Object.freeze(Array.from(actor.effects ?? []).map(effect => Object.freeze({
      name: String(effect.name ?? ''),
      statusId: String(effect.getFlag?.('core', 'statusId') ?? effect.flags?.core?.statusId ?? '')
    })))
  });
}

function projectItem(item) {
  if (!item) return null;
  return Object.freeze({
    id: String(item.id ?? ''),
    uuid: String(item.uuid ?? ''),
    name: String(item.name ?? ''),
    type: String(item.type ?? ''),
    system: foundry.utils.deepClone(item.system ?? {})
  });
}

/**
 * Give every passing effect a name so waitForNamedEffects can wait for it after Sequencer's play promise settles.
 * Authored names are kept, and persistent effects are left out.
 * @returns {{anim: object, names: string[]}} The renamed animation and the names to wait on.
 */
function prepareAwaitTracking(anim) {
  const names = [];
  let counter = 0;
  const steps = anim.steps.map(s => {
    if (!s || s.kind !== 'effect' || s.persist) return s;
    if (s.name) { names.push(s.name); return s; }
    const name = `em-await-${foundry.utils.randomID()}-${counter++}`;
    names.push(name);
    return { ...s, name };
  });
  return { anim: { ...anim, steps }, names };
}

/**
 * The longest an awaited animation is waited on, for Sequencer's play promise and again for the named effects, so
 * a missing file or paused rendering can't leave the caller waiting forever.
 */
const NAMED_EFFECT_WAIT_CAP_MS = 8000;

/**
 * Check every 100 ms until none of the named effects is still running. Records a diagnostic if they outlast the
 * time limit.
 */
async function waitForNamedEffects(names, timeoutMs = NAMED_EFFECT_WAIT_CAP_MS) {
  if (!SequencerRuntime.available || names.length === 0) return;
  const cleared = await waitFor(
    () => !SequencerRuntime.hasRunningEffect(names),
    { timeoutMs, intervalMs: 100 }
  );
  if (!cleared) reportFoundryError(import.meta.url, names, 'emblem-rpg | AnimationDispatcher: awaited effects still running after timeout');
}

/**
 * Play a built sequence. With `opts.await`, the returned promise settles when the sequence ends or after
 * NAMED_EFFECT_WAIT_CAP_MS, whichever comes first. Otherwise a later failure is recorded here, where the
 * diagnostic still names this file.
 * @param {string} label What to call this in an error.
 */
function playPromise(seq, opts, label) {
  if (!seq) return null;
  try {
    const promise = seq.play();
    if (opts.await === true && promise?.then) {
      let cap = null;
      const capped = new Promise(resolve => {
        cap = setTimeout(() => {
          reportFoundryError(import.meta.url, null, `emblem-rpg | AnimationDispatcher: ${label} still playing after timeout`);
          resolve(null);
        }, NAMED_EFFECT_WAIT_CAP_MS);
      });
      return Promise.race([promise, capped]).finally(() => clearTimeout(cap));
    }
    if (promise?.catch) {
      promise.catch(err => reportFoundryError(import.meta.url, err, `emblem-rpg | AnimationDispatcher: ${label} failed`));
    }
    return promise ?? null;
  } catch (err) {
    reportFoundryError(import.meta.url, err, `emblem-rpg | AnimationDispatcher: ${label} dispatch failed`);
    return null;
  }
}

/* -------------------------------------------- */
/*  Dispatch workflow                           */
/* -------------------------------------------- */
/**
 * Play an animation for AnimationDispatcher.play, playMountFlourish and playDestructionSmoke. When the context has
 * a list of targets and some steps are marked perTarget, the other steps play once first (aimed at the first
 * target), then one sequence per target plays in parallel.
 */
async function playAnimation(anim, ctx, opts = {}) {
    if (!isPopulated(anim)) return;

    let awaitNames = null;
    if (opts.await === true) {
      const tracked = prepareAwaitTracking(anim);
      anim = tracked.anim;
      awaitNames = tracked.names;
    }

    const targets = Array.isArray(ctx?.target) ? ctx.target.filter(Boolean) : null;
    const hasPerTargetStep = anim.steps.some(s => s?.perTarget === true);

    try {
      if (targets && targets.length > 0 && hasPerTargetStep) {
        const globalSteps = anim.steps.filter(s => s?.perTarget !== true);
        const perTargetSteps = anim.steps.filter(s => s?.perTarget === true);

        // Play the shared steps once, aimed at the first target.
        const globalCtx = { ...ctx, target: targets[0] };
        const globalSeq = globalSteps.length > 0 ? buildSequence(globalSteps, globalCtx, opts) : null;
        const globalPromise = playPromise(globalSeq, { await: true }, 'global sequence');
        if (globalPromise?.then) await globalPromise;

        // Then start one sequence per target, all at once.
        const perTargetPromises = [];
        for (const t of targets) {
          const perCtx = { ...ctx, target: t };
          const seq = buildSequence(perTargetSteps, perCtx, opts);
          const p = playPromise(seq, opts, 'per-target sequence');
          if (p) perTargetPromises.push(p);
        }
        if (opts.await === true) {
          await Promise.all(perTargetPromises.map(p => p?.then ? p : Promise.resolve()));
          await waitForNamedEffects(awaitNames);
        }
        return;
      }

      const seq = buildSequence(anim.steps, ctx, opts);
      const promise = playPromise(seq, opts, 'sequence');
      if (opts.await === true) {
        if (promise?.then) await promise;
        await waitForNamedEffects(awaitNames);
      }
    } catch (err) {
      reportFoundryError(import.meta.url, err, 'emblem-rpg | AnimationDispatcher: sequence dispatch failed');
    }
}
