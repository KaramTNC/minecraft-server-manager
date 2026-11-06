import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { parseEnvDocument } from '@minecraft-docker/shared/utils';
import { ModSourceFactory, type ModFile, type ModProject, type ModVersion } from '@minecraft-docker/shared';

const MAX_MOD_BYTES = 100 * 1024 * 1024;
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}\.jar$/i;
const LOCK_FILE = '.mcctl-mods.json';

export interface ServerModCompatibility {
  gameVersion: string;
  loader: string;
}

export interface ManagedModRecord {
  source: string;
  projectId: string;
  slug: string;
  title: string;
  versionId: string;
  version: string;
  filename: string;
  sha1: string;
  enabled: boolean;
  installedAt: string;
  configFiles?: string[];
}

export interface InstalledModFile extends ManagedModRecord {
  managed: boolean;
  enabled: boolean;
  excluded: boolean;
}

interface LockDocument { schemaVersion: 1; mods: ManagedModRecord[] }
interface PreparedMod { record: ManagedModRecord; bytes: Buffer; previous?: ManagedModRecord }

export class ModManagementError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 409 | 422 | 502) {
    super(message);
    this.name = 'ModManagementError';
  }
}

/** Exact-file mod installer. Every download is compatibility checked and hash verified before it reaches mods/. */
export class ManagedModService {
  constructor(private readonly root: string) {}

  compatibility(serverName: string): ServerModCompatibility {
    const configPath = join(this.root, 'servers', serverName, 'config.env');
    if (!existsSync(configPath)) throw new ModManagementError(`Configuration for '${serverName}' was not found.`, 404);
    const env = parseEnvDocument(readFileSync(configPath, 'utf8')).values;
    const gameVersion = (env.get('VERSION') ?? '').trim();
    const serverType = (env.get('TYPE') ?? '').trim().toUpperCase();
    const loader = (env.get('MOD_LOADER') ?? env.get('LOADER') ?? serverType).trim().toLowerCase();
    if (!gameVersion || /^(latest|snapshot|release)$/i.test(gameVersion)) {
      throw new ModManagementError('Pin VERSION to an exact Minecraft version before managing individual mods.', 409);
    }
    if (!['fabric', 'quilt', 'forge', 'neoforge'].includes(loader)) {
      throw new ModManagementError(`Individual mod files require a Fabric, Quilt, Forge, or NeoForge server. This server uses '${serverType || 'unknown'}'.`, 409);
    }
    return { gameVersion, loader };
  }

  list(serverName: string): InstalledModFile[] {
    const dataDir = this.dataDir(serverName);
    const modsDir = join(dataDir, 'mods');
    const disabledDir = join(dataDir, 'mods-disabled');
    const records = this.readLock(serverName).mods;
    const byFilename = new Map(records.map((record) => [record.filename, record]));
    const files: InstalledModFile[] = [];
    for (const [directory, enabled] of [[modsDir, true], [disabledDir, false]] as const) {
      if (!existsSync(directory)) continue;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jar')) continue;
        const record = byFilename.get(entry.name);
        files.push({
          ...(record ?? { source: '', projectId: '', slug: '', title: entry.name, versionId: '', version: '', filename: entry.name, sha1: '', installedAt: '' }),
          managed: !!record?.source,
          enabled,
          excluded: false,
        });
      }
    }
    return files.sort((a, b) => a.title.localeCompare(b.title));
  }

  async install(serverName: string, sourceName: string, projectId: string, versionId: string): Promise<ManagedModRecord> {
    const compatibility = this.compatibility(serverName);
    const existing = this.readLock(serverName).mods;
    if (existing.some((mod) => mod.source === sourceName && mod.projectId === projectId)) {
      throw new ModManagementError('This project is already managed on the server.', 409);
    }
    const plan = await this.resolveInstallPlan(sourceName, projectId, versionId, compatibility, existing);
    const filenames = new Set<string>();
    const modsDir = join(this.dataDir(serverName), 'mods');
    const disabledDir = join(this.dataDir(serverName), 'mods-disabled');
    mkdirSync(modsDir, { recursive: true });
    for (const item of plan) {
      const filename = this.safeFilename(item.file.filename);
      if (filenames.has(filename.toLowerCase()) || existsSync(join(modsDir, filename)) || existsSync(join(disabledDir, filename))) {
        throw new ModManagementError(`A mod file named '${filename}' already exists. Remove or rename it before installing this version.`, 409);
      }
      filenames.add(filename.toLowerCase());
    }
    const records = plan.map(({ project, version, file, bytes, sha1 }) => ({
      source: sourceName, projectId: project.sourceId, slug: project.slug, title: project.title,
      versionId: version.id, version: version.versionNumber, filename: this.safeFilename(file.filename),
      sha1, enabled: true, installedAt: new Date().toISOString(),
    } satisfies ManagedModRecord));
    const written: string[] = [];
    try {
      for (const item of plan) {
        const filename = this.safeFilename(item.file.filename);
        this.writeArtifact(modsDir, filename, item.bytes);
        written.push(filename);
      }
      this.writeLock(serverName, [...existing, ...records]);
    } catch (error) {
      for (const filename of written) rmSync(join(modsDir, filename), { force: true });
      throw error;
    }
    return records[0]!;
  }

  setEnabled(serverName: string, filename: string, enabled: boolean): InstalledModFile {
    this.assertFilename(filename);
    const dataDir = this.dataDir(serverName);
    const modsDir = join(dataDir, 'mods');
    const disabledDir = join(dataDir, 'mods-disabled');
    const source = join(enabled ? disabledDir : modsDir, filename);
    const target = join(enabled ? modsDir : disabledDir, filename);
    if (!existsSync(source)) throw new ModManagementError(`Mod '${filename}' was not found in the ${enabled ? 'disabled' : 'enabled'} mods folder.`, 404);
    mkdirSync(enabled ? modsDir : disabledDir, { recursive: true });
    if (existsSync(target)) throw new ModManagementError(`Cannot change '${filename}' state: another file already exists at the destination.`, 409);
    renameSync(source, target);
    try {
      const lock = this.readLock(serverName);
      const updated = lock.mods.map((mod) => mod.filename === filename ? { ...mod, enabled } : mod);
      this.writeLock(serverName, updated);
    } catch (error) {
      renameSync(target, source);
      throw error;
    }
    return this.list(serverName).find((mod) => mod.filename === filename)!;
  }

  delete(serverName: string, filename: string): void {
    this.assertFilename(filename);
    const dataDir = this.dataDir(serverName);
    const paths = [join(dataDir, 'mods', filename), join(dataDir, 'mods-disabled', filename)];
    const target = paths.find((path) => existsSync(path));
    if (!target) throw new ModManagementError(`Mod '${filename}' was not found.`, 404);
    const quarantine = join(this.dataDir(serverName), `.mcctl-delete-${randomUUID()}`);
    renameSync(target, quarantine);
    try {
      this.writeLock(serverName, this.readLock(serverName).mods.filter((mod) => mod.filename !== filename));
      rmSync(quarantine, { force: true });
    } catch (error) {
      if (existsSync(quarantine)) renameSync(quarantine, target);
      throw error;
    }
  }

  listConfigFiles(serverName: string): string[] {
    const configDir = join(this.dataDir(serverName), 'config');
    if (!existsSync(configDir)) return [];
    const allowed = /\.(json|toml|cfg|conf|properties|ya?ml|ini|txt)$/i;
    const results: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 8 || results.length >= 2000) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        const absolute = join(dir, entry.name);
        if (entry.isDirectory()) walk(absolute, depth + 1);
        else if (entry.isFile() && allowed.test(entry.name) && statSync(absolute).size <= 5 * 1024 * 1024) {
          results.push(relative(this.dataDir(serverName), absolute).split('\\').join('/'));
        }
      }
    };
    walk(configDir, 0);
    return results.sort((a, b) => a.localeCompare(b));
  }

  setConfigFiles(serverName: string, filename: string, configFiles: string[]): string[] {
    this.assertFilename(filename);
    const installed = this.list(serverName).find((mod) => mod.filename === filename);
    if (!installed) throw new ModManagementError(`Mod '${filename}' was not found.`, 404);
    const available = new Set(this.listConfigFiles(serverName));
    const unique = [...new Set(configFiles)];
    if (unique.some((path) => !available.has(path))) throw new ModManagementError('Choose config files from this server\'s config directory.', 400);
    const records = this.readLock(serverName).mods;
    const existing = records.find((record) => record.filename === filename);
    const record: ManagedModRecord = existing ?? {
      source: '', projectId: '', slug: '', title: filename, versionId: '', version: '',
      filename, sha1: '', enabled: installed.enabled, installedAt: '',
    };
    const next = existing
      ? records.map((item) => item.filename === filename ? { ...item, configFiles: unique } : item)
      : [...records, { ...record, configFiles: unique }];
    this.writeLock(serverName, next);
    return unique;
  }

  async adoptExisting(serverName: string): Promise<{ adopted: ManagedModRecord[]; unrecognized: string[] }> {
    const compatibility = this.compatibility(serverName);
    const adapter = ModSourceFactory.get('modrinth');
    if (!adapter.findByFileHash) throw new ModManagementError('Modrinth does not support hash matching in this build.', 409);
    const existing = this.readLock(serverName).mods;
    const adopted: ManagedModRecord[] = [];
    const unrecognized: string[] = [];
    for (const file of this.list(serverName).filter((item) => !item.managed)) {
      const path = join(this.dataDir(serverName), file.enabled ? 'mods' : 'mods-disabled', file.filename);
      const hash = createHash('sha1').update(readFileSync(path)).digest('hex');
      const match = await adapter.findByFileHash(hash, 'sha1');
      const matchedFile = match?.version.files.find((candidate) => candidate.hashes.sha1?.toLowerCase() === hash);
      if (!match || !matchedFile || !this.isCompatible(match.version, compatibility)) {
        unrecognized.push(file.filename);
        continue;
      }
      adopted.push({
        source: 'modrinth', projectId: match.project.sourceId, slug: match.project.slug,
        title: match.project.title, versionId: match.version.id, version: match.version.versionNumber,
        filename: file.filename, sha1: hash, enabled: file.enabled, installedAt: '',
      });
    }
    if (adopted.length) this.writeLock(serverName, [...existing, ...adopted]);
    return { adopted, unrecognized };
  }

  async update(serverName: string, filenames?: string[]): Promise<{ updated: ManagedModRecord[]; unchanged: string[] }> {
    const compatibility = this.compatibility(serverName);
    const lock = this.readLock(serverName);
    const selected = filenames ? new Set(filenames) : undefined;
    const current = lock.mods.filter((mod) => mod.source && (!selected || selected.has(mod.filename)));
    if (selected && [...selected].some((filename) => !current.some((mod) => mod.filename === filename))) {
      throw new ModManagementError('Updates are available only for mods installed through the mod manager.', 404);
    }
    const prepared: PreparedMod[] = [];
    const unchanged: string[] = [];
    for (const previous of current) {
      const adapter = ModSourceFactory.get(previous.source);
      const versions = await adapter.getVersions(previous.projectId, { gameVersions: [compatibility.gameVersion], loaders: [compatibility.loader] });
      const nextVersion = this.latestCompatible(versions, compatibility);
      if (!nextVersion || nextVersion.id === previous.versionId) { unchanged.push(previous.filename); continue; }
      const file = this.primaryJar(nextVersion);
      const bytes = await this.downloadAndVerify(adapter.sourceName, file);
      const sha1 = createHash('sha1').update(bytes).digest('hex');
      prepared.push({
        previous,
        bytes,
        record: {
          ...previous, versionId: nextVersion.id, version: nextVersion.versionNumber,
          filename: this.safeFilename(file.filename), sha1, installedAt: new Date().toISOString(),
        },
      });
    }
    if (prepared.length === 0) return { updated: [], unchanged };
    this.commitUpdates(serverName, lock.mods, prepared);
    return { updated: prepared.map((item) => item.record), unchanged };
  }

  async checkUpdates(serverName: string): Promise<Array<{ filename: string; currentVersion: string; latestVersion: string | null; updateAvailable: boolean }>> {
    const compatibility = this.compatibility(serverName);
    return Promise.all(this.readLock(serverName).mods.filter((mod) => mod.source).map(async (mod) => {
      const adapter = ModSourceFactory.get(mod.source);
      const versions = await adapter.getVersions(mod.projectId, { gameVersions: [compatibility.gameVersion], loaders: [compatibility.loader] });
      const latest = this.latestCompatible(versions, compatibility);
      return {
        filename: mod.filename, currentVersion: mod.version,
        latestVersion: latest?.versionNumber ?? null,
        updateAvailable: !!latest && latest.id !== mod.versionId,
      };
    }));
  }

  private async prepare(sourceName: string, projectId: string, versionId: string, compatibility: ServerModCompatibility) {
    const adapter = ModSourceFactory.get(sourceName);
    const project = await adapter.getProject(projectId);
    if (!project) throw new ModManagementError(`Project '${projectId}' was not found on ${adapter.displayName}.`, 404);
    const versions = await adapter.getVersions(projectId, { gameVersions: [compatibility.gameVersion], loaders: [compatibility.loader] });
    const version = versions.find((candidate) => candidate.id === versionId);
    if (!version || !this.isCompatible(version, compatibility)) {
      throw new ModManagementError(`The selected ${adapter.displayName} file is not verified for Minecraft ${compatibility.gameVersion} on ${compatibility.loader}.`, 422);
    }
    const file = this.primaryJar(version);
    const bytes = await this.downloadAndVerify(sourceName, file);
    return { project, version, file, bytes, sha1: createHash('sha1').update(bytes).digest('hex') };
  }

  private async resolveInstallPlan(
    sourceName: string,
    projectId: string,
    versionId: string,
    compatibility: ServerModCompatibility,
    installed: ManagedModRecord[],
  ) {
    const plan: Array<Awaited<ReturnType<ManagedModService['prepare']>>> = [];
    const planned = new Set<string>();
    const pending = [{ projectId, versionId }];
    const isPresent = (id: string) => installed.some((mod) => mod.source === sourceName && mod.projectId === id) || planned.has(`${sourceName}:${id}`);
    while (pending.length) {
      const item = pending.shift()!;
      const key = `${sourceName}:${item.projectId}`;
      if (isPresent(item.projectId)) continue;
      const prepared = await this.prepare(sourceName, item.projectId, item.versionId, compatibility);
      planned.add(key);
      plan.push(prepared);
      for (const dependency of prepared.version.dependencies) {
        if (dependency.dependencyType === 'incompatible') {
          if (isPresent(dependency.projectId)) throw new ModManagementError(`${prepared.project.title} is incompatible with an already installed dependency.`, 409);
          continue;
        }
        if (dependency.dependencyType === 'required' && !isPresent(dependency.projectId)) {
          const dependencyAdapter = ModSourceFactory.get(sourceName);
          const versions = await dependencyAdapter.getVersions(dependency.projectId, {
            gameVersions: [compatibility.gameVersion], loaders: [compatibility.loader],
          });
          const compatible = versions.filter((version) => this.isCompatible(version, compatibility));
          const selected = dependency.versionId
            ? compatible.find((version) => version.id === dependency.versionId)
            : compatible.find((version) => version.versionType === 'release') ?? compatible[0];
          if (!selected) throw new ModManagementError(`Required dependency '${dependency.projectId}' has no version compatible with Minecraft ${compatibility.gameVersion} on ${compatibility.loader}.`, 422);
          pending.push({ projectId: dependency.projectId, versionId: selected.id });
        }
      }
    }
    return plan;
  }

  private isCompatible(version: ModVersion, compatibility: ServerModCompatibility): boolean {
    return version.gameVersions.some((item) => item.toLowerCase() === compatibility.gameVersion.toLowerCase()) &&
      version.loaders.some((item) => item.toLowerCase() === compatibility.loader.toLowerCase());
  }

  private latestCompatible(versions: ModVersion[], compatibility: ServerModCompatibility): ModVersion | null {
    const compatible = versions.filter((version) => this.isCompatible(version, compatibility));
    const releases = compatible.filter((version) => version.versionType === 'release');
    const candidates = releases.length ? releases : compatible;
    return candidates.sort((a, b) => Date.parse(b.datePublished) - Date.parse(a.datePublished))[0] ?? null;
  }

  private primaryJar(version: ModVersion): ModFile {
    const file = version.files.find((candidate) => candidate.primary && candidate.filename.toLowerCase().endsWith('.jar')) ??
      version.files.find((candidate) => candidate.filename.toLowerCase().endsWith('.jar'));
    if (!file) throw new ModManagementError('The selected version does not contain a downloadable server JAR.', 422);
    this.safeFilename(file.filename);
    return file;
  }

  private async downloadAndVerify(source: string, file: ModFile): Promise<Buffer> {
    let url: URL;
    try { url = new URL(file.url); } catch { throw new ModManagementError('The mod source returned an invalid download URL.', 422); }
    if (url.protocol !== 'https:' || !this.isTrustedHost(source, url.hostname)) {
      throw new ModManagementError('The mod source returned an untrusted download host.', 422);
    }
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(45_000) });
    if (!response.ok) throw new ModManagementError(`Mod download failed: ${response.status} ${response.statusText}.`, 502);
    const declaredLength = Number(response.headers.get('content-length') ?? file.size);
    if (declaredLength > MAX_MOD_BYTES) throw new ModManagementError('Mod file exceeds the 100 MB safety limit.', 422);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_MOD_BYTES || (file.size > 0 && bytes.length !== file.size)) {
      throw new ModManagementError('Downloaded file size does not match the publisher metadata.', 422);
    }
    const expected = file.hashes.sha512 ?? file.hashes.sha1;
    const algorithm = file.hashes.sha512 ? 'sha512' : 'sha1';
    if (!expected || !/^[a-f0-9]+$/i.test(expected)) throw new ModManagementError('The publisher did not provide a supported checksum; refusing an unverifiable download.', 422);
    const actual = createHash(algorithm).update(bytes).digest('hex');
    const left = Buffer.from(actual.toLowerCase());
    const right = Buffer.from(expected.toLowerCase());
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw new ModManagementError('The downloaded file failed publisher checksum verification.', 422);
    return bytes;
  }

  private isTrustedHost(source: string, hostname: string): boolean {
    const host = hostname.toLowerCase();
    if (source === 'modrinth') return host === 'cdn.modrinth.com';
    if (source === 'curseforge') return host === 'mediafilez.forgecdn.net' || host === 'edge.forgecdn.net' || host.endsWith('.forgecdn.net');
    return false;
  }

  private commitUpdates(serverName: string, allRecords: ManagedModRecord[], prepared: PreparedMod[]): void {
    const dataDir = this.dataDir(serverName);
    const stageDir = join(dataDir, '.mcctl-staging');
    const modsDir = join(dataDir, 'mods');
    const disabledDir = join(dataDir, 'mods-disabled');
    mkdirSync(stageDir, { recursive: true });
    const occupied = new Set(this.list(serverName).filter((mod) => !prepared.some((item) => item.previous?.filename === mod.filename)).map((mod) => mod.filename.toLowerCase()));
    for (const item of prepared) {
      const key = item.record.filename.toLowerCase();
      if (occupied.has(key)) throw new ModManagementError(`Update filename '${item.record.filename}' conflicts with another installed mod.`, 409);
      occupied.add(key);
    }
    const id = randomUUID();
    const staged = prepared.map((item, index) => {
      const path = join(stageDir, `${id}-${index}.jar`);
      writeFileSync(path, item.bytes, { flag: 'wx', mode: 0o600 });
      return { ...item, stage: path, backup: join(stageDir, `${id}-${index}.bak`), destination: join(item.previous?.enabled ? modsDir : disabledDir, item.record.filename) };
    });
    const moved: typeof staged = [];
    try {
      for (const item of staged) {
        const oldPath = join(item.previous?.enabled ? modsDir : disabledDir, item.previous!.filename);
        if (!existsSync(oldPath)) throw new ModManagementError(`Installed mod '${item.previous!.filename}' is missing; update was not applied.`, 409);
        renameSync(oldPath, item.backup);
        try { renameSync(item.stage, item.destination); }
        catch (error) { renameSync(item.backup, oldPath); throw error; }
        moved.push(item);
      }
      const replaced = new Map(prepared.map((item) => [item.previous!.filename, item.record]));
      this.writeLock(serverName, allRecords.map((record) => replaced.get(record.filename) ?? record));
      for (const item of moved) rmSync(item.backup, { force: true });
    } catch (error) {
      for (const item of moved.reverse()) {
        rmSync(item.destination, { force: true });
        const oldPath = join(item.previous?.enabled ? modsDir : disabledDir, item.previous!.filename);
        if (existsSync(item.backup)) renameSync(item.backup, oldPath);
      }
      throw error;
    } finally {
      rmSync(stageDir, { recursive: true, force: true });
    }
  }

  private writeArtifact(modsDir: string, filename: string, bytes: Buffer): void {
    const temporary = join(modsDir, `.${randomUUID()}.download`);
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o644 });
    try { renameSync(temporary, join(modsDir, filename)); }
    catch (error) { rmSync(temporary, { force: true }); throw error; }
  }

  private readLock(serverName: string): LockDocument {
    const file = join(this.dataDir(serverName), LOCK_FILE);
    if (!existsSync(file)) return { schemaVersion: 1, mods: [] };
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as LockDocument;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.mods)) throw new Error('Invalid managed mod lock file.');
      return parsed;
    } catch (error) { throw new ModManagementError(`Cannot read ${LOCK_FILE}: ${(error as Error).message}`, 409); }
  }

  private writeLock(serverName: string, mods: ManagedModRecord[]): void {
    const dataDir = this.dataDir(serverName);
    mkdirSync(dataDir, { recursive: true });
    const destination = join(dataDir, LOCK_FILE);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, mods } satisfies LockDocument, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, destination);
  }

  private dataDir(serverName: string): string {
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(serverName)) throw new ModManagementError('Invalid server name.', 400);
    return join(this.root, 'servers', serverName, 'data');
  }

  private safeFilename(filename: string): string {
    const file = basename(filename);
    if (!SAFE_FILENAME.test(file) || file !== filename || file === '.' || file === '..') {
      throw new ModManagementError('The publisher returned an unsafe mod filename.', 422);
    }
    return file;
  }

  private assertFilename(filename: string): void {
    this.safeFilename(filename);
  }
}

export function createManagedModService(root: string): ManagedModService {
  return new ManagedModService(root);
}
