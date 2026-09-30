# Changelog


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
