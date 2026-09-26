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
    <main className="site-shell">
      <header className="site-header">
        <div className="brand"><span className="brand__mark" aria-hidden="true" /><span>Profile Photo Score</span></div>
        <p>Thoughtful feedback for the photo you share.</p>
      </header>
      {config === null ? (
        <section className="unavailable" role="status">
          <h1>Photo review is unavailable right now.</h1>
          <p>Please come back in a moment to try your photo.</p>
        </section>
      ) : (
        <AnalyseForm supabaseUrl={config.url} supabaseAnonKey={config.anonKey} />
      )}
      <footer className="site-footer"><span>Profile Photo Score</span><span>Feedback on the photograph, never a judgment of the person.</span></footer>
    </main>
  );
}
