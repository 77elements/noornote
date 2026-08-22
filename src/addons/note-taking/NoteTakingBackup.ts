/**
 * NoteTakingBackup - local JSON backup + restore for the Note taking addon.
 *
 * Mirrors the lists backup model (src/lists/file.ts): on Desktop the file lives
 * at a fixed path ~/.noornote/{npub}/note-taking-backup.json; on Web/Mobile it
 * goes through the browser download/upload dialogs (Capacitor uses the Web path,
 * exactly like the lists). The file holds DECRYPTED plaintext notes (a local
 * file the user keeps), so restore refuses a backup from a different account.
 */

import { PlatformService } from '../../services/PlatformService';
import { AuthService } from '../../services/AuthService';
import { ToastService } from '../../services/ToastService';
import {
  writeJsonFile,
  readJsonFile,
  downloadAsJson,
  uploadJsonFile,
} from '../../lists/file';
import { NoteTakingService } from './NoteTakingService';
import { NoteTakingSyncService } from './NoteTakingSyncService';
import type { NotePayload } from './NoteTakingStore';

const BACKUP_FILE = 'note-taking-backup.json';

interface NoteBackup {
  version: number;
  exportedAt: string;
  pubkey: string;
  notes: NotePayload[];
}

/** Build a plaintext backup of all live notes and save it (Desktop file / Web download). */
export async function backupNotes(): Promise<void> {
  const user = AuthService.getInstance().getCurrentUser();
  if (!user) {
    ToastService.show('Log in to back up notes', 'error');
    return;
  }

  const service = NoteTakingService.getInstance();
  const notes = (await service.listNotes()).map(n => service.toPayload(n));

  const bundle: NoteBackup = {
    version: 1,
    exportedAt: new Date().toISOString(),
    pubkey: user.pubkey,
    notes,
  };

  try {
    if (PlatformService.getInstance().isDesktop) {
      await writeJsonFile(BACKUP_FILE, bundle);
      ToastService.show(
        `Backed up ${notes.length} notes to ~/.noornote`,
        'success'
      );
    } else {
      downloadAsJson(bundle, 'notes');
      ToastService.show(`Backed up ${notes.length} notes`, 'success');
    }
  } catch (_error) {
    ToastService.show('Backup failed', 'error');
  }
}

/**
 * Restore notes from a local backup. An explicit restore is a recovery action,
 * so it DOES bring deleted notes back: a prior tombstone is cleared and the note
 * is written with a fresh timestamp so it supersedes the relay tombstone on the
 * next sync (the recovered note is re-published). It still won't clobber a newer
 * local copy. Restored notes are marked dirty so the next sync re-publishes them.
 * Returns the number of notes actually restored.
 */
export async function restoreNotes(): Promise<number> {
  const user = AuthService.getInstance().getCurrentUser();
  if (!user) {
    ToastService.show('Log in to restore notes', 'error');
    return 0;
  }

  let bundle: NoteBackup | null;
  if (PlatformService.getInstance().isDesktop) {
    bundle = await readJsonFile<NoteBackup | null>(BACKUP_FILE, null);
  } else {
    bundle = await uploadJsonFile<NoteBackup>();
  }

  if (!bundle || !Array.isArray(bundle.notes)) {
    ToastService.show('No valid backup found', 'error');
    return 0;
  }

  // The backup is plaintext on disk; refuse a file from another account so we
  // never import + re-encrypt + republish someone else's notes under this key.
  if (bundle.pubkey && bundle.pubkey !== user.pubkey) {
    ToastService.show('Backup belongs to a different account', 'error');
    return 0;
  }

  const service = NoteTakingService.getInstance();
  const store = service.storeRef;
  const tombstones = service.getTombstones();
  const now = Math.floor(Date.now() / 1000);
  let restored = 0;

  for (const payload of bundle.notes) {
    if (!payload || !payload.id || payload.deleted) continue;
    const local = await store.get(payload.id);
    if (local && local.updatedAt >= payload.updatedAt) continue; // keep a newer/equal local copy
    // Explicit restore overrides a prior deletion: clear the tombstone and write
    // the note with a fresh timestamp so it beats the relay tombstone on sync.
    const wasTombstoned = tombstones[payload.id] !== undefined;
    if (wasTombstoned) service.clearTombstone(payload.id);
    const updatedAt = wasTombstoned ? now : payload.updatedAt;
    await store.put({ ...payload, updatedAt, dirty: true }); // restore + re-sync
    restored++;
  }

  if (restored > 0) {
    ToastService.show(`Restored ${restored} notes`, 'success');
    void NoteTakingSyncService.getInstance().syncAll();
  } else {
    ToastService.show('Nothing to restore (notes already up to date)', 'info');
  }
  return restored;
}
