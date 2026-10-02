/** @layer ui/apps/menus */
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { escapeHtml } from '../../../lib/dom/html.mjs';
import {
  FOOTSTEP_GROUPS, MAX_TOKEN_ART_TABS, ON_CAST_CONDITION, SPECIFIC_ITEM_CONDITION, STEADY_TOKEN_CONDITIONS,
  TOKEN_ART_SLOTS, TOKEN_CONDITIONS, TOKEN_ENTRY_MAP_GROUPS, TOKEN_ENTRY_REFERENCE_FIELDS, TOKEN_FX_ANIM_TYPES,
  TOKEN_FX_DEFAULTS, TOKEN_FX_FLAG_KEY, TOKEN_FX_SECTIONS, USING_ABILITY_CONDITION, normalizeAudioFolderPath,
  normalizeTokenFxConfig, planTokenEntryMap, readTokenEntryGuards, readTokenEntryReferences,
  readTokenEntryTriggers, tokenFxAdvancedSections
} from '../../../contracts/domains/tokens.mjs';
import { openStudioForSlot, STUDIO_OPEN_CODES, studioClassSeedUpdate } from '../../../external/studio/character-art.mjs';
import {
  applyTokenFxToPlacedTokens, buildPrototypeTokenFxFilters, buildTokenFxFilters
} from '../../../external/token-magic-fx/filters.mjs';
import { NOTIFICATION_IDS, NotificationService } from '../../../presentation/interface/notifications.mjs';
import { openEditor } from '../../dialogs.mjs';
import { ACTOR_CONTROL_TOOLTIP_IDS, getTooltip } from '../../tooltips.mjs';
import { collectionValues } from '../../../lib/core/runtime.mjs';
import { forcedDeletion, readDropPayload } from '../../../foundry/adapters/services/host.mjs';
import { unitAudioRepository } from '../../../foundry/adapters/services/audio.mjs';
import { canFoundryUserAuthorDocument } from '../../../foundry/adapters/services/authority.mjs';
import { readItemCatalog } from '../../../foundry/adapters/projections/items.mjs';
import { reportFoundryError, FoundryDiagnostics } from '../../../foundry/adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Application configuration                   */
/* -------------------------------------------- */
const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;
const ActorControlApplication = HandlebarsApplicationMixin(ApplicationV2);
const ACTOR_TYPES = Object.freeze(['Lord', 'Retainer', 'Ally', 'Neutral', 'Enemy', 'Boss']);
const LINKED_ACTOR_TYPES = new Set(['Lord', 'Retainer']);
const DEFAULT_IMAGE = 'icons/svg/mystery-man.svg';
const TRANSIENT_TOKEN_CONDITIONS = new Set(
  TOKEN_CONDITIONS.filter(condition => !STEADY_TOKEN_CONDITIONS.includes(condition))
);
const DEFAULT_ICON = 'icons/svg/aura.svg';
const DEFAULT_TAB_ID = 'default';
const ACP_WIDTH = 1000;
const SCALE_MIN = 0.5;
const SCALE_MAX = 2;
const AVATAR_SCALE_MAX = 3;
const AVATAR_SCALE_DEFAULT = 1.25;
const OFFSET_Y_MIN = -0.5;
const OFFSET_Y_MAX = 1;
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const OWNER = Number(CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
const NONE = Number(CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE) || 0;
const ENTRY_DRAG_MIME = 'application/x-emblem-cond-entry';
/** Form-name suffix and entry field of each reference-list input, named centry_<tab>_<i>_<suffix> in the template. */
const ENTRY_REFERENCE_INPUTS = Object.freeze([
  ['uuid', 'specificItemUuid'], ['abilityIds', 'specificAbilityIds'], ['spellNames', 'specificSpellNames']
]);
const ENTRY_REFERENCE_FIELDS = new Set(Object.values(TOKEN_ENTRY_REFERENCE_FIELDS));
const REFINEMENT_SUFFIX = /\s*\(\+\d+\)\s*$/;
const VARIANT_DRAG_MIME = 'application/x-emblem-token-variant';
const ENTRY_GROUPS = Object.freeze([
  Object.freeze({ key: 'unset', label: 'Unconfigured', hint: 'add a trigger' }),
  Object.freeze({ key: 'keyed', label: 'Named Item / Ability / Spell', hint: 'checked first' }),
  Object.freeze({ key: 'steady', label: 'Wielding', hint: 'steady state' }),
  Object.freeze({ key: 'event', label: 'Events', hint: 'transient' })
]);
const DEFAULT_TAB_SLOTS = Object.freeze([
  Object.freeze({ key: 'avatar', label: 'Avatar', isAvatar: true, showOffsetY: false, scaleMax: AVATAR_SCALE_MAX }),
  Object.freeze({ ...TOKEN_ART_SLOTS[0] })
]);
const activePanels = new Map();
const ART_REFRESH_PATHS = Object.freeze(['img', 'system.art', 'prototypeToken.texture']);
const notifications = new NotificationService({ diagnostics: new FoundryDiagnostics() });

/* -------------------------------------------- */
/*  Actor Control Panel                         */
/* -------------------------------------------- */
/**
 * The Actor Control Panel: a Character's faction, unit audio, class art, conditional art and prototype token. The
 * Character sheet opens it through ActorControlPanel.openFor.
 */
export class ActorControlPanel extends ActorControlApplication {
  /* -------------------------------------------- */
  /*  Application configuration                   */
  /* -------------------------------------------- */
  static DEFAULT_OPTIONS = {
    id: 'emblem-actor-control-panel-{id}',
    classes: ['emblem-rpg', 'emblem-actor-control-panel'],
    tag: 'form',
    position: { width: ACP_WIDTH, height: 635 },
    window: { title: 'Actor Control Panel', icon: 'fas fa-sliders', minimizable: true, resizable: true },
    form: { handler: ActorControlPanel.submit, submitOnChange: true, closeOnSubmit: false },
    actions: {
      addConditionalEntry: ActorControlPanel.addConditionalEntry,
      addEntryGuard: ActorControlPanel.addEntryGuard,
      addEntryTrigger: ActorControlPanel.addEntryTrigger,
      addTab: ActorControlPanel.addTab,
      clearConditionalSlot: ActorControlPanel.clearConditionalSlot,
      clearTabTokenSlot: ActorControlPanel.clearTabTokenSlot,
      clearTokenSlot: ActorControlPanel.clearTokenSlot,
      deleteConditionalEntry: ActorControlPanel.deleteConditionalEntry,
      deleteTab: ActorControlPanel.deleteTab,
      duplicateConditionalEntry: ActorControlPanel.duplicateConditionalEntry,
      editConditionalSlot: ActorControlPanel.editConditionalSlot,
      editTabTokenSlot: ActorControlPanel.editTabTokenSlot,
      editTokenSlot: ActorControlPanel.editTokenSlot,
      fillFromClass: ActorControlPanel.fillFromClass,
      mapConditionalEntries: ActorControlPanel.mapConditionalEntries,
      openColor: ActorControlPanel.openColor,
      pickFolder: ActorControlPanel.pickFolder,
      pickFieldImage: ActorControlPanel.pickFieldImage,
      approveVoicePath: ActorControlPanel.approveVoicePath,
      removeEntryGuard: ActorControlPanel.removeEntryGuard,
      removeEntryTrigger: ActorControlPanel.removeEntryTrigger,
      renameTab: ActorControlPanel.renameTab,
      selectTab: ActorControlPanel.selectTab,
      setTray: ActorControlPanel.setTray,
      toggleAllConditionalEntries: ActorControlPanel.toggleAllConditionalEntries
    }
  };

  static PARTS = { main: {
    template: `systems/${SYSTEM_ID}/templates/editors/actor-control-panel.hbs`,
    scrollable: ['.acp-token-pane', '.acp-faction-pane', '.acp-audio-pane']
  } };

  /** Open this Character's control panel (one per Character) if the user may edit it. */
  static openFor(actor) {
    if (actor?.documentName !== 'Actor' || actor.type !== 'Character') return null;
    if (!canFoundryUserAuthorDocument(game.user, actor)) return null;
    const key = actor.uuid ?? actor.id;
    const existing = activePanels.get(key);
    if (existing) {
      void existing._renderAndRaise(key);
      return existing;
    }
    const panel = new ActorControlPanel(actor, { id: `emblem-actor-control-panel-${actor.id}` });
    activePanels.set(key, panel);
    void panel._renderAndRaise(key);
    return panel;
  }

  /** Render and bring to front. If the render fails, forget the panel so the next click opens a new one. */
  async _renderAndRaise(key) {
    try {
      await this.render({ force: true });
      this.bringToFront();
    } catch (error) {
      if (activePanels.get(key) === this) activePanels.delete(key);
      reportFoundryError(import.meta.url, error, 'Emblem RPG | Actor Control Panel failed to open');
    }
  }

  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
    this._activeTray = 'faction';
    this._activeTabId = DEFAULT_TAB_ID;
    this._openEntries = new Map();
    this._entryDrag = null;
    // Saves this panel has in flight. While above zero, refreshFromActor ignores updates, so the
    // panel does not re-render from its own save.
    this._localWrites = 0;
    this._refreshTimer = null;
    this._artBust = 0;
    this._fxOpen = {};
    this._fxPreviewTimer = null;
  }

  get title() { return `Control Panel: ${this.actor.name}`; }

  /** Hold the authored width so the resize handle only ever changes height. */
  setPosition(position = {}) {
    return super.setPosition({ ...position, width: ACP_WIDTH });
  }

  async close(options = {}) {
    const key = this.actor.uuid ?? this.actor.id;
    if (activePanels.get(key) === this) activePanels.delete(key);
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    if (this._fxPreviewTimer) clearTimeout(this._fxPreviewTimer);
    return super.close(options);
  }

  /**
   * Re-render once, after a short delay, for an update made outside this panel. Updates that arrive while the panel
   * is saving are ignored. `bustArt` makes the images reload.
   */
  refreshFromActor({ bustArt = false } = {}) {
    if (bustArt) this._artBust = Date.now();
    if (this._localWrites > 0 || !this.rendered) return;
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      if (this.rendered) this.render(false);
    }, 20);
  }

  /* -------------------------------------------- */
  /*  Render context                              */
  /* -------------------------------------------- */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const faction = this.actor.system.faction;
    const flags = this.actor.system.art;
    const prototype = this.actor.prototypeToken;
    const actorType = ACTOR_TYPES.includes(faction.role) ? faction.role : 'Neutral';
    const cacheBust = String(Math.max(Number(this.actor._stats?.modifiedTime) || 0, this._artBust) || Date.now());
    const topScales = flags.tokenScales;
    const topOffsets = flags.tokenOffsetsY;
    const footsteps = FOOTSTEP_GROUPS.map(group => {
      const authored = flags.footsteps[group.key];
      const preset = group.presets.some(option => option.value === authored.preset) ? authored.preset : 'default';
      return {
        ...group,
        preset,
        customPath: authored.customPath || '',
        showCustom: preset === 'custom',
        presetOptions: group.presets.map(option => ({ ...option, selected: option.value === preset }))
      };
    });
    const tokens = DEFAULT_TAB_SLOTS.map(slot => {
      if (slot.isAvatar) {
        const scale = clampScale(topScales.avatar ?? this.actor.system.art.avatarScale,
          AVATAR_SCALE_MAX, AVATAR_SCALE_DEFAULT);
        const portrait = this.actor.img === DEFAULT_IMAGE ? '' : this.actor.img || '';
        return tokenView(slot, portrait, '', scale, 0, cacheBust);
      }
      return tokenView(slot, flags.tokens.default || '', prototype.texture.src || '',
        clampScale(topScales.default), clampOffsetY(topOffsets.default), cacheBust);
    });
    const customTabs = foundry.utils.deepClone(flags.tabs);
    const tabs = [
      { id: DEFAULT_TAB_ID, name: 'Default Token', active: this._activeTabId === DEFAULT_TAB_ID, deletable: false },
      ...customTabs.map(tab => ({ id: tab.id, name: tab.name || 'Untitled',
        active: tab.id === this._activeTabId, deletable: true }))
    ];
    if (!tabs.some(tab => tab.active)) {
      this._activeTabId = DEFAULT_TAB_ID;
      tabs[0].active = true;
    }
    return {
      ...context,
      actor: this.actor,
      isGM: game.user.isGM,
      isTrayFaction: this._activeTray === 'faction',
      isTrayAudio: this._activeTray === 'audio',
      actorTypes: ACTOR_TYPES.map(value => ({ value, label: value, selected: value === actorType })),
      factionName: faction.name || '',
      factionIcon: faction.icon || '',
      factionIconPreview: faction.icon || DEFAULT_ICON,
      factionColor: HEX_COLOR.test(faction.color) ? faction.color : '#ffffff',
      owners: playerUsers().map(user => ({ id: user.id, name: user.name,
        color: user.color?.css ?? user.color ?? '#888',
        checked: Number(this.actor.ownership?.[user.id] ?? NONE) >= OWNER })),
      tokens,
      voicePath: flags.voicePath || '',
      voicePathApproved: unitAudioRepository.isVoicePathApproved(this.actor) === true,
      footsteps,
      tabs,
      activeTabIsDefault: this._activeTabId === DEFAULT_TAB_ID,
      activeTab: this._activeTabId === DEFAULT_TAB_ID ? null : this._activeTabView(customTabs, flags, cacheBust),
      atTabLimit: tabs.length >= MAX_TOKEN_ART_TABS,
      isUnlinkedToken: this.actor.isToken,
      prototypeToken: {
        name: prototype.name ?? this.actor.name,
        isRegular: Number(prototype.width ?? 1) <= 1.5,
        isLarge: Number(prototype.width ?? 1) > 1.5,
        actorLink: LINKED_ACTOR_TYPES.has(actorType) ? true : Boolean(prototype.actorLink),
        linkForcedOn: LINKED_ACTOR_TYPES.has(actorType),
        actorTypeLabel: actorType,
        ...sightView(this.actor)
      },
      tokenFx: this._tokenFxView(),
      tooltips: actorControlTooltips()
    };
  }

  _tokenFxView() {
    const config = normalizeTokenFxConfig(this.actor.flags?.[SYSTEM_ID]?.[TOKEN_FX_FLAG_KEY]);
    const advanced = tokenFxAdvancedSections(config);
    const open = Object.fromEntries(
      TOKEN_FX_SECTIONS.map(section => [section, this._fxOpen[section] ?? advanced[section]])
    );
    return { ...config, open,
      animTypeOptions: TOKEN_FX_ANIM_TYPES.map(option => ({ ...option,
        selected: option.value === config.glowAnimType })) };
  }

  _activeTabView(tabs, flags, cacheBust) {
    const tab = tabs.find(candidate => candidate.id === this._activeTabId);
    if (!tab) return null;
    const open = this._openEntries.get(tab.id) ?? new Set();
    const tabTokens = TOKEN_ART_SLOTS.map(slot => tokenView(slot, tab.tokens[slot.key] || '', '',
      clampScale(tab.tokenScales[slot.key]), clampOffsetY(tab.tokenOffsetsY[slot.key]), cacheBust));
    const shadows = computeTokenEntryShadows(tab.entries);
    const entries = tab.entries.map((entry, index) => {
      const triggers = readTokenEntryTriggers(entry);
      const guards = readTokenEntryGuards(entry);
      const conditions = [...triggers, ...guards];
      const shadow = shadows[index];
      return {
        index,
        tabId: tab.id,
        groupKey: classifyTokenEntry(entry, triggers, guards),
        triggers: triggers.map(name => ({ name })),
        guards: guards.map(name => ({ name })),
        hasTriggers: triggers.length > 0,
        hasGuards: guards.length > 0,
        open: open.has(index),
        hasSpecificItem: conditions.includes(SPECIFIC_ITEM_CONDITION),
        specificItemUuid: String(entry.specificItemUuid || '').trim(),
        hasSpecificAbility: conditions.includes(USING_ABILITY_CONDITION),
        specificAbilityIds: String(entry.specificAbilityIds || '').trim(),
        hasSpecificSpell: triggers.includes(ON_CAST_CONDITION),
        specificSpellNames: String(entry.specificSpellNames || '').trim(),
        shadowed: shadow.shadowed,
        shadowTooltip: shadow.shadowed
          ? `Never fires because “${shadow.byName}” sits higher in this group and covers it` : '',
        slots: TOKEN_ART_SLOTS.map(slot => tokenView(slot, entry.tokens[slot.key] || '',
          tab.tokens[slot.key] || flags.tokens[slot.key] || '',
          clampScale(tab.tokenScales[slot.key] ?? flags.tokenScales[slot.key]),
          clampOffsetY(tab.tokenOffsetsY[slot.key] ?? flags.tokenOffsetsY[slot.key]), cacheBust))
      };
    });
    const groups = ENTRY_GROUPS.map(group => ({ ...group,
      entries: entries.filter(entry => entry.groupKey === group.key) }))
      .filter(group => group.entries.length).map(group => ({ ...group, count: group.entries.length }));
    return { id: tab.id, name: tab.name || 'Untitled', tokens: tabTokens, entries, groups,
      hasEntries: entries.length > 0, anyOpen: entries.some(entry => entry.open) };
  }

  /* -------------------------------------------- */
  /*  Form submission                             */
  /* -------------------------------------------- */
  /** Save the panel's form edits. Allowed for the GM, or a Trusted Player who owns the unit. */
  static async submit(_event, _form, formData) {
    if (!this.actor || !canFoundryUserAuthorDocument(game.user, this.actor)) return;
    const data = formData.object;
    const update = {};
    const footstepApprovals = [];
    let submittedVoicePath;
    let approveSubmittedVoicePath = false;
    const submittedType = ACTOR_TYPES.includes(data.actorType) ? data.actorType : null;
    if (submittedType) update['system.faction.role'] = submittedType;
    if ('factionName' in data) update['system.faction.name'] = String(data.factionName || '').trim();
    if ('factionIcon' in data) update['system.faction.icon'] = String(data.factionIcon || '').trim();
    if ('voicePath' in data) {
      const rawPath = String(data.voicePath || '').trim();
      submittedVoicePath = rawPath ? normalizeAudioFolderPath(rawPath) : '';
      if (rawPath && !submittedVoicePath) {
        warn('Voice folder must be a relative data path without traversal or URL syntax.');
        return;
      }
      const storedPath = normalizeAudioFolderPath(this.actor.system.art.voicePath) || '';
      approveSubmittedVoicePath = submittedVoicePath !== storedPath;
      update['system.art.voicePath'] = submittedVoicePath;
    }
    for (const group of FOOTSTEP_GROUPS) {
      const presetKey = `fs_${group.key}_preset`;
      const customKey = `fs_${group.key}_custom`;
      if (presetKey in data) {
        const preset = group.presets.some(option => option.value === data[presetKey])
          ? data[presetKey] : 'default';
        update[`system.art.footsteps.${group.key}.preset`] = preset;
      }
      if (!(customKey in data)) continue;
      const rawPath = String(data[customKey] || '').trim();
      const path = rawPath ? normalizeAudioFolderPath(rawPath) : '';
      if (rawPath && !path) {
        warn(`${group.label} custom footsteps must use a relative data folder without traversal or URL syntax.`);
        return;
      }
      update[`system.art.footsteps.${group.key}.customPath`] = path;
      const storedPath = normalizeAudioFolderPath(
        this.actor.system.art.footsteps[group.key].customPath
      ) || '';
      if ((path || storedPath) && !unitAudioRepository.isFootstepPathApproved(this.actor, group.key, path)) {
        footstepApprovals.push([group.key, path]);
      }
    }
    if ('factionColor' in data) {
      const color = String(data.factionColor || '').trim();
      if (color === '' || HEX_COLOR.test(color)) update['system.faction.color'] = color;
      else notifications.show(NOTIFICATION_IDS.ACTOR_CONTROL_COLOR_INVALID);
    }
    if ('scale_avatar' in data) {
      const scale = clampScale(data.scale_avatar, AVATAR_SCALE_MAX, AVATAR_SCALE_DEFAULT);
      update['system.art.tokenScales.avatar'] = scale;
      update['system.art.avatarScale'] = scale;
    }
    if ('scale_default' in data) update['system.art.tokenScales.default'] = clampScale(data.scale_default);
    if ('offsety_default' in data) update['system.art.tokenOffsetsY.default'] = clampOffsetY(data.offsety_default);
    if ('prototypeTokenName' in data) {
      const name = String(data.prototypeTokenName || '').trim();
      if (name) update['prototypeToken.name'] = name;
    }
    if ('prototypeTokenSize' in data) {
      const size = Number(data.prototypeTokenSize) === 2 ? 2 : 1;
      update['prototypeToken.width'] = size;
      update['prototypeToken.height'] = size;
    }
    const { sightUpdate, tokenFx } = this._collectPrototypeTokenUpdates(data, update, submittedType);
    this._collectArtTabUpdates(data, update);
    if (!Object.keys(update).length) return;
    if (!await this._saveActor(update)) return;
    if (Object.keys(sightUpdate).length) await this._applySightToPlacedTokens(sightUpdate);
    if (tokenFx) applyTokenFxToPlacedTokens(this.actor, tokenFx);
    if (approveSubmittedVoicePath) await unitAudioRepository.approveVoicePath(this.actor, submittedVoicePath);
    for (const [mode, path] of footstepApprovals) {
      await unitAudioRepository.approveFootstepPath(this.actor, mode, path);
    }
  }

  /**
   * Gather the prototype-token half of a submission: linkage, sight, the visual effects and, for a GM, ownership.
   * @param {object} data            The submitted form data.
   * @param {object} update          The Actor update being built, extended in place.
   * @param {string|null} submittedType The faction role submitted, when one was.
   * @returns {object} The sight changes and token effects, which are also pushed to placed Tokens.
   */
  _collectPrototypeTokenUpdates(data, update, submittedType) {
    const linkedType = submittedType ?? this.actor.system.faction.role ?? 'Neutral';
    if ('prototypeTokenLink' in data || LINKED_ACTOR_TYPES.has(linkedType)) {
      update['prototypeToken.actorLink'] = LINKED_ACTOR_TYPES.has(linkedType) || Boolean(data.prototypeTokenLink);
    }
    const sightUpdate = {};
    if ('prototypeTokenSight' in data) sightUpdate['sight.enabled'] = Boolean(data.prototypeTokenSight);
    if ('prototypeTokenSightRange' in data) {
      const range = Number(data.prototypeTokenSightRange);
      if (Number.isFinite(range) && range >= 0) sightUpdate['sight.range'] = range;
    }
    if ('prototypeTokenSightAngle' in data) {
      const angle = Number(data.prototypeTokenSightAngle);
      if (Number.isFinite(angle)) sightUpdate['sight.angle'] = Math.max(0, Math.min(360, angle));
    }
    for (const [path, value] of Object.entries(sightUpdate)) update[`prototypeToken.${path}`] = value;
    const tokenFx = readTokenFxSubmission(data, this.actor.flags?.[SYSTEM_ID]?.[TOKEN_FX_FLAG_KEY]);
    if (tokenFx) {
      update[`flags.${SYSTEM_ID}.${TOKEN_FX_FLAG_KEY}`] = tokenFx;
      if (!this.actor.isToken) {
        const filters = buildPrototypeTokenFxFilters(this.actor, buildTokenFxFilters(tokenFx));
        if (filters.length) update['prototypeToken.flags.tokenmagic.filters'] = filters;
        else Object.assign(update, forcedDeletion('prototypeToken.flags.tokenmagic.filters'));
      }
    }
    // Only the GM may change ownership. The Owners boxes are also shown to a Trusted owner, but their
    // changes are ignored here.
    const ownership = game.user.isGM ? ownershipChanges(this.actor, data) : {};
    if (Object.keys(ownership).length) update.ownership = ownership;
    return { sightUpdate, tokenFx };
  }

  /**
   * Gather the Class art tabs, their slot scales and offsets, and their entries' item, ability and spell references
   * out of a submission.
   * @param {object} data     The submitted form data.
   * @param {object} update   The Actor update being built, extended in place.
   */
  _collectArtTabUpdates(data, update) {
    const tabs = foundry.utils.deepClone(this.actor.system.art.tabs);
    let tabsDirty = false;
    for (const tab of tabs) {
      for (const slot of TOKEN_ART_SLOTS) {
        const scaleKey = `tabscale_${tab.id}_${slot.key}`;
        if (scaleKey in data) {
          const value = clampScale(data[scaleKey]);
          if (tab.tokenScales[slot.key] !== value) { tab.tokenScales[slot.key] = value; tabsDirty = true; }
        }
        const offsetKey = `taboffsety_${tab.id}_${slot.key}`;
        if (offsetKey in data) {
          const value = clampOffsetY(data[offsetKey]);
          if (tab.tokenOffsetsY[slot.key] !== value) { tab.tokenOffsetsY[slot.key] = value; tabsDirty = true; }
        }
      }
      tab.entries = tab.entries.map((entry, index) => {
        let next = entry;
        for (const [suffix, field] of ENTRY_REFERENCE_INPUTS) {
          const key = `centry_${tab.id}_${index}_${suffix}`;
          if (!(key in data)) continue;
          const value = String(data[key] || '').trim();
          if (value !== String(entry[field] || '')) { next = { ...next, [field]: value }; tabsDirty = true; }
        }
        return next;
      });
    }
    if (tabsDirty) update['system.art.tabs'] = tabs;
  }

  /**
   * Push a sight edit to this Actor's placed Tokens on every Scene, not only the one this client displays: one write
   * per Scene, holding only the Tokens whose sight differs.
   */
  async _applySightToPlacedTokens(sightUpdate) {
    this._localWrites += 1;
    try {
      if (this.actor.isToken) return void await this.actor.token?.update(sightUpdate);
      const updates = new Map();
      for (const token of this.actor.getDependentTokens({ concreteOnly: true })) {
        const differs = Object.entries(sightUpdate)
          .some(([path, value]) => foundry.utils.getProperty(token._source, path) !== value);
        if (!differs) continue;
        if (!updates.has(token.parent)) updates.set(token.parent, []);
        updates.get(token.parent).push({ _id: token.id, ...sightUpdate });
      }
      for (const [scene, tokens] of updates) await scene.updateEmbeddedDocuments('Token', tokens);
    } catch (error) {
      reportFoundryError(import.meta.url, error, 'Emblem RPG | Actor Control Panel sight push failed');
    } finally { this._localWrites -= 1; }
  }

  async _saveActor(update, { render = false } = {}) {
    this._localWrites += 1;
    try {
      await this.actor.update(update);
      if (render) this.render(false);
      return true;
    } catch (error) {
      reportFoundryError(import.meta.url, error, 'Emblem RPG | Actor Control Panel update failed');
      return false;
    } finally { this._localWrites -= 1; }
  }

  /* -------------------------------------------- */
  /*  Tray and folder actions                     */
  /* -------------------------------------------- */
  static setTray(event, target) {
    event.preventDefault();
    const tray = target.dataset.tray;
    if (!['faction', 'audio'].includes(tray)) return;
    this._activeTray = tray;
    for (const tab of this.element?.querySelectorAll('[data-tray]') ?? []) {
      const active = tab.dataset.tray === tray;
      tab.classList.toggle('is-active', active);
      if (active) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    }
    for (const pane of this.element?.querySelectorAll('[data-tray-pane]') ?? []) {
      pane.classList.toggle('is-active', pane.dataset.trayPane === tray);
    }
  }

  static async pickFolder(event, target) {
    event.preventDefault();
    const input = this.element?.querySelector(`[name="${target.dataset.target}"]`);
    if (!input) return;
    const picker = new foundry.applications.apps.FilePicker.implementation({
      type: 'folder',
      current: input.value || 'worlds/',
      callback: path => {
        input.value = path;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    return picker.browse();
  }

  /** GM only: approve this voice folder, or remove its approval. */
  static async approveVoicePath(event) {
    event.preventDefault();
    const input = this.element?.querySelector('[name="voicePath"]');
    const rawPath = String(input?.value || '').trim();
    const path = normalizeAudioFolderPath(rawPath);
    if (!path) return warn('Choose a valid voice folder before approving it.');
    const storedPath = normalizeAudioFolderPath(this.actor.system.art.voicePath) || '';
    if (storedPath === path && unitAudioRepository.isVoicePathApproved(this.actor) === true) {
      if (await unitAudioRepository.approveVoicePath(this.actor, null)) {
        info('Voice folder approval revoked.');
        this.render(false);
      }
      return;
    }
    if ((this.actor.system.art.voicePath || '') !== path) {
      if (!await this._saveActor({ 'system.art.voicePath': path })) return;
    }
    if (await unitAudioRepository.approveVoicePath(this.actor, path)) {
      info('Voice folder approved.');
      this.render(false);
    }
  }

  /* -------------------------------------------- */
  /*  Image and color actions                     */
  /* -------------------------------------------- */
  static async pickFieldImage(event, target) {
    event.preventDefault();
    const fieldName = target.dataset.target;
    const input = this.element?.querySelector(`[name="${fieldName}"]`);
    if (!input) return;
    return browseImage(input.value || 'worlds/', path => {
      input.value = path;
      const preview = this.element?.querySelector(`[data-preview-for="${fieldName}"]`);
      if (preview) preview.src = path || DEFAULT_ICON;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  /** Open Token Studio through the Studio adapter. */
  static async editTokenSlot(event, target) {
    event.preventDefault();
    if (this.actor.isToken || !canFoundryUserAuthorDocument(game.user, this.actor)) return;
    const outcome = await openStudioForSlot(this.actor, target.dataset.slot === 'avatar' ? 'default' : target.dataset.slot);
    if (!outcome.ok) showStudioFailure(outcome);
  }

  static async clearTokenSlot(event, target) {
    event.preventDefault();
    if (target.dataset.slot === 'avatar') return this._saveActor({ img: DEFAULT_IMAGE }, { render: true });
    const slot = tokenSlot(target.dataset.slot);
    if (!slot) return;
    const update = { [`system.art.tokens.${slot.key}`]: '' };
    if (slot.key === 'default') update['prototypeToken.texture.src'] = this.actor.img || DEFAULT_IMAGE;
    await this._saveActor(update, { render: true });
  }

  static openColor(event) {
    event.preventDefault();
    const textInput = this.element?.querySelector('input[name="factionColor"]');
    const nativeInput = this.element?.querySelector('input[data-native-color="1"]');
    if (!textInput || !nativeInput) return;
    nativeInput.value = HEX_COLOR.test(textInput.value) ? textInput.value : '#ffffff';
    nativeInput.click();
  }

  /* -------------------------------------------- */
  /*  Class tabs                                  */
  /* -------------------------------------------- */
  static selectTab(event, target) {
    event.preventDefault();
    this._activeTabId = target.dataset.tab || DEFAULT_TAB_ID;
    this.render(false);
  }

  static async addTab(event) {
    event.preventDefault();
    const tabs = foundry.utils.deepClone(this.actor.system.art.tabs);
    if (tabs.length + 1 >= MAX_TOKEN_ART_TABS) return warn(`Maximum of ${MAX_TOKEN_ART_TABS} tabs reached.`);
    const classNames = await this._getAllClassNames();
    if (!classNames.length) return warn('No Class items exist in this world.');
    const datalistId = `acp-class-list-${this.actor.id}`;
    const choices = classNames.map(name => `<option value="${escapeHtml(name)}"></option>`).join('');
    const raw = await DialogV2.prompt({
      window: { title: 'Add a Class' },
      content: `<div class="form-group"><label>Class name</label><input type="text" name="tabName" list="${datalistId}" autofocus autocomplete="off"><datalist id="${datalistId}">${choices}</datalist></div>`,
      ok: { label: 'Add', callback: (_event, button) => button.form.elements.tabName.value },
      rejectClose: false
    });
    const requested = String(raw ?? '').trim();
    if (!requested) return;
    const canonical = classNames.find(name => name.toLowerCase() === requested.toLowerCase());
    if (!canonical) return warn(`“${requested}” is not a valid Class.`);
    if (tabs.some(tab => String(tab.name || '').toLowerCase() === canonical.toLowerCase())) {
      return warn(`A tab for “${canonical}” already exists.`);
    }
    const seed = String(classItemFor(this.actor)?.name || '').toLowerCase() === canonical.toLowerCase();
    const newTab = { id: foundry.utils.randomID(), name: canonical,
      tokens: seed ? this._defaultTokenSnapshot() : {},
      tokenScales: seed ? this._defaultScalesSnapshot() : {},
      tokenOffsetsY: seed ? this._defaultOffsetsSnapshot() : {}, entries: [] };
    tabs.push(newTab);
    this._activeTabId = newTab.id;
    await this._saveActor({ 'system.art.tabs': tabs,
      ...(seed ? studioClassSeedUpdate(this.actor, canonical) : {}) }, { render: true });
  }

  static async renameTab(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const tabs = foundry.utils.deepClone(this.actor.system.art.tabs);
    const index = tabs.findIndex(tab => tab.id === target.dataset.tab);
    if (index < 0) return;
    const raw = await DialogV2.prompt({
      window: { title: 'Rename Tab' },
      content: `<div class="form-group"><label>Tab name</label><input type="text" name="tabName" value="${escapeHtml(tabs[index].name || '')}" autofocus autocomplete="off"></div>`,
      ok: { label: 'Rename', callback: (_event, button) => button.form.elements.tabName.value }, rejectClose: false
    });
    const name = String(raw ?? '').trim();
    if (!name || name === tabs[index].name) return;
    if (tabs.some((tab, tabIndex) => tabIndex !== index && String(tab.name || '').toLowerCase() === name.toLowerCase())) {
      return warn(`A tab named “${name}” already exists.`);
    }
    tabs[index].name = name;
    await this._saveActor({ 'system.art.tabs': tabs }, { render: true });
  }

  static async deleteTab(event, target) {
    event.preventDefault();
    const tabs = foundry.utils.deepClone(this.actor.system.art.tabs);
    const index = tabs.findIndex(tab => tab.id === target.dataset.tab);
    if (index < 0) return;
    const confirmed = await DialogV2.confirm({ window: { title: 'Delete Tab' },
      content: `<p>Delete tab <strong>${escapeHtml(tabs[index].name || 'Untitled')}</strong> and all its conditional entries?</p>`, modal: true });
    if (!confirmed) return;
    const tabId = tabs[index].id;
    tabs.splice(index, 1);
    this._openEntries.delete(tabId);
    if (this._activeTabId === tabId) this._activeTabId = DEFAULT_TAB_ID;
    await this._saveActor({ 'system.art.tabs': tabs }, { render: true });
  }

  static async fillFromClass(event) {
    event.preventDefault();
    const classItem = classItemFor(this.actor);
    if (!classItem) return warn(`${this.actor.name} has no Class.`);
    const names = [classItem.name,
      ...classItem.system.promotions.map(entry => String(entry.className || '').trim()).filter(Boolean)];
    const tabs = foundry.utils.deepClone(this.actor.system.art.tabs);
    const existing = new Set(tabs.map(tab => String(tab.name || '').toLowerCase()).filter(Boolean));
    const capacity = MAX_TOKEN_ART_TABS - 1 - tabs.length;
    if (capacity <= 0) return warn(`Maximum of ${MAX_TOKEN_ART_TABS} tabs reached.`);
    let added = 0;
    let seededClass = '';
    for (const name of names) {
      if (added >= capacity) break;
      if (!name || existing.has(name.toLowerCase())) continue;
      const seed = name.toLowerCase() === String(classItem.name || '').toLowerCase();
      if (seed) seededClass = name;
      tabs.push({ id: foundry.utils.randomID(), name,
        tokens: seed ? this._defaultTokenSnapshot() : {},
        tokenScales: seed ? this._defaultScalesSnapshot() : {},
        tokenOffsetsY: seed ? this._defaultOffsetsSnapshot() : {}, entries: [] });
      existing.add(name.toLowerCase());
      added += 1;
    }
    if (!added) return info('All Class names are already tabs.');
    await this._saveActor({ 'system.art.tabs': tabs,
      ...(seededClass ? studioClassSeedUpdate(this.actor, seededClass) : {}) }, { render: true });
  }

  async _getAllClassNames() {
    const names = new Set();
    const own = classItemFor(this.actor);
    if (own?.name) names.add(own.name);
    for (const entry of await readItemCatalog(['Class'])) if (entry.name) names.add(entry.name);
    return [...names].sort((left, right) => left.localeCompare(right));
  }

  _defaultTokenSnapshot() {
    return { default: this.actor.system.art.tokens.default || '' };
  }

  _defaultScalesSnapshot() {
    return { default: clampScale(this.actor.system.art.tokenScales.default) };
  }

  _defaultOffsetsSnapshot() {
    return { default: clampOffsetY(this.actor.system.art.tokenOffsetsY.default) };
  }

  /* -------------------------------------------- */
  /*  Nested token slots                          */
  /* -------------------------------------------- */
  /** Open Token Studio on this class art slot. */
  static async editTabTokenSlot(event, target) {
    event.preventDefault();
    if (this.actor.isToken || !canFoundryUserAuthorDocument(game.user, this.actor)) return;
    const outcome = await openStudioForSlot(this.actor, target.dataset.slot, { tabId: target.dataset.tab });
    if (!outcome.ok) showStudioFailure(outcome);
  }

  static async clearTabTokenSlot(event, target) {
    event.preventDefault();
    const slot = tokenSlot(target.dataset.slot);
    const tabs = foundry.utils.deepClone(this.actor.system.art.tabs);
    const tab = tabs.find(candidate => candidate.id === target.dataset.tab);
    if (!slot || !tab) return;
    tab.tokens[slot.key] = '';
    await this._saveActor({ 'system.art.tabs': tabs }, { render: true });
  }

  /** Open Token Studio on this conditional art slot. */
  static async editConditionalSlot(event, target) {
    event.preventDefault();
    if (this.actor.isToken || !canFoundryUserAuthorDocument(game.user, this.actor)) return;
    const entryIndex = Number(target.dataset.entry);
    if (!Number.isInteger(entryIndex)) return;
    const outcome = await openStudioForSlot(this.actor, target.dataset.slot,
      { tabId: target.dataset.tab, entryIndex });
    if (!outcome.ok) showStudioFailure(outcome);
  }

  static async clearConditionalSlot(event, target) {
    event.preventDefault();
    const slot = tokenSlot(target.dataset.slot);
    const entryIndex = Number(target.dataset.entry);
    const tabs = foundry.utils.deepClone(this.actor.system.art.tabs);
    const entry = tabs.find(tab => tab.id === target.dataset.tab)?.entries[entryIndex];
    if (!slot || !entry) return;
    entry.tokens[slot.key] = '';
    await this._saveActor({ 'system.art.tabs': tabs }, { render: true });
  }

  /* -------------------------------------------- */
  /*  Conditional entries                        */
  /* -------------------------------------------- */
  static async addConditionalEntry(event, target) {
    event.preventDefault();
    const tabs = foundry.utils.deepClone(this.actor.system.art.tabs);
    const tab = tabs.find(candidate => candidate.id === target.dataset.tab);
    if (!tab) return;
    const index = tab.entries.length;
    tab.entries.push({ id: foundry.utils.randomID(), name: '', triggers: [], guards: [] });
    const open = this._openEntries.get(tab.id) ?? new Set();
    open.add(index);
    this._openEntries.set(tab.id, open);
    await this._saveActor({ 'system.art.tabs': tabs }, { render: true });
  }

  /**
   * Append the stock entries the Map Entries checklist asks for to this tab in one save. `planTokenEntryMap` in
   * `contracts/domains/tokens.mjs` decides the entries. One the tab already carries is skipped, so mapping twice
   * adds nothing.
   */
  static async mapConditionalEntries(event, target) {
    event.preventDefault();
    const selections = await openMapEntriesDialog(this.actor);
    if (!Array.isArray(selections)) return;
    const tabs = foundry.utils.deepClone(this.actor.system.art.tabs);
    const tab = tabs.find(candidate => candidate.id === target.dataset.tab);
    if (!tab) return;
    const existing = new Set(tab.entries.map(entry =>
      deriveTokenEntryName(readTokenEntryTriggers(entry), readTokenEntryGuards(entry))));
    let added = 0;
    for (const { triggers, guards } of planTokenEntryMap(selections)) {
      const name = deriveTokenEntryName(triggers, guards);
      if (existing.has(name)) continue;
      existing.add(name);
      tab.entries.push({ id: foundry.utils.randomID(), name, triggers, guards });
      added += 1;
    }
    if (!added) return info('Every mapped entry is already on this tab.');
    await this._saveActor({ 'system.art.tabs': tabs }, { render: true });
  }

  static async deleteConditionalEntry(event, target) {
    event.preventDefault();
    const index = Number(target.dataset.entry);
    const tabs = foundry.utils.deepClone(this.actor.system.art.tabs);
    const tab = tabs.find(candidate => candidate.id === target.dataset.tab);
    if (!tab?.entries[index]) return;
    tab.entries.splice(index, 1);
    this._remapOpenEntries(tab.id, index, -1);
    await this._saveActor({ 'system.art.tabs': tabs }, { render: true });
  }

  static async duplicateConditionalEntry(event, target) {
    event.preventDefault();
    const index = Number(target.dataset.entry);
    const tabs = foundry.utils.deepClone(this.actor.system.art.tabs);
    const tab = tabs.find(candidate => candidate.id === target.dataset.tab);
    if (!tab?.entries[index]) return;
    tab.entries.splice(index + 1, 0, { ...foundry.utils.deepClone(tab.entries[index]), id: foundry.utils.randomID() });
    this._remapOpenEntries(tab.id, index, 1);
    const open = this._openEntries.get(tab.id) ?? new Set();
    open.add(index + 1);
    this._openEntries.set(tab.id, open);
    await this._saveActor({ 'system.art.tabs': tabs }, { render: true });
  }

  _remapOpenEntries(tabId, pivot, delta) {
    const current = this._openEntries.get(tabId) ?? new Set();
    const next = new Set();
    for (const index of current) {
      if (delta < 0 && index === pivot) continue;
      next.add(index > pivot ? index + delta : index);
    }
    this._openEntries.set(tabId, next);
  }

  static toggleAllConditionalEntries(event, target) {
    event.preventDefault();
    const tab = this.actor.system.art.tabs.find(candidate => candidate.id === target.dataset.tab);
    const current = this._openEntries.get(target.dataset.tab) ?? new Set();
    this._openEntries.set(target.dataset.tab, current.size ? new Set()
      : new Set(Array.from({ length: tab?.entries.length ?? 0 }, (_value, index) => index)));
    this.render(false);
  }

  async _moveConditionalEntry(tabId, from, to, before) {
    if (from === to) return;
    const tabs = foundry.utils.deepClone(this.actor.system.art.tabs);
    const entries = tabs.find(tab => tab.id === tabId)?.entries;
    if (!entries?.[from] || !entries?.[to]) return;
    const open = this._openEntries.get(tabId) ?? new Set();
    const openFlags = entries.map((_entry, index) => open.has(index));
    const [entry] = entries.splice(from, 1);
    const [wasOpen] = openFlags.splice(from, 1);
    let insertion = to > from ? to - 1 : to;
    if (!before) insertion += 1;
    entries.splice(insertion, 0, entry);
    openFlags.splice(insertion, 0, wasOpen);
    this._openEntries.set(tabId, new Set(openFlags.flatMap((value, index) => value ? [index] : [])));
    await this._saveActor({ 'system.art.tabs': tabs }, { render: true });
  }

  static async addEntryTrigger(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const index = Number(target.dataset.entry);
    const { triggers, guards } = this._entryConditionSets(target.dataset.tab, index);
    const condition = await this._pickCondition('Add Trigger', new Set([...triggers, ...guards]), TOKEN_CONDITIONS);
    if (!condition) return;
    await this._mutateEntry(target.dataset.tab, index, entry => {
      entry.triggers = [...readTokenEntryTriggers(entry), condition];
    });
  }

  static async removeEntryTrigger(event, target) {
    event.preventDefault();
    event.stopPropagation();
    await this._mutateEntry(target.dataset.tab, Number(target.dataset.entry), entry => {
      entry.triggers = readTokenEntryTriggers(entry).filter(condition => condition !== target.dataset.cond);
    });
  }

  static async addEntryGuard(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const index = Number(target.dataset.entry);
    const { triggers, guards } = this._entryConditionSets(target.dataset.tab, index);
    const condition = await this._pickCondition('Add Requirement', new Set([...triggers, ...guards]),
      STEADY_TOKEN_CONDITIONS);
    if (!condition) return;
    await this._mutateEntry(target.dataset.tab, index, entry => {
      entry.guards = [...readTokenEntryGuards(entry), condition];
    });
  }

  static async removeEntryGuard(event, target) {
    event.preventDefault();
    event.stopPropagation();
    await this._mutateEntry(target.dataset.tab, Number(target.dataset.entry), entry => {
      entry.guards = readTokenEntryGuards(entry).filter(condition => condition !== target.dataset.cond);
    });
  }

  _entryConditionSets(tabId, index) {
    const entry = this.actor.system.art.tabs.find(tab => tab.id === tabId)?.entries[index];
    return { triggers: new Set(readTokenEntryTriggers(entry)), guards: new Set(readTokenEntryGuards(entry)) };
  }

  async _pickCondition(title, excluded, vocabulary) {
    const available = vocabulary.filter(condition => !excluded.has(condition));
    if (!available.length) { info('All applicable conditions are already on this entry.'); return null; }
    const options = available.map(condition => `<option value="${escapeHtml(condition)}">${escapeHtml(condition)}</option>`).join('');
    const value = await DialogV2.prompt({ window: { title },
      content: `<div class="form-group"><label>Condition</label><select name="condition">${options}</select></div>`,
      ok: { label: 'Add', callback: (_event, button) => button.form.elements.condition.value }, rejectClose: false });
    return String(value ?? '').trim() || null;
  }

  async _mutateEntry(tabId, index, mutator) {
    const tabs = foundry.utils.deepClone(this.actor.system.art.tabs);
    const entry = tabs.find(tab => tab.id === tabId)?.entries[index];
    if (!entry) return;
    mutator(entry);
    entry.triggers = readTokenEntryTriggers(entry);
    entry.guards = readTokenEntryGuards(entry);
    entry.name = deriveTokenEntryName(entry.triggers, entry.guards);
    await this._saveActor({ 'system.art.tabs': tabs }, { render: true });
  }

  /* -------------------------------------------- */
  /*  Live controls and drag/drop                 */
  /* -------------------------------------------- */
  _onRender(context, options) {
    super._onRender(context, options);
    if (!this.element) return;
    this._paintWindowTitle();
    this._bindColorControls();
    this._bindFootstepControls();
    this._bindScaleLabels();
    this._bindConditionalEntries();
    this._bindItemDrops();
    this._bindVariantDrops();
    this._bindTokenEffects();
    const tabs = this.element.querySelector('.acp-tabs');
    tabs?.addEventListener('wheel', event => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      tabs.scrollLeft += event.deltaY;
    }, { passive: false });
  }

  _paintWindowTitle() {
    const heading = this.element.querySelector('.window-header .window-title');
    if (!heading) return;
    heading.innerHTML = `Control Panel: <span class="acp-title-subject">${escapeHtml(this.actor.name)}</span>`;
  }

  _bindTokenEffects() {
    const root = this.element.querySelector('[data-acp-fx]');
    if (!root) return;
    for (const slider of root.querySelectorAll('input[type="range"][data-fx-label]')) {
      const readout = root.querySelector(`[data-fx-value="${slider.dataset.fxLabel}"]`);
      if (readout) slider.addEventListener('input', () => { readout.textContent = slider.value; });
    }
    for (const disclosure of root.querySelectorAll('details.acp-fx-adv[data-fx-adv]')) {
      disclosure.addEventListener('toggle', () => { this._fxOpen[disclosure.dataset.fxAdv] = disclosure.open; });
    }
    const animSelect = root.querySelector('[data-fx-anim-select]');
    const showAnimMode = () => {
      const pulse = animSelect?.value === 'pulse';
      for (const block of root.querySelectorAll('[data-fx-anim-mode="color"]')) {
        block.style.display = pulse ? 'none' : '';
      }
      for (const block of root.querySelectorAll('[data-fx-anim-mode="pulse"]')) {
        block.style.display = pulse ? '' : 'none';
      }
    };
    animSelect?.addEventListener('change', showAnimMode);
    showAnimMode();
    // Live preview while a control moves: at most every 90 ms, write the effects to this actor's placed
    // tokens. These are saved Token Magic flags, so every client sees the preview.
    root.addEventListener('input', () => {
      if (this._fxPreviewTimer) return;
      this._fxPreviewTimer = setTimeout(() => {
        this._fxPreviewTimer = null;
        applyTokenFxToPlacedTokens(this.actor, this._readTokenFxFields(root));
      }, 90);
    });
  }

  _readTokenFxFields(root) {
    const data = {};
    for (const field of root.querySelectorAll('[name^="fx_"]')) {
      data[field.name] = field.type === 'checkbox' ? field.checked : field.value;
    }
    return readTokenFxSubmission(data, this.actor.flags?.[SYSTEM_ID]?.[TOKEN_FX_FLAG_KEY])
      ?? normalizeTokenFxConfig(this.actor.flags?.[SYSTEM_ID]?.[TOKEN_FX_FLAG_KEY]);
  }

  _bindColorControls() {
    const textInput = this.element.querySelector('input[name="factionColor"]');
    const nativeInput = this.element.querySelector('input[data-native-color="1"]');
    const swatch = this.element.querySelector('.acp-color-swatch');
    const updateSwatch = value => { if (swatch) swatch.style.background = HEX_COLOR.test(value) ? value : 'transparent'; };
    if (textInput) {
      updateSwatch(textInput.value);
      textInput.addEventListener('input', () => updateSwatch(textInput.value));
    }
    // The hidden native color picker copies its value into the text field and fires change there,
    // which submits the form on every input event.
    nativeInput?.addEventListener('input', () => {
      if (!textInput) return;
      textInput.value = nativeInput.value;
      updateSwatch(nativeInput.value);
      textInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  _bindScaleLabels() {
    for (const input of this.element.querySelectorAll('[data-scale-id]')) {
      input.addEventListener('input', () => {
        const label = this.element.querySelector(`[data-scale-label="${input.dataset.scaleId}"]`);
        if (label) label.textContent = Number(input.value).toFixed(2);
      });
    }
  }

  _bindFootstepControls() {
    for (const select of this.element.querySelectorAll('[data-fs-preset]')) {
      select.addEventListener('change', () => {
        const row = this.element.querySelector(`[data-fs-custom-row="${select.dataset.fsPreset}"]`);
        if (row) row.style.display = select.value === 'custom' ? '' : 'none';
      });
    }
  }

  _bindConditionalEntries() {
    for (const details of this.element.querySelectorAll('details.acp-promo-entry')) {
      const index = Number(details.dataset.entryIndex);
      const tabId = details.dataset.tab;
      details.addEventListener('toggle', () => {
        const open = this._openEntries.get(tabId) ?? new Set();
        if (details.open) open.add(index); else open.delete(index);
        this._openEntries.set(tabId, open);
      });
      // A text selection dragged out of a header field releases over the header,
      // and that click would toggle the entry.
      const summary = details.querySelector(':scope > summary');
      let pressedInField = false;
      summary?.addEventListener('pointerdown', event => {
        pressedInField = !!event.target.closest('input, textarea, select');
      });
      summary?.addEventListener('click', event => {
        if (pressedInField) event.preventDefault();
        pressedInField = false;
      }, { capture: true });
      const grip = details.querySelector('.acp-promo-grip');
      grip?.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
      grip?.addEventListener('dragstart', event => {
        this._entryDrag = { tabId, index, group: details.dataset.group };
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData(ENTRY_DRAG_MIME, '1');
        details.classList.add('acp-drag-source');
      });
      grip?.addEventListener('dragend', () => {
        this._entryDrag = null;
        this.element.querySelectorAll('.acp-drag-source, .acp-drag-over-top, .acp-drag-over-bottom')
          .forEach(element => element.classList.remove('acp-drag-source', 'acp-drag-over-top', 'acp-drag-over-bottom'));
      });
      details.addEventListener('dragover', event => {
        const drag = this._entryDrag;
        if (!drag || drag.tabId !== tabId || drag.group !== details.dataset.group || drag.index === index) return;
        event.preventDefault();
        const rect = details.getBoundingClientRect();
        const before = event.clientY - rect.top < rect.height / 2;
        details.classList.toggle('acp-drag-over-top', before);
        details.classList.toggle('acp-drag-over-bottom', !before);
      });
      details.addEventListener('drop', async event => {
        const drag = this._entryDrag;
        if (!drag || drag.tabId !== tabId || drag.group !== details.dataset.group || drag.index === index) return;
        event.preventDefault();
        const rect = details.getBoundingClientRect();
        await this._moveConditionalEntry(tabId, drag.index, index, event.clientY - rect.top < rect.height / 2);
      });
    }
  }

  _bindItemDrops() {
    for (const input of this.element.querySelectorAll('input[data-acp-item-input="1"]')) {
      input.addEventListener('click', event => event.stopPropagation());
      input.addEventListener('dragover', event => { event.preventDefault(); input.classList.add('acp-drop-hot'); });
      input.addEventListener('dragleave', () => input.classList.remove('acp-drop-hot'));
      input.addEventListener('drop', async event => {
        event.preventDefault();
        event.stopPropagation();
        input.classList.remove('acp-drop-hot');
        const payload = readDropPayload(event);
        const uuid = String(payload?.uuid ?? '').trim();
        if (!uuid) return;
        let document = null;
        try {
          document = await foundry.utils.fromUuid(uuid);
        } catch (_) {
          reportFoundryError(import.meta.url, _, '_bindItemDrops');
        }
        if (document?.documentName !== 'Item') return warn('That drop is not an Item.');
        // A name without its refinement tier covers every forged copy of the item.
        const name = String(document.name ?? '').replace(REFINEMENT_SUFFIX, '').trim();
        if (!name) return warn('That Item has no name to reference.');
        const tabs = foundry.utils.deepClone(this.actor.system.art.tabs);
        const entry = tabs.find(tab => tab.id === input.dataset.acpTab)?.entries[Number(input.dataset.acpEntry)];
        if (!entry) return;
        const field = ENTRY_REFERENCE_FIELDS.has(input.dataset.acpField) ? input.dataset.acpField : 'specificItemUuid';
        const names = readTokenEntryReferences(entry[field]);
        if (!names.some(existing => existing.toLowerCase() === name.toLowerCase())) names.push(name);
        entry[field] = names.join(', ');
        await this._saveActor({ 'system.art.tabs': tabs }, { render: true });
      });
    }
  }

  _bindVariantDrops() {
    if (this.actor.isToken) return;
    for (const frame of this.element.querySelectorAll('.acp-token-frame[data-acp-frame]')) {
      if (frame.dataset.acpDrag === '1') {
        frame.draggable = true;
        frame.addEventListener('dragstart', event => {
          const path = frame.dataset.acpPath || '';
          if (!path) return event.preventDefault();
          event.dataTransfer.setData(VARIANT_DRAG_MIME, path);
          event.dataTransfer.effectAllowed = 'copy';
        });
      }
      frame.addEventListener('dragover', event => {
        if (!event.dataTransfer.types.includes(VARIANT_DRAG_MIME)) return;
        event.preventDefault();
        frame.classList.add('acp-drop-hot');
      });
      frame.addEventListener('dragleave', () => frame.classList.remove('acp-drop-hot'));
      frame.addEventListener('drop', async event => {
        if (!event.dataTransfer.types.includes(VARIANT_DRAG_MIME)) return;
        event.preventDefault();
        frame.classList.remove('acp-drop-hot');
        if (frame.dataset.acpHas === '1') return warn('Clear this variant image before pasting over it.');
        await this._pasteVariantImage(frame, event.dataTransfer.getData(VARIANT_DRAG_MIME));
      });
    }
  }

  async _pasteVariantImage(frame, path) {
    const slot = tokenSlot(frame.dataset.acpSlot);
    if (!slot || !path) return;
    if (frame.dataset.acpKind === 'default') {
      await this._saveActor({ [`system.art.tokens.${slot.key}`]: path }, { render: true });
      return;
    }
    const tabs = foundry.utils.deepClone(this.actor.system.art.tabs);
    const tab = tabs.find(candidate => candidate.id === frame.dataset.acpTab);
    if (!tab) return;
    if (frame.dataset.acpKind === 'tab') {
      tab.tokens[slot.key] = path;
    } else if (frame.dataset.acpKind === 'entry') {
      const entry = tab.entries[Number(frame.dataset.acpEntry)];
      if (!entry) return;
      entry.tokens[slot.key] = path;
    } else return;
    await this._saveActor({ 'system.art.tabs': tabs }, { render: true });
  }
}

/* -------------------------------------------- */
/*  External refresh                            */
/* -------------------------------------------- */
/**
 * Refresh the open panel for an Actor after any update to it, gameplay included. init/hooks.mjs calls it from
 * updateActor, and refreshFromActor skips the panel's own writes and batches the rest into one render.
 */
export function refreshActorControlPanel(actor, changes) {
  const bustArt = !changes || ART_REFRESH_PATHS.some(path => foundry.utils.hasProperty(changes, path));
  activePanels.get(actor?.uuid ?? actor?.id)?.refreshFromActor({ bustArt });
}

/**
 * Reload the images the open panel for one Actor shows, after a file was overwritten in place. Returns whether a
 * panel was open.
 */
export function refreshActorControlPanelArt(actorUuid) {
  const panel = activePanels.get(String(actorUuid ?? ''));
  if (!panel) return false;
  panel.refreshFromActor({ bustArt: true });
  return true;
}

/* -------------------------------------------- */
/*  View helpers                                */
/* -------------------------------------------- */
function tokenView(slot, path, fallbackPath, scale, offsetY, cacheBust) {
  const resolved = path || fallbackPath || '';
  return {
    ...slot,
    path,
    preview: resolved ? `${resolved}?${cacheBust}` : DEFAULT_IMAGE,
    hasImage: Boolean(path),
    isFallback: !path && Boolean(fallbackPath),
    dragPath: resolved,
    canDrag: Boolean(resolved),
    scale,
    scaleLabel: scale.toFixed(2),
    scaleMin: SCALE_MIN,
    scaleMax: slot.scaleMax ?? SCALE_MAX,
    scaleStep: 0.01,
    offsetY,
    offsetYLabel: offsetY.toFixed(2),
    offsetYMin: OFFSET_Y_MIN,
    offsetYMax: OFFSET_Y_MAX,
    offsetYStep: 0.05,
    showOffsetY: slot.showOffsetY !== false,
    editTooltip: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.EDIT_TOKEN_IMAGE, { label: slot.label })
  };
}

/** The sight fields the panel actually governs: an unlinked unit's own, everyone else's prototype. */
function sightView(actor) {
  const sight = (actor?.isToken ? actor.token?._source?.sight : actor?.prototypeToken?.sight) ?? {};
  return {
    sightEnabled: sight.enabled === true,
    sightRange: Number.isFinite(sight.range) ? sight.range : 0,
    sightAngle: Number.isFinite(sight.angle) ? sight.angle : 360
  };
}

function actorControlTooltips() {
  return Object.freeze({
    audioTray: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.AUDIO_TRAY),
    approveVoicePath: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.APPROVE_VOICE_PATH),
    approvedVoicePath: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.APPROVED_VOICE_PATH),
    addConditionalEntry: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.ADD_CONDITIONAL_ENTRY),
    mapConditionalEntries: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.MAP_CONDITIONAL_ENTRIES),
    addRequirement: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.ADD_REQUIREMENT),
    addTab: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.ADD_TOKEN_TAB),
    addTrigger: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.ADD_TRIGGER),
    browseFactionIcon: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.BROWSE_FACTION_ICON),
    browseAudioFolder: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.BROWSE_AUDIO_FOLDER),
    clearTokenImage: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.CLEAR_TOKEN_IMAGE),
    deleteEntry: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.DELETE_ENTRY),
    deleteTab: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.DELETE_TOKEN_TAB),
    dragEntry: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.DRAG_CONDITIONAL_ENTRY),
    dropItem: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.DROP_ITEM),
    duplicateEntry: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.DUPLICATE_ENTRY),
    fillTabs: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.FILL_TOKEN_TABS),
    factionTray: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.FACTION_TRAY),
    pickColor: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.PICK_COLOR),
    removeRequirement: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.REMOVE_REQUIREMENT),
    removeTrigger: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.REMOVE_TRIGGER),
    renameTab: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.RENAME_TOKEN_TAB),
    specificAbility: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.SPECIFIC_ABILITY),
    specificItem: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.SPECIFIC_ITEM),
    specificSpell: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.SPECIFIC_SPELL),
    tokenOffsetY: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.TOKEN_OFFSET_Y),
    tokenScale: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.TOKEN_SCALE),
    unlinkedToken: getTooltip(ACTOR_CONTROL_TOOLTIP_IDS.UNLINKED_TOKEN)
  });
}

/* -------------------------------------------- */
/*  Token effect submission                     */
/* -------------------------------------------- */
function readTokenFxSubmission(data, stored) {
  const submitted = Object.keys(TOKEN_FX_DEFAULTS).filter(key => `fx_${key}` in data);
  if (!submitted.length) return null;
  const current = normalizeTokenFxConfig(stored);
  const next = normalizeTokenFxConfig({ ...current,
    ...Object.fromEntries(submitted.map(key => [key, data[`fx_${key}`]])) });
  return JSON.stringify(next) === JSON.stringify(current) ? null : next;
}

/* -------------------------------------------- */
/*  Map Entries dialog                          */
/* -------------------------------------------- */
const MAP_ENTRY_EVENTS = Object.freeze([
  Object.freeze({ key: 'evade', label: 'Evade', hint: 'On Evade' }),
  Object.freeze({ key: 'split', label: 'Atk/Crit', hint: 'On Attack and On Crit, as two entries' }),
  Object.freeze({ key: 'combined', label: 'Atk+Crit', hint: 'On Attack and On Crit, as one entry' })
]);

/**
 * Ask which stock entries `ActorControlPanel.mapConditionalEntries` should add, in the shared `openEditor` shell.
 * Resolves with the checked groups in the shape `planTokenEntryMap` reads, or a non-array when dismissed.
 */
function openMapEntriesDialog(actor) {
  return openEditor({
    document: actor,
    title: 'Map Entries',
    icon: 'fas fa-diagram-project',
    width: 400,
    height: 'auto',
    classes: ['dialog-map-entries'],
    content: mapEntriesContent(),
    confirmAction: 'confirm',
    confirmLabel: 'Map',
    confirmIcon: 'fas fa-check',
    wire: wireMapEntries,
    gather: root => Array.from(root.querySelectorAll('.map-entries-group'))
      .filter(card => card.querySelector('[data-map-group]').checked)
      .map(card => ({
        group: card.dataset.group,
        ...Object.fromEntries(MAP_ENTRY_EVENTS.map(option =>
          [option.key, card.querySelector(`[data-map-event="${option.key}"]`)?.checked === true]))
      }))
  });
}

function mapEntriesContent() {
  const groups = TOKEN_ENTRY_MAP_GROUPS.map(group => {
    const events = MAP_ENTRY_EVENTS.filter(option => group.wielding || option.key === 'combined');
    const boxes = events.map(option => `
          <label class="map-entries-event" data-tooltip="${escapeHtml(option.hint)}">
            <input type="checkbox" data-map-event="${option.key}"><span>${escapeHtml(option.label)}</span>
          </label>`).join('');
    return `
      <div class="ed-card map-entries-group" data-group="${group.key}">
        <label class="ed-card-header">
          <input type="checkbox" data-map-group><span>${escapeHtml(group.label)}</span>
        </label>
        <div class="ed-card-body map-entries-events is-hidden">${boxes}</div>
      </div>`;
  }).join('');
  return `<div class="ed-container map-entries-container">
      <p class="ed-description">Check every group to map onto this tab. Entries the tab already has are skipped.</p>
      ${groups}
    </div>`;
}

/** Reveal a group's event boxes while it is checked, and keep the split and combined attack boxes exclusive. */
function wireMapEntries(root, _context, dialog) {
  for (const card of root.querySelectorAll('.map-entries-group')) {
    const events = card.querySelector('.map-entries-events');
    card.querySelector('[data-map-group]').addEventListener('change', event => {
      events.classList.toggle('is-hidden', !event.currentTarget.checked);
      dialog.setPosition({ height: 'auto' });
    });
    const split = card.querySelector('[data-map-event="split"]');
    const combined = card.querySelector('[data-map-event="combined"]');
    split?.addEventListener('change', () => { if (split.checked) combined.checked = false; });
    combined?.addEventListener('change', () => { if (combined.checked && split) split.checked = false; });
  }
}

/* -------------------------------------------- */
/*  Data helpers                                */
/* -------------------------------------------- */
function deriveTokenEntryName(triggers, guards) {
  if (!triggers.length && !guards.length) return '';
  return `${triggers.join(' / ')}${guards.length ? ` (+ ${guards.join(' & ')})` : ''}`;
}

/** Whether a keyed condition on the entry names an item, ability or spell, which puts it in the checked-first group. */
function entryNamesItems(entry, conditions) {
  return conditions.some(condition => condition in TOKEN_ENTRY_REFERENCE_FIELDS
    && readTokenEntryReferences(entry[TOKEN_ENTRY_REFERENCE_FIELDS[condition]]).length > 0);
}

function classifyTokenEntry(entry, triggers, guards) {
  if (!triggers.length) return 'unset';
  const conditions = [...triggers, ...guards];
  if (conditions.includes(SPECIFIC_ITEM_CONDITION) || entryNamesItems(entry, conditions)) return 'keyed';
  return triggers.some(trigger => TRANSIENT_TOKEN_CONDITIONS.has(trigger) || trigger === USING_ABILITY_CONDITION)
    ? 'event' : 'steady';
}

function computeTokenEntryShadows(entries) {
  const rows = entries.map(entry => {
    const triggers = readTokenEntryTriggers(entry);
    const guards = readTokenEntryGuards(entry);
    const conditions = [...triggers, ...guards];
    return {
      entry,
      triggers,
      guards,
      guardSet: new Set(guards),
      group: classifyTokenEntry(entry, triggers, guards),
      slots: TOKEN_ART_SLOTS.map(slot => slot.key).filter(key => entry.tokens[key]),
      keyed: conditions.some(condition => condition in TOKEN_ENTRY_REFERENCE_FIELDS),
      ids: entryReferenceKey(entry)
    };
  });
  return rows.map((row, index) => {
    if (!row.triggers.length || !row.slots.length) return { shadowed: false, byName: '' };
    const earlier = rows.slice(0, index).filter(candidate => candidate.group === row.group);
    let coverer = null;
    const covered = row.triggers.every(trigger => row.slots.every(field => {
      const match = earlier.find(candidate => candidate.triggers.includes(trigger)
        && candidate.entry?.[field]
        && candidate.guards.every(guard => row.guardSet.has(guard))
        && (!(candidate.keyed || row.keyed) || candidate.ids === row.ids));
      coverer ??= match ?? null;
      return Boolean(match);
    }));
    return {
      shadowed: covered,
      byName: covered && coverer ? deriveTokenEntryName(coverer.triggers, coverer.guards) : ''
    };
  });
}

function entryReferenceKey(entry) {
  const normalized = raw => readTokenEntryReferences(raw)
    .map(value => value.toLowerCase().split('.').pop() ?? '').filter(Boolean).sort().join(',');
  return Object.values(TOKEN_ENTRY_REFERENCE_FIELDS).map(field => normalized(entry[field])).join('|');
}

function tokenSlot(key) { return TOKEN_ART_SLOTS.find(slot => slot.key === key) ?? null; }
function classItemFor(actor) { return collectionValues(actor?.items).find(item => item?.type === 'Class') ?? null; }
function playerUsers() { return collectionValues(game.users).filter(user => !user.isGM); }

function ownershipChanges(actor, data) {
  const changes = {};
  for (const user of playerUsers()) {
    const key = `owner_${user.id}`;
    if (!(key in data)) continue;
    const requested = Boolean(data[key]);
    const current = Number(actor.ownership?.[user.id] ?? NONE) >= OWNER;
    if (requested !== current) changes[user.id] = requested ? OWNER : NONE;
  }
  return changes;
}

function clampScale(value, maximum = SCALE_MAX, fallback = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(SCALE_MIN, Math.min(maximum, number)) : fallback;
}
function clampOffsetY(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(OFFSET_Y_MIN, Math.min(OFFSET_Y_MAX, number)) : 0;
}
function browseImage(current, callback) {
  return new foundry.applications.apps.FilePicker.implementation({ type: 'image', current, callback }).browse();
}
function warn(message) { notifications.show(NOTIFICATION_IDS.ACTOR_CONTROL_WARNING, { message }); }
function info(message) { notifications.show(NOTIFICATION_IDS.ACTOR_CONTROL_INFO, { message }); }

/* -------------------------------------------- */
/*  Studio outcomes                             */
/* -------------------------------------------- */
function showStudioFailure(outcome) {
  const notificationsByCode = {
    [STUDIO_OPEN_CODES.ACTOR_REQUIRED]: NOTIFICATION_IDS.ACTOR_CONTROL_STUDIO_ACTOR_REQUIRED,
    [STUDIO_OPEN_CODES.BASE_ACTOR_REQUIRED]: NOTIFICATION_IDS.ACTOR_CONTROL_STUDIO_BASE_ACTOR_REQUIRED,
    [STUDIO_OPEN_CODES.SLOT_UNKNOWN]: NOTIFICATION_IDS.ACTOR_CONTROL_STUDIO_SLOT_UNKNOWN,
    [STUDIO_OPEN_CODES.TAB_NOT_FOUND]: NOTIFICATION_IDS.ACTOR_CONTROL_STUDIO_TAB_NOT_FOUND,
    [STUDIO_OPEN_CODES.ENTRY_NOT_FOUND]: NOTIFICATION_IDS.ACTOR_CONTROL_STUDIO_ENTRY_NOT_FOUND,
    [STUDIO_OPEN_CODES.API_UNAVAILABLE]: NOTIFICATION_IDS.ACTOR_CONTROL_STUDIO_UNAVAILABLE
  };
  notifications.show(notificationsByCode[outcome.code] ?? NOTIFICATION_IDS.ACTOR_CONTROL_STUDIO_UNAVAILABLE,
    outcome.data);
}
