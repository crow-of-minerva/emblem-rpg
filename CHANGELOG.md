# Changelog

## Emblem RPG 1.0.1

### Added

- **World content GM macros** for migration and synchronization:
  - **Migration:** updates world content data to match the codebase schemas. Run it once if you imported 1.0.0 content, then let it work. Wait for it to say it's finished.
  - **Synchronization:** updates world content data to match the compendium's canonical values. Renamed content is skipped.

### Fixed

- Trusted Players who were granted permission can now open the Token/Sprite Studio.
- Authored content discrepancies. To get these updates, reimport the content or run the Synchronization macro:
  - **Lucent Sublimate:** now grants +2 Tqn as intended.
  - **Blur Cloak:** the modifier now matches the description.
  - **Poison Bomb:** DC is now 18.

### Changed

- Terrain Builder zone buttons are always visible instead of only on hover.
- Improvements/fixes to the studio application.

### Background Stuff

- Backend logic and data cleanup.
