/** @layer lib/core */

/* -------------------------------------------- */
/*  Token UUID remapping                        */
/* -------------------------------------------- */
const TOKEN_UUID_PATTERN = /Scene\.([A-Za-z0-9]+)\.Token\.([A-Za-z0-9]+)/g;

/**
 * Point the token UUIDs in nested data at this Scene when they name another Scene but a token id this Scene holds.
 * foundry/hooks/scene.mjs uses it to repair a duplicated or imported Scene. Returns the new value and the count.
 */
export function remapSceneTokenUuids(value, sceneId, tokenIds) {
  let count = 0;
  const visit = node => {
    if (typeof node === 'string') {
      return node.replace(TOKEN_UUID_PATTERN, (match, fromScene, tokenId) => {
        if (fromScene === sceneId || !tokenIds.has(tokenId)) return match;
        count += 1;
        return `Scene.${sceneId}.Token.${tokenId}`;
      });
    }
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(visit);
    const copy = {};
    for (const [key, entry] of Object.entries(node)) copy[key] = visit(entry);
    return copy;
  };
  return { value: visit(value), count };
}
