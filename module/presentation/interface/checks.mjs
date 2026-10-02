/** @layer presentation/interface */
import { SYSTEM_ID } from '../../contracts/protocol.mjs';
import { avatarScaleStyle, escapeHtml } from '../../lib/dom/html.mjs';

/* -------------------------------------------- */
/*  Character check chat                        */
/* -------------------------------------------- */
/** Post the chat cards for skill checks and saving throws through FoundryChatOutput, from the rolled results. */
export class CharacterCheckChatPresenter {
  constructor(output) {
    this.output = output;
  }

  /**
   * Post one skill check card. A check against a DC shows the verdict, with the target in it. An open check has no
   * verdict, so its title carries the target after the activity, then its roll mode.
   */
  async presentSkill(data) {
    // `contested` means the check has a DC.
    const contested = Number.isFinite(data.dc);
    const modeLabel = data.check.mode === 'advantage' ? ' (Advantage)'
      : data.check.mode === 'disadvantage' ? ' (Disadvantage)' : '';
    const activity = `${data.check.skillLabel} Skill Check${data.effectName ? `: ${data.effectName}` : ''}`;
    const title = contested
      ? activity
      : `${activity}${data.targetName ? ` vs ${data.targetName}` : ''}${modeLabel}`;
    const resultClass = contested ? (data.success ? 'is-success' : 'is-failure') : '';
    const verdict = contested
      ? `${data.success ? 'SUCCESS' : 'FAILURE'}${data.targetName ? ` vs ${data.targetName}` : ''} (DC ${data.dc})`
      : '';
    const content = renderCheckCard({
      actorName: data.actorName,
      actorImage: data.actorImage,
      avatarScale: data.avatarScale,
      title,
      icon: {
        image: `systems/${SYSTEM_ID}/assets/ui/skills/${data.check.skillKey}.png`,
        alt: data.check.skillLabel,
        className: 'emblem-skill-icon'
      },
      breakdown: breakdownHtml(data.check, data.roll),
      total: data.total,
      resultClass,
      verdict
    });
    await this.output.create({
      actorUuid: data.actorUuid,
      content,
      rollReference: data.roll.rollReference,
      waitForDice: true,
      requester: data.requester ?? null
    });
  }

  /** Post one saving throw card, with the effect's image beside the roll when it has one. */
  async presentSave(data) {
    const advantage = data.hasAdvantage ? ' (Advantage)' : '';
    const title = `${data.effectName ? `Saving Throw vs ${data.effectName}` : 'Saving Throw'}${advantage}`;
    const resultClass = data.success ? 'is-success' : 'is-failure';
    const content = renderCheckCard({
      actorName: data.actorName,
      actorImage: data.actorImage,
      avatarScale: data.avatarScale,
      title,
      classes: 'emblem-save-card',
      icon: data.sourceImg ? {
        image: data.sourceImg,
        alt: data.effectName || 'source',
        className: 'emblem-save-source',
        tooltip: data.effectName
      } : null,
      breakdown: breakdownHtml(data.check, data.roll),
      total: data.total,
      resultClass,
      verdict: `${data.success ? 'SUCCESS' : 'FAILURE'} (DC ${data.dc})`
    });
    await this.output.create({
      actorUuid: data.actorUuid,
      content,
      rollReference: data.roll.rollReference,
      waitForDice: true,
      requester: data.requester ?? null
    });
  }
}

/* -------------------------------------------- */
/*  Card rendering                              */
/* -------------------------------------------- */
/** The card markup that skill checks and saving throws share. */
function renderCheckCard({
  actorName,
  actorImage,
  avatarScale,
  title,
  classes = '',
  icon = null,
  breakdown = '',
  total,
  resultClass = '',
  verdict = ''
}) {
  const iconHtml = icon?.image ? `<img class="${escapeHtml(icon.className)}" src="${escapeHtml(icon.image)}"
          alt="${escapeHtml(icon.alt ?? '')}"${icon.tooltip ? ` data-tooltip="${escapeHtml(icon.tooltip)}"` : ''}>` : '';
  const verdictHtml = verdict
    ? `<div class="emblem-skill-verdict ${escapeHtml(resultClass)}">${escapeHtml(verdict)}</div>`
    : '';
  return `
    <div class="emblem-roll-card emblem-skill-card${classes ? ` ${escapeHtml(classes)}` : ''}">
      <header class="emblem-roll-header emblem-skill-header">
        <img src="${escapeHtml(actorImage || 'icons/svg/mystery-man.svg')}" alt="${escapeHtml(actorName)}"
          style="${avatarScaleStyle(avatarScale)}">
        <div class="emblem-skill-headtext">
          <span class="emblem-skill-actorname">${escapeHtml(actorName)}</span>
          <span class="emblem-skill-rollname">${escapeHtml(title)}</span>
        </div>
      </header>
      <div class="emblem-skill-body">
        ${iconHtml}
        ${breakdown}
        <div class="emblem-skill-total ${escapeHtml(resultClass)}">${escapeHtml(total)}</div>
        ${verdictHtml}
      </div>
    </div>`;
}

function breakdownHtml(check, roll) {
  return roll.rolls.map((entry, index) => {
    const line = formatRollFormula(entry.natural, checkTerms(check, entry));
    if (roll.rolls.length < 2) return `<div class="emblem-skill-breakdown">${line}</div>`;
    const state = index === roll.chosenIndex ? 'is-chosen' : 'is-discarded';
    return `<div class="emblem-skill-breakdown emblem-skill-line ${state}">${line} `
      + `<span class="emblem-skill-eq">= ${escapeHtml(entry.total)}</span></div>`;
  }).join('');
}

function checkTerms(check, roll) {
  let extraIndex = 0;
  const blessed = check.blessed ? roll.extraDice[extraIndex++] : null;
  const rank = check.rankDie ? roll.extraDice[extraIndex] : null;
  if (check.kind === 'skill') {
    const terms = [{ value: check.statBonus, label: displayStat(check.statKey) }];
    if (rank !== null) terms.push({ value: rank, label: `d${check.rankDie}` });
    if (blessed !== null) terms.push({ value: blessed, label: 'Blessed' });
    return terms;
  }
  const terms = [];
  if (check.attribute) terms.push({ value: check.modifier, label: check.targetAttribute });
  else if (check.modifier) terms.push({ value: check.modifier, label: 'Mod' });
  if (blessed !== null) terms.push({ value: blessed, label: 'Blessed' });
  return terms;
}

function formatRollFormula(natural, terms) {
  let html = `<strong class="emblem-roll-num">${escapeHtml(natural)}</strong>`;
  for (const term of terms) {
    const value = Number(term.value) || 0;
    const separator = value < 0 ? ' − ' : ' + ';
    html += `${separator}<strong class="emblem-roll-num">${Math.abs(value)}</strong>`
      + ` <span class="emblem-roll-lbl">(${escapeHtml(term.label)})</span>`;
  }
  return html;
}

function displayStat(key) {
  return ({ mgt: 'Mgt', agi: 'Agi', tqn: 'Tqn', wit: 'Wit', cha: 'Cha' })[key] ?? key;
}
