/** @layer api */
/*
 * The shapes of the records game.emblemRpg.api returns, and of the system flags, `system.art` fields and Item
 * `system` fields companion modules read or write, written as JSDoc typedefs for editor help. This file holds no
 * code. A companion module names a shape with a comment-only `import()` of this file, which never runs. Squares are
 * grid squares counted from the map's top-left corner; every Scene is kept at padding 0 on a square or gridless
 * grid, so they match the squares drawn on the map. Every record the API returns is frozen.
 */

/* -------------------------------------------- */
/*  API version                                 */
/* -------------------------------------------- */

/**
 * `api.version`. The rule for raising each number is written above API_VERSION in api/facade.mjs.
 * @typedef {object} ApiVersion
 * @property {number} major Raised when something published is removed, renamed or changes meaning.
 * @property {number} minor Raised when something is added. Reset to 0 when major goes up.
 */

/* -------------------------------------------- */
/*  Encounter reads                             */
/* -------------------------------------------- */

/**
 * One Scene's encounter state, without its units.
 * @typedef {object} EncounterState
 * @property {string} sceneUuid The Scene read.
 * @property {string} phase The current phase, `'Player'` or `'Enemy'`, or `''` when no phase is set.
 * @property {number} round The current round, 1 or more.
 * @property {boolean} started Whether the Scene's Combat has started.
 * @property {boolean} autoAdvance Whether the phase moves on by itself once every unit in it has acted. True when
 *   the Scene has no Combat.
 * @property {boolean} exploration Whether the Scene is in exploration mode.
 * @property {boolean} encounterActive Whether a started Combat is bound to the Scene.
 * @property {boolean} paused Whether the Scene holds a paused encounter, so a deleted Combat is a pause, not an end.
 * @property {string} combatUuid The Scene's Combat, or `''` when it has none.
 */

/**
 * Every token on a Scene with what a planner needs about it, in squares.
 * @typedef {object} UnitBoard
 * @property {string} sceneUuid The Scene read.
 * @property {number} gridSize The Scene's grid size in pixels.
 * @property {number} columns The map's width in squares.
 * @property {number} rows The map's height in squares.
 * @property {string} phase The current phase, `'Player'` or `'Enemy'`, or `''` when no phase is set.
 * @property {number} round The current round, 1 or more.
 * @property {boolean} encounterActive Whether a started Combat is bound to the Scene.
 * @property {boolean} exploration Whether the Scene is in exploration mode.
 * @property {boolean} classicFlyers Whether the world uses Classic flyer targeting.
 * @property {boolean} flightForbidden Whether the Scene's movement permission forbids flight.
 * @property {readonly MeasuredUnit[]} units Every token with an actor. A hidden fixture is left out, except a hidden
 *   Destructible, which still blocks movement.
 */

/**
 * One token on the map: a Character, or an Object, Vendor or Convoy. Missing numbers read as 0.
 * @typedef {object} MeasuredUnit
 * @property {string} tokenUuid The token.
 * @property {string} tokenId The token's id.
 * @property {string} actorUuid The token's actor.
 * @property {string} actorId The actor's id.
 * @property {string} name The actor's name, or the token's when the actor has none.
 * @property {string} img The token's image, or the actor's when the token has none.
 * @property {string} documentType The actor type: `'Character'`, `'Object'`, `'Vendor'` or `'Convoy'`.
 * @property {boolean} isCharacter Whether the actor is a Character.
 * @property {boolean} destructible Whether the actor is a Destructible object.
 * @property {boolean} destroyed Whether it is a Destructible with less than 1 stance left.
 * @property {string} objectType The Object's type, or `''` for any other actor.
 * @property {string} factionRole The faction, such as `'Lord'`, `'Enemy'` or `'Neutral'`.
 * @property {string} factionGroup The side that faction belongs to, `'player'`, `'enemy'` or `'neutral'`, or `''`.
 * @property {boolean} hidden Whether the token is hidden.
 * @property {boolean} visible Whether the token shows on the calling client's canvas, under that client's vision.
 *   True when the Scene isn't drawn there.
 * @property {number} x The left column of its saved position. During a move this is a square on the way.
 * @property {number} y The top row of its saved position.
 * @property {number} width Its width in squares. A Character covers at most 3.
 * @property {number} height Its height in squares. A Character covers at most 3.
 * @property {number} sort The token's draw order.
 * @property {number} hp Current HP.
 * @property {number} hpMax Maximum HP.
 * @property {number} stance Current stance.
 * @property {number} stanceMax Maximum stance.
 * @property {number} stanceRegen The stance it gets back by resting: all of it at 0 stance, otherwise its
 *   regeneration up to its max.
 * @property {number} wit The Wit stat.
 * @property {number} critMultiplier The critical damage multiplier, 2 when the stat is missing.
 * @property {number} movement The movement stat, in squares.
 * @property {readonly string[]} statuses Its active status keys, lowercased with only letters and digits kept.
 * @property {boolean} flanked Whether it is Flanked.
 * @property {boolean} hasOutflank Whether it has the Outflank combat passive.
 * @property {boolean} airborne Whether it is in the air now.
 * @property {boolean} stanceBroken Whether its stance is broken. Only a Character has a stance to break.
 * @property {boolean} flying Whether its unit type is a flier, in the air or not.
 * @property {boolean} grounded Whether it has the Grounded status.
 * @property {boolean} levitating Whether it has the Levitation combat passive.
 * @property {boolean} groundedByStanceBreak Whether a stance break forced it to the ground. Taking off clears it.
 * @property {boolean} canTakeOff Whether the flight action would take it off now: a grounded flier on a map that
 *   allows flight, with its stance whole and its action unspent.
 * @property {boolean} mounted Whether it is mounted.
 * @property {boolean} silenced Whether it is Silenced.
 * @property {MeasuredTurn} turn What it has left to spend this phase.
 * @property {string} tauntedByActorUuid The actor that taunted it, or `''` when it isn't taunted.
 * @property {string} guarderTokenUuid The token that takes an attack aimed at this one: its Guard partner, or its
 *   own token when nothing guards it.
 * @property {boolean} sanctuary Whether it has Sanctuary.
 * @property {boolean} sneaking Whether it has Sneak.
 * @property {boolean} lure Whether the token is a lure, such as an Illusion, which Enemy AI treats as a decoy.
 * @property {string} summonedBy The actor whose effect summoned this token, or `''` for a token that wasn't summoned.
 * @property {boolean} passing Whether it can pass through other units.
 * @property {boolean} passable Whether other units can pass through it.
 * @property {boolean} blocksFlyers Whether it blocks fliers as well as walkers.
 * @property {boolean} occupiesLanding Whether its squares are taken, so another unit can't end a move there.
 * @property {number} pendingPhaseDamage The damage its statuses will deal it when the next phase opens, averaged
 *   rather than rolled.
 */

/**
 * What a unit has left to spend this phase.
 * @typedef {object} MeasuredTurn
 * @property {boolean} actionAvailable Whether its action is unspent.
 * @property {boolean} bonusActionAvailable Whether its bonus action is unspent.
 * @property {boolean} movementAvailable Whether it may still move.
 * @property {number} movementSpent The squares of movement spent this phase.
 * @property {boolean} turnComplete Whether it has spent both its action and its movement.
 * @property {number} extraActionsRemaining How many extra actions it has left.
 * @property {boolean} extraActionUsed Whether it has used an extra action this phase.
 */

/* -------------------------------------------- */
/*  Terrain reads                               */
/* -------------------------------------------- */

/**
 * The whole map's terrain as a planner reads it.
 * @typedef {object} TerrainBoard
 * @property {boolean} hasTerrain Whether any square carries terrain.
 * @property {readonly {x: number, y: number}[]} defendPoints The Defend objective squares.
 * @property {readonly TerrainTeleport[]} teleports Every teleport pad, in the order the Scene saved them.
 * @property {Readonly<Record<string, number>>} elevations The height of every raised or sunken square, keyed
 *   `"x,y"`. A square that isn't listed is at 0.
 * @property {boolean} travelBoundedByDistance Whether straight-line distance is still a lower bound on the cost of
 *   travel. Free squares and paired movement-priced teleports make it false.
 * @property {number} columns The map's width in squares.
 * @property {number} rows The map's height in squares.
 */

/**
 * One teleport pad. A pad pairs with the first other pad of the same letter.
 * @typedef {object} TerrainTeleport
 * @property {number} x The pad's column.
 * @property {number} y The pad's row.
 * @property {string} letter The letter that pairs it with its exit.
 * @property {string} cost What using it spends: `'standard'` (the action), `'bonus'` (the bonus action) or
 *   `'movement'`.
 * @property {number} movementCost The squares of movement it costs when `cost` is `'movement'`.
 * @property {boolean} blockable Whether a unit on the exit stops the teleport, rather than moving the arrival aside.
 * @property {Readonly<{x: number, y: number}>|null} exit The partner pad's square, or null when it has none.
 */

/* -------------------------------------------- */
/*  Combat reads                                */
/* -------------------------------------------- */

/**
 * The forecast of one exchange if the attacker used a weapon from a square it is considering. Chances are percents
 * from 0 to 100. Damage per hit is a range such as `'4-9'` or a single number, or the formula itself when it
 * isn't plain dice.
 * @typedef {object} Matchup
 * @property {string} weaponId The attacker's weapon.
 * @property {string} damageType The damage type the attacker would deal.
 * @property {readonly string[]} validDamageTypes Every damage type the attacker's weapon may deal against this
 *   defender.
 * @property {boolean} randomizeDamageType Whether the attacker's damage type is rolled at random.
 * @property {readonly string[]} attackerProtections Damage types the attacker resists.
 * @property {readonly string[]} attackerVulnerabilities Damage types the attacker is weak to.
 * @property {readonly string[]} attackerImmunities Damage types the attacker is immune to.
 * @property {readonly string[]} defenderProtections Damage types the defender resists.
 * @property {readonly string[]} defenderVulnerabilities Damage types the defender is weak to.
 * @property {readonly string[]} defenderImmunities Damage types the defender is immune to.
 * @property {number} hitChance The attacker's chance to hit.
 * @property {number} critChance The attacker's chance to land a critical hit.
 * @property {string} damage The attacker's damage per hit.
 * @property {number} attackCount How many times the attacker strikes in the exchange.
 * @property {number} critMultiplier The attacker's critical damage multiplier.
 * @property {number} breakDamage The stance damage each of the attacker's hits deals.
 * @property {boolean} breakVulnerable Whether the defender is weak to the attacker's damage type.
 * @property {boolean} breakResisted Whether the defender resists the attacker's damage type.
 * @property {boolean} effective Whether the attacker's weapon is effective against the defender.
 * @property {boolean} advantage Whether the attacker rolls to hit with advantage.
 * @property {boolean} disadvantage Whether the attacker rolls to hit with disadvantage.
 * @property {MatchupDefender} defender The defender's side of the exchange.
 * @property {boolean} defenderCanRespond Whether the defender can counter.
 * @property {string} attackSequence The order of strikes, such as `'A1, D1, A2'`.
 * @property {boolean} willBreak Whether the attacker's hits, if all land, break the defender's stance.
 * @property {number} attackerHp The attacker's current HP.
 * @property {number} attackerHpMax The attacker's maximum HP.
 */

/**
 * The defender's side of a forecast exchange, with its equipped weapon or the one the caller named.
 * @typedef {object} MatchupDefender
 * @property {string} damageType The damage type the defender would counter with.
 * @property {readonly string[]} validDamageTypes Every damage type the defender's weapon may deal against the
 *   attacker.
 * @property {boolean} randomizeDamageType Whether the defender's damage type is rolled at random.
 * @property {boolean} breakVulnerable Whether the attacker is weak to the defender's damage type.
 * @property {boolean} breakResisted Whether the attacker resists the defender's damage type.
 * @property {number} hitChance The defender's chance to hit.
 * @property {number} critChance The defender's chance to land a critical hit.
 * @property {string} damage The defender's damage per hit.
 * @property {number} attackCount How many times the defender strikes back, 0 when it can't counter.
 * @property {number} critMultiplier The defender's critical damage multiplier.
 * @property {number} stance The defender's current stance.
 * @property {number} stanceMax The defender's maximum stance.
 * @property {number} hp The defender's current HP.
 * @property {number} hpMax The defender's maximum HP.
 */

/**
 * Everything a unit carries.
 * @typedef {object} Loadout
 * @property {readonly LoadoutWeapon[]} weapons The items it could attack with: Weapon, Attack and Staff items whose
 *   range parses.
 * @property {readonly LoadoutItem[]} items Every item it carries, weapons included.
 */

/**
 * One item a unit could attack with.
 * @typedef {object} LoadoutWeapon
 * @property {string} id The item's id.
 * @property {string} uuid The item.
 * @property {string} name The item's name.
 * @property {string} itemType The item's subtype: `'Weapon'` or `'Staff'` for Equipment, `'Attack'` for a Spell.
 * @property {boolean} wielded Whether the unit is wielding it.
 * @property {Readonly<{minRange: number, maxRange: number}>} range Its reach in squares in this unit's hands.
 * @property {number} breakDamage The weapon's own stance damage, before the unit's stats.
 * @property {boolean} usable Whether the unit could attack with it now: it has uses left, the unit has the rank,
 *   a Silenced unit isn't holding a magic weapon, and the item's caster requirements pass.
 * @property {boolean} hasUses Whether it has uses left or never runs out.
 * @property {readonly string[]} damageTypes The damage types the weapon may deal.
 * @property {boolean} randomizeDamageType Whether its damage type is rolled at random.
 * @property {readonly string[]} effectiveAgainst The unit types it is effective against.
 * @property {boolean} onHitDebuff Whether a hit applies a harmful effect to the target.
 */

/**
 * One item a unit carries. The values listed for `type`, `actionType`, `targetType`, `rangeType` and `losRule` are
 * part of the API, because Enemy AI compares items against them.
 * @typedef {object} LoadoutItem
 * @property {string} id The item's id.
 * @property {string} uuid The item.
 * @property {string} name The item's name.
 * @property {string} type The Foundry item type: `'Class'`, `'Equipment'`, `'Consumable'`, `'Ability'`, `'Spell'`,
 *   `'Miscellaneous'` or `'Resource'`.
 * @property {string} itemType The item's subtype within its Foundry item type, such as `'Weapon'` or `'Potion'`.
 *   `ItemSystemData` lists them all.
 * @property {string} actionType What using it spends: `'Standard Action'` or `'Bonus Action'`.
 * @property {string} targetType Who or what it targets: `'Any'`, `'Self'`, `'Friendly'`, `'Hostile'` or `'Ground'`.
 * @property {string} rangeType How many units or squares it reaches, and in what shape: `'Single'`, `'Multiple'`,
 *   `'Line'`, `'Area'`, `'Cone'` or `'Location'`.
 * @property {Readonly<{minRange: number, maxRange: number}>|null} range Its reach in squares for this unit, or null
 *   when that range doesn't parse.
 * @property {string} losRule The line-of-sight rule it runs under: `'normal'` (walls and height block sight),
 *   `'ignoreHeight'` or `'ignoreLoS'` as authored, or `'ignoreLoS'` when the unit ignores line of sight.
 * @property {number} usesCurrent Uses left.
 * @property {boolean} usesInfinite Whether it never runs out.
 * @property {boolean} hasUses Whether it has uses left or never runs out.
 * @property {number|null} healAverage The average healing of its first on-use heal step, or null when it doesn't
 *   heal.
 * @property {boolean} usable Whether the item's caster requirements and the Spell rank check pass, and a magic
 *   item isn't held by a Silenced unit. No target is checked.
 * @property {Readonly<object>} flags A frozen copy of the item's flags, so a module can read its own scope.
 */

/**
 * Whether a unit can use one of its items, optionally on a target.
 * @typedef {object} ItemUsability
 * @property {boolean} ok Whether every check passes.
 * @property {boolean} casterOk Whether the item's caster requirements and the Spell rank check pass, and a magic
 *   item isn't held by a Silenced unit.
 * @property {readonly string[]} casterNames The names of the caster requirements that failed.
 * @property {boolean} targetOk Whether the target passes the item's target requirements and isn't shielded from it
 *   by Sanctuary. True when no target was given.
 * @property {boolean} silenced Whether Silence alone blocks a magic item.
 */

/* -------------------------------------------- */
/*  Movement reads                              */
/* -------------------------------------------- */

/**
 * How one unit's move treats another token, by the rule the system's pathfinding uses.
 * @typedef {object} PairOccupancy
 * @property {boolean} canPass Whether the moving unit may move through the other token's squares.
 * @property {boolean} occupiesLanding Whether those squares are taken, so the moving unit can't end its move there.
 */

/**
 * `movement.getField`: one unit's movement search, measured without moving it. Only the fields named here are part
 * of the API. `snapshot` is the system's own movement data for the unit, and every other field in it may change.
 * @typedef {object} MovementField
 * @property {MovementGraph} graph The squares the unit can reach and the routes to them.
 * @property {{occupiedCells: readonly string[]}} snapshot The movement data the search ran on. `occupiedCells` holds
 *   the cell keys (`"x,y"`) of other tokens' squares that the unit may not end its move on.
 */

/**
 * The movement search in a MovementField. Each square is a footprint's top-left corner, and a cell key is `"x,y"`.
 * Only the fields named here are part of the API.
 * @typedef {object} MovementGraph
 * @property {{x: number, y: number}} start The square the search started from.
 * @property {number} allowance The movement cost the search stopped at.
 * @property {readonly {x: number, y: number, cost: number}[]} placements Every square the unit can reach, with its
 *   movement cost.
 * @property {readonly {x: number, y: number, cost: number}[]} destinations The placements where the unit's squares
 *   are free, so it can end its move there.
 * @property {Readonly<Record<string, number>>} costByCell The movement cost to reach each square, by cell key.
 * @property {Readonly<Record<string, number>>} routeByCell The route cost to each square, by cell key: the movement
 *   cost plus, for each step, the largest of the caller's `cellPenalties` under the footprint stepped into. Each
 *   square keeps the route with the lowest route cost, and `costByCell` is that route's movement cost.
 * @property {Readonly<Record<string, string>>} parentByCell The cell key of the square each square is reached from.
 *   In a `reverse` search, it is the next square on the way to `start`.
 */

/**
 * One climb or drop a unit could attempt this turn, from `movement.crossings`.
 * @typedef {object} MovementCrossing
 * @property {{x: number, y: number}} from The square the attempt starts from.
 * @property {{x: number, y: number}} to The square it lands on.
 * @property {string} direction The direction of the step: `'up'`, `'down'`, `'left'` or `'right'` on the map.
 * @property {string} zoneName The name of the elevation zone landed in.
 * @property {string} skillKey The skill the unit rolls, `'athletics'` or `'finesse'`.
 * @property {number} dc The roll's DC.
 * @property {number} chance The unit's chance to succeed, as a whole percentage.
 * @property {boolean} descending Whether it drops to a lower elevation.
 * @property {number} levels How many elevation levels it climbs or drops.
 * @property {number} fromElevation The elevation of the square it starts from.
 * @property {number} toElevation The elevation of the square it lands on.
 * @property {number} worstFallDamage The damage of a failed drop missed by 10 or more, which takes the whole fall; 0
 *   for a climb.
 * @property {number} fallFraction `worstFallDamage` as a share of the unit's max HP, or 0 when it has none.
 */

/* -------------------------------------------- */
/*  Host client                                 */
/* -------------------------------------------- */

/**
 * Which client hosts commands, as this client sees it. Exactly one GM with one tab open hosts; Assistant GMs never do.
 * @typedef {object} HostView
 * @property {string} state `'ready'`, `'no-host'`, `'multiple-hosts'` (several GMs are connected) or
 *   `'duplicate-pages'` (the one GM has several tabs open).
 * @property {string} hostUserId The host's user id, or `''` unless the state is `'ready'`.
 * @property {readonly string[]} hostUserIds Every connected GM's user id, sorted.
 * @property {boolean} localIsHost Whether this client is the host client.
 */

/* -------------------------------------------- */
/*  System flags                                */
/* -------------------------------------------- */

/**
 * The flags companion modules read or write in the system's flag scope (`flags.emblem-rpg`).
 * @typedef {object} SystemFlags
 * @property {string} [spawnBehavior] On the Actor of a token a spawn square placed: the behavior that square gave
 *   the unit, one of the `value` strings in `api.encounters.spawnBehaviors.choices`. The system writes it and Enemy
 *   AI reads it. Its key is `api.encounters.spawnBehaviors.flag`.
 * @property {boolean} [pixelArt] On an Item or Actor: true when its image is pixel art, so the system's sheets and
 *   trade window draw it without smoothing. Studio sets it when it saves an image.
 */

/* -------------------------------------------- */
/*  Item data                                   */
/* -------------------------------------------- */

/**
 * The part of an Item's `system` data that companion modules read. Enemy AI compares the subtype against the values
 * listed below to decide which items get AI parameters, so those values are part of the API.
 * @typedef {object} ItemSystemData
 * @property {string} itemType The item's subtype within its Foundry item type, the same value a `LoadoutItem`
 *   reports: `'Weapon'`, `'Armor'`, `'Staff'`, `'Staff (U)'`, `'Shield'` or `'Accessory'` for Equipment;
 *   `'Active'`, `'Passive'`, `'Weapon Art'` or `'Mount'` for an Ability; `'Attack'` or `'Utility'` for a Spell;
 *   `'Potion'`, `'Bomb'`, `'Booster'` or `'Promotion'` for a Consumable; `'Coinpurse'` or `'Other'` for
 *   Miscellaneous.
 */

/* -------------------------------------------- */
/*  Character art                               */
/* -------------------------------------------- */

/**
 * The parts of a Character's `system.art` that Studio reads or writes. Image paths are stored as given, and `''`
 * means none. A slot key is one of `'default'`, `'armored'`, `'cavalry'` (mounted), `'armoredCavalry'` or `'flying'`.
 * @typedef {object} ActorArt
 * @property {{default: string}} tokens The default token image, used when no Class tab matches or the matching
 *   tab has no default image.
 * @property {{default: number, avatar: number}} tokenScales The default token's scale, 1 by default, and the
 *   Control Panel avatar's scale, 1.25 by default.
 * @property {{default: number}} tokenOffsetsY The default token's vertical offset in squares, 0 by default.
 * @property {ActorArtTab[]} tabs The token sets the Character's Classes wear, at most 10.
 * @property {string} legacyAvatar A legacy avatar's image path, `''` when unset. While it is set, the avatar is drawn
 *   as Foundry draws it, with none of the system's art handling, and Studio must not write the avatar (`img`).
 * @property {string} legacyToken A legacy token's image or video path, `''` when unset. While it is set, the tokens
 *   are drawn as Foundry draws them, with none of the system's art handling, and Studio must not write the default
 *   token.
 */

/**
 * The token set one Class wears. The tab whose name matches the Character's Class, ignoring case, is used.
 * @typedef {object} ActorArtTab
 * @property {string} id The tab's id.
 * @property {string} name The Class name it matches.
 * @property {string} avatar An image path the schema stores with the tab. The system doesn't draw it.
 * @property {Record<string, string>} tokens The token image for each slot key.
 * @property {Record<string, number>} tokenScales The token scale for each slot key, 1 by default.
 * @property {Record<string, number>} tokenOffsetsY The vertical offset in squares for each slot key, used between
 *   -0.5 and 1.
 * @property {ActorArtEntry[]} entries Images that replace the slot's token while their conditions hold.
 */

/**
 * One conditional image on a Class tab.
 * @typedef {object} ActorArtEntry
 * @property {string} id The entry's id.
 * @property {string} name The entry's name.
 * @property {string[]} triggers Conditions from `api.character.art.conditions`, any one of which shows the entry.
 * @property {string[]} guards Conditions that must all hold as well.
 * @property {string} specificItemUuid Comma-separated item names the `'Wielding: Specific Item'` condition matches.
 * @property {string} specificAbilityIds Comma-separated item names the `'Using Ability'` condition matches.
 * @property {string} specificSpellNames Comma-separated spell names the `'On Cast'` condition matches.
 * @property {Record<string, string>} tokens The image for each slot key while the entry shows.
 */

export {};
