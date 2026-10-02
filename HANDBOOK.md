# Emblem RPG Handbook

 Documentation on how to use the Emblem RPG system. This handbook will go over the game's rules and mechanics, the way it plays, and finally how a GM can author homebrew content themselves.

> **Version:** 1.0.2 · **Foundry:** v14

---


## Contents

- [Part I - Game Rules](#part-i---game-rules)

## Introduction
This game system was inspired from the premise that Fire Emblem tactical combat mechanics would mix spectacularly well with DnD-style tabletop roleplaying. That is more or less the vision. While every TTRPG makes compromises between the tenuous balance of narrative and crunchy gameplay, I have always felt that Fire Emblem was unique in how, when done right, the map design and combat itself could dynamically tell a story all on its own without a shred of dialog or flashy cinematic cutscenes. FE Engage is not a good story (hot take I know), and yet... it has one of the most memorable and compelling story moments in any Fire Emblem I've ever played. Chapter 11. And if you've played it, especially on Hard or Maddening, you know exactly why.

Chapter 11 of FE Engage is my favorite Fire Emblem map, and probably the most fun I've ever  had in the franchise. It accomplishes an absolute identity between story and gameplay by telling the former with the latter, and it is exactly that kind of experience that I wanted to be able to recreate at the table. What does traditional DnD-esque roleplaying become when we throw in a larger roster of player characters, permadeath that advances rather than dead-ends a story, and whole map structured encounters? Well, in my experience of privately running this system for over a year, what you get is a damn good time.

### Structure of Play 

In Emblem RPG, players control a **LORD** character as their primary driver. Their Lord is who they roleplay as and who they fully own. They will additionally own a roster of **RETAINER** characters as well, who, for one story reason or another, have cause to follow the player's Lord into battle. Players work together to form a **Party** (as of right now, PVP is not really supported nor planned). 

The game is designed so that sessions of a campaign in Emblem RPG proceed in cycles of Map Encounter -> Downtime -> Map Encounter -> Downtime, and so on and so on. Think Three Houses: there's some story, then a combat map, then back to the monastary for some downtime and more story, then a combat, then downtime again. This is the play cycle that Emblem RPG is designed for, so rather than DnD where combat and rolepalying is ostensibly intermingled in the same session, here we more or less explicitly expect our players to either be doing one or the other depending on what part of that cycle the table is in. This is, of course, just a suggestion. You know best what works for you and your group.

Map Encounters are the substantive action of the game, and Downtime is like the aftercare. There are Downtime activities in the system player units (Lords and Retainers) can perform to progress in various ways and prepare for the next encounter. But more than that, Downtime is also when the roleplaying part of Emblem RPG can shine. Since every map is (at least theoretically) an intense experience, the question falls on the GM and Players to ask -- "how have the characters been impacted by that experience?" Map encounters aren't just 3 wolves in a forest after all. It's a whole structured event with inherent narrative significance, and that is precisely what a Fire Emblem approach to map and encounter design engenders: grand storytelling with stakes. *Because* the map is so big and *because* an encounter runs the whole session, and *because* so many characters are involved, it naturally creates for us infinite possibilities for storytelling. Again, Chapter 11. It's the player Party saving a town from a whole small army of invaders. It's holding a defense point against impossibly surmounting odds until a fated hour of salvation. It's running for your life against the Big Bad, who stole all your god damn Emblem Rings.

And there's Permadeath. Units can die. Your Lord can die. But this is where the 'TTRPG' side of things fills in for what a regular FE game in principle cannot do. Unlike Fire Emblem where a main character's death means the map resets and you run it back,  here we have the possiblity of carrying forward with the story. You pick up a Retainer and make them your new Lord. The whole campaign's storytelling is now naturally compelled to change dramatically, keeping the narrative constantly engaging and fresh. Downtime is precisely where this happens. It's where the natural dramatic potential of a map enounter finds itself realized by the players and by the characters themselves.


## Part I - The Character Sheet

![A Lord's character sheet](docs/images/character-sheet.png)

A lot of the game's mechanics can be learned from understanding the elements of its Character Sheet. 

1. ### Stats
    From top to bottom, the stats are:
   
    - **Stance (STN).** This is the unit's battle posture. When reduced to zero by Break (Brk) damage, a unit becomes Stance Broken. A Stance Broken unit loses cannot use their Action (but may still Move), and has -4 to Mgt, Agi, Tqn, Wit, and Cha. They also lose any bonuses to Def and Res they get from their worn Armor item. If a unit's Stn is restored above 0 by even half a point by something else, e.g. a healing spell, the unit is no longer Stance Broken and gains access to their Action again.
    - **Movement (MOV).** This is how many squares a unit an move on their phase. 
    - **Build (BLD).** This is the unit's equipment load capacity. Every item equipped by the unit, including a wielded spell, has a Weight (Wgt) score. Every point of total Wgt equipped by the unit above the unit's Bld deducts -1 Agi from the unit, e.g. Bld 7 equipping Wgt 9 nets an Agi -1 penalty.
    - **Might (MGT).** This is the unit's physical might. Every point of Mgt adds 1 Atk (or damage) to a martial weapon, and 1 HP to the unit's total HP. Every 4 points of Mgt also increaeses the unit's Bld by 1 point.
    - **Agility (AGI).** This is the unit's quickness. Every point of Agi adds 1 Speed (Spd) to the unit. Every 2 points raises the unit's Evasion (Eva) by 1 point.
    - **Technique (TQN).** This is the unit's precision and skill. Every point adds 1 point to the unit's Accuracy (Acc) and increases the unit's Critial Hit Damage bonus by 5%.
    - **Wit (WIT).** This is the unit's cunning and intellect. Every point adds 1 Atk to an equipped spell or staff, and also raises the unit's Critical Hit chance by 1%.
    - **Charm (CHA).**  This is the unit's charisma and fortune. Every point reduces the chance they will be critically hit by 1%. It also affects the range of a unit's Rally ability, as well as the spell save DC of various supportive spells such as healing (Salve), crowd control (Fear), and debuffs (Bane).
    - **Defense (DEF).** This is the unit's damage reduction against physical damage types (Slashing, Piercing, Crushing, Missle). Untyped damage (e.g. made with an Unarmed Attack) counts as physical. Ex: 12 physical damage vs 10 Def = 2 damage.
    - **Resistance (RES).** This is the unit's damage reduction against magical types (Fire, Ice, Lightning, Wind, Arcane, Decay, Shadow, Holy). Same principle as Def.

   **UI Interaction**: Right-click the name of the stat to edit it. What comes up will be the following dialog panel:

    <img src="docs/images/hp-editor.png" alt="Hugo's HP editor" width="250"> 

   - Value: This tracks the editable gains of the unit in that particular stat. When a unit levels up and grows in a particular stat, it is this field that goes up by one point.
   - Shields: This tracks temporary HP granted to the unit by spell effects (e.g. Aegis or Mage Armor). If all damage from an attack or effect is taken out of Shields, then any Brk that would have been dealt is negated instead.
   - Class Base: The base stat derived from the actor's Class.
   - Modifiers: Temporary modifiers currently affecting the unit's stat.
   - Total: The total sum of value, class base, and modifiers.
   - Growths: This is the percentage chance the unit has of increasing in this stat every time they level up. It has the same array of a class base, plus modifiers (e.g. from Cooking bonuses), plus value.

2. ### Combat Stats
    Combat stats are derived stats that determine the play by play of combat mechanics. From left to right, they are:

    - **Weight (WGT).** This is the total burden of the unit's equipped items. If this value exceeds the unit's Bld, the difference is deducted from the unit's Agi, and Wgt turns red.
    - **Range (RNG).** This is the unit's current range of action with their equipped weapon or spell. A unit can only counterattack if their attacker is within their Rng.
    - **Evasion (EVA).** This is the unit's ability to dodge. Every point reduces an attacker's chance to hit by 5%.
    - **Accuracy (ACC).** This is the unit's ability to land hits. On an attack, the unit rolls d20 + Acc and hits if the total beats the target's Eva. Ex: 6 Acc vs 12 Eva = hits on a 7 or higher (70%).
    - **Speed (SPD).** This is the unit's attack speed. Having 4 more Spd than an opponent grants 1 extra attack in an exchange, and 8 more grants 2.
    - **Critical (CRIT).** This is the unit's critical hit chance, reduced by the target's Cha and their Armor's Crit Reduction. A critical hit multiplies the damage dealt by 2, plus the unit's Tqn bonus. Ex: 11 Crit vs 4 Cha = 7% crit chance.
    - **Attack (ATK).** This is the unit's damage per hit, equal to the equipped weapon or spell's Atk plus its scaling stat (usually Mgt or Wit). The target's Def or Res is subtracted from it on a hit.
