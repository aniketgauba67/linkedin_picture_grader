import type { Stage } from '@/lib/analyse';

const STEPS = [
  { stage: 'hashing', title: 'Preparing your photo', detail: 'Getting the image ready for review.' },
  { stage: 'uploading', title: 'Uploading your photo', detail: 'Sending the original photo securely.' },
  { stage: 'analysing', title: 'Reviewing the photograph', detail: 'Looking at image quality and presentation.' },
  { stage: 'scoring', title: 'Building your result', detail: 'Putting the observations together.' },
] as const;

export function AnalysisProgress({ stage }: { readonly stage: Stage }) {
  const current = STEPS.findIndex((step) => step.stage === stage);

  return (
    <section className="analysis-copy" aria-label="Analysis progress" aria-busy="true">
      <p className="section-kicker">Photo review in progress</p>
      <h1>Your photo is being reviewed.</h1>
      <p className="analysis-copy__intro">We are looking at the photo itself, from clarity and lighting to how it is framed.</p>
      <p className="analysis-current" role="status" aria-live="polite">
        <span className="analysis-current__pulse" aria-hidden="true" />
        {STEPS[current]?.title ?? 'Preparing your photo'}
      </p>
      <ol className="analysis-steps">
        {STEPS.map((step, index) => (
          <li key={step.stage} className={`analysis-step ${index < current ? 'is-complete' : ''} ${index === current ? 'is-current' : ''}`}>
            <span className="analysis-step__marker" aria-hidden="true">{index < current ? '✓' : index + 1}</span>
            <span>
              <strong>{step.title}</strong>
              <span className="analysis-step__detail">{step.detail}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="analysis-copy__note">This can take a moment. Please keep this page open.</p>
    </section>
  );
}
