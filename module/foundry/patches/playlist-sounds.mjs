/** @layer foundry/patches */
import { installWrapperGroup } from '../../external/host.mjs';

/* -------------------------------------------- */
/*  Locked audio                                */
/* -------------------------------------------- */
const LOCKED_SYNC_GROUP = 'playlist-sound-locked-sync';
const SYNC_TARGET = 'CONFIG.PlaylistSound.documentClass.prototype.sync';

/**
 * Hold PlaylistSound playback on this client until its first gesture unlocks audio. Core's Playlist update handler
 * skips its sync while audio is locked, but its PlaylistSound update handler syncs on every change, and syncing a
 * playing sound creates its Sound, which core refuses by throwing while audio is locked. The host client's phase
 * and performance music (foundry/adapters/services/audio.mjs) write fades, and the Scene music's restart, onto the
 * PlaylistSound itself, so each of those writes reaches that handler on every client. Core's Playlists.initialize
 * syncs every sound once the unlock comes, so a sound still playing then starts.
 */
export function installLockedPlaylistSoundHold() {
  installWrapperGroup({
    id: LOCKED_SYNC_GROUP,
    required: false,
    wrappers: [{
      target: SYNC_TARGET,
      fn(wrapped, ...args) {
        if (game.audio.locked) return undefined;
        return wrapped(...args);
      },
      type: 'MIXED'
    }]
  });
}
