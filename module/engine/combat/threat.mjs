/** @layer engine/combat */
import { DIAGNOSTIC_SOURCES, createDiagnostic, requirePorts } from '../../contracts/protocol.mjs';
import { THREAT_TIERS } from '../../contracts/domains/combat.mjs';
import { buildMovementGraph } from '../../game/movement/pathfinding.mjs';
import {
  gradeIncomingThreat,
  isIncapacitated,
  leftPrefilterEnvelope,
  selectThreatCandidates,
  threatCovers,
  threatReach
} from '../../game/combat/threat.mjs';

/* -------------------------------------------- */
/*  Threat assessment                           */
/* -------------------------------------------- */
/**
 * Give the threat overlay (ThreatIndicators in presentation/canvas/threat.mjs) each hostile's reach and how hard
 * it could hit. It uses the injected Foundry reads and the game/combat/threat.mjs rules, and writes nothing.
 * @param {{board: object, matchups: object, diagnostics: object}} ports The projections and the diagnostics port.
 */
export function createThreatAssessment({ board, matchups, diagnostics }) {
  requirePorts('createThreatAssessment', { board, matchups, diagnostics });
  const report = (detail, error) => diagnostics.record(createDiagnostic({ sourcePath: import.meta.url,
    source: DIAGNOSTIC_SOURCES.THREAT, detail, error
  }));

  const reachOf = (candidate, selectedTokenUuid) => {
    try {
      const snapshot = board.projectThreatReach(candidate.tokenUuid, selectedTokenUuid);
      if (!snapshot?.supportedGrid) return null;
      return threatReach(buildMovementGraph(snapshot, { teleports: true, keyboardDiagonals: false }));
    } catch (error) {
      report('threat-reach', error);
      return null;
    }
  };

  const measure = (candidate, selectedTokenUuid) => {
    const reach = reachOf(candidate, selectedTokenUuid);
    if (!reach || reach.reach.size === 0) return null;
    return Object.freeze({
      tokenUuid: candidate.tokenUuid,
      tokenId: candidate.tokenId,
      actorUuid: candidate.actorUuid,
      reach: reach.reach,
      occluded: reach.occluded,
      tier: isIncapacitated(candidate) ? THREAT_TIERS.INERT : null
    });
  };

  /** Open a threat inspection from the board projection. `advance` measures hostile reaches within a frame budget. */
  const beginInspection = selectedTokenUuid => {
    const projected = board.projectThreatBoard(selectedTokenUuid);
    if (!projected) return null;
    const picked = selectThreatCandidates(projected);
    const queue = [...picked.candidates];
    const threats = [];
    return Object.freeze({
      encounterActive: projected.encounterActive,
      selected: projected.selected,
      gridSize: projected.gridSize,
      liveHostiles: picked.liveHostiles,
      compulsionSources: picked.compulsionSources,
      prefilter: picked.prefilter,
      remaining: () => queue.length,
      /** Measure hostiles until none are left or `exhausted` says the frame's time is up. True once complete. */
      advance(exhausted = () => false) {
        while (queue.length) {
          const threat = measure(queue.shift(), selectedTokenUuid);
          if (threat) threats.push(threat);
          if (queue.length && exhausted()) return false;
        }
        return true;
      },
      threats: () => Object.freeze([...threats])
    });
  };

  return Object.freeze({
    beginInspection,

    /** Every hostile whose next-turn reach could cover the selected unit, with the reach it would use. */
    inspect(selectedTokenUuid) {
      const inspection = beginInspection(selectedTokenUuid);
      if (!inspection) return null;
      inspection.advance();
      return Object.freeze({
        encounterActive: inspection.encounterActive,
        selected: inspection.selected,
        gridSize: inspection.gridSize,
        threats: inspection.threats(),
        liveHostiles: inspection.liveHostiles,
        compulsionSources: inspection.compulsionSources,
        prefilter: inspection.prefilter
      });
    },

    /** Whether a built reach covers the square the focus now stands on. */
    covers: (threat, focus) => threatCovers(threat, focus),

    /** Whether the focus has left the envelope the prefilter assumed when the threats were built. */
    leftEnvelope: (prefilter, focus) => leftPrefilterEnvelope(prefilter, focus),

    /** How dangerous one hostile is to the selected unit if it attacks, measured across every weapon it could wield. */
    grade(hostileTokenUuid, selectedTokenUuid) {
      try {
        const projected = matchups.projectThreatMatchups(hostileTokenUuid, selectedTokenUuid);
        if (!projected) return null;
        return gradeIncomingThreat({
          incapacitated: isIncapacitated(projected),
          targetHp: projected.targetHp,
          matchups: projected.matchups
        });
      } catch (error) {
        report('threat-grade', error);
        return null;
      }
    }
  });
}
