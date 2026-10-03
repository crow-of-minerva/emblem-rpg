# Changelog


## Unreleased

### Added

- Custom statuses are authored in a form inside the Apply status step instead of a raw JSON box: name, icon, id tag, polarity, hidden on token, phases and reapplication, the triggers that wear the status down, stacking, and modifier rows picked from the same vocabulary as modifiers. An advanced json box keeps anything the form has no field for.
- A status can now have both a stack count and a duration. Each trigger that wears it down removes one phase or one stack, chosen per trigger. Phases 0 means the status lasts until a trigger removes it.
- A status can override a stat total outright (for example Defense to 0); stats built from it use the overridden value.
- Statuses can be kept off the token's icon list and the HUD.
- The Remove status step is rebuilt as one card: who, which, amount, applied by and except. Who can be self, the target or the whole map, and a whole map removal can spare self or the target.
- Remove status picks one status by name, or every status of the kinds ticked: all harmful, all beneficial, and the new all neutral.
- Remove status can take off a number of stacks or phases instead of the whole status.

### Changed

- Reapplying a status now renews its duration to the applied value (or adds to it when the step stacks duration) instead of keeping the longer of the two. A stackable status at its stack limit still has its duration renewed.
- The status id is derived from the name (letters and digits only) and is no longer typed.
- A custom status made before this version that lasts more than one phase and ends on an event (attacked, a hostile action, being targeted, a stance break or the end of an exchange) now loses one phase on that event instead of ending; shipped content is not affected.
- Remove status by name matches the status's name or id, ignoring upper and lower case, spaces and punctuation.
- Remove status never takes off an effect a GM made by hand (one without phases), even when its name matches.
- Applied by (formerly placed by) checks only who applied the status, so an old Mark that recorded only who marked it no longer matches.

### Background Stuff

- Migrate World Content brings every custom status to the new shape (world schema 4). Statuses that had no id are marked hidden on token so they look as before. **(the updated macro text must be in the system macros compendium before the host reloads; otherwise run the macro by hand)**
- Migrate World Content brings every Remove status step to the new shape (world schema 5): scope, placed by, exclude target and the dispel boxes become who, applied by, except and which. A step that named a status and also ticked a dispel box keeps only the name, and a run by hand lists it.
- Restore, Panacea, Sneak, Berserk and Marking Shot in the content compendiums were updated to the new Remove status step.

---------------------

## Emblem RPG 1.0.2a HOTFIX

### Hotfix

- Players can no longer see through NPCs token vision while having OBSERVER level permissions (Emblem grants this permission by default so players can inspect an enemy's stats and actor sheet for the purposes of tactical gameplay).

---------------------

## Emblem RPG 1.0.2

### Changed

- Critical Hit bonus damage scaling now based on Tqn, not Wit
- Minor optimizations to the system

### Fixed

- Incorrect exp-data.json values were fixed. Units should now recieve appropriate exp gains for actions other than attacking. **(requires running the shipped Sync World JSON to Canon macro)**
- Threat lines were ignoring attacks that could ignore LoS. Fixed.
- Incorrectly authored effects skip instead of reverting the entire action.

### Background Stuff

- Asset and import paths now respect Foundry's route prefix instead of assuming the server root.
- Groundwork edits to prepare for item authorship panels refactor

------------------------

## Emblem RPG 1.0.1

### Added

- **World content automatic migration** that runs once when the system launches to update documents to be in line with backend updates.
- **World content GM macros** for migration and synchronization:
  - **Migration:** updates world content data to match the codebase schemas. Only needed if the automatic migration fails.
  - **Synchronization:** updates world content data to match the compendium's canonical values. Renamed content is skipped.

### Fixed

- Trusted Players who were granted permission can now open the Token/Sprite Studio.
- Authored content discrepancies. To get these updates, reimport the content or run the Synchronization macro:
  - **Lucent Sublimate:** now grants +2 Tqn as intended.
  - **Blur Cloak:** the modifier now matches the description.
  - **Poison Bomb:** DC is now 18.

### Changed

- Terrain Builder zone buttons are always visible instead of only on hover.
- General improvements/fixes to the studio application.

### Background Stuff

- Backend logic and data cleanup.
