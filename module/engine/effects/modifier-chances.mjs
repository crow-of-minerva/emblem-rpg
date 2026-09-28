/** @layer engine/effects */
import { COMMAND_LANES } from '../../contracts/commands.mjs';

/* -------------------------------------------- */
/*  Action scope                                */
/* -------------------------------------------- */

/**
 * Run every command handler inside a modifier-chance scope (FoundryModifierChanceScopes in
 * foundry/adapters/dice/modifier-chances.mjs), so an action draws its chances once at the root command and nested
 * commands reuse them. Inspection opens no scope. Every gameplay root, a phase change included, draws its chances
 * eagerly and keeps them for that one action. Other lanes draw only when a nested action asks.
 * @param {ReadonlyArray<object>} definitions A command contribution.
 * @param {{open: Function, close: Function}} scopes The host's chance-modifier scopes.
 * @returns {object[]} The same definitions, each handler run inside its action's scope.
 */
export function withActionModifierChances(definitions, scopes) {
  return definitions.map(definition => ({
    ...definition,
    handler: context => runInScope(definition, context, scopes)
  }));
}

/** Open or join the modifier-chance scope for the action callback, then close it in finally. */
async function runInScope(definition, context, scopes) {
  if (context.lane === COMMAND_LANES.INSPECT) return definition.handler(context);
  const scope = await scopes.open({ eager: context.lane === COMMAND_LANES.GAMEPLAY });
  try {
    return await definition.handler(context);
  } finally {
    await scopes.close(scope);
  }
}
