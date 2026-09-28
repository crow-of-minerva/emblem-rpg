# Changelog

## Emblem RPG 1.0.1

### Added

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
