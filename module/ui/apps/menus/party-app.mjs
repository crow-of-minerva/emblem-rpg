/** @layer ui/apps/menus */
import { SYSTEM_ID } from '../../../contracts/protocol.mjs';
import { NOTIFICATION_IDS, NotificationService } from '../../../presentation/interface/notifications.mjs';
import { escapeHtml } from '../../../lib/dom/html.mjs';
import { PARTY_TOOLTIP_IDS, getTooltip } from '../../tooltips.mjs';
import { readDropPayload } from '../../../foundry/adapters/services/host.mjs';
import { FoundryDiagnostics } from '../../../foundry/adapters/services/diagnostics.mjs';

/* -------------------------------------------- */
/*  Party application                           */
/* -------------------------------------------- */
const { ApplicationV2, DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;
const PartyApplication = HandlebarsApplicationMixin(ApplicationV2);
const collapsedPlayers = new Set();
const notifications = new NotificationService({ diagnostics: new FoundryDiagnostics() });
let activePartyApplication = null;

/**
 * The GM's Configure Party window: player units, campaign parties, Lords and shared Convoys. Opened from the
 * Configure Party button in the Actors directory (ui/apps/foundry/directories.mjs). Changes go through api.parties.
 */
export class ConfigurePartyApp extends PartyApplication {
  /* -------------------------------------------- */
  /*  Application configuration                   */
  /* -------------------------------------------- */
  static DEFAULT_OPTIONS = {
    id: 'emblem-configure-party',
    classes: ['emblem-rpg', 'emblem-configure-party'],
    tag: 'div',
    position: { width: 790, height: 640 },
    window: {
      title: 'Configure Party',
      icon: 'fas fa-flag',
      minimizable: true,
      resizable: true
    },
    actions: {
      addByUuid: ConfigurePartyApp.addByUuid,
      createParty: ConfigurePartyApp.createParty,
      deleteParty: ConfigurePartyApp.deleteParty,
      removeUnit: ConfigurePartyApp.removeUnit,
      renameParty: ConfigurePartyApp.renameParty,
      togglePlayer: ConfigurePartyApp.togglePlayer,
      unlinkConvoy: ConfigurePartyApp.unlinkConvoy
    }
  };

  static PARTS = {
    main: {
      template: `systems/${SYSTEM_ID}/templates/editors/configure-party.hbs`,
      scrollable: ['.cp-pane-scroll']
    }
  };

  /** Open the window for a GM, or re-render the open one and bring it forward. Players get null. */
  static open() {
    if (!game.user.isGM) return null;
    if (activePartyApplication) {
      activePartyApplication.render({ force: true });
      activePartyApplication.bringToFront();
      return activePartyApplication;
    }
    activePartyApplication = new ConfigurePartyApp();
    activePartyApplication.render({ force: true });
    return activePartyApplication;
  }

  async close(options = {}) {
    if (activePartyApplication === this) activePartyApplication = null;
    return super.close(options);
  }

  /* -------------------------------------------- */
  /*  Render context                              */
  /* -------------------------------------------- */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const result = await game.emblemRpg.api.parties.getState();
    const snapshot = result.ok ? result.data : { state: { parties: [], membership: {}, lords: {} }, players: [], unitsByUser: {}, convoys: [] };
    this.partySnapshot = snapshot;
    const users = snapshot.players;
    const { parties, membership, lords } = snapshot.state;
    const players = users.map(user => this._playerView(user, parties, membership, lords));
    const partyCards = parties.map(party => this._partyView(party, users, membership));
    return {
      ...context,
      players,
      parties: partyCards,
      hasPlayers: players.length > 0,
      hasParties: partyCards.length > 0,
      tooltips: partyTooltips()
    };
  }

  _playerView(user, parties, membership, lords) {
    const units = this.partySnapshot.unitsByUser?.[user.id] ?? [];
    const lord = units.find(unit => unit.uuid === lords[user.id]) ?? null;
    const retainers = units.filter(unit => unit !== lord);
    const party = parties.find(entry => entry.id === membership[user.id]) ?? null;
    return {
      id: user.id,
      name: user.name,
      color: user.color?.css ?? user.color ?? '#888',
      partyName: party?.name ?? '',
      lord,
      retainers,
      hasRetainers: retainers.length > 0,
      collapsed: collapsedPlayers.has(user.id),
      toggleTooltip: getTooltip(
        collapsedPlayers.has(user.id) ? PARTY_TOOLTIP_IDS.EXPAND_PLAYER : PARTY_TOOLTIP_IDS.COLLAPSE_PLAYER,
        { name: user.name }
      )
    };
  }

  _partyView(party, users, membership) {
    const convoy = this.partySnapshot.convoys?.find(actor => actor.uuid === party.convoyUuid) ?? null;
    return {
      id: party.id,
      name: party.name,
      convoy: convoy ? {
        uuid: convoy.uuid,
        name: convoy.name,
        img: convoy.img || 'icons/svg/mystery-man.svg'
      } : null,
      memberPills: users.map(user => ({
        id: user.id,
        name: user.name,
        color: user.color?.css ?? user.color ?? '#888',
        checked: membership[user.id] === party.id
      }))
    };
  }

  /* -------------------------------------------- */
  /*  Party actions                               */
  /* -------------------------------------------- */
  static togglePlayer(event, target) {
    event.preventDefault();
    const userId = target.dataset.user;
    if (!userId) return;
    if (collapsedPlayers.has(userId)) collapsedPlayers.delete(userId);
    else collapsedPlayers.add(userId);
    this.render(false);
  }

  static async createParty(event) {
    event.preventDefault();
    const name = await this._promptText({ title: 'Create Party', label: 'Party name' });
    if (!name) return;
    const state = this._partyState();
    state.parties.push({ id: foundry.utils.randomID(), name, convoyUuid: null });
    showPartyFailure(await game.emblemRpg.api.parties.saveState(state));
    this.render(false);
  }

  static async renameParty(event, target) {
    event.preventDefault();
    const state = this._partyState();
    const party = state.parties.find(entry => entry.id === target.dataset.party);
    if (!party) return;
    const name = await this._promptText({ title: 'Rename Party', label: 'Party name', initial: party.name });
    if (!name) return;
    party.name = name;
    showPartyFailure(await game.emblemRpg.api.parties.saveState(state));
    this.render(false);
  }

  static async deleteParty(event, target) {
    event.preventDefault();
    const state = this._partyState();
    const partyId = target.dataset.party;
    const party = state.parties.find(entry => entry.id === partyId);
    if (!party) return;
    const confirmed = await DialogV2.confirm({
      window: { title: 'Delete Party' },
      classes: [SYSTEM_ID, 'dialog-configure-party'],
      content: `<p>Delete party "<strong>${escapeHtml(party.name)}</strong>"? Its players become unassigned and lose `
        + 'access to its convoy. Unit ownership is not changed.</p>'
    });
    if (!confirmed) return;
    state.parties = state.parties.filter(entry => entry.id !== partyId);
    for (const userId of Object.keys(state.membership)) {
      if (state.membership[userId] === partyId) delete state.membership[userId];
    }
    showPartyFailure(await game.emblemRpg.api.parties.saveState(state));
    this.render(false);
  }

  static async unlinkConvoy(event, target) {
    event.preventDefault();
    const state = this._partyState();
    const party = state.parties.find(entry => entry.id === target.dataset.party);
    if (!party) return;
    party.convoyUuid = null;
    showPartyFailure(await game.emblemRpg.api.parties.saveState(state));
    this.render(false);
  }

  /* -------------------------------------------- */
  /*  Unit actions                                */
  /* -------------------------------------------- */
  static async addByUuid(event, target) {
    event.preventDefault();
    const userId = target.dataset.user;
    if (!userId) return;
    const uuid = await this._promptText({
      title: 'Add Unit by UUID',
      label: 'Actor or Token UUID',
      placeholder: 'Scene.xxx.Token.yyy or Actor.zzz'
    });
    if (!uuid) return;
    const candidate = await game.emblemRpg.api.parties.getActorCandidate(uuid);
    if (!candidate.ok) return notifications.show(candidate.code);
    const actor = candidate.data;
    if (!actor.imported) return notifications.show(NOTIFICATION_IDS.PARTY_ACTOR_IMPORT_REQUIRED);
    const result = await game.emblemRpg.api.parties.grantOwnership(userId, actor.uuid);
    if (result.ok) {
      notifications.show(NOTIFICATION_IDS.PARTY_OWNERSHIP_GRANTED, {
        userName: game.users.get(userId)?.name ?? 'user',
        actorName: actor.name
      });
    } else notifications.show(result.code);
    this.render(false);
  }

  static async removeUnit(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const userId = target.dataset.user;
    const uuid = target.dataset.uuid;
    if (!userId || !uuid) return;
    const result = await game.emblemRpg.api.parties.removeUnit(userId, uuid);
    if (!result.ok) notifications.show(result.code);
    this.render(false);
  }

  /** Assign a Character as one player's Lord or Retainer. */
  async _assignUnit(userId, actor, role, fromUserId = '') {
    if (!userId) return;
    if (actor?.documentName !== 'Actor' || actor.type !== 'Character') {
      return notifications.show(NOTIFICATION_IDS.PARTY_CHARACTER_REQUIRED);
    }
    if (!actor.imported) return notifications.show(NOTIFICATION_IDS.PARTY_ACTOR_IMPORT_REQUIRED);

    const isLord = role === 'lord';
    const moving = Boolean(fromUserId && fromUserId !== userId);
    if (fromUserId === userId) {
      const wasLord = this._partyState().lords[userId] === actor.uuid;
      if (wasLord === isLord) return;
    }

    const requiredType = isLord ? 'Lord' : 'Retainer';
    const actorType = actor.actorType ?? '';
    let changeType = false;
    if (actorType !== requiredType) {
      const confirmed = await DialogV2.confirm({
        window: { title: 'Change Unit Type' },
        classes: [SYSTEM_ID, 'dialog-configure-party'],
        content: `<p><strong>${escapeHtml(actor.name)}</strong> is a <strong>${escapeHtml(actorType || 'Neutral')}`
          + `</strong> unit. Change them to a <strong>${requiredType}</strong>?</p>`
      });
      if (!confirmed) return;
      changeType = true;
    }
    const result = await game.emblemRpg.api.parties.assignUnit({
      userId,
      actorUuid: actor.uuid,
      role,
      fromUserId: moving ? fromUserId : '',
      changeType
    });
    if (!result.ok) notifications.show(result.code, result.data);
    this.render(false);
  }

  /** Link a Convoy Actor to one party. */
  async _assignConvoy(partyId, actor) {
    if (actor?.documentName !== 'Actor' || actor.type !== 'Convoy') {
      return notifications.show(NOTIFICATION_IDS.PARTY_CONVOY_REQUIRED);
    }
    if (!actor.imported) return notifications.show(NOTIFICATION_IDS.PARTY_CONVOY_IMPORT_REQUIRED);
    const result = await game.emblemRpg.api.parties.assignConvoy(partyId, actor.uuid);
    if (!result.ok) notifications.show(result.code, result.data);
    this.render(false);
  }

  /* -------------------------------------------- */
  /*  Interactive controls                        */
  /* -------------------------------------------- */
  _onRender(context, options) {
    super._onRender(context, options);
    if (!this.element) return;
    this._hoistTopbar();
    this._bindMembershipControls();
    this._bindUnitDrags();
    this._bindDropZones();
  }

  /** Move the Create Party button into the window header. */
  _hoistTopbar() {
    const header = this.element.querySelector('.window-header');
    if (!header) return;
    for (const stale of header.querySelectorAll('.cp-topbar')) stale.remove();
    const bar = this.element.querySelector('.cp-topbar');
    if (!bar) return;
    header.insertBefore(bar, header.querySelector('.header-control') ?? null);
    for (const button of bar.querySelectorAll('button')) {
      button.addEventListener('pointerdown', event => event.stopPropagation());
    }
  }

  _bindMembershipControls() {
    for (const checkbox of this.element.querySelectorAll('[data-party-toggle]')) {
      checkbox.addEventListener('change', async () => {
        const partyId = checkbox.dataset.partyToggle;
        const userId = checkbox.dataset.user;
        if (!partyId || !userId) return;
        const state = this._partyState();
        if (checkbox.checked) state.membership[userId] = partyId;
        else if (state.membership[userId] === partyId) delete state.membership[userId];
        showPartyFailure(await game.emblemRpg.api.parties.saveState(state));
        this.render(false);
      });
    }
  }

  _bindUnitDrags() {
    for (const row of this.element.querySelectorAll('[data-unit-drag]')) {
      row.addEventListener('dragstart', event => {
        if (!event.dataTransfer || !row.dataset.uuid) return;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', JSON.stringify({
          type: 'Actor',
          uuid: row.dataset.uuid,
          emblemFromUser: row.dataset.user ?? ''
        }));
        row.classList.add('is-dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('is-dragging'));
    }
  }

  _bindDropZones() {
    for (const zone of this.element.querySelectorAll('[data-drop]')) {
      zone.addEventListener('dragover', event => {
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = event.dataTransfer.effectAllowed === 'move' ? 'move' : 'copy';
        }
        zone.classList.add('is-drop-hot');
      });
      zone.addEventListener('dragleave', () => zone.classList.remove('is-drop-hot'));
      zone.addEventListener('drop', event => this._onDrop(event, zone));
    }
  }

  async _onDrop(event, zone) {
    event.preventDefault();
    event.stopPropagation();
    zone.classList.remove('is-drop-hot');
    const payload = readDropPayload(event);
    if (!payload) return;
    const actor = await this._resolveDroppedActor(payload);
    if (!actor) return notifications.show(NOTIFICATION_IDS.PARTY_DROP_ACTOR_REQUIRED);
    if (zone.dataset.drop === 'convoy') await this._assignConvoy(zone.dataset.party, actor);
    else await this._assignUnit(
      zone.dataset.user,
      actor,
      zone.dataset.drop,
      payload.emblemFromUser ?? ''
    );
  }

  async _resolveDroppedActor(payload) {
    if (payload.uuid) {
      const result = await game.emblemRpg.api.parties.getActorCandidate(payload.uuid);
      if (result.ok) return result.data;
    }
    if (payload.type === 'Actor' && payload.id) {
      const result = await game.emblemRpg.api.parties.getActorCandidate(`Actor.${payload.id}`);
      if (result.ok) return result.data;
    }
    return null;
  }

  _partyState() {
    return foundry.utils.deepClone(this.partySnapshot?.state ?? { parties: [], membership: {}, lords: {} });
  }

  /* -------------------------------------------- */
  /*  Text prompts                                */
  /* -------------------------------------------- */
  async _promptText({ title, label, initial = '', placeholder = '' }) {
    const result = await DialogV2.wait({
      window: { title },
      classes: [SYSTEM_ID, 'dialog-configure-party'],
      content: `
        <div class="cp-dialog-field">
          <label class="cp-dialog-label">${escapeHtml(label)}</label>
          <input type="text" name="val" value="${escapeHtml(initial)}" placeholder="${escapeHtml(placeholder)}"
                 autofocus />
        </div>`,
      position: { width: 440 },
      buttons: [
        {
          action: 'ok',
          label: 'Save',
          default: true,
          callback: (_event, _button, dialog) => ({
            value: dialog.element.querySelector('input[name="val"]')?.value?.trim() || null
          })
        },
        { action: 'cancel', label: 'Cancel' }
      ],
      rejectClose: false
    });
    return result && typeof result === 'object' ? result.value : null;
  }
}

/* -------------------------------------------- */
/*  View helpers                                */
/* -------------------------------------------- */
function partyTooltips() {
  return Object.freeze({
    addByUuid: getTooltip(PARTY_TOOLTIP_IDS.ADD_BY_UUID),
    deleteParty: getTooltip(PARTY_TOOLTIP_IDS.DELETE_PARTY),
    removeUnit: getTooltip(PARTY_TOOLTIP_IDS.REMOVE_UNIT),
    renameParty: getTooltip(PARTY_TOOLTIP_IDS.RENAME_PARTY),
    unlinkConvoy: getTooltip(PARTY_TOOLTIP_IDS.UNLINK_CONVOY)
  });
}

function showPartyFailure(result) {
  if (!result?.ok) notifications.show(result?.code ?? NOTIFICATION_IDS.PARTY_STATE_UPDATE_FAILED, result?.data);
}
