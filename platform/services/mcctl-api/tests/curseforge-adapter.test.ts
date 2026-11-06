import { afterEach, describe, expect, it, vi } from 'vitest';
import { CurseForgeAdapter } from '../src/services/CurseForgeAdapter.js';

describe('CurseForgeAdapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('searches Minecraft mods with the exact game version and loader filter', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 123, slug: 'example', name: 'Example', summary: 'A mod', downloadCount: 42, authors: [{ name: 'Author' }] }],
      pagination: { index: 0, pageSize: 10, totalCount: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new CurseForgeAdapter('test-key');

    const result = await adapter.search('example', { gameVersions: ['1.21.1'], loaders: ['fabric'] });

    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.searchParams.get('gameId')).toBe('432');
    expect(url.searchParams.get('classId')).toBe('6');
    expect(url.searchParams.get('gameVersion')).toBe('1.21.1');
    expect(url.searchParams.get('modLoaderType')).toBe('4');
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ headers: { 'x-api-key': 'test-key' } });
    expect(result.hits[0]).toMatchObject({ sourceId: '123', sourceName: 'curseforge', slug: 'example' });
  });

  it('returns versions with exact Minecraft and loader metadata plus file hashes', async () => {
    const fetchMock = vi.fn().mockImplementation((input: string | URL) => {
      const url = String(input);
      const body = url.includes('/files?') ? {
        data: [{
          id: 456, modId: 123, displayName: 'Example 1.2', fileName: 'example-1.2.jar',
          releaseType: 1, fileDate: '2026-01-01T00:00:00Z', downloadCount: 10, fileLength: 12,
          downloadUrl: 'https://edge.forgecdn.net/files/example.jar', gameVersions: ['1.21.1', 'Fabric'],
          hashes: [{ value: '0123456789abcdef0123456789abcdef01234567', algo: 1 }], dependencies: [],
        }],
      } : { data: null };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new CurseForgeAdapter('test-key');

    const versions = await adapter.getVersions('123', { gameVersions: ['1.21.1'], loaders: ['fabric'] });

    expect(versions[0]).toMatchObject({
      id: '456', projectId: '123', gameVersions: ['1.21.1'], loaders: ['Fabric'],
      files: [{ filename: 'example-1.2.jar', hashes: { sha1: '0123456789abcdef0123456789abcdef01234567' } }],
    });
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ headers: { 'x-api-key': 'test-key' } });
  });

  it('reports the provider unavailable when no API key is configured', async () => {
    expect(await new CurseForgeAdapter('').isAvailable()).toBe(false);
  });
});
