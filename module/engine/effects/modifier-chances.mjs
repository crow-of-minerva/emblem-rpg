/** @layer engine/effects */
import { COMMAND_LANES } from '../../contracts/commands.mjs';

/* -------------------------------------------- */
/*  Action scope                                */
/* -------------------------------------------- */

/**
 * Run every command handler inside a modifier-chance scope (FoundryModifierChanceScopes in
 * foundry/adapters/dice/modifier-chances.mjs), so each unit's chance-based modifiers are rolled once per action and
 * every step and child command of that action sees the same rolls. Read-only (inspect) commands open no scope. A
 * gameplay command, a phase change included, rolls up front for every Character in the world, world actors and
 * unlinked tokens alike. Other kinds of command roll only when a nested action asks.
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

/** Open or join the modifier-chance scope for the handler, then close it once the handler returns or throws. */
async function runInScope(definition, context, scopes) {
  if (context.lane === COMMAND_LANES.INSPECT) return definition.handler(context);
  const scope = await scopes.open({ eager: context.lane === COMMAND_LANES.GAMEPLAY });
  try {
    return await definition.handler(context);
  } finally {
    await scopes.close(scope);
  }
}
