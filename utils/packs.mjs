/**
 * Builds and extracts this package's compendium packs.
 *
 * The source of truth for every compendium document is one JSON file under packs/_source/<pack>/, kept in git.
 * The LevelDB directories Foundry reads (packs/<pack>/) are build output and are not tracked. Run this with
 * Foundry closed: Foundry holds a lock on every pack while a world is open.
 *
 *   npm run build:db             compile every pack from packs/_source into packs/
 *   npm run build:db -- items    compile one pack
 *   npm run build:json           extract every pack from packs/ into packs/_source
 *   npm run build:clean          rewrite the source files with the cleaning rules below, without touching packs/
 *
 * The pack list is read from system.json or module.json in the current directory.
 */

import fs from "node:fs";
import path from "node:path";
import { compilePack, extractPack } from "@foundryvtt/foundryvtt-cli";

const PACK_DEST = "packs";
const PACK_SRC = "packs/_source";

/** The user id written as every document's last editor, so extracts don't record who touched what. */
const BUILDER_ID = "emblembuilder000";

const [action, packName] = process.argv.slice(2);
if ( !["pack", "unpack", "clean"].includes(action) ) {
  console.error("Usage: node utils/packs.mjs <pack|unpack|clean> [packName]");
  process.exit(1);
}

/** The packs declared in the package manifest, limited to one pack when a name was given. */
function manifestPacks() {
  const manifestName = ["system.json", "module.json"].find(name => fs.existsSync(name));
  if ( !manifestName ) throw new Error("No system.json or module.json in the current directory.");
  const manifest = JSON.parse(fs.readFileSync(manifestName, "utf8"));
  const packs = (manifest.packs ?? []).filter(pack => !packName || pack.name === packName);
  if ( !packs.length ) throw new Error(`No pack named "${packName}" in ${manifestName}.`);
  return packs;
}

/* -------------------------------------------- */
/*  Cleaning                                    */
/* -------------------------------------------- */

/**
 * Strips the fields that change every time a document is touched in Foundry but carry no content: where the
 * document was copied from, who last edited it, and per-document ownership (the pack's ownership in the
 * manifest decides access). Embedded items, effects and pages are cleaned too.
 * @param {object} data                       One document as stored in the pack.
 * @param {object} [options]
 * @param {boolean} [options.clearSourceId]   Remove the compendium-source fields. Off for embedded documents.
 * @param {number} [options.ownership]        The default ownership level to write. Pages inherit (-1).
 */
function cleanEntry(data, { clearSourceId=true, ownership=0 }={}) {
  if ( data.ownership ) data.ownership = { default: ownership };
  if ( clearSourceId && data._stats ) {
    delete data._stats.compendiumSource;
    delete data._stats.duplicateSource;
  }
  if ( data._stats?.lastModifiedBy ) data._stats.lastModifiedBy = BUILDER_ID;
  if ( data.flags ) {
    delete data.flags.core?.sourceId;
    delete data.flags.exportSource;
    delete data.flags.importSource;
    for ( const [scope, contents] of Object.entries(data.flags) ) {
      if ( contents && (typeof contents === "object") && !Object.keys(contents).length ) delete data.flags[scope];
    }
  }
  data.effects?.forEach(effect => cleanEntry(effect, { clearSourceId: false }));
  data.items?.forEach(item => cleanEntry(item, { clearSourceId: false }));
  data.pages?.forEach(page => cleanEntry(page, { clearSourceId: false, ownership: -1 }));
}

/** Every .json file under a directory, recursively. */
function* walk(dir) {
  for ( const entry of fs.readdirSync(dir, { withFileTypes: true }) ) {
    const full = path.join(dir, entry.name);
    if ( entry.isDirectory() ) yield* walk(full);
    else if ( path.extname(entry.name) === ".json" ) yield full;
  }
}

function cleanPacks() {
  for ( const pack of manifestPacks() ) {
    const src = path.join(PACK_SRC, pack.name);
    if ( !fs.existsSync(src) ) continue;
    console.log(`Cleaning ${pack.name}`);
    for ( const file of walk(src) ) {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      cleanEntry(data);
      fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    }
  }
}

/* -------------------------------------------- */
/*  Compile and extract                         */
/* -------------------------------------------- */

async function compilePacks() {
  for ( const pack of manifestPacks() ) {
    const src = path.join(PACK_SRC, pack.name);
    if ( !fs.existsSync(src) ) {
      console.warn(`Skipping ${pack.name}: no source directory at ${src}`);
      continue;
    }
    console.log(`Compiling ${pack.name}`);
    await compilePack(src, path.join(PACK_DEST, pack.name), {
      recursive: true, log: true, transformEntry: cleanEntry
    });
  }
}

/**
 * Writes each document to its own file, in a directory tree that mirrors the pack's folders. The source
 * directory is replaced, so documents deleted in Foundry disappear from git. Timestamps are kept from the
 * existing file when nothing else changed, so an extract after an untouched pack produces no diff.
 */
async function extractPacks() {
  for ( const pack of manifestPacks() ) {
    const dest = path.join(PACK_DEST, pack.name);
    if ( !fs.existsSync(dest) ) {
      console.warn(`Skipping ${pack.name}: no compiled pack at ${dest}`);
      continue;
    }
    console.log(`Extracting ${pack.name}`);
    await extractPack(dest, path.join(PACK_SRC, pack.name), {
      log: true, clean: true, folders: true, omitVolatile: true, transformEntry: cleanEntry,
      jsonOptions: { space: 2 }
    });
  }
}

switch ( action ) {
  case "pack": await compilePacks(); break;
  case "unpack": await extractPacks(); break;
  case "clean": cleanPacks(); break;
}
