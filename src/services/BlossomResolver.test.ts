import { describe, it, expect, vi, afterEach } from 'vitest';
import { BlossomResolver, type BlossomResolution } from './BlossomResolver';
import { parseBlossomUri } from '../helpers/blossomUri';

// Service imports pull in the DiagnosticLogger/PlatformService chain, which
// touches browser globals at module scope.
// @vitest-environment jsdom

const HASH = 'b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553';

/** Real SHA-256 of the 5-byte payload "hello" — used for verified downloads. */
const HELLO_BYTES = new TextEncoder().encode('hello');
const HELLO_HASH =
  '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

function fakeTransport() {
  return {
    fetch: vi.fn().mockResolvedValue([]),
  } as unknown as NostrTransportLike;
}

interface NostrTransportLike {
  fetch: ReturnType<typeof vi.fn>;
}

function fakeRelayConfig() {
  return { getReadRelays: () => ['wss://relay.example'] };
}

function makeResolver(): BlossomResolver {
  // Storage/localStorage are not used unless the own-server fallback runs;
  // tests never enable it implicitly.
  return new BlossomResolver(
    fakeTransport() as never,
    fakeRelayConfig() as never
  );
}

function headResponse(
  status: number,
  headers: Record<string, string> = {}
): Response {
  return new Response(null, { status, headers });
}

describe('BlossomResolver', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when no candidate server has the blob', async () => {
    const resolver = makeResolver();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(headResponse(404)));

    const info = parseBlossomUri(`blossom:${HASH}.png?xs=cdn.example.com`)!;
    expect(await resolver.resolve(info)).toBeNull();
  });

  it('resolves via the first working xs hint (image → verified object URL)', async () => {
    const resolver = makeResolver();
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith('https://dead.example/')) {
        return headResponse(404);
      }
      if (u.startsWith('https://alive.example/')) {
        return new Response(HELLO_BYTES.slice(), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      return headResponse(404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const info = parseBlossomUri(
      `blossom:${HELLO_HASH}.png?xs=dead.example&xs=alive.example`
    )!;
    const resolution: BlossomResolution | null = await resolver.resolve(info);

    expect(resolution).not.toBeNull();
    expect(resolution!.serverUrl).toBe('https://alive.example');
    expect(resolution!.blobUrl).toBe(`https://alive.example/${HELLO_HASH}.png`);
    expect(resolution!.verified).toBe(true);
    expect(resolution!.contentUrl.startsWith('blob:')).toBe(true);
    // HEAD went to both servers in order, then one GET to the working one
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `https://dead.example/${HELLO_HASH}.png`
    );
  });

  it('rejects a server serving wrong bytes (hash mismatch) and falls through', async () => {
    const resolver = makeResolver();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.startsWith('https://liar.example/')) {
          // HEAD OK, but the bytes don't match the hash
          if (u.endsWith(`.png`)) {
            return new Response(HELLO_BYTES.slice(), {
              status: 200,
              headers: { 'content-type': 'image/png' },
            });
          }
        }
        return new Response(null, { status: 404 });
      })
    );

    const info = parseBlossomUri(`blossom:${HASH}.png?xs=liar.example`)!;
    expect(await resolver.resolve(info)).toBeNull();
  });

  it('resolves video to the direct server URL without full download', async () => {
    const resolver = makeResolver();
    const fetchMock = vi.fn().mockResolvedValue(
      headResponse(200, {
        'content-type': 'video/mp4',
        'content-length': '123',
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const info = parseBlossomUri(`blossom:${HASH}.mp4?xs=cdn.example.com`)!;
    const resolution = await resolver.resolve(info);

    expect(resolution).not.toBeNull();
    expect(resolution!.contentUrl).toBe(`https://cdn.example.com/${HASH}.mp4`);
    expect(resolution!.verified).toBe(false);
    // Exactly one HEAD, no GET download
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a video whose HEAD content-length contradicts sz', async () => {
    const resolver = makeResolver();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        headResponse(200, {
          'content-type': 'video/mp4',
          'content-length': '999',
        })
      )
    );

    const info = parseBlossomUri(
      `blossom:${HASH}.mp4?xs=cdn.example.com&sz=123`
    )!;
    expect(await resolver.resolve(info)).toBeNull();
  });

  it('queries the author kind:10063 list when xs hints fail', async () => {
    const transport = fakeTransport();
    transport.fetch.mockResolvedValue([
      {
        created_at: 1700000000,
        tags: [
          ['server', 'https://author-blossom.example'],
          ['server', 'not-a-server'],
        ],
      },
    ]);
    const withTransport = new BlossomResolver(
      transport as never,
      fakeRelayConfig() as never
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url).startsWith('https://author-blossom.example/')) {
          return new Response(HELLO_BYTES.slice(), {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
          });
        }
        return new Response(null, { status: 404 });
      })
    );

    const author = 'a'.repeat(64);
    const info = parseBlossomUri(`blossom:${HELLO_HASH}.jpg?as=${author}`)!;
    const resolution = await withTransport.resolve(info);

    expect(resolution).not.toBeNull();
    expect(resolution!.serverUrl).toBe('https://author-blossom.example');
    // One kind:10063 fetch happened for the author
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(transport.fetch.mock.calls[0]![1]).toEqual([
      { kinds: [10063], authors: [author], limit: 1 },
    ]);
  });

  it('uses the authorHint (note author) as additional 10063 source', async () => {
    const transport = fakeTransport();
    transport.fetch.mockImplementation(
      async (_relays: unknown, filter: { authors: string[] }[]) => {
        if (filter[0]?.authors?.[0] === 'b'.repeat(64)) {
          return [
            {
              created_at: 1,
              tags: [['server', 'https://from-hint.example']],
            },
          ];
        }
        return [];
      }
    );
    const withTransport = new BlossomResolver(
      transport as never,
      fakeRelayConfig() as never
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url).startsWith('https://from-hint.example/')) {
          return new Response(HELLO_BYTES.slice(), {
            status: 200,
            headers: { 'content-type': 'image/webp' },
          });
        }
        return new Response(null, { status: 404 });
      })
    );

    const info = parseBlossomUri(`blossom:${HELLO_HASH}.webp`)!;
    const resolution = await withTransport.resolve(info, {
      authorHint: 'b'.repeat(64),
    });
    expect(resolution).not.toBeNull();
  });

  it('caches resolutions and misses per URI (in-flight dedup included)', async () => {
    const resolver = makeResolver();
    const fetchMock = vi.fn(
      async () =>
        new Response(HELLO_BYTES.slice(), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const info = parseBlossomUri(
      `blossom:${HELLO_HASH}.png?xs=cdn.example.com`
    )!;
    await Promise.all([
      resolver.resolve(info),
      resolver.resolve(info),
      resolver.resolve(info),
    ]);
    // 1 HEAD + 1 GET — all concurrent calls share one resolution
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Same URI again → served from cache, zero additional network
    await resolver.resolve(info);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
