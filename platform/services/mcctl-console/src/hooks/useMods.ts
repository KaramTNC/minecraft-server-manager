import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './useApi';
import type {
  ModListResponse,
  AddModsResponse,
  RemoveModResponse,
  ModSearchResponse,
  ModProjectsResponse,
  ModVersionsResponse,
  InstalledModsResponse,
  ToggleModExcludeResponse,
  ModSourcesResponse,
  ModCompatibilityResponse,
  CompatibleModVersionsResponse,
  ModConfigFilesResponse,
  ModUpdatesResponse,
  InstalledModEntry,
} from '@/ports/api/IMcctlApiClient';

// ============================================================
// Server Mods Hooks
// ============================================================

/**
 * Hook to fetch installed mods for a server
 */
export function useServerMods(serverName: string, options?: { enabled?: boolean }) {
  return useQuery<ModListResponse, Error>({
    queryKey: ['servers', serverName, 'mods'],
    queryFn: () =>
      apiFetch<ModListResponse>(`/api/servers/${encodeURIComponent(serverName)}/mods`),
    enabled: options?.enabled !== false && !!serverName,
  });
}

/**
 * Hook to search mods on Modrinth
 */
export function useModSearch(
  query: string,
  options?: { limit?: number; offset?: number; enabled?: boolean; source?: string; serverName?: string }
) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  if (options?.source) params.set('source', options.source);
  if (options?.serverName) params.set('serverName', options.serverName);

  return useQuery<ModSearchResponse, Error>({
    queryKey: ['mods', 'search', query, options?.limit, options?.offset, options?.source, options?.serverName],
    queryFn: () => apiFetch<ModSearchResponse>(`/api/mods/search?${params}`),
    enabled: options?.enabled !== false && !!query.trim(),
  });
}

const mcctlPath = (path: string) => `/api/mcctl/${path.replace(/^\/+/, '')}`;

export function useModSources() {
  return useQuery<ModSourcesResponse, Error>({
    queryKey: ['mods', 'sources'],
    queryFn: () => apiFetch<ModSourcesResponse>(mcctlPath('mods/sources')),
    staleTime: 60_000,
  });
}

export function useSaveCurseForgeApiKey() {
  const queryClient = useQueryClient();
  return useMutation<{ success: boolean; configured: boolean }, Error, { apiKey: string }>({
    mutationFn: ({ apiKey }) => apiFetch(mcctlPath('mods/sources/curseforge-key'), {
      method: 'PUT', body: JSON.stringify({ apiKey }),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['mods', 'sources'] }),
  });
}

export function useModCompatibility(serverName: string) {
  return useQuery<ModCompatibilityResponse, Error>({
    queryKey: ['servers', serverName, 'mods', 'compatibility'],
    queryFn: () => apiFetch<ModCompatibilityResponse>(mcctlPath(`servers/${encodeURIComponent(serverName)}/mods/compatibility`)),
    enabled: !!serverName,
  });
}

export function useCompatibleModVersions(slug: string, source: string, serverName: string, enabled = true) {
  const params = new URLSearchParams({ source, serverName });
  return useQuery<CompatibleModVersionsResponse, Error>({
    queryKey: ['mods', 'compatible-versions', source, slug, serverName],
    queryFn: () => apiFetch<CompatibleModVersionsResponse>(mcctlPath(`mods/${encodeURIComponent(slug)}/compatible-versions?${params}`)),
    enabled: enabled && !!slug && !!serverName,
    staleTime: 60_000,
  });
}

export function useInstallManagedMod() {
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, { serverName: string; source: string; projectId: string; versionId: string }>({
    mutationFn: ({ serverName, source, projectId, versionId }) =>
      apiFetch(mcctlPath(`servers/${encodeURIComponent(serverName)}/mods/manage`), {
        method: 'POST', body: JSON.stringify({ source, projectId, versionId }),
      }),
    onSuccess: (_, { serverName }) => {
      queryClient.invalidateQueries({ queryKey: ['servers', serverName, 'mods'] });
      queryClient.invalidateQueries({ queryKey: ['servers', serverName, 'mods', 'installed'] });
      queryClient.invalidateQueries({ queryKey: ['servers', serverName, 'mods', 'updates'] });
    },
  });
}

export function useAdoptExistingMods() {
  const queryClient = useQueryClient();
  return useMutation<{ adopted: InstalledModEntry[]; unrecognized: string[] }, Error, { serverName: string }>({
    mutationFn: ({ serverName }) => apiFetch(mcctlPath(`servers/${encodeURIComponent(serverName)}/mods/adopt`), { method: 'POST' }),
    onSuccess: (_, { serverName }) => {
      queryClient.invalidateQueries({ queryKey: ['servers', serverName, 'mods', 'installed'] });
      queryClient.invalidateQueries({ queryKey: ['servers', serverName, 'mods', 'updates'] });
    },
  });
}

export function useManagedModUpdates(serverName: string) {
  return useQuery<ModUpdatesResponse, Error>({
    queryKey: ['servers', serverName, 'mods', 'updates'],
    queryFn: () => apiFetch<ModUpdatesResponse>(mcctlPath(`servers/${encodeURIComponent(serverName)}/mods/updates`)),
    enabled: !!serverName,
    staleTime: 60_000,
  });
}

export function useUpdateManagedMods() {
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, { serverName: string; filenames?: string[] }>({
    mutationFn: ({ serverName, filenames }) =>
      apiFetch(mcctlPath(`servers/${encodeURIComponent(serverName)}/mods/update`), {
        method: 'POST', body: JSON.stringify({ filenames }),
      }),
    onSuccess: (_, { serverName }) => {
      queryClient.invalidateQueries({ queryKey: ['servers', serverName, 'mods', 'installed'] });
      queryClient.invalidateQueries({ queryKey: ['servers', serverName, 'mods', 'updates'] });
    },
  });
}

export function useSetManagedModEnabled() {
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, { serverName: string; filename: string; enabled: boolean }>({
    mutationFn: ({ serverName, filename, enabled }) =>
      apiFetch(mcctlPath(`servers/${encodeURIComponent(serverName)}/mods/installed/${encodeURIComponent(filename)}/state`), {
        method: 'PATCH', body: JSON.stringify({ enabled }),
      }),
    onSuccess: (_, { serverName }) => queryClient.invalidateQueries({ queryKey: ['servers', serverName, 'mods', 'installed'] }),
  });
}

export function useDeleteManagedMod() {
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, { serverName: string; filename: string }>({
    mutationFn: ({ serverName, filename }) =>
      apiFetch(mcctlPath(`servers/${encodeURIComponent(serverName)}/mods/installed/${encodeURIComponent(filename)}`), { method: 'DELETE' }),
    onSuccess: (_, { serverName }) => {
      queryClient.invalidateQueries({ queryKey: ['servers', serverName, 'mods', 'installed'] });
      queryClient.invalidateQueries({ queryKey: ['servers', serverName, 'mods', 'updates'] });
    },
  });
}

export function useModConfigFiles(serverName: string, filename: string | null) {
  return useQuery<ModConfigFilesResponse, Error>({
    queryKey: ['servers', serverName, 'mods', filename, 'configs'],
    queryFn: () => apiFetch<ModConfigFilesResponse>(mcctlPath(`servers/${encodeURIComponent(serverName)}/mods/installed/${encodeURIComponent(filename!)}/configs`)),
    enabled: !!serverName && !!filename,
  });
}

export function useSaveModConfigFiles() {
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, { serverName: string; filename: string; files: string[] }>({
    mutationFn: ({ serverName, filename, files }) =>
      apiFetch(mcctlPath(`servers/${encodeURIComponent(serverName)}/mods/installed/${encodeURIComponent(filename)}/configs`), {
        method: 'PUT', body: JSON.stringify({ files }),
      }),
    onSuccess: (_, { serverName, filename }) => queryClient.invalidateQueries({ queryKey: ['servers', serverName, 'mods', filename, 'configs'] }),
  });
}

/**
 * Hook to search modpacks on Modrinth (project_type=modpack).
 * Used by the Create Server dialog autocomplete.
 */
export function useModpackSearch(
  query: string,
  options?: { limit?: number; enabled?: boolean }
) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  params.set('type', 'modpack');
  if (options?.limit != null) params.set('limit', String(options.limit));

  return useQuery<ModSearchResponse, Error>({
    queryKey: ['mods', 'search', 'modpack', query, options?.limit],
    queryFn: () => apiFetch<ModSearchResponse>(`/api/mods/search?${params}`),
    enabled: options?.enabled !== false && !!query.trim(),
    staleTime: 60 * 1000,
  });
}

/**
 * Hook to fetch the loader/Minecraft-version compatibility matrix for a modpack.
 */
export function useModVersions(
  slug: string,
  options?: { source?: string; enabled?: boolean }
) {
  const params = new URLSearchParams();
  if (options?.source) params.set('source', options.source);
  const qs = params.toString();

  return useQuery<ModVersionsResponse, Error>({
    queryKey: ['mods', slug, 'versions', options?.source],
    queryFn: () =>
      apiFetch<ModVersionsResponse>(
        `/api/mods/${encodeURIComponent(slug)}/versions${qs ? `?${qs}` : ''}`
      ),
    enabled: options?.enabled !== false && !!slug.trim(),
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    retry: false,
  });
}

/**
 * Hook to fetch project details for installed mods (batch)
 */
export function useModProjects(
  slugs: string[],
  options?: { source?: string; enabled?: boolean }
) {
  const slugsKey = slugs.slice().sort().join(',');
  const params = new URLSearchParams();
  if (slugsKey) params.set('slugs', slugsKey);
  if (options?.source) params.set('source', options.source);

  return useQuery<ModProjectsResponse, Error>({
    queryKey: ['mods', 'projects', slugsKey, options?.source],
    queryFn: () => apiFetch<ModProjectsResponse>(`/api/mods/projects?${params}`),
    enabled: options?.enabled !== false && slugs.length > 0,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
}

/**
 * Hook to add mods to a server
 */
export function useAddMod() {
  const queryClient = useQueryClient();

  return useMutation<
    AddModsResponse,
    Error,
    { serverName: string; slugs: string[]; source?: string }
  >({
    mutationFn: ({ serverName, slugs, source }) =>
      apiFetch<AddModsResponse>(
        `/api/servers/${encodeURIComponent(serverName)}/mods`,
        {
          method: 'POST',
          body: JSON.stringify({ slugs, source }),
        }
      ),
    onSuccess: (_, { serverName }) => {
      queryClient.invalidateQueries({ queryKey: ['servers', serverName, 'mods'] });
    },
  });
}

/**
 * Hook to remove a mod from a server
 */
export function useRemoveMod() {
  const queryClient = useQueryClient();

  return useMutation<RemoveModResponse, Error, { serverName: string; slug: string }>({
    mutationFn: ({ serverName, slug }) =>
      apiFetch<RemoveModResponse>(
        `/api/servers/${encodeURIComponent(serverName)}/mods/${encodeURIComponent(slug)}`,
        { method: 'DELETE' }
      ),
    onSuccess: (_, { serverName }) => {
      queryClient.invalidateQueries({ queryKey: ['servers', serverName, 'mods'] });
    },
  });
}

// ============================================================
// Modpack client-only detection (#524)
// ============================================================

/** Response of GET /api/mods/:slug/client-only */
export interface ModpackClientOnlyResponse {
  slug: string;
  clientOnly: string[];
}

/**
 * Hook to detect client-only mods bundled in a modpack, so the Create Server
 * dialog can pre-fill them into the exclude list. Fails quietly (no retry) — a
 * detection failure simply means no suggestions.
 */
export function useModpackClientOnly(
  slug: string,
  version?: string,
  options?: { enabled?: boolean; source?: string }
) {
  const params = new URLSearchParams();
  if (version) params.set('version', version);
  if (options?.source) params.set('source', options.source);
  const qs = params.toString();

  return useQuery<ModpackClientOnlyResponse, Error>({
    queryKey: ['mods', slug, 'client-only', version, options?.source],
    queryFn: () =>
      apiFetch<ModpackClientOnlyResponse>(
        `/api/mods/${encodeURIComponent(slug)}/client-only${qs ? `?${qs}` : ''}`
      ),
    enabled: options?.enabled !== false && !!slug.trim(),
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    retry: false,
  });
}

// ============================================================
// Installed Mod Jar Hooks (Phase 1 — #523)
// ============================================================

/**
 * Hook to fetch installed mod jar files from server data/mods directory
 */
export function useInstalledMods(serverName: string, options?: { enabled?: boolean }) {
  return useQuery<InstalledModsResponse, Error>({
    queryKey: ['servers', serverName, 'mods', 'installed'],
    queryFn: () =>
      apiFetch<InstalledModsResponse>(mcctlPath(`servers/${encodeURIComponent(serverName)}/mods/installed`)),
    enabled: options?.enabled !== false && !!serverName,
  });
}

/**
 * Hook to toggle exclude state of an installed mod jar
 */
export function useToggleModExclude() {
  const queryClient = useQueryClient();

  return useMutation<
    ToggleModExcludeResponse,
    Error,
    { serverName: string; filename: string; excluded: boolean }
  >({
    mutationFn: ({ serverName, filename, excluded }) =>
      apiFetch<ToggleModExcludeResponse>(
        mcctlPath(`servers/${encodeURIComponent(serverName)}/mods/installed/${encodeURIComponent(filename)}/exclude`),
        {
          method: 'PATCH',
          body: JSON.stringify({ excluded }),
        }
      ),
    onSuccess: (_, { serverName }) => {
      queryClient.invalidateQueries({
        queryKey: ['servers', serverName, 'mods', 'installed'],
      });
    },
  });
}
