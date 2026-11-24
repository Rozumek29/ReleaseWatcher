import { problem } from '../http.ts';
import { body, readBody, z } from '../validation.ts';
import { IMPORT_MODES } from './domain.ts';
import { backupFileSchema } from './schema.ts';
import { BackupConflictError, type BackupService, BackupValidationError, type ImportResult } from './service.ts';

export interface BackupRoutesDeps {
  service: BackupService;
  /** Called after an import was applied (e.g. to check newly added repositories). */
  onImported?: (result: ImportResult) => void;
}

const importSchema = body({
  backup: backupFileSchema,
  mode: z.enum(IMPORT_MODES),
  /** true = only return the preview, nothing is written. */
  dryRun: z.boolean().optional(),
});

/** Backup & restore of the configuration (Settings → Backup): export without secrets, import with a preview. */
export function backupRoutes(deps: BackupRoutesDeps) {
  return {
    '/api/backup/export': {
      GET: () => {
        const now = new Date();
        return Response.json(deps.service.exportBackup(now), {
          headers: {
            'content-disposition': `attachment; filename="releasewatcher-backup-${now.toISOString().slice(0, 10)}.json"`,
          },
        });
      },
    },
    '/api/backup/import': {
      POST: async (req: Request) => {
        const { backup, mode, dryRun } = await readBody(req, importSchema);
        try {
          const plan = deps.service.planImport(backup, mode);
          if (dryRun) {
            return Response.json({ applied: false, preview: plan.preview });
          }
          const result = plan.apply();
          deps.onImported?.(result);
          return Response.json({ applied: true, preview: plan.preview });
        } catch (error) {
          if (error instanceof BackupValidationError) {
            return problem(400, 'The backup file contains values that cannot be imported.', { errors: error.errors });
          }
          if (error instanceof BackupConflictError) {
            return problem(409, error.message);
          }
          throw error;
        }
      },
    },
  };
}
