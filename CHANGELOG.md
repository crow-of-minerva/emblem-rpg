# Changelog

## Emblem RPG 1.0.3 MAJOR UPDATE

### Added

- Game Manual journal included in the system's native compendiums. This manual goes over all of the game's mechanical rules and covers the mindset to approach when planning campaigns, creating characters, GMing the game, and using the in-app tools.
- Effect Editor custom status effects significantly improved. Users can now author custom status effects from form fields rather than manual json (Automatic data migration will re-run on world load.)
- 'Retractable' parameter now authorable on self-targeting activated abiltiies, utility spells, or items. This makes the action temporary, which the player can take back. 'Dash' already behaved this way (player previews the extra movement and considers if they want to keep it), now it is simply something any custom content can apply.
- Legacy Avatar and Legacy Token fields added to the Actor Control Panel's Prototype Token section, so a character can use traditional artwork. Foundry draws it natively, with no pixelation, zoom, scaling or conditional art.
- Bug fixes and optimizations to core systema and companion modules

### Changed

- Effect Editor 'Restore actions' step simplified.
- Restoring movement now also clears the squares already moved and any movement penalty, so the unit gets its full movement back.
- Trusted Players can now select and drag the tokens they own the normal Foundry way, like a GM, while no combat encounter is running on the map. Once an encounter starts they move units through movement plans as before.
- Doors now have a 'Block Flyers?' checkbox, like Destructibles.

### Content Pack

- 'Wyvern' creature added to actor compendium
- 'Berserk' active ability added to showcase the Retractable ability, and the new form editor for custom status effects.

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
