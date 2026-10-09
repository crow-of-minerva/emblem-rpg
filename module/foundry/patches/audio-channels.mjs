/** @layer foundry/patches */
import { VOICE_OVER_VOLUME_SETTING } from '../../config/settings.mjs';
import { AUDIO_CHANNELS, VOICE_OVER_CHANNEL_LABEL } from '../../contracts/domains/tokens.mjs';
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { installWrapperGroup } from '../../external/host.mjs';
import { readSetting } from '../adapters/services/host.mjs';
import { reportFoundryError } from '../adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Channel vocabulary                          */
/* -------------------------------------------- */
const ROW_CLASS = 'emblem-voice-over-volume';
const SLIDER_CLASS = 'emblem-volume-slider';
const ROW_TOOLTIP = 'Volume of unit voice lines on this client';
const WRAPPER_GROUP_ID = 'audio-global-mute-sync';
const MUTE_TOGGLE_TARGET = 'foundry.applications.ui.Hotbar.prototype._updateToggles';
const DEFAULT_VOLUME = 0.5;

/* -------------------------------------------- */
/*  Public lifecycle                            */
/* -------------------------------------------- */
/** Give this client a fourth audio channel for voice-overs, beside Foundry's music, environment and interface. */
export function installVoiceOverChannel() {
  void openChannel();
  installWrapperGroup({
    id: WRAPPER_GROUP_ID,
    required: false,
    wrappers: [{
      target: MUTE_TOGGLE_TARGET,
      type: 'WRAPPER',
      fn(wrapped, ...args) {
        const result = wrapped(...args);
        applyVoiceOverVolume();
        return result;
      }
    }]
  });
  return true;
}

/** Bring the voice-over gain in line with its stored volume and the global mute. */
export function applyVoiceOverVolume(volume = null) {
  const context = voiceOverContext();
  if (!context) return false;
  const level = game.audio.globalMute === true ? 0 : storedVolume(volume);
  try {
    context.gainNode.gain.setValueAtTime(level, context.currentTime);
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'applyVoiceOverVolume');
    return false;
  }
  return true;
}

/** Add the Voice-Overs row to the sidebar's User Volume Controls, which Foundry renders for its own three. */
export function onRenderPlaylistDirectoryVolume(_application, element) {
  const list = rootElement(element)?.querySelector?.('.global-volume')?.querySelector?.('ol');
  if (!list) return false;
  for (const stale of list.querySelectorAll(`.${ROW_CLASS}`)) stale.remove();
  const row = buildRow();
  if (!row) return false;
  list.append(row);
  return true;
}

/* -------------------------------------------- */
/*  Channel context                             */
/* -------------------------------------------- */
function voiceOverContext() {
  const context = game.audio[AUDIO_CHANNELS.VOICE_OVER];
  return context?.gainNode ? context : null;
}

/** Build the channel once Foundry's own first-gesture unlock has built its three. */
async function openChannel() {
  const audio = game.audio;
  if (typeof globalThis.AudioContext !== 'function') return false;
  if (audio.locked) await audio.unlock;
  if (voiceOverContext()) return false;
  try {
    const context = new globalThis.AudioContext();
    context.gainNode = context.createGain();
    context.gainNode.connect(context.destination);
    audio[AUDIO_CHANNELS.VOICE_OVER] = context;
  } catch (diagnosticError) {
    reportFoundryError(import.meta.url, diagnosticError, 'openChannel');
    return false;
  }
  return applyVoiceOverVolume();
}

function storedVolume(volume) {
  const value = Number(volume ?? readSetting(VOICE_OVER_VOLUME_SETTING, DEFAULT_VOLUME));
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : DEFAULT_VOLUME;
}

/* -------------------------------------------- */
/*  Sidebar row                                 */
/* -------------------------------------------- */
function rootElement(element) {
  return element instanceof globalThis.HTMLElement ? element : element?.[0] ?? element;
}

/** Build a row like Foundry's own volume rows, leaving out the class Foundry's own handler looks for. */
function buildRow() {
  const document = globalThis.document;
  const helper = foundry.audio.AudioHelper;
  const picker = foundry.applications.elements.HTMLRangePickerElement;
  if (!document?.createElement) return null;
  const modifier = helper.volumeToInput(storedVolume());

  const row = document.createElement('li');
  row.className = `flexrow ${ROW_CLASS}`;
  row.dataset.tooltip = ROW_TOOLTIP;

  const label = document.createElement('label');
  label.textContent = VOICE_OVER_CHANNEL_LABEL;
  const icon = document.createElement('i');
  icon.className = 'volume-icon fa-fw fa-solid fa-volume-low';
  icon.toggleAttribute('inert', true);

  const slider = buildSlider(picker, modifier);
  row.append(label, icon, slider);
  return row;
}

/**
 * Build the slider with Foundry's own range-picker factory. A range-picker reads min, max and step only when the
 * element upgrades, so they're set at creation.
 */
function buildSlider(picker, modifier) {
  const slider = picker.create({
    name: VOICE_OVER_VOLUME_SETTING, value: modifier, min: 0, max: 1, step: 0.05
  });
  slider.className = SLIDER_CLASS;
  slider.setAttribute('aria-label', VOICE_OVER_CHANNEL_LABEL);
  describeSlider(slider, modifier);
  slider.addEventListener('change', event => void onSliderChange(event.target));
  return slider;
}

function describeSlider(slider, modifier) {
  const helper = globalThis.foundry.audio.AudioHelper;
  slider.dataset.tooltip = helper.volumeToPercentage(modifier);
  slider.ariaValueText = helper.volumeToPercentage(modifier, { label: true });
}

/** Store one slider move on Foundry's own volume curve, unmuting the way its three rows do. */
async function onSliderChange(slider) {
  const helper = foundry.audio.AudioHelper;
  const audio = game.audio;
  const modifier = Number(slider?.value);
  if (!Number.isFinite(modifier)) return false;
  describeSlider(slider, modifier);
  game.tooltip.activate(slider, { text: helper.volumeToPercentage(modifier) });
  if (audio.globalMute === true) {
    audio.globalMute = false;
    globalThis.ui?.hotbar?._updateToggles?.();
  }
  await globalThis.game.settings.set(SYSTEM_ID, VOICE_OVER_VOLUME_SETTING, helper.inputToVolume(modifier));
  return true;
}
