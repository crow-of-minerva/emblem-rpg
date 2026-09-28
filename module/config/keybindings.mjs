/** @layer config */

/* -------------------------------------------- */
/*  Keybinding vocabulary                       */
/* -------------------------------------------- */
export const KEYBINDING_IDS = Object.freeze({
  CONFIRM: 'keybind-Selector',
  CANCEL: 'keybind-Canceller',
  CYCLE_UNITS: 'keybind-CycleUnits',
  TRADE: 'keybind-Trade',
  INTERACT: 'keybind-Interact',
  ZOOM_OUT: 'keybind-ZoomOut',
  SHOW_TOKEN_TOOLTIP: 'keybind-ShowTokenTooltip',
  SHOW_TERRAIN_TIPS: 'keybind-ShowTooltips',
  PREVIEW_TOOLTIP_ATTACK: 'keybind-PreviewTooltipAttack'
});

/* -------------------------------------------- */
/*  Hotbar slots                                */
/* -------------------------------------------- */
const HOTBAR_ROW_NAMES = Object.freeze(['first', 'second', 'third']);
const HOTBAR_ROW_MODIFIERS = Object.freeze([Object.freeze([]), Object.freeze(['Alt']), Object.freeze(['Control'])]);

/**
 * The thirty hotbar presses, one per cell of the three BG3 hotbar rows, handled by
 * `createCanvasKeybindingHandlers` in ui/controls/keybindings.mjs. Foundry's controls list sorts by precedence and
 * then by registration order, so these sit together at the end of the priority group rather than among the gameplay
 * presses above them.
 */
export const BG3_HOTBAR_KEYBINDINGS = Object.freeze(HOTBAR_ROW_NAMES.flatMap((rowName, gridIndex) =>
  Array.from({ length: 10 }, (_, slotIndex) => {
    const display = slotIndex + 1;
    const digit = slotIndex === 9 ? '0' : String(display);
    return Object.freeze({
      id: gridIndex === 0 ? `bg3HotbarSlot${display}` : `bg3HotbarGrid${gridIndex + 1}Slot${display}`,
      name: `Hotbar Row ${gridIndex + 1} Slot ${display}`,
      hint: `Uses the item or ability in slot ${display} of the ${rowName} hotbar row.`,
      keys: Object.freeze([`Digit${digit}`]),
      modifiers: HOTBAR_ROW_MODIFIERS[gridIndex],
      precedence: 'priority',
      bg3GridIndex: gridIndex,
      bg3SlotIndex: slotIndex
    });
  })));

/* -------------------------------------------- */
/*  Keybinding table                            */
/* -------------------------------------------- */
/**
 * Every system keybinding, registered in init/registrations.mjs and handled by ui/controls/keybindings.mjs.
 *
 * The array order is the registration order, which is what Foundry's controls list sorts by within a precedence
 * group, so it is also the reading order players see: the presses they use every turn, then the hotbar, then the
 * two held display keys and the camera. A binding's precedence decides which action wins a key core also binds, so
 * it is not free to reorder across the groups: Interact, Show Terrain Tips and Zoom Out share F, E and Q with
 * core's ruler waypoint, ascend and descend.
 */
export const KEYBINDING_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: KEYBINDING_IDS.CONFIRM,
    name: 'Select and Confirm',
    hint: 'Takes up the unit under the cursor, or confirms a move, a target, or an open prompt.',
    keys: Object.freeze(['Space']),
    precedence: 'priority'
  }),
  Object.freeze({
    id: KEYBINDING_IDS.CANCEL,
    name: 'Cancel and Put Down',
    hint: 'Steps back one choice: drops targeting, undoes a move step, '
      + 'or puts the unit down.',
    keys: Object.freeze(['ShiftLeft', 'ShiftRight', 'Escape']),
    precedence: 'priority'
  }),
  Object.freeze({
    id: KEYBINDING_IDS.CYCLE_UNITS,
    name: 'Cycle Units',
    hint: 'Moves to the nearest unit that still has a turn to take, '
      + 'and takes it up if it is yours to command.',
    keys: Object.freeze(['Tab']),
    precedence: 'priority',
    repeat: true
  }),
  Object.freeze({
    id: KEYBINDING_IDS.INTERACT,
    name: 'Interact',
    hint: 'Acts on what the unit is standing on or next to: opens a door or a chest, uses a downtime station, '
      + 'or takes up a weapon left on the ground.',
    keys: Object.freeze(['KeyF']),
    precedence: 'priority'
  }),
  Object.freeze({
    id: KEYBINDING_IDS.TRADE,
    name: 'Trade',
    hint: 'Marks every friendly unit beside this one so you can click one to swap items with it.',
    keys: Object.freeze(['KeyG']),
    precedence: 'priority'
  }),
  Object.freeze({
    id: KEYBINDING_IDS.PREVIEW_TOOLTIP_ATTACK,
    name: 'Preview Next Attack',
    hint: 'While a token tooltip is open, each press reads the unit '
      + 'as if it held its next weapon.',
    keys: Object.freeze(['KeyE']),
    modifiers: Object.freeze(['Alt']),
    precedence: 'priority'
  }),
  ...BG3_HOTBAR_KEYBINDINGS,
  Object.freeze({
    id: KEYBINDING_IDS.SHOW_TOKEN_TOOLTIP,
    name: 'Show Token Tooltip',
    hint: 'Hold this and point at a token to read its stats.',
    keys: Object.freeze(['AltLeft', 'AltRight']),
    precedence: 'normal'
  }),
  Object.freeze({
    id: KEYBINDING_IDS.SHOW_TERRAIN_TIPS,
    name: 'Show Terrain Tips',
    hint: 'Shows what each square of terrain does, held or toggled as set by the Terrain Tips setting.',
    keys: Object.freeze(['KeyE']),
    precedence: 'normal'
  }),
  Object.freeze({
    id: KEYBINDING_IDS.ZOOM_OUT,
    name: 'Zoom Out to the Whole Map',
    hint: 'Pulls the camera back far enough to see the whole map.',
    keys: Object.freeze(['KeyQ']),
    precedence: 'normal'
  })
]);

/* -------------------------------------------- */
/*  Core keybinding defaults                    */
/* -------------------------------------------- */
/**
 * Foundry's own defaults this system replaces, applied by foundry/patches/core-keybindings.mjs after core registers
 * its actions. Space belongs to Select and Confirm above, so the world pause takes P instead for anyone who has not
 * rebound it on this client.
 */
export const CORE_KEYBINDING_DEFAULTS = Object.freeze([
  Object.freeze({
    action: 'core.pause',
    keys: Object.freeze(['KeyP'])
  })
]);
