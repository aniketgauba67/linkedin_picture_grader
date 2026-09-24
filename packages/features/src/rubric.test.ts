import { describe, expect, it } from 'vitest';
import { MAX_TOKENS, MODEL, OUTPUT_JSON_SCHEMA, SYSTEM_PROMPT } from './rubric.js';

/**
 * A lint on the prompt itself.
 *
 * The rubric's hard constraints forbid reasoning about a set of things.
 * Nothing stopped an ANCHOR from quietly requiring exactly that - the
 * first draft of BACKGROUND level 2 said "legible text or signage
 * unrelated to the subject's work", which cannot be judged without
 * inferring what the subject does. It was caught by reading, which is
 * not a control.
 *
 * This is that control. It scans the anchors and the method for terms
 * the constraints forbid, and permits them only where the surrounding
 * sentence is itself a prohibition.
 */

/**
 * Stems rather than whole words, so "attractiveness" is caught by
 * "attractive" and "employability" by "employab". `work` is anchored to
 * a whole word on purpose - "workshop" is a place, not an occupation.
 */
const FORBIDDEN_INFERENCES: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'profession', pattern: /\bprofessions?\b/i },
  { label: 'occupation', pattern: /\boccupation\w*/i },
  { label: 'job', pattern: /\bjobs?\b/i },
  { label: 'work', pattern: /\bwork\b/i },
  { label: 'career', pattern: /\bcareers?\b/i },
  { label: 'employer', pattern: /\bemploy\w*/i },
  { label: 'industry', pattern: /\bindustr\w*/i },
  { label: 'seniority', pattern: /\bsenior\w*/i },
  { label: 'age', pattern: /\bages?\b/i },
  { label: 'race', pattern: /\brac(e|es|ial)\b/i },
  { label: 'ethnicity', pattern: /\bethnic\w*/i },
  { label: 'gender', pattern: /\bgender\w*/i },
  { label: 'attractive', pattern: /\battractive\w*/i },
  { label: 'competent', pattern: /\bcompeten\w*/i },
  { label: 'hireable', pattern: /\bhir(e)?able\b/i },
  { label: 'trustworthy', pattern: /\btrustworth\w*/i },
  { label: 'intelligence', pattern: /\bintelligen\w*/i },
];

/**
 * "professional" is allowed only where it modifies a photograph, a
 * backdrop or clothing - never a person, and never a setting, because a
 * person's setting is a proxy for what they do.
 */
const PROFESSIONAL_ALLOWED = [
  /professional profile pictures/i,
  /professional backdrop/i,
  /formal professional dress/i,
];

/**
 * A line may name a forbidden term when the line exists to forbid it.
 * "Never assess ... profession" is the rule; "signage unrelated to the
 * subject's work" is a violation of it.
 */
const PROHIBITION = /\b(never|do not|don'?t|must not|is a violation|forbidden|not scoring)\b/i;

function sectionsOf(prompt: string): Map<string, string> {
  const sections = new Map<string, string>();
  const parts = prompt.split(/^## /m);
  for (const part of parts.slice(1)) {
    const newline = part.indexOf('\n');
    sections.set(part.slice(0, newline).trim().toLowerCase(), part.slice(newline + 1));
  }
  return sections;
}

interface Offence {
  readonly where: string;
  readonly term: string;
  readonly line: string;
}

function scan(where: string, body: string): Offence[] {
  const offences: Offence[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;

    if (/professional/i.test(line) && !PROFESSIONAL_ALLOWED.some((ok) => ok.test(line))) {
      offences.push({ where, term: 'professional (applied to a person or their setting)', line });
    }

    if (PROHIBITION.test(line)) continue;

    for (const { label, pattern } of FORBIDDEN_INFERENCES) {
      if (pattern.test(line)) {
        offences.push({ where, term: label, line });
      }
    }
  }
  return offences;
}

function report(offences: readonly Offence[]): string {
  return offences
    .map((o) => `\n  [${o.where}] forbidden inference "${o.term}"\n    > ${o.line}`)
    .join('');
}

const sections = sectionsOf(SYSTEM_PROMPT);
const method = sections.get('method') ?? '';
const axes = sections.get('axes') ?? '';

const AXIS_NAMES = ['BACKGROUND', 'ATTIRE', 'EXPRESSION', 'SOLO'] as const;

function axisBlock(name: string): string {
  const start = axes.indexOf(`### ${name}`);
  if (start === -1) return '';
  const next = axes.indexOf('### ', start + 1);
  return axes.slice(start, next === -1 ? undefined : next);
}

describe('the prompt parses into the sections the lint depends on', () => {
  it('finds the method and the axes', () => {
    expect(method.length).toBeGreaterThan(100);
    expect(axes.length).toBeGreaterThan(100);
  });

  it.each(AXIS_NAMES)('finds five anchors for %s', (name) => {
    const block = axisBlock(name);
    // Em dash, not a hyphen. Getting this wrong is not academic: an
    // earlier edit searched the anchors for "1 - " and str.replace
    // silently returned the text unchanged, so a rewrite that looked
    // applied was never applied at all.
    const anchors = block.split('\n').filter((l) => /^[1-5]\s*[—-]\s/.test(l.trim()));
    expect(anchors).toHaveLength(5);
  });
});

describe('no anchor requires an inference the constraints forbid', () => {
  it.each(AXIS_NAMES)('%s anchors are clean', (name) => {
    const offences = scan(`${name} axis`, axisBlock(name));
    expect(offences, report(offences)).toEqual([]);
  });

  it('the method is clean', () => {
    const offences = scan('METHOD', method);
    expect(offences, report(offences)).toEqual([]);
  });
});

describe('the constraints section still says what the lint assumes', () => {
  it('names the things it forbids, so the lint and the prompt cannot drift', () => {
    const constraints = sections.get('hard constraints') ?? '';
    for (const term of ['attractiveness', 'competence', 'employability', 'seniority', 'profession']) {
      expect(constraints.toLowerCase(), `constraints should still forbid ${term}`).toContain(term);
    }
    for (const term of ['age', 'race', 'ethnicity', 'gender']) {
      expect(constraints.toLowerCase()).toContain(term);
    }
  });

  it('keeps the photograph-not-the-person framing in the method', () => {
    expect(method).toMatch(/EVIDENCE DESCRIBES THE PHOTOGRAPH, NEVER THE PERSON/);
  });
});

describe('request invariants', () => {
  it('stays pinned to the model and ceiling the probe was run against', () => {
    expect(MODEL).toBe('claude-sonnet-5');
    expect(MAX_TOKENS).toBe(4096);
  });

  it('declares every decline reason the rubric may return', () => {
    const properties = OUTPUT_JSON_SCHEMA.properties as unknown as Record<
      string,
      { enum?: unknown[] }
    >;
    const reason = properties['reason'];
    expect(reason?.enum).toEqual(['no_face', 'apparent_minor', 'not_a_photo', null]);
  });
});
