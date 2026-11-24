/**
 * Zod schema of a backup file as accepted by `POST /api/backup/import`. Lenient on purpose: optional fields get
 * defaults, unknown properties are dropped, so files of older and newer versions still parse; the values themselves
 * are checked by `BackupService` with the same rules as the regular endpoints.
 */
import { z } from '../validation.ts';

const text = (maxLength: number) => z.string().max(maxLength).nullish();

const appSchema = z.object({
  name: z.string().max(100),
  versionCommand: text(4000),
  latestSource: z.string().max(20).nullish(),
  repository: text(300),
  latestCommand: text(4000),
  updateCommand: text(4000),
  useTty: z.boolean().nullish(),
  timeoutSeconds: z.int().nullish(),
  installedVersion: text(100),
  isInstalledVersionSource: z.boolean().nullish(),
});

const targetSchema = z.object({
  kind: z.string().max(20),
  vmid: z.int().min(0).max(999_999_999),
  name: z.string().max(100),
  isEnabled: z.boolean().nullish(),
  aptEnabled: z.boolean().nullish(),
  backupBeforeUpdate: z.boolean().nullish(),
  startWhenStopped: z.boolean().nullish(),
  checkCron: text(200),
  updateCores: z.int().nullish(),
  updateMemoryMb: z.int().nullish(),
  dockerEnabled: z.boolean().nullish(),
  homeAssistantUrl: text(500),
  homeAssistantInstall: z.boolean().nullish(),
  hasHomeAssistantToken: z.boolean().nullish(),
  apps: z.array(appSchema).max(500).nullish(),
});

const hostSchema = z.object({
  type: z.string().max(20),
  name: z.string().max(100),
  address: z.string().max(253),
  port: z.int().nullish(),
  user: text(32),
  sshKeyName: text(100),
  backupStorage: text(100),
  targets: z.array(targetSchema).max(5000).nullish(),
});

const repositorySchema = z.object({
  owner: z.string().max(100),
  name: z.string().max(100),
  includePrereleases: z.boolean().nullish(),
  isEnabled: z.boolean().nullish(),
  icon: text(2000),
  installedVersionUrl: text(2000),
  installedVersionField: text(200),
  installedVersionHeaderNames: z.array(z.string().max(100)).max(50).nullish(),
  installedVersion: text(100),
  osvEcosystem: text(50),
  osvPackage: text(300),
  hasGithubToken: z.boolean().nullish(),
});

const endpointSchema = z.object({
  name: z.string().max(100),
  url: z.string().max(500),
  isEnabled: z.boolean().nullish(),
});

export const backupFileSchema = z.object({
  format: z.string().max(100),
  schemaVersion: z.int(),
  appVersion: text(50),
  exportedAt: text(50),
  settings: z.record(z.string().max(100), z.union([z.string().max(5000), z.number(), z.boolean(), z.null()])).nullish(),
  repositories: z.array(repositorySchema).max(5000).nullish(),
  hosts: z.array(hostSchema).max(1000).nullish(),
  dockerEndpoints: z.array(endpointSchema).max(1000).nullish(),
  /** Labels of the secrets the exporting instance left out (see `BackupFile.secretsOmitted`). */
  secretsOmitted: z.array(z.string().max(500)).max(10_000).nullish(),
});

/** A backup file as read from an import request (optional fields may be missing). */
export type BackupInput = z.output<typeof backupFileSchema>;
