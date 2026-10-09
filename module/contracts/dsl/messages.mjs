/** @layer contracts/dsl */
/*
 * Plain English for validation messages. The validators track where a problem sits as a path such as
 * `entry.action.steps[2].then[0].target`. placeOf turns that path into the words the editor shows, here
 * `step 1 inside step 3`, and say and warn build the sentence a GM reads.
 */

/** Path segments that open a condition. Anything below one is part of that condition. */
const CONDITION_KEYS = Object.freeze(['condition', 'conditionTree', 'tree']);

/**
 * Where a path points, in words. Steps are numbered from 1 as their cards show them, a step in an if branch reads
 * `step 1 inside step 3` or `step 1 in the else part of step 3`, and a condition reads `the condition` or
 * `the condition in step 2`. A path that names neither gives `fallback`.
 * @param {string} path
 * @param {string} [fallback]
 * @returns {string}
 */
export function placeOf(path, fallback = 'this effect') {
  const parts = String(path ?? '').match(/[A-Za-z_$][\w$]*|\[\d+\]/g) ?? [];
  const steps = [];
  let condition = false;
  for (let i = 0; i < parts.length && !condition; i++) {
    const index = /^\[(\d+)\]$/.exec(parts[i + 1] ?? '');
    if (index && ['steps', 'then', 'else'].includes(parts[i])) {
      if (parts[i] === 'steps') steps.length = 0;
      steps.push({ number: Number(index[1]) + 1, branch: parts[i] });
      i++;
    } else if (CONDITION_KEYS.includes(parts[i])) condition = true;
  }
  if (!steps.length) return condition ? 'the condition' : fallback;
  let words = `step ${steps.at(-1).number}`;
  for (let j = steps.length - 1; j > 0; j--) {
    const outer = steps[j - 1].number;
    words += steps[j].branch === 'else' ? ` in the else part of step ${outer}` : ` inside step ${outer}`;
  }
  return condition ? `the condition in ${words}` : words;
}

/** One error sentence: the place, then what is wrong with it. */
export function say(place, sentence) {
  const text = `${place} ${sentence}`.trim();
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.?!]$/.test(text) ? '' : '.'}`;
}

/** One warning sentence, which reads like an error after a leading `Warning:`. */
export function warn(place, sentence) {
  const text = say(place, sentence);
  return `Warning: ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

/** A short list of choices as a person says it: `a, b or c`. */
export function oneOf(words) {
  const list = [...words].map(String);
  return list.length > 1 ? `${list.slice(0, -1).join(', ')} or ${list.at(-1)}` : (list[0] ?? '');
}
