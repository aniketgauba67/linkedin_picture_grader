import type { AxisName } from '@pps/scoring';
import { COMPUTED_AXES, JUDGED_AXES } from '@pps/scoring';

import type { OutcomeView, AxisRow } from '@/lib/outcome-view';

const AXIS_COPY: Readonly<Record<AxisName, string>> = {
  sharpness: 'Focus and visible detail',
  lighting: 'How clearly the photo is lit',
  resolution: 'Detail available at profile size',
  framing: 'Crop and subject placement',
  background: 'Distractions in the background',
  attire: 'Visible clothing for this context',
  expression: 'The expression captured in the photo',
  solo: 'One clear subject in the frame',
};

function ScoreRow({ row }: { readonly row: AxisRow }) {
  return (
    <li className="score-row">
      <div className="score-row__copy">
        <strong>{row.axis}</strong>
        <span>{AXIS_COPY[row.axis]}</span>
      </div>
      <div className="score-row__measure">
        <span className="score-row__value">{row.score}<small> / 5</small></span>
        <span className="score-row__track" aria-hidden="true">
          <span style={{ width: `${(row.score / 5) * 100}%` }} />
        </span>
      </div>
    </li>
  );
}

function ScoreGroup({ title, axes, rows, missingText }: {
  readonly title: string;
  readonly axes: readonly AxisName[];
  readonly rows: readonly AxisRow[];
  readonly missingText?: string;
}) {
  const visible = rows.filter((row) => axes.includes(row.axis));
  return (
    <section className="score-group" aria-label={title}>
      <div className="score-group__heading">
        <h3>{title}</h3>
        <span>{visible.length} of {axes.length} reviewed</span>
      </div>
      {visible.length > 0 ? (
        <ul>{visible.map((row) => <ScoreRow key={row.axis} row={row} />)}</ul>
      ) : (
        <p className="score-group__empty">{missingText ?? 'These dimensions could not be reviewed for this photo.'}</p>
      )}
    </section>
  );
}

export function ResultPanel({ view, onReset }: {
  readonly view: OutcomeView;
  readonly onReset: () => void;
}) {
  const noFace = view.reason === 'no_face';
  return (
    <div className="result-copy">
      <div className="result-heading">
        <div>
          <p className="section-kicker">Your photo review</p>
          <h1>{noFace ? 'No face found in this photo.' : view.kind === 'declined' ? 'This photo needs another look.' : 'Your profile photo score.'}</h1>
        </div>
        <button type="button" className="text-action result-heading__reset" onClick={onReset}>Try another photo</button>
      </div>

      <section className={`score-hero ${view.kind === 'declined' ? 'score-hero--partial' : ''}`}
        aria-label="Overall result" role="status" aria-live="polite">
        {view.score === null ? (
          <p className="score-hero__unscored">Not scored</p>
        ) : (
          <div className="score-hero__number"><strong>{view.score.toFixed(1)}</strong><span>/ 10</span></div>
        )}
        <div className="score-hero__context">
          <p>{view.kind === 'declined' ? 'Partial photo review' : 'Overall photo score'}</p>
          <span>{view.detail}</span>
        </div>
      </section>

      {view.caveat !== null && <p className="result-caveat">{view.caveat}</p>}

      <section className="recommendations" aria-labelledby="recommendations-heading">
        <div className="content-heading">
          <p className="section-kicker">What to do next</p>
          <h2 id="recommendations-heading">{noFace && view.fixes.length === 0 ? 'For a full review' : 'Top improvements'}</h2>
        </div>
        {view.fixes.length > 0 ? (
          <ol className="recommendation-list">
            {view.fixes.map((fix, index) => (
              <li key={`${fix.axis}-${index}`}>
                <span className="recommendation-list__number" aria-hidden="true">{index + 1}</span>
                <div><strong>{fix.axis}</strong><p>{fix.message}</p></div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="recommendations__empty">{noFace
            ? 'Choose a photo with one clearly visible face to see the presentation scores.'
            : 'No specific changes were suggested for this photo.'}</p>
        )}
      </section>

      <div className="breakdown-heading">
        <p className="section-kicker">The detail</p>
        <h2>How each part scored</h2>
        <p>Each dimension is scored from 1 to 5. Only dimensions that were actually reviewed appear below.</p>
      </div>
      <div className="score-groups">
        <ScoreGroup title="Image quality" axes={COMPUTED_AXES} rows={view.rows} />
        <ScoreGroup title="Presentation" axes={JUDGED_AXES} rows={view.rows}
          {...(noFace ? { missingText: 'A usable face is needed to review background, attire, expression, and whether the photo has one clear subject.' } : {})} />
      </div>
      <button type="button" className="button button--secondary result-bottom-action" onClick={onReset}>Try another photo</button>
    </div>
  );
}
