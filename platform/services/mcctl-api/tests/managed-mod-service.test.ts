import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModSourceFactory, type ModFile, type ModVersion } from '@minecraft-docker/shared';
import type { IModSourcePort } from '@minecraft-docker/shared/application';
import { ManagedModService, ModManagementError } from '../src/services/ManagedModService.js';

const bytes = Buffer.from('verified test jar artifact');
const sha1 = createHash('sha1').update(bytes).digest('hex');
const sha512 = createHash('sha512').update(bytes).digest('hex');

function makeVersion(id: string, versionNumber: string, mcVersion = '1.21.1', fileBytes = bytes, checksum = sha512): ModVersion {
  const file: ModFile = {
    url: 'https://cdn.modrinth.com/data/project/versions/version/mod.jar',
    filename: `example-${versionNumber}.jar`, size: fileBytes.length,
    hashes: { sha1, sha512: checksum }, primary: true,
  };
  return {
    id, projectId: 'project-id', name: versionNumber, versionNumber, versionType: 'release',
    gameVersions: [mcVersion], loaders: ['fabric'], files: [file], dependencies: [],
    downloads: 10, datePublished: '2026-01-01T00:00:00Z',
  };
}

describe('ManagedModService', () => {
  let root: string;
  let service: ManagedModService;
  let versions: ModVersion[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mcctl-mods-'));
    const serverDir = join(root, 'servers', 'survival');
    mkdirSync(join(serverDir, 'data'), { recursive: true });
    mkdirSync(join(serverDir, 'data', 'mods'), { recursive: true });
    writeFileSync(join(serverDir, 'config.env'), 'TYPE=FABRIC\nVERSION=1.21.1\n');
    service = new ManagedModService(root);
    versions = [makeVersion('v1', '1.0.0')];
    ModSourceFactory.clear();
    const adapter: IModSourcePort = {
      sourceName: 'modrinth', displayName: 'Modrinth',
      search: vi.fn(), getProject: vi.fn().mockResolvedValue({
        slug: 'example', title: 'Example', description: '', downloads: 1, iconUrl: null,
        serverSide: 'required', clientSide: 'optional', projectType: 'mod', categories: [],
        author: 'Test', license: 'MIT', sourceId: 'project-id', sourceName: 'modrinth',
      }),
      getVersions: vi.fn(async () => versions), isAvailable: vi.fn().mockResolvedValue(true),
      getEnvKey: () => 'MODRINTH_PROJECTS', formatForEnv: (project) => project.slug,
      findByFileHash: vi.fn(async () => ({
        project: {
          slug: 'example', title: 'Example', description: '', downloads: 1, iconUrl: null,
          serverSide: 'required', clientSide: 'optional', projectType: 'mod', categories: [],
          author: 'Test', license: 'MIT', sourceId: 'project-id', sourceName: 'modrinth',
        },
        version: versions[0]!,
      })),
    };
    ModSourceFactory.register(adapter);
    fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(bytes, {
      status: 200, headers: { 'content-length': String(bytes.length) },
    })));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    ModSourceFactory.clear();
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects a version for another Minecraft release before downloading it', async () => {
    versions = [makeVersion('old', '0.9.0', '1.20.1')];
    await expect(service.install('survival', 'modrinth', 'project-id', 'old'))
      .rejects.toBeInstanceOf(ModManagementError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pins the selected compatible artifact and verifies its publisher checksum', async () => {
    const mod = await service.install('survival', 'modrinth', 'project-id', 'v1');
    expect(mod).toMatchObject({ source: 'modrinth', versionId: 'v1', filename: 'example-1.0.0.jar', sha1, enabled: true });
    expect(readFileSync(join(root, 'servers', 'survival', 'data', 'mods', mod.filename))).toEqual(bytes);
    expect(JSON.parse(readFileSync(join(root, 'servers', 'survival', 'data', '.mcctl-mods.json'), 'utf8')).mods).toHaveLength(1);
  });

  it('rejects a checksum mismatch without leaving a jar behind', async () => {
    versions = [makeVersion('v1', '1.0.0', '1.21.1', bytes, '0'.repeat(128))];
    await expect(service.install('survival', 'modrinth', 'project-id', 'v1'))
      .rejects.toThrow(/checksum verification/);
    expect(readdirSync(join(root, 'servers', 'survival', 'data', 'mods'))).toEqual([]);
  });

  it('updates the selected managed mod, can disable it, and deletes it', async () => {
    const installed = await service.install('survival', 'modrinth', 'project-id', 'v1');
    versions = [makeVersion('v2', '2.0.0')];
    const result = await service.update('survival', [installed.filename]);
    expect(result.updated[0]).toMatchObject({ versionId: 'v2', version: '2.0.0' });
    expect(readdirSync(join(root, 'servers', 'survival', 'data', 'mods'))).toEqual(['example-2.0.0.jar']);
    const disabled = service.setEnabled('survival', 'example-2.0.0.jar', false);
    expect(disabled.enabled).toBe(false);
    expect(service.list('survival')).toHaveLength(1);
    service.delete('survival', 'example-2.0.0.jar');
    expect(service.list('survival')).toEqual([]);
  });

  it('does not downgrade when the publisher lists the installed version as current latest', async () => {
    const installed = await service.install('survival', 'modrinth', 'project-id', 'v1');
    versions = [makeVersion('v1', '1.0.0'), makeVersion('old', '0.9.0')];
    expect(await service.checkUpdates('survival')).toEqual([{
      filename: installed.filename, currentVersion: '1.0.0', latestVersion: '1.0.0', updateAvailable: false,
    }]);
    expect(await service.update('survival')).toMatchObject({ updated: [], unchanged: [installed.filename] });
  });

  it('adopts an existing jar only when Modrinth resolves its exact hash and compatible version', async () => {
    const jar = join(root, 'servers', 'survival', 'data', 'mods', 'legacy.jar');
    writeFileSync(jar, bytes);
    const result = await service.adoptExisting('survival');
    expect(result.adopted).toMatchObject([{ filename: 'legacy.jar', slug: 'example', versionId: 'v1', sha1 }]);
    expect(result.unrecognized).toEqual([]);
    expect(service.list('survival')[0]?.managed).toBe(true);
  });

  it('stores per-mod links only to existing text configs inside config/', async () => {
    const installed = await service.install('survival', 'modrinth', 'project-id', 'v1');
    const configDir = join(root, 'servers', 'survival', 'data', 'config');
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'example.toml'), 'enabled=true\n');
    expect(service.setConfigFiles('survival', installed.filename, ['config/example.toml']))
      .toEqual(['config/example.toml']);
    expect(service.list('survival')[0]?.configFiles).toEqual(['config/example.toml']);
    expect(() => service.setConfigFiles('survival', installed.filename, ['../server.properties']))
      .toThrow(/config directory/);
  });
});
