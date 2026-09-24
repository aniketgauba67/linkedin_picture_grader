export interface BrowserEnv {
  readonly url: string;
  readonly anonKey: string;
}

export interface ServiceEnv extends BrowserEnv {
  readonly serviceRoleKey: string;
}

function required(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable ${name}. See .env.example.`);
  }
  return value;
}

export function readBrowserEnv(source: Record<string, string | undefined>): BrowserEnv {
  return {
    url: required('NEXT_PUBLIC_SUPABASE_URL', source['NEXT_PUBLIC_SUPABASE_URL']),
    anonKey: required('NEXT_PUBLIC_SUPABASE_ANON_KEY', source['NEXT_PUBLIC_SUPABASE_ANON_KEY']),
  };
}

export function readServiceEnv(source: Record<string, string | undefined>): ServiceEnv {
  return {
    ...readBrowserEnv(source),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY', source['SUPABASE_SERVICE_ROLE_KEY']),
  };
}

export const IMAGE_BUCKET = 'photos';
