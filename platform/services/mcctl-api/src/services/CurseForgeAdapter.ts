import type {
  ModDependency,
  ModFile,
  ModProject,
  ModSearchOptions,
  ModSearchResult,
  ModVersion,
  ModVersionOptions,
} from '@minecraft-docker/shared';
import type { IModSourcePort } from '@minecraft-docker/shared/application';
import { ModSourceFactory } from '@minecraft-docker/shared';

const API = 'https://api.curseforge.com/v1';
const MINECRAFT_GAME_ID = 432;
const MINECRAFT_MODS_CLASS_ID = 6;

interface CurseForgeResponse<T> { data: T; pagination?: { index: number; pageSize: number; totalCount: number } }
interface CfCategory { name: string }
interface CfMod {
  id: number; slug: string; name: string; summary: string; downloadCount: number;
  logo?: { url?: string } | null; categories?: CfCategory[]; authors?: Array<{ name: string }>;
}
interface CfHash { value: string; algo: number }
interface CfDependency { modId: number; relationType: number }
interface CfFile {
  id: number; modId: number; displayName: string; fileName: string; releaseType: number;
  fileDate: string; downloadCount: number; fileLength: number; downloadUrl: string | null;
  gameVersions: string[]; hashes: CfHash[]; dependencies?: CfDependency[];
}

const LOADER_TYPES: Record<string, number> = {
  forge: 1, fabric: 4, quilt: 5, neoforge: 6,
};

/** CurseForge's official REST API adapter. Requires CURSEFORGE_API_KEY. */
export class CurseForgeAdapter implements IModSourcePort {
  readonly sourceName = 'curseforge';
  readonly displayName = 'CurseForge';

  constructor(private apiKey: string | undefined = process.env.CURSEFORGE_API_KEY) {}

  setApiKey(apiKey: string): void { this.apiKey = apiKey; }

  private async request<T>(path: string, query?: URLSearchParams): Promise<T> {
    const apiKey = this.apiKey ?? process.env.CURSEFORGE_API_KEY;
    if (!apiKey) throw new Error('CurseForge search and downloads require CURSEFORGE_API_KEY.');
    const response = await fetch(`${API}${path}${query?.size ? `?${query}` : ''}`, {
      headers: { 'x-api-key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`CurseForge API error: ${response.status} ${response.statusText}`);
    return (await response.json()) as T;
  }

  async search(query: string, options: ModSearchOptions = {}): Promise<ModSearchResult> {
    const params = new URLSearchParams({
      gameId: String(MINECRAFT_GAME_ID), classId: String(MINECRAFT_MODS_CLASS_ID),
      searchFilter: query, pageSize: String(Math.min(options.limit ?? 10, 50)), index: String(options.offset ?? 0),
    });
    if (options.gameVersions?.[0]) params.set('gameVersion', options.gameVersions[0]);
    const loader = options.loaders?.[0]?.toLowerCase();
    if (loader && LOADER_TYPES[loader]) params.set('modLoaderType', String(LOADER_TYPES[loader]));
    const result = await this.request<CurseForgeResponse<CfMod[]>>('/mods/search', params);
    const hits = await Promise.all(result.data.map(async (raw) => this.toProject(raw)));
    return { hits, totalHits: result.pagination?.totalCount ?? hits.length, offset: options.offset ?? 0, limit: options.limit ?? 10 };
  }

  async getProject(idOrSlug: string): Promise<ModProject | null> {
    const id = await this.resolveId(idOrSlug);
    if (!id) return null;
    const response = await this.request<CurseForgeResponse<CfMod>>(`/mods/${id}`);
    return this.toProject(response.data);
  }

  async getProjects(idsOrSlugs: string[]): Promise<Map<string, ModProject>> {
    const result = new Map<string, ModProject>();
    for (const input of idsOrSlugs) {
      const project = await this.getProject(input);
      if (project) {
        result.set(input, project);
        result.set(project.slug, project);
        result.set(project.sourceId, project);
      }
    }
    return result;
  }

  async getVersions(idOrSlug: string, options: ModVersionOptions = {}): Promise<ModVersion[]> {
    const id = await this.resolveId(idOrSlug);
    if (!id) return [];
    const params = new URLSearchParams({ pageSize: '50', index: '0' });
    if (options.gameVersions?.[0]) params.set('gameVersion', options.gameVersions[0]);
    const loader = options.loaders?.[0]?.toLowerCase();
    if (loader && LOADER_TYPES[loader]) params.set('modLoaderType', String(LOADER_TYPES[loader]));
    const response = await this.request<CurseForgeResponse<CfFile[]>>(`/mods/${id}/files`, params);
    return Promise.all(response.data.map(async (file) => {
      const downloadUrl = file.downloadUrl ?? (await this.request<CurseForgeResponse<string>>(`/mods/${id}/files/${file.id}/download-url`)).data;
      return this.toVersion(file, downloadUrl);
    }));
  }

  async isAvailable(): Promise<boolean> {
    if (!(this.apiKey ?? process.env.CURSEFORGE_API_KEY)) return false;
    try { await this.request<CurseForgeResponse<unknown>>(`/games/${MINECRAFT_GAME_ID}`); return true; }
    catch { return false; }
  }

  getEnvKey(): string { return 'CURSEFORGE_FILES'; }
  formatForEnv(project: ModProject): string { return project.sourceId; }

  private async resolveId(idOrSlug: string): Promise<string | null> {
    if (/^\d+$/.test(idOrSlug)) return idOrSlug;
    const params = new URLSearchParams({ gameId: String(MINECRAFT_GAME_ID), classId: String(MINECRAFT_MODS_CLASS_ID), slug: idOrSlug, pageSize: '1' });
    const result = await this.request<CurseForgeResponse<CfMod[]>>('/mods/search', params);
    return result.data[0] ? String(result.data[0].id) : null;
  }

  private toProject(raw: CfMod): ModProject {
    return {
      slug: raw.slug || String(raw.id), title: raw.name, description: raw.summary ?? '',
      downloads: raw.downloadCount ?? 0, iconUrl: raw.logo?.url ?? null,
      serverSide: 'optional', clientSide: 'optional', projectType: 'mod',
      categories: (raw.categories ?? []).map((category) => category.name),
      author: raw.authors?.[0]?.name ?? 'Unknown', license: 'CurseForge license',
      sourceId: String(raw.id), sourceName: this.sourceName,
    };
  }

  private toVersion(raw: CfFile, downloadUrl: string): ModVersion {
    const loaders = raw.gameVersions.filter((version) => /^(forge|fabric|quilt|neoforge)$/i.test(version));
    const gameVersions = raw.gameVersions.filter((version) => !loaders.includes(version));
    const hashes = raw.hashes ?? [];
    const sha1 = hashes.find((hash) => hash.algo === 1)?.value;
    const md5 = hashes.find((hash) => hash.algo === 2)?.value;
    const dependencies: ModDependency[] = (raw.dependencies ?? []).map((dependency) => ({
      projectId: String(dependency.modId),
      dependencyType: dependency.relationType === 3 ? 'required'
        : dependency.relationType === 5 ? 'incompatible'
          : dependency.relationType === 1 || dependency.relationType === 6 ? 'embedded' : 'optional',
    }));
    const file: ModFile = {
      url: downloadUrl, filename: raw.fileName, size: raw.fileLength,
      hashes: { sha1, md5 }, primary: true,
    };
    return {
      id: String(raw.id), projectId: String(raw.modId), name: raw.displayName,
      versionNumber: raw.displayName, versionType: raw.releaseType === 1 ? 'release' : raw.releaseType === 2 ? 'beta' : 'alpha',
      gameVersions, loaders, files: [file], dependencies, downloads: raw.downloadCount,
      datePublished: raw.fileDate,
    };
  }
}

if (!ModSourceFactory.isSupported('curseforge')) ModSourceFactory.register(new CurseForgeAdapter());

