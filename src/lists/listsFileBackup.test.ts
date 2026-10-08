/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const TEST_PK = 'aa'.repeat(32);
const TEST_NPUB = 'npub1testuser';
const NOW = 1_800_000_000;

vi.mock('./relays', () => ({
  getTransport: () => ({}),
  getReadRelays: () => [],
  getWriteRelays: () => ['wss://relay'],
  getCurrentUserPubkey: () => TEST_PK,
  requireAuth: () => ({ pubkey: TEST_PK }),
  fetchEvents: async () => [],
  publishEvent: async () => new Set<string>(),
  signEvent: async () => null,
  encryptContent: async () => '',
  decryptContent: async () => null,
}));

vi.mock('../services/AuthService', () => ({
  AuthService: {
    getInstance: () => ({
      getCurrentUser: () => ({ pubkey: TEST_PK, npub: TEST_NPUB }),
    }),
  },
}));

vi.mock('../services/PlatformService', () => ({
  PlatformService: {
    getInstance: () => platform,
  },
}));

// Stable PlatformService singleton — file.ts captures it at module scope.
const platform = {
  isDesktop: true,
  isBrowser: false,
  isMobile: false,
  isNative: false,
};

// In-memory Electron FS bridging window.electronAPI.
const fs = new Map<string, string>();

function stubElectronApi(): void {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getHomeDir: async () => '/home/test',
    fsExists: async (path: string) => fs.has(path),
    fsMkdir: async () => undefined,
    writeTextFile: async (path: string, content: string) => {
      fs.set(path, content);
    },
    readTextFile: async (path: string) => {
      const content = fs.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
  };
}

function filePath(filename: string): string {
  return `/home/test/.noornote/${TEST_NPUB}/${filename}`;
}

async function readFile(filename: string): Promise<unknown> {
  return JSON.parse(fs.get(filePath(filename))!) as unknown;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW * 1000));
  localStorage.clear();
  fs.clear();
  stubElectronApi();
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  fs.clear();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

// ===========================================================================
// Bookmarks file backup (BookmarkSetData format)
// ===========================================================================

describe('bookmarks file backup', () => {
  it('saveBookmarksToFile mirrors the browser state: root set, folder sets, setOrder', async () => {
    const { writeBrowserBookmarks } = await import('./bookmarks');
    const { PerAccountLocalStorage, StorageKeys } = await import(
      '../services/PerAccountLocalStorage'
    );
    const storage = PerAccountLocalStorage.getInstance();

    writeBrowserBookmarks([
      { id: 'e1'.padEnd(64, '0'), type: 'e', value: 'e1'.padEnd(64, '0') },
      {
        id: 'e2'.padEnd(64, '0'),
        type: 'e',
        value: 'e2'.padEnd(64, '0'),
        category: 'AI',
      },
    ]);
    storage.set(StorageKeys.BOOKMARK_FOLDERS, [
      { id: 'folder_AI', name: 'AI', createdAt: NOW * 1000 },
    ]);
    storage.set(StorageKeys.BOOKMARK_FOLDER_ASSIGNMENTS, [
      { bookmarkId: 'e2'.padEnd(64, '0'), folderId: 'folder_AI', order: 0 },
    ]);
    storage.set(StorageKeys.BOOKMARK_ROOT_ORDER, [
      { type: 'folder', id: 'folder_AI' },
      { type: 'bookmark', id: 'e1'.padEnd(64, '0') },
    ]);

    const { saveBookmarksToFile } = await import('./bookmarks');
    await saveBookmarksToFile();

    const data = (await readFile('bookmarks.json')) as {
      version: number;
      metadata: { setOrder: string[] };
      sets: Array<{
        d: string;
        publicTags: string[][];
        privateTags: string[][];
      }>;
    };

    expect(data.version).toBe(2);
    expect(data.metadata.setOrder).toEqual(['', 'AI']);
    const root = data.sets.find(s => s.d === '');
    const ai = data.sets.find(s => s.d === 'AI');
    // File format serializes tags as objects (not string arrays like on relays).
    expect(root?.publicTags).toEqual([
      { type: 'e', value: 'e1'.padEnd(64, '0') },
    ]);
    expect(ai?.publicTags).toEqual([
      { type: 'e', value: 'e2'.padEnd(64, '0') },
    ]);
  });

  it('keeps private items (with description) in privateTags — the file path does NOT drop descriptions', async () => {
    const {
      writeBrowserBookmarks,
      saveBookmarksToFile,
      readBookmarkFile,
      extractItemsFromSetData,
    } = await import('./bookmarks');
    const PRIV = 'e9'.padEnd(64, '0');
    writeBrowserBookmarks([
      {
        id: PRIV,
        type: 'r',
        value: 'https://example.com',
        isPrivate: true,
        description: 'secret',
      },
    ]);

    await saveBookmarksToFile();
    const data = (await readFile('bookmarks.json')) as {
      sets: Array<{
        d: string;
        publicTags: string[][];
        privateTags: string[][];
      }>;
    };
    const root = data.sets.find(s => s.d === '')!;
    expect(root.publicTags).toEqual([]); // private NOT in plaintext tags
    expect(root.privateTags).toEqual([
      { type: 'r', value: 'https://example.com', description: 'secret' },
    ]);

    // Round trip: file → items preserves privacy + description.
    // (tagToItem derives id from value — for URL bookmarks id === value.)
    const items = extractItemsFromSetData(await readBookmarkFile());
    expect(items).toEqual([
      {
        id: 'https://example.com',
        type: 'r',
        value: 'https://example.com',
        isPrivate: true,
        category: '',
        description: 'secret',
      },
    ]);
  });

  it('readBookmarkFile returns empty set data when no file exists', async () => {
    const { readBookmarkFile } = await import('./bookmarks');
    const data = await readBookmarkFile();
    expect(data.version).toBe(2);
    expect(data.sets.map(s => s.d)).toEqual(['']);
  });
});

// ===========================================================================
// Follows file backup (FollowListData, two files)
// ===========================================================================

describe('follows file backup', () => {
  it('saveToFile → getFileFollows round-trips public and private follows', async () => {
    const { setFollowItems, saveToFile, getFileFollows } = await import(
      './follows'
    );
    const PK1 = '11'.repeat(32);
    const PK2 = '22'.repeat(32);
    setFollowItems([
      { id: PK1, pubkey: PK1, addedAt: NOW, isPrivate: false },
      { id: PK2, pubkey: PK2, addedAt: NOW, isPrivate: true, petname: 'alice' },
    ]);

    await saveToFile();

    const publicFile = (await readFile('follows-public.json')) as {
      items: unknown[];
    };
    const privateFile = (await readFile('follows-private.json')) as {
      items: unknown[];
    };
    expect(publicFile.items).toHaveLength(1);
    expect(privateFile.items).toHaveLength(1);

    const restored = await getFileFollows();
    expect(restored).toHaveLength(2);
    expect(restored.find(i => i.pubkey === PK1)?.isPrivate).toBe(false);
    expect(restored.find(i => i.pubkey === PK2)?.isPrivate).toBe(true);
    expect(restored.find(i => i.pubkey === PK2)?.petname).toBe('alice');
  });
});

// ===========================================================================
// Mutes file backup (MuteListData, two files) + empty-file protection
// ===========================================================================

describe('mutes file backup', () => {
  it('saveToFile → getFileMutes round-trips users, threads and privacy', async () => {
    const { setMuteItems, saveToFile, getFileMutes } = await import('./mutes');
    const PK1 = '11'.repeat(32);
    const THREAD = 'c0'.repeat(32);
    setMuteItems([
      { type: 'user', id: PK1, isPrivate: true, addedAt: NOW },
      { type: 'thread', id: THREAD, isPrivate: false, addedAt: NOW },
    ]);

    await saveToFile();

    const restored = await getFileMutes();
    expect(restored).toHaveLength(2);
    expect(restored.find(i => i.id === PK1)).toMatchObject({
      type: 'user',
      isPrivate: true,
    });
    expect(restored.find(i => i.id === THREAD)).toMatchObject({
      type: 'thread',
      isPrivate: false,
    });
  });

  it('restoreFromFile refuses to overwrite non-empty browser state with an empty file', async () => {
    const { setMuteItems, restoreFromFile } = await import('./mutes');
    const PK1 = '11'.repeat(32);
    setMuteItems([{ type: 'user', id: PK1, isPrivate: false, addedAt: NOW }]);

    // No files written — both file reads return defaults (empty).
    await expect(restoreFromFile()).rejects.toThrow('File is empty');
    // Browser state untouched.
    const { getMuteItems } = await import('./mutes');
    expect(getMuteItems().map(i => i.id)).toEqual([PK1]);
  });
});
