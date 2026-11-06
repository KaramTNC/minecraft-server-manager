import { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import {
  serverExists,
  AuditActionEnum,
  ModSourceFactory,
  buildModpackCompatibilityMatrix,
  ServerSpecError,
} from '@minecraft-docker/shared';
import '@minecraft-docker/mod-source-modrinth';
import '../../services/CurseForgeAdapter.js';
import { EnvValueError } from '@minecraft-docker/shared/utils';
import { writeAuditLog } from '../../services/audit-log-service.js';
import { createModConfigService } from '../../services/ModConfigService.js';
import { createManagedModService, ManagedModService, ModManagementError } from '../../services/ManagedModService.js';
import { CurseForgeAdapter } from '../../services/CurseForgeAdapter.js';
import { serverSpecFailure } from '../../lib/server-spec.js';
import { ErrorResponseSchema, ServerNameParamsSchema, type ServerNameParams } from '../../schemas/server.js';
import { config } from '../../config/index.js';
import { applyEnvChanges, atomicWriteFileSync } from '@minecraft-docker/shared/utils';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InstalledModEntry } from '../../services/ModConfigService.js';

// ============================================================
// Types
// ============================================================

interface ModListRoute {
  Params: ServerNameParams;
}

interface AddModsRoute {
  Params: ServerNameParams;
  Body: { slugs: string[]; source?: string };
}

interface RemoveModRoute {
  Params: ServerNameParams & { slug: string };
}

interface SearchModsRoute {
  Querystring: { q: string; limit?: number; offset?: number; type?: string; source?: string; serverName?: string };
}

interface GetProjectsRoute {
  Querystring: { slugs: string; source?: string };
}

interface ModVersionsRoute {
  Params: { slug: string };
  Querystring: { source?: string };
}

interface CompatibleModVersionsRoute {
  Params: { slug: string };
  Querystring: { source?: string; serverName: string };
}

interface ModSourcesRoute { }
interface CurseForgeKeyRoute { Body: { apiKey: string } }
interface ManageModRoute {
  Params: ServerNameParams;
  Body: { source: string; projectId: string; versionId: string };
}
interface ModUpdateRoute {
  Params: ServerNameParams;
  Body?: { filenames?: string[] };
}
interface AdoptModsRoute { Params: ServerNameParams }
interface ModStateRoute {
  Params: ServerNameParams & { filename: string };
  Body: { enabled: boolean };
}
interface ModFileRoute { Params: ServerNameParams & { filename: string } }
interface ModConfigFilesRoute { Params: ServerNameParams & { filename: string }; Body: { files: string[] } }

interface ModClientOnlyRoute {
  Params: { slug: string };
  Querystring: { version?: string; source?: string };
}

interface InstalledModsRoute {
  Params: ServerNameParams;
}

interface ToggleModExcludeRoute {
  Params: ServerNameParams & { filename: string };
  Body: { excluded: boolean };
}

// ============================================================
// Plugin Definition
// ============================================================

const modsPlugin: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  const modConfigService = createModConfigService(config.mcctlRoot);
  const managedMods = createManagedModService(config.mcctlRoot);

  fastify.get<ModSourcesRoute>('/api/mods/sources', async (_request, reply) => {
    const sources = await Promise.all(ModSourceFactory.getAllAdapters().map(async (adapter) => ({
      id: adapter.sourceName,
      name: adapter.displayName,
      available: await adapter.isAvailable(),
      requiresApiKey: adapter.sourceName === 'curseforge' && !process.env.CURSEFORGE_API_KEY,
    })));
    return reply.send({ sources });
  });

  fastify.put<CurseForgeKeyRoute>('/api/mods/sources/curseforge-key', {
    schema: { tags: ['mods'], response: { 400: ErrorResponseSchema } },
  }, async (request, reply) => {
    const apiKey = request.body?.apiKey?.trim();
    if (!apiKey || apiKey.length > 256 || /[\r\n\0]/.test(apiKey)) {
      return reply.code(400).send({ error: 'BadRequest', message: 'Enter a valid CurseForge API key.' });
    }
    const envPath = join(config.mcctlRoot, '.env');
    const oldText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
    atomicWriteFileSync(envPath, applyEnvChanges(oldText, { set: { CURSEFORGE_API_KEY: apiKey } }), { mode: 0o600 });
    process.env.CURSEFORGE_API_KEY = apiKey;
    const adapter = ModSourceFactory.getOrNull('curseforge');
    if (adapter instanceof CurseForgeAdapter) adapter.setApiKey(apiKey);
    await writeAuditLog({ action: AuditActionEnum.PLATFORM_SETTINGS_UPDATE, actor: 'api:console', targetType: 'platform', targetName: 'CURSEFORGE_API_KEY', details: { configured: true }, status: 'success' });
    return reply.send({ success: true, configured: true });
  });

  fastify.get<InstalledModsRoute>('/api/servers/:name/mods/compatibility', {
    schema: { tags: ['servers', 'mods'], params: ServerNameParamsSchema, response: { 404: ErrorResponseSchema, 409: ErrorResponseSchema } },
  }, async (request, reply) => {
    if (!serverExists(request.params.name)) return reply.code(404).send({ error: 'NotFound', message: `Server '${request.params.name}' not found` });
    try { return reply.send(managedMods.compatibility(request.params.name)); }
    catch (error) { return reply.code(error instanceof ModManagementError ? error.statusCode : 500).send({ error: 'Conflict', message: (error as Error).message }); }
  });

  fastify.get<CompatibleModVersionsRoute>('/api/mods/:slug/compatible-versions', {
    schema: { tags: ['mods'], response: { 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema, 500: ErrorResponseSchema } },
  }, async (request, reply) => {
    const { slug } = request.params;
    const { serverName, source: sourceName = 'modrinth' } = request.query;
    if (!serverName) return reply.code(400).send({ error: 'BadRequest', message: 'serverName is required.' });
    if (!serverExists(serverName)) return reply.code(404).send({ error: 'NotFound', message: `Server '${serverName}' not found` });
    try {
      const compatibility = managedMods.compatibility(serverName);
      const source = ModSourceFactory.get(sourceName);
      const versions = await source.getVersions(slug, { gameVersions: [compatibility.gameVersion], loaders: [compatibility.loader] });
      return reply.send({ source: source.sourceName, gameVersion: compatibility.gameVersion, loader: compatibility.loader,
        versions: versions.filter((version) => version.gameVersions.some((item) => item.toLowerCase() === compatibility.gameVersion.toLowerCase()) &&
          version.loaders.some((item) => item.toLowerCase() === compatibility.loader.toLowerCase())) });
    } catch (error) {
      const status = error instanceof ModManagementError ? error.statusCode : 500;
      return reply.code(status).send({ error: status === 409 ? 'Conflict' : 'InternalServerError', message: (error as Error).message });
    }
  });

  fastify.post<ManageModRoute>('/api/servers/:name/mods/manage', {
    schema: { tags: ['servers', 'mods'], params: ServerNameParamsSchema, response: { 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema, 422: ErrorResponseSchema, 502: ErrorResponseSchema } },
  }, async (request, reply) => {
    const { name } = request.params;
    if (!serverExists(name)) return reply.code(404).send({ error: 'NotFound', message: `Server '${name}' not found` });
    const { source, projectId, versionId } = request.body ?? {};
    if (!source || !projectId || !versionId) return reply.code(400).send({ error: 'BadRequest', message: 'source, projectId and versionId are required.' });
    try {
      const mod = await managedMods.install(name, source, projectId, versionId);
      await writeAuditLog({ action: AuditActionEnum.MOD_ADD, actor: 'api:console', targetType: 'server', targetName: name, details: { source, projectId, versionId, filename: mod.filename }, status: 'success' });
      return reply.code(201).send({ success: true, mod, restartRequired: true });
    } catch (error) {
      const status = error instanceof ModManagementError ? error.statusCode : 500;
      return reply.code(status).send({ error: status === 404 ? 'NotFound' : status === 409 ? 'Conflict' : status === 422 ? 'UnprocessableEntity' : status === 502 ? 'BadGateway' : 'InternalServerError', message: (error as Error).message });
    }
  });

  fastify.get<InstalledModsRoute>('/api/servers/:name/mods/updates', {
    schema: { tags: ['servers', 'mods'], params: ServerNameParamsSchema, response: { 404: ErrorResponseSchema, 500: ErrorResponseSchema } },
  }, async (request, reply) => {
    if (!serverExists(request.params.name)) return reply.code(404).send({ error: 'NotFound', message: `Server '${request.params.name}' not found` });
    try { return reply.send({ updates: await managedMods.checkUpdates(request.params.name) }); }
    catch (error) { fastify.log.error(error, 'Failed to check mod updates'); return reply.code(500).send({ error: 'InternalServerError', message: (error as Error).message }); }
  });

  fastify.post<AdoptModsRoute>('/api/servers/:name/mods/adopt', {
    schema: { tags: ['servers', 'mods'], params: ServerNameParamsSchema, response: { 404: ErrorResponseSchema, 409: ErrorResponseSchema, 500: ErrorResponseSchema } },
  }, async (request, reply) => {
    const { name } = request.params;
    if (!serverExists(name)) return reply.code(404).send({ error: 'NotFound', message: `Server '${name}' not found` });
    try {
      const result = await managedMods.adoptExisting(name);
      await writeAuditLog({ action: AuditActionEnum.MOD_ADD, actor: 'api:console', targetType: 'server', targetName: name, details: { adoptedCount: result.adopted.length, unrecognizedCount: result.unrecognized.length }, status: 'success' });
      return reply.send(result);
    } catch (error) {
      const status = error instanceof ModManagementError ? error.statusCode : 500;
      return reply.code(status).send({ error: status === 409 ? 'Conflict' : 'InternalServerError', message: (error as Error).message });
    }
  });

  fastify.post<ModUpdateRoute>('/api/servers/:name/mods/update', {
    schema: { tags: ['servers', 'mods'], params: ServerNameParamsSchema, response: { 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema, 422: ErrorResponseSchema, 502: ErrorResponseSchema } },
  }, async (request, reply) => {
    if (!serverExists(request.params.name)) return reply.code(404).send({ error: 'NotFound', message: `Server '${request.params.name}' not found` });
    try { return reply.send({ success: true, ...(await managedMods.update(request.params.name, request.body?.filenames)), restartRequired: true }); }
    catch (error) { const status = error instanceof ModManagementError ? error.statusCode : 500; return reply.code(status).send({ error: status === 404 ? 'NotFound' : status === 409 ? 'Conflict' : status === 422 ? 'UnprocessableEntity' : status === 502 ? 'BadGateway' : 'InternalServerError', message: (error as Error).message }); }
  });

  fastify.patch<ModStateRoute>('/api/servers/:name/mods/installed/:filename/state', {
    schema: { tags: ['servers', 'mods'], params: ServerNameParamsSchema, response: { 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema } },
  }, async (request, reply) => {
    if (!serverExists(request.params.name)) return reply.code(404).send({ error: 'NotFound', message: `Server '${request.params.name}' not found` });
    if (typeof request.body?.enabled !== 'boolean') return reply.code(400).send({ error: 'BadRequest', message: 'enabled must be a boolean.' });
    try { return reply.send({ success: true, mod: managedMods.setEnabled(request.params.name, request.params.filename, request.body.enabled), restartRequired: true }); }
    catch (error) { const status = error instanceof ModManagementError ? error.statusCode : 500; return reply.code(status).send({ error: status === 404 ? 'NotFound' : status === 409 ? 'Conflict' : 'BadRequest', message: (error as Error).message }); }
  });

  fastify.delete<ModFileRoute>('/api/servers/:name/mods/installed/:filename', {
    schema: { tags: ['servers', 'mods'], params: ServerNameParamsSchema, response: { 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema } },
  }, async (request, reply) => {
    if (!serverExists(request.params.name)) return reply.code(404).send({ error: 'NotFound', message: `Server '${request.params.name}' not found` });
    try { managedMods.delete(request.params.name, request.params.filename); return reply.send({ success: true, deleted: request.params.filename, restartRequired: true }); }
    catch (error) { const status = error instanceof ModManagementError ? error.statusCode : 500; return reply.code(status).send({ error: status === 404 ? 'NotFound' : status === 409 ? 'Conflict' : 'BadRequest', message: (error as Error).message }); }
  });

  fastify.get<ModFileRoute>('/api/servers/:name/mods/installed/:filename/configs', {
    schema: { tags: ['servers', 'mods'], params: ServerNameParamsSchema, response: { 404: ErrorResponseSchema } },
  }, async (request, reply) => {
    if (!serverExists(request.params.name)) return reply.code(404).send({ error: 'NotFound', message: `Server '${request.params.name}' not found` });
    try {
      return reply.send(await managedMods.discoverConfigFiles(request.params.name, request.params.filename));
    } catch (error) {
      const status = error instanceof ModManagementError ? error.statusCode : 500;
      return reply.code(status).send({ error: 'InternalServerError', message: (error as Error).message });
    }
  });

  fastify.put<ModConfigFilesRoute>('/api/servers/:name/mods/installed/:filename/configs', {
    schema: { tags: ['servers', 'mods'], params: ServerNameParamsSchema, response: { 400: ErrorResponseSchema, 404: ErrorResponseSchema } },
  }, async (request, reply) => {
    if (!serverExists(request.params.name)) return reply.code(404).send({ error: 'NotFound', message: `Server '${request.params.name}' not found` });
    if (!Array.isArray(request.body?.files) || request.body.files.some((item) => typeof item !== 'string')) {
      return reply.code(400).send({ error: 'BadRequest', message: 'files must be an array of config file paths.' });
    }
    try {
      const files = managedMods.setConfigFiles(request.params.name, request.params.filename, request.body.files);
      return reply.send({ success: true, files });
    } catch (error) {
      const status = error instanceof ModManagementError ? error.statusCode : 500;
      return reply.code(status).send({ error: status === 404 ? 'NotFound' : 'BadRequest', message: (error as Error).message });
    }
  });

  /**
   * GET /api/servers/:name/mods
   * List installed mods from config.env
   */
  fastify.get<ModListRoute>('/api/servers/:name/mods', {
    schema: {
      description: 'List installed mods for a server',
      tags: ['servers', 'mods'],
      params: ServerNameParamsSchema,
      response: {
        404: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
  }, async (request: FastifyRequest<ModListRoute>, reply: FastifyReply) => {
    const { name } = request.params;

    try {
      if (!serverExists(name)) {
        return reply.code(404).send({ error: 'NotFound', message: `Server '${name}' not found` });
      }

      const mods = modConfigService.getInstalledMods(name);
      return reply.send({ mods });
    } catch (error) {
      fastify.log.error(error, 'Failed to list mods');
      return reply.code(500).send({ error: 'InternalServerError', message: 'Failed to list mods' });
    }
  });

  /**
   * POST /api/servers/:name/mods
   * Add mods to server config
   */
  fastify.post<AddModsRoute>('/api/servers/:name/mods', {
    schema: {
      description: 'Add mods to a server',
      tags: ['servers', 'mods'],
      params: ServerNameParamsSchema,
      response: {
        400: ErrorResponseSchema,
        404: ErrorResponseSchema,
        409: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
  }, async (request: FastifyRequest<AddModsRoute>, reply: FastifyReply) => {
    const { name } = request.params;
    const { slugs, source } = request.body;

    try {
      if (!serverExists(name)) {
        return reply.code(404).send({ error: 'NotFound', message: `Server '${name}' not found` });
      }

      if (!slugs || !Array.isArray(slugs) || slugs.length === 0) {
        return reply.code(400).send({ error: 'BadRequest', message: 'slugs array is required and must not be empty' });
      }

      if (!modConfigService.configExists(name)) {
        return reply.code(404).send({ error: 'NotFound', message: `Configuration for server '${name}' not found` });
      }

      const sourceName = source || ModSourceFactory.getDefaultSource();
      const { added, mods } = await modConfigService.addMods(name, slugs, sourceName);

      await writeAuditLog({
        action: AuditActionEnum.MOD_ADD,
        actor: 'api:console',
        targetType: 'server',
        targetName: name,
        details: { slugs: added, source: sourceName },
        status: 'success',
      });

      fastify.log.info({ server: name, added, source: sourceName }, 'Mods added');

      return reply.send({ success: true, added, mods });
    } catch (error) {
      await writeAuditLog({
        action: AuditActionEnum.MOD_ADD,
        actor: 'api:console',
        targetType: 'server',
        targetName: name,
        details: { slugs, source },
        status: 'failure',
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      });
      if (error instanceof EnvValueError) {
        return reply.code(400).send({ error: 'BadRequest', message: error.message });
      }
      if (error instanceof ServerSpecError) {
        const failure = serverSpecFailure(error);
        return reply.code(failure.status).send(failure.body);
      }
      fastify.log.error(error, 'Failed to add mods');
      return reply.code(500).send({ error: 'InternalServerError', message: 'Failed to add mods' });
    }
  });

  /**
   * DELETE /api/servers/:name/mods/:slug
   * Remove a mod from server config
   */
  fastify.delete<RemoveModRoute>('/api/servers/:name/mods/:slug', {
    schema: {
      description: 'Remove a mod from a server',
      tags: ['servers', 'mods'],
      params: ServerNameParamsSchema,
      response: {
        400: ErrorResponseSchema,
        404: ErrorResponseSchema,
        409: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
  }, async (request: FastifyRequest<RemoveModRoute>, reply: FastifyReply) => {
    const { name, slug } = request.params;

    try {
      if (!serverExists(name)) {
        return reply.code(404).send({ error: 'NotFound', message: `Server '${name}' not found` });
      }

      if (!modConfigService.configExists(name)) {
        return reply.code(404).send({ error: 'NotFound', message: `Configuration for server '${name}' not found` });
      }

      const { removed, sourceName } = await modConfigService.removeMod(name, slug);

      if (!removed) {
        return reply.code(404).send({ error: 'NotFound', message: `Mod '${slug}' not found in server configuration` });
      }

      await writeAuditLog({
        action: AuditActionEnum.MOD_REMOVE,
        actor: 'api:console',
        targetType: 'server',
        targetName: name,
        details: { slug, source: sourceName },
        status: 'success',
      });

      fastify.log.info({ server: name, slug, source: sourceName }, 'Mod removed');

      return reply.send({ success: true, removed: slug });
    } catch (error) {
      await writeAuditLog({
        action: AuditActionEnum.MOD_REMOVE,
        actor: 'api:console',
        targetType: 'server',
        targetName: name,
        details: { slug },
        status: 'failure',
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      });
      if (error instanceof ServerSpecError) {
        const failure = serverSpecFailure(error);
        return reply.code(failure.status).send(failure.body);
      }
      fastify.log.error(error, 'Failed to remove mod');
      return reply.code(500).send({ error: 'InternalServerError', message: 'Failed to remove mod' });
    }
  });

  /**
   * GET /api/mods/projects
   * Get project details for multiple slugs (batch)
   */
  fastify.get<GetProjectsRoute>('/api/mods/projects', {
    schema: {
      description: 'Get project details for multiple mod slugs',
      tags: ['mods'],
      response: {
        500: ErrorResponseSchema,
      },
    },
  }, async (request: FastifyRequest<GetProjectsRoute>, reply: FastifyReply) => {
    const { slugs: slugsParam, source: sourceName } = request.query;

    try {
      if (!slugsParam || !slugsParam.trim()) {
        return reply.code(400).send({ error: 'BadRequest', message: 'Query parameter "slugs" is required' });
      }

      const slugs = slugsParam.split(',').map(s => s.trim()).filter(Boolean);
      if (slugs.length === 0) {
        return reply.code(400).send({ error: 'BadRequest', message: 'At least one slug is required' });
      }

      const source = ModSourceFactory.get(sourceName || 'modrinth');

      // Use batch getProjects if available, otherwise fallback to individual getProject
      const projects: Record<string, {
        slug: string;
        title: string;
        description: string;
        downloads: number;
        iconUrl: string | null;
        author: string;
        categories: string[];
        sourceUrl: string;
      } | null> = {};

      if (typeof source.getProjects === 'function') {
        const projectMap = await source.getProjects(slugs);
        for (const slug of slugs) {
          const p = projectMap.get(slug);
          projects[slug] = p ? {
            slug: p.slug,
            title: p.title,
            description: p.description,
            downloads: p.downloads,
            iconUrl: p.iconUrl,
            author: p.author,
            categories: p.categories,
            sourceUrl: source.sourceName === 'curseforge'
              ? `https://www.curseforge.com/minecraft/mc-mods/${p.slug}`
              : `https://modrinth.com/mod/${p.slug}`,
          } : null;
        }
      } else {
        const results = await Promise.all(
          slugs.map(async (slug) => {
            const p = await source.getProject(slug);
            return { slug, project: p };
          })
        );
        for (const { slug, project: p } of results) {
          projects[slug] = p ? {
            slug: p.slug,
            title: p.title,
            description: p.description,
            downloads: p.downloads,
            iconUrl: p.iconUrl,
            author: p.author,
            categories: p.categories,
            sourceUrl: source.sourceName === 'curseforge'
              ? `https://www.curseforge.com/minecraft/mc-mods/${p.slug}`
              : `https://modrinth.com/mod/${p.slug}`,
          } : null;
        }
      }

      return reply.send({ projects });
    } catch (error) {
      fastify.log.error(error, 'Failed to get mod projects');
      return reply.code(500).send({ error: 'InternalServerError', message: 'Failed to get mod projects' });
    }
  });

  /**
   * GET /api/mods/search
   * Search mods through a registered publisher adapter
   */
  fastify.get<SearchModsRoute>('/api/mods/search', {
    schema: {
      description: 'Search for mods on Modrinth',
      tags: ['mods'],
      response: {
        500: ErrorResponseSchema,
      },
    },
  }, async (request: FastifyRequest<SearchModsRoute>, reply: FastifyReply) => {
    const { q, limit, offset, type, source: sourceName = 'modrinth', serverName } = request.query;

    try {
      if (!q || !q.trim()) {
        return reply.code(400).send({ error: 'BadRequest', message: 'Query parameter "q" is required' });
      }

      const source = ModSourceFactory.get(sourceName);
      const compatibility = serverName ? managedMods.compatibility(serverName) : undefined;
      const result = await source.search(q, {
        limit: limit != null ? Number(limit) : 10,
        offset: offset != null ? Number(offset) : 0,
        ...(compatibility ? { gameVersions: [compatibility.gameVersion], loaders: [compatibility.loader] } : {}),
        // Restrict to modpacks when requested (used by Create Server autocomplete)
        ...(type === 'modpack' ? { projectType: 'modpack' as const } : {}),
      });

      return reply.send(result);
    } catch (error) {
      fastify.log.error(error, 'Failed to search mods');
      if (error instanceof ModManagementError) {
        return reply.code(error.statusCode).send({ error: error.statusCode === 400 ? 'BadRequest' : 'Conflict', message: error.message });
      }
      return reply.code(500).send({ error: 'InternalServerError', message: 'Failed to search mods' });
    }
  });

  /**
   * GET /api/mods/:slug/versions
   * Return a loader -> game-version compatibility matrix for a modpack/mod.
   * Used by the Create Server dialog to offer only valid (loader, MC version)
   * combinations and prevent the "No files available" failure.
   */
  fastify.get<ModVersionsRoute>('/api/mods/:slug/versions', {
    schema: {
      description: 'Get loader/Minecraft-version compatibility matrix for a modpack',
      tags: ['mods'],
      response: {
        404: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
  }, async (request: FastifyRequest<ModVersionsRoute>, reply: FastifyReply) => {
    const { slug } = request.params;
    const { source: sourceName } = request.query;

    try {
      if (!slug || !slug.trim()) {
        return reply.code(400).send({ error: 'BadRequest', message: 'Path parameter "slug" is required' });
      }

      const source = ModSourceFactory.get(sourceName || 'modrinth');
      const versions = await source.getVersions(slug);

      if (!versions || versions.length === 0) {
        return reply.code(404).send({
          error: 'NotFound',
          message: `No versions found for modpack '${slug}'`,
        });
      }

      const matrix = buildModpackCompatibilityMatrix(versions);

      return reply.send({ slug, ...matrix });
    } catch (error) {
      fastify.log.error(error, 'Failed to get mod versions');
      return reply.code(500).send({ error: 'InternalServerError', message: 'Failed to get mod versions' });
    }
  });

  /**
   * GET /api/mods/:slug/client-only
   * Detect client-only mods (canonical server_side: unsupported) bundled in a
   * modpack, so the Create Server flow can pre-fill them into the exclude list.
   * Returns 502 on detection failure so the client can simply skip pre-filling.
   */
  fastify.get<ModClientOnlyRoute>('/api/mods/:slug/client-only', {
    schema: {
      description: 'Detect client-only mods bundled in a modpack (to exclude on a server)',
      tags: ['mods'],
      response: {
        400: ErrorResponseSchema,
        502: ErrorResponseSchema,
      },
    },
  }, async (request: FastifyRequest<ModClientOnlyRoute>, reply: FastifyReply) => {
    const { slug } = request.params;
    const { version, source: sourceName } = request.query;

    if (!slug || !slug.trim()) {
      return reply.code(400).send({ error: 'BadRequest', message: 'Path parameter "slug" is required' });
    }

    const source = ModSourceFactory.get(sourceName || 'modrinth');
    if (typeof source.getModpackClientOnlyMods !== 'function') {
      // Source doesn't support modpack inspection — nothing to detect.
      return reply.send({ slug, clientOnly: [] });
    }

    try {
      const clientOnly = await source.getModpackClientOnlyMods(slug, version);
      return reply.send({ slug, clientOnly });
    } catch (error) {
      fastify.log.warn(error, 'Failed to detect client-only modpack mods');
      return reply.code(502).send({
        error: 'BadGateway',
        message: 'Failed to detect client-only mods for this modpack',
      });
    }
  });

  // ============================================================
  // Installed Mod Jar Endpoints (Phase 1 — #523)
  // ============================================================

  /**
   * Safe jar filename pattern: only [A-Za-z0-9._+-] characters, must end with .jar.
   * Rejects: path separators (/\), newlines, spaces, shell metacharacters (; | ` $ & ( ) < > * ? ! # { } [ ] ~ ' ").
   * Mirrors the excludeFiles pattern from #515 server creation schema.
   */
  const SAFE_JAR_FILENAME_RE = /^[A-Za-z0-9._+-]+\.jar$/;

  /**
   * GET /api/servers/:name/mods/installed
   * Scan <data>/mods/*.jar and return list with excluded status
   */
  fastify.get<InstalledModsRoute>('/api/servers/:name/mods/installed', {
    schema: {
      description: 'List installed mod jar files in the server data directory',
      tags: ['servers', 'mods'],
      params: ServerNameParamsSchema,
      response: {
        404: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
  }, async (request: FastifyRequest<InstalledModsRoute>, reply: FastifyReply) => {
    const { name } = request.params;

    try {
      if (!serverExists(name)) {
        return reply.code(404).send({ error: 'NotFound', message: `Server '${name}' not found` });
      }

      const exclusions = new Map(modConfigService.getInstalledModJars(name).map((entry) => [entry.filename, entry.excluded]));
      const mods: InstalledModEntry[] = managedMods.list(name).map((entry) => ({ ...entry, excluded: exclusions.get(entry.filename) ?? false }));
      return reply.send({ mods });
    } catch (error) {
      fastify.log.error(error, 'Failed to list installed mod jars');
      return reply.code(500).send({ error: 'InternalServerError', message: 'Failed to list installed mod jars' });
    }
  });

  /**
   * PATCH /api/servers/:name/mods/installed/:filename/exclude
   * Toggle exclude state of a jar file in MODRINTH_EXCLUDE_FILES or CF_EXCLUDE_MODS
   */
  fastify.patch<ToggleModExcludeRoute>('/api/servers/:name/mods/installed/:filename/exclude', {
    schema: {
      description: 'Toggle exclude state of an installed mod jar',
      tags: ['servers', 'mods'],
      params: ServerNameParamsSchema,
      response: {
        404: ErrorResponseSchema,
        400: ErrorResponseSchema,
        409: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
  }, async (request: FastifyRequest<ToggleModExcludeRoute>, reply: FastifyReply) => {
    const { name, filename } = request.params;
    const { excluded } = request.body ?? {};

    try {
      if (!serverExists(name)) {
        return reply.code(404).send({ error: 'NotFound', message: `Server '${name}' not found` });
      }

      if (typeof excluded !== 'boolean') {
        return reply.code(400).send({ error: 'BadRequest', message: '"excluded" field (boolean) is required' });
      }

      // Security: validate filename against safe pattern before touching config.env
      if (!SAFE_JAR_FILENAME_RE.test(filename)) {
        return reply.code(400).send({
          error: 'BadRequest',
          message: 'Invalid filename: only alphanumeric characters, dots, underscores, hyphens, and plus signs are allowed, and filename must end with .jar',
        });
      }

      // Cross-check: filename must actually exist in the installed jar list
      const installedMods = modConfigService.getInstalledModJars(name);
      const isInstalled = installedMods.some((m) => m.filename === filename);
      if (!isInstalled) {
        return reply.code(404).send({
          error: 'NotFound',
          message: `Jar file '${filename}' is not found in the server's mods directory`,
        });
      }

      const { excludeKey, excludeList } = await modConfigService.toggleModExclude(name, filename, excluded);

      await writeAuditLog({
        action: AuditActionEnum.MOD_ADD,
        actor: 'api:console',
        targetType: 'server',
        targetName: name,
        details: { filename, excluded, excludeKey },
        status: 'success',
      });

      fastify.log.info({ server: name, filename, excluded, excludeKey }, 'Mod exclude toggled');

      return reply.send({
        success: true,
        filename,
        excluded,
        excludeList,
        restartRequired: true,
      });
    } catch (error) {
      if (error instanceof ServerSpecError) {
        const failure = serverSpecFailure(error);
        return reply.code(failure.status).send(failure.body);
      }
      fastify.log.error(error, 'Failed to toggle mod exclude');
      return reply.code(500).send({ error: 'InternalServerError', message: 'Failed to toggle mod exclude' });
    }
  });
};

// ============================================================
// Export
// ============================================================

export default fp(modsPlugin, {
  name: 'server-mods-routes',
  fastify: '5.x',
});

export { modsPlugin };
