import { AXES, AXIS_DESCRIPTIONS, COMPUTED_AXES, JUDGED_AXES } from '@pps/scoring';

import { AnalyseForm } from './analyse-form';

/**
 * Only the two PUBLIC Supabase values reach the browser. The service
 * role key and the Anthropic key are read exclusively inside route
 * handlers and never referenced in a client component, so the bundler
 * has nothing to inline.
 */
function publicConfig(): { url: string; anonKey: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (url === undefined || url === '' || anonKey === undefined || anonKey === '') return null;
  return { url, anonKey };
}

export default function Home() {
  const config = publicConfig();

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Profile Photo Scorer</h1>
        <p className="text-muted text-balance">
          Every axis below describes the photograph, not the person, and every one of them is
          something you can change by retaking the shot.
        </p>
      </header>

      {config === null ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
          Scoring is not configured in this environment.
        </p>
      ) : (
        <AnalyseForm supabaseUrl={config.url} supabaseAnonKey={config.anonKey} />
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide">
          Computed from pixels ({COMPUTED_AXES.length})
        </h2>
        <AxisList axes={COMPUTED_AXES} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide">
          Judged by a vision model ({JUDGED_AXES.length})
        </h2>
        <AxisList axes={JUDGED_AXES} />
      </section>

      <p className="text-muted text-sm">
        {AXES.length} axes, each scored 1&ndash;5, weighted into a single 1&ndash;10 composite.
      </p>
    </main>
  );
}

function AxisList({ axes }: { axes: readonly (typeof AXES)[number][] }) {
  return (
    <ul className="flex flex-col gap-2">
      {axes.map((axis) => (
        <li key={axis} className="rounded-lg border border-black/10 px-4 py-3">
          <span className="font-medium">{axis}</span>
          <span className="text-muted block text-sm">{AXIS_DESCRIPTIONS[axis]}</span>
        </li>
      ))}
    </ul>
  );
}
