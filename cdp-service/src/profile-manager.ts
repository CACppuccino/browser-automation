/**
 * Profile manager for persistent browser profiles.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  BrowserAccessRequest,
  BrowserStateMode,
  ProfileCreateRequest,
  ProfileListResponse,
  ProfileMigrationMode,
  ProfileMigrationRequest,
  ProfileRecord,
  ProfileResponse,
  ProfileStoragePaths,
  ProfileStorageScope,
  ServiceConfig,
} from './types.js';

interface LockPayload {
  instanceKey: string;
  agentId: string;
  pid?: number;
  timestamp: number;
}

interface ResolvedAccessContext {
  stateMode: BrowserStateMode;
  profileId?: string;
  profileScope?: ProfileStorageScope;
  workspacePath?: string;
  paths: ProfileStoragePaths;
  deleteUserDataDirOnShutdown: boolean;
}

export class ProfileManager {
  constructor(private readonly config: ServiceConfig['browser']) {}

  normalizeAccessRequest(request: BrowserAccessRequest): BrowserAccessRequest {
    const browserMode = request.browserMode ?? this.config.defaultMode;
    const stateMode = request.stateMode ?? (browserMode === 'dedicated' ? 'fresh' : 'profile');
    const profileScope = request.profileScope ?? this.config.profiles.defaultScope;
    const workspacePath = this.normalizeWorkspacePath(request.workspacePath);

    return {
      ...request,
      browserMode,
      stateMode,
      profileScope,
      workspacePath,
      agentId: request.agentId.trim(),
      profileId: request.profileId?.trim(),
      freshInstanceId: request.freshInstanceId?.trim(),
      targetId: request.targetId?.trim(),
    };
  }

  validateAccessRequest(request: BrowserAccessRequest): void {
    const normalized = this.normalizeAccessRequest(request);

    if (!normalized.agentId) {
      throw new Error('agentId is required');
    }

    if (normalized.browserMode === 'shared' && normalized.stateMode === 'fresh') {
      throw new Error('shared browserMode does not support fresh stateMode');
    }

    if (normalized.browserMode === 'shared' && normalized.profileId) {
      throw new Error('shared browserMode does not support profileId selection');
    }

    if (normalized.browserMode === 'dedicated' && normalized.stateMode === 'profile' && !normalized.profileId) {
      throw new Error('profileId is required when stateMode=profile');
    }

    if (normalized.stateMode === 'fresh' && normalized.profileId) {
      throw new Error('profileId is not allowed when stateMode=fresh');
    }

    if (
      normalized.browserMode === 'dedicated' &&
      normalized.profileScope === 'workspace' &&
      normalized.stateMode === 'profile' &&
      !normalized.workspacePath
    ) {
      throw new Error('workspacePath is required for workspace-scoped profiles');
    }
  }

  resolveAccessContext(request: BrowserAccessRequest): ResolvedAccessContext {
    const normalized = this.normalizeAccessRequest(request);
    this.validateAccessRequest(normalized);

    if (normalized.stateMode === 'profile') {
      const paths = this.getProfilePaths(
        normalized.profileId!,
        normalized.profileScope!,
        normalized.workspacePath
      );
      this.ensureProfileStructure(paths);
      const record = this.ensureProfileRecord({
        profileId: normalized.profileId!,
        scope: normalized.profileScope!,
        workspacePath: normalized.workspacePath,
      });
      this.touchProfileRecord(record);

      return {
        stateMode: 'profile',
        profileId: record.profileId,
        profileScope: record.scope,
        workspacePath: record.workspacePath,
        paths,
        deleteUserDataDirOnShutdown: false,
      };
    }

    const freshId = normalized.freshInstanceId || `fresh-${Date.now()}`;
    const rootDir = join(this.config.dedicated.userDataDirBase, 'fresh', sanitizeSegment(normalized.agentId), sanitizeSegment(freshId));
    const userDataDir = join(rootDir, 'user-data');
    const metadataPath = join(rootDir, this.config.profiles.metadataFileName);
    const lockPath = join(rootDir, this.config.profiles.lockFileName);
    mkdirSync(userDataDir, { recursive: true });

    return {
      stateMode: 'fresh',
      workspacePath: normalized.workspacePath,
      paths: {
        rootDir,
        userDataDir,
        metadataPath,
        lockPath,
      },
      deleteUserDataDirOnShutdown: this.config.profiles.retention.cleanupFreshOnShutdown,
    };
  }

  createProfile(request: ProfileCreateRequest): ProfileResponse {
    const profileId = request.profileId.trim();
    const scope = request.scope ?? this.config.profiles.defaultScope;
    const workspacePath = this.normalizeWorkspacePath(request.workspacePath);

    if (!profileId) {
      throw new Error('profileId is required');
    }
    if (scope === 'workspace' && !workspacePath) {
      throw new Error('workspacePath is required for workspace-scoped profiles');
    }

    const paths = this.getProfilePaths(profileId, scope, workspacePath);
    this.ensureProfileStructure(paths);

    const now = Date.now();
    const profile: ProfileRecord = {
      profileId,
      scope,
      workspacePath,
      displayName: request.displayName?.trim() || profileId,
      rootDir: paths.rootDir,
      userDataDir: paths.userDataDir,
      metadataPath: paths.metadataPath,
      lockPath: paths.lockPath,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
      state: 'ready',
      version: 1,
    };

    this.writeProfileRecord(profile);
    return { profile };
  }

  getProfile(profileId: string, scope: ProfileStorageScope, workspacePath?: string): ProfileResponse {
    const record = this.readProfileRecord(profileId, scope, workspacePath);
    return { profile: record };
  }

  listProfiles(scope?: ProfileStorageScope, workspacePath?: string): ProfileListResponse {
    const profiles: ProfileRecord[] = [];

    if (!scope || scope === 'global') {
      profiles.push(...this.listProfilesUnderRoot(this.config.profiles.globalRootDir, 'global'));
    }

    if (!scope || scope === 'workspace') {
      const normalizedWorkspace = this.normalizeWorkspacePath(workspacePath);
      if (normalizedWorkspace) {
        profiles.push(...this.listProfilesUnderRoot(this.getWorkspaceProfilesRoot(normalizedWorkspace), 'workspace', normalizedWorkspace));
      }
    }

    return { profiles };
  }

  deleteProfile(profileId: string, scope: ProfileStorageScope, workspacePath?: string): void {
    const record = this.readProfileRecord(profileId, scope, workspacePath);
    if (existsSync(record.lockPath)) {
      throw new Error(`Profile ${profileId} is locked and cannot be deleted`);
    }
    rmSync(record.rootDir, { recursive: true, force: true });
  }

  migrateProfile(
    profileId: string,
    sourceScope: ProfileStorageScope,
    sourceWorkspacePath: string | undefined,
    request: ProfileMigrationRequest
  ): ProfileResponse {
    const source = this.readProfileRecord(profileId, sourceScope, sourceWorkspacePath);
    const targetProfileId = request.targetProfileId?.trim() || profileId;
    const mode: ProfileMigrationMode = request.mode ?? 'copy';
    const targetWorkspacePath = this.normalizeWorkspacePath(request.targetWorkspacePath);

    if (request.targetScope === 'workspace' && !targetWorkspacePath) {
      throw new Error('targetWorkspacePath is required for workspace-scoped profile migration');
    }
    if (existsSync(source.lockPath) && !request.force) {
      throw new Error(`Profile ${profileId} is locked and cannot be migrated without force=true`);
    }

    const targetPaths = this.getProfilePaths(targetProfileId, request.targetScope, targetWorkspacePath);
    if (existsSync(targetPaths.metadataPath)) {
      throw new Error(`Target profile ${targetProfileId} already exists`);
    }

    mkdirSync(dirname(targetPaths.rootDir), { recursive: true });
    cpSync(source.rootDir, targetPaths.rootDir, { recursive: true, force: false });

    const migrated = this.readProfileRecord(targetProfileId, request.targetScope, targetWorkspacePath, targetPaths);
    migrated.profileId = targetProfileId;
    migrated.scope = request.targetScope;
    migrated.workspacePath = targetWorkspacePath;
    migrated.rootDir = targetPaths.rootDir;
    migrated.userDataDir = targetPaths.userDataDir;
    migrated.metadataPath = targetPaths.metadataPath;
    migrated.lockPath = targetPaths.lockPath;
    migrated.updatedAt = Date.now();
    migrated.lastUsedAt = Date.now();
    migrated.state = 'ready';
    migrated.sourceProfileId = source.profileId;
    migrated.sourceScope = source.scope;
    migrated.migratedFrom = {
      profileId: source.profileId,
      scope: source.scope,
      workspacePath: source.workspacePath,
      migratedAt: Date.now(),
      mode,
    };
    this.writeProfileRecord(migrated);

    if (mode === 'move') {
      rmSync(source.rootDir, { recursive: true, force: true });
    }

    return { profile: migrated };
  }

  acquireProfileLock(profile: ProfileRecord, owner: LockPayload): void {
    if (existsSync(profile.lockPath)) {
      const current = this.readLock(profile.lockPath);
      if (current && Date.now() - current.timestamp < this.config.profiles.lockTimeoutMs) {
        throw new Error(`Profile ${profile.profileId} is already locked by ${current.instanceKey}`);
      }
      rmSync(profile.lockPath, { force: true });
    }

    writeFileSync(profile.lockPath, JSON.stringify(owner, null, 2), 'utf8');
    profile.state = 'locked';
    profile.updatedAt = Date.now();
    this.writeProfileRecord(profile);
  }

  releaseProfileLock(profile: ProfileRecord, instanceKey?: string): void {
    if (existsSync(profile.lockPath)) {
      const current = this.readLock(profile.lockPath);
      if (!instanceKey || !current || current.instanceKey === instanceKey) {
        unlinkSync(profile.lockPath);
      }
    }

    profile.state = 'ready';
    profile.updatedAt = Date.now();
    this.writeProfileRecord(profile);
  }

  readProfileRecord(
    profileId: string,
    scope: ProfileStorageScope,
    workspacePath?: string,
    paths?: ProfileStoragePaths
  ): ProfileRecord {
    const resolvedPaths = paths ?? this.getProfilePaths(profileId, scope, this.normalizeWorkspacePath(workspacePath));
    if (!existsSync(resolvedPaths.metadataPath)) {
      throw new Error(`Profile ${profileId} not found`);
    }

    const record = JSON.parse(readFileSync(resolvedPaths.metadataPath, 'utf8')) as ProfileRecord;
    record.rootDir = resolvedPaths.rootDir;
    record.userDataDir = resolvedPaths.userDataDir;
    record.metadataPath = resolvedPaths.metadataPath;
    record.lockPath = resolvedPaths.lockPath;
    return record;
  }

  ensureProfileRecord(request: ProfileCreateRequest): ProfileRecord {
    try {
      return this.readProfileRecord(request.profileId, request.scope ?? this.config.profiles.defaultScope, request.workspacePath);
    } catch {
      return this.createProfile(request).profile;
    }
  }

  getProfilePaths(profileId: string, scope: ProfileStorageScope, workspacePath?: string): ProfileStoragePaths {
    const safeId = sanitizeSegment(profileId);
    const rootDir =
      scope === 'global'
        ? join(this.config.profiles.globalRootDir, safeId)
        : join(this.getWorkspaceProfilesRoot(workspacePath), safeId);

    return {
      rootDir,
      userDataDir: join(rootDir, 'user-data'),
      metadataPath: join(rootDir, this.config.profiles.metadataFileName),
      lockPath: join(rootDir, this.config.profiles.lockFileName),
    };
  }

  getWorkspaceProfilesRoot(workspacePath?: string): string {
    const normalizedWorkspace = this.normalizeWorkspacePath(workspacePath);
    if (!normalizedWorkspace) {
      throw new Error('workspacePath is required for workspace-scoped profiles');
    }
    return join(normalizedWorkspace, this.config.profiles.workspaceRootName);
  }

  private listProfilesUnderRoot(rootDir: string, scope: ProfileStorageScope, workspacePath?: string): ProfileRecord[] {
    if (!existsSync(rootDir)) {
      return [];
    }

    return readdirSync(rootDir)
      .map((entry) => join(rootDir, entry))
      .filter((entryPath) => statSync(entryPath).isDirectory())
      .map((entryPath) => {
        const profileId = entryPath.split('/').pop() || '';
        try {
          return this.readProfileRecord(profileId, scope, workspacePath, {
            rootDir: entryPath,
            userDataDir: join(entryPath, 'user-data'),
            metadataPath: join(entryPath, this.config.profiles.metadataFileName),
            lockPath: join(entryPath, this.config.profiles.lockFileName),
          });
        } catch {
          return null;
        }
      })
      .filter((profile): profile is ProfileRecord => profile !== null);
  }

  private ensureProfileStructure(paths: ProfileStoragePaths): void {
    mkdirSync(paths.userDataDir, { recursive: true });
  }

  private writeProfileRecord(profile: ProfileRecord): void {
    mkdirSync(profile.rootDir, { recursive: true });
    writeFileSync(profile.metadataPath, JSON.stringify(profile, null, 2), 'utf8');
  }

  private touchProfileRecord(profile: ProfileRecord): void {
    profile.lastUsedAt = Date.now();
    profile.updatedAt = Date.now();
    if (profile.state === 'locked' && !existsSync(profile.lockPath)) {
      profile.state = 'ready';
    }
    this.writeProfileRecord(profile);
  }

  private normalizeWorkspacePath(workspacePath?: string): string | undefined {
    if (!workspacePath) {
      return undefined;
    }
    const trimmed = workspacePath.trim();
    if (!trimmed) {
      return undefined;
    }
    if (!isAbsolute(trimmed)) {
      throw new Error('workspacePath must be an absolute path');
    }
    return resolve(trimmed);
  }

  private readLock(lockPath: string): LockPayload | null {
    if (!existsSync(lockPath)) {
      return null;
    }

    try {
      return JSON.parse(readFileSync(lockPath, 'utf8')) as LockPayload;
    } catch {
      return null;
    }
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-');
}
