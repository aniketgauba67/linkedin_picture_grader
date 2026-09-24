import type { Client } from './client.js';

/**
 * A stand-in for a Supabase client, for unit tests.
 *
 * supabase-js builds a query by chaining and only sends it when the
 * builder is awaited, so a fake only has to be chainable and thenable.
 * Every method records its name and arguments, then returns the same
 * object; awaiting it resolves to the next queued result.
 *
 * This exercises the helper logic - dedup fallback, validation, error
 * mapping. It cannot test whether the SQL is right, which is what the
 * integration suites against real Postgres are for.
 */
export interface Call {
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface QueuedResult {
  readonly data?: unknown;
  readonly error?: { message: string; code?: string } | null;
}

export interface FakeClient {
  readonly client: Client;
  readonly calls: readonly Call[];
  /** Args of the first recorded call to `method`, if any. */
  argsFor(method: string): readonly unknown[] | undefined;
  removedPaths(): readonly string[];
}

export function createFakeClient(results: readonly QueuedResult[]): FakeClient {
  const calls: Call[] = [];
  const queue = [...results];
  const removed: string[] = [];

  function nextResult(): QueuedResult {
    return queue.shift() ?? { data: null, error: null };
  }

  function builder(): unknown {
    const chain: Record<string, unknown> = {};
    const record = (method: string) => {
      chain[method] = (...args: unknown[]) => {
        calls.push({ method, args });
        return chain;
      };
    };

    for (const method of [
      'select',
      'insert',
      'upsert',
      'update',
      'delete',
      'eq',
      'is',
      'lte',
      'not',
      'order',
      'limit',
    ]) {
      record(method);
    }

    // Terminals resolve the builder.
    for (const method of ['single', 'maybeSingle']) {
      chain[method] = (...args: unknown[]) => {
        calls.push({ method, args });
        const result = nextResult();
        return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
      };
    }

    chain['then'] = (resolve: (value: unknown) => unknown) => {
      const result = nextResult();
      return Promise.resolve(resolve({ data: result.data ?? null, error: result.error ?? null }));
    };

    return chain;
  }

  const client = {
    from(table: string) {
      calls.push({ method: 'from', args: [table] });
      return builder();
    },
    rpc(name: string, args: unknown) {
      calls.push({ method: 'rpc', args: [name, args] });
      const result = nextResult();
      return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
    },
    storage: {
      from(bucket: string) {
        calls.push({ method: 'storage.from', args: [bucket] });
        return {
          remove(paths: string[]) {
            calls.push({ method: 'storage.remove', args: [paths] });
            removed.push(...paths);
            const result = nextResult();
            return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
          },
        };
      },
    },
  } as unknown as Client;

  return {
    client,
    calls,
    argsFor(method) {
      return calls.find((call) => call.method === method)?.args;
    },
    removedPaths() {
      return removed;
    },
  };
}
