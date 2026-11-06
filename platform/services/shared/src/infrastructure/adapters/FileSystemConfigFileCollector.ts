import { readFile, readdir, lstat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { IConfigFileCollector } from '../../application/ports/outbound/IConfigFileCollector.js';
import { ConfigSnapshotFile } from '../../domain/value-objects/ConfigSnapshotFile.js';
import { atomicWriteFile } from '../../utils/atomic-write.js';

/**
 * Known config file names that are always collected if present
 */
const KNOWN_CONFIG_FILES = [
  // The server definition (#675); config.env and docker-compose.yml are rendered from it
  'server.yaml',
  'server.properties',
  'config.env',
  'docker-compose.yml',
  'bukkit.yml',
  'spigot.yml',
  'paper.yml',
  'paper-global.yml',
  'paper-world-defaults.yml',
  'ops.json',
  'whitelist.json',
  'banned-players.json',
  'banned-ips.json',
];

/**
 * File extensions to collect for additional config files
 */
const CONFIG_EXTENSIONS = ['.yml', '.yaml', '.json', '.properties', '.toml', '.cfg', '.conf', '.ini'];
const MOD_CONFIG_EXTENSIONS = [...CONFIG_EXTENSIONS, '.txt'];

/**
 * Maximum file size to collect (1MB)
 */
const MAX_FILE_SIZE = 1024 * 1024;
const MAX_CONFIG_FILES = 2000;
const MAX_TOTAL_SIZE = 100 * 1024 * 1024;
const MOD_CONFIG_ROOTS = ['data/config', 'data/defaultconfigs', 'data/serverconfig'];

/**
 * FileSystemConfigFileCollector
 * Implements IConfigFileCollector for collecting server configuration files.
 * Collects known server files and supported config formats from the server directory
 * and Minecraft's mod config folders under data/.
 * Computes SHA-256 hash for each file. Skips files larger than 1MB.
 */
export class FileSystemConfigFileCollector implements IConfigFileCollector {
  constructor(private readonly serversDir: string) {}

  /**
   * Collect all trackable config files for a server
   * Returns metadata (path, hash, size) for each file found
   */
  async collectFiles(serverName: string): Promise<ConfigSnapshotFile[]> {
    const serverDir = join(this.serversDir, serverName);

    if (!existsSync(serverDir)) {
      return [];
    }

    const collectedPaths = new Set<string>();
    const files: ConfigSnapshotFile[] = [];
    const configRoots = [...MOD_CONFIG_ROOTS];
    let totalSize = 0;

    const addFile = async (fileName: string) => {
      if (collectedPaths.has(fileName) || files.length >= MAX_CONFIG_FILES) return;
      const file = await this.processFile(serverDir, fileName);
      if (!file || totalSize + file.size > MAX_TOTAL_SIZE) return;
      files.push(file);
      collectedPaths.add(fileName);
      totalSize += file.size;
    };

    // Collect known config files
    for (const fileName of KNOWN_CONFIG_FILES) {
      await addFile(fileName);
    }

    // Collect additional supported config files in the server root.
    try {
      const entries = await readdir(serverDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (collectedPaths.has(entry.name)) continue;

        const ext = this.getExtension(entry.name);
        if (CONFIG_EXTENSIONS.includes(ext)) await addFile(entry.name);
      }
    } catch {
      // Ignore errors reading directory
    }

    const dataServerProperties = join(serverDir, 'data', 'server.properties');
    if (existsSync(dataServerProperties)) {
      await addFile('data/server.properties');
      try {
        const propertiesStat = await lstat(dataServerProperties);
        if (propertiesStat.isFile() && !propertiesStat.isSymbolicLink()) {
          const levelName = (await readFile(dataServerProperties, 'utf-8'))
            .match(/^\s*level-name\s*=\s*([^\r\n#]+)/m)?.[1]?.trim();
          if (levelName && /^[A-Za-z0-9 ._-]{1,100}$/.test(levelName) && levelName !== '.' && levelName !== '..') {
            configRoots.push(`data/${levelName}/serverconfig`);
          }
        }
      } catch { /* The remaining config roots can still be collected. */ }
    }

    for (const root of new Set(configRoots)) {
      const absoluteRoot = join(serverDir, root);
      try {
        await this.assertNoSymlinkParents(serverDir, absoluteRoot);
        const rootStat = await lstat(absoluteRoot);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) continue;
      } catch { continue; }
      await this.collectConfigDirectory(serverDir, root, addFile);
    }

    return files;
  }

  /**
   * Read the content of a specific config file
   */
  async readFileContent(serverName: string, filePath: string): Promise<string> {
    const serverDir = resolve(this.serversDir, serverName);
    const fullPath = this.resolveServerPath(serverName, filePath);
    await this.assertNoSymlinkParents(serverDir, fullPath);
    const fileStat = await lstat(fullPath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error('Config snapshot paths must point to regular files.');
    }
    return readFile(fullPath, 'utf-8');
  }

  /**
   * Write content to a specific config file in the server directory
   * Creates parent directories if they don't exist
   */
  async writeFileContent(
    serverName: string,
    filePath: string,
    content: string
  ): Promise<void> {
    const fullPath = this.resolveServerPath(serverName, filePath);
    const fileDir = dirname(fullPath);
    const serverDir = resolve(this.serversDir, serverName);
    await this.assertNoSymlinkParents(serverDir, fullPath);
    await mkdir(fileDir, { recursive: true });
    await this.assertNoSymlinkParents(serverDir, fullPath);
    await atomicWriteFile(fullPath, content);
  }

  private async collectConfigDirectory(
    serverDir: string,
    root: string,
    addFile: (fileName: string) => Promise<void>
  ): Promise<void> {
    const walk = async (relativeDir: string, depth: number): Promise<void> => {
      if (depth > 12) return;
      const absoluteDir = join(serverDir, relativeDir);
      let entries;
      try { entries = await readdir(absoluteDir, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        const relativePath = join(relativeDir, entry.name).split(sep).join('/');
        if (entry.isDirectory()) await walk(relativePath, depth + 1);
        else if (entry.isFile() && MOD_CONFIG_EXTENSIONS.includes(this.getExtension(entry.name))) {
          await addFile(relativePath);
        }
      }
    };
    await walk(root, 0);
  }

  private resolveServerPath(serverName: string, filePath: string): string {
    if (!serverName || serverName === '.' || serverName === '..' || /[\\/\0]/.test(serverName)) {
      throw new Error('Config snapshot server name must be a single directory name.');
    }
    const serverDir = resolve(this.serversDir, serverName);
    if (!filePath || isAbsolute(filePath) || filePath.split(/[\\/]/).some((part) => part === '..' || part === '.')) {
      throw new Error('Config snapshot path must be relative to the server directory.');
    }
    const target = resolve(serverDir, filePath);
    const fromServer = relative(serverDir, target);
    if (!fromServer || fromServer === '..' || fromServer.startsWith(`..${sep}`) || isAbsolute(fromServer)) {
      throw new Error('Config snapshot path must remain inside the server directory.');
    }
    return target;
  }

  private async assertNoSymlinkParents(serverDir: string, target: string): Promise<void> {
    const relativePath = relative(serverDir, target);
    let current = serverDir;
    for (const part of relativePath.split(sep).slice(0, -1)) {
      current = join(current, part);
      try {
        const entry = await lstat(current);
        if (entry.isSymbolicLink()) throw new Error('Config snapshot paths may not traverse symbolic links.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  /**
   * Process a single file: compute hash and size
   * Returns null if file is too large or cannot be read
   */
  private async processFile(
    serverDir: string,
    fileName: string
  ): Promise<ConfigSnapshotFile | null> {
    const fullPath = join(serverDir, fileName);

    try {
      const fileStat = await lstat(fullPath);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) return null;

      // Skip files larger than 1MB
      if (fileStat.size > MAX_FILE_SIZE) {
        return null;
      }

      const content = await readFile(fullPath);

      // Compute SHA-256 hash
      const hash = createHash('sha256').update(content).digest('hex');

      return ConfigSnapshotFile.create({
        path: fileName,
        hash,
        size: fileStat.size,
      });
    } catch {
      return null;
    }
  }

  /**
   * Get file extension (lowercase)
   */
  private getExtension(fileName: string): string {
    const dotIndex = fileName.lastIndexOf('.');
    if (dotIndex === -1) return '';
    return fileName.substring(dotIndex).toLowerCase();
  }
}
