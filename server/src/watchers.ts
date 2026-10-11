import { watch, type FSWatcher } from 'node:fs';

const quietPeriod = 5000;

/**
 * One recursive watcher per folder. A burst of changes (a game writing its saves) becomes a single
 * call once the folder has been quiet for a few seconds.
 */
export class FolderWatchers {
  private readonly onChange: (folderId: number) => void;
  private readonly onError: (folderId: number, error: Error) => void;
  private readonly watchers = new Map<number, FSWatcher>();
  private readonly timers = new Map<number, NodeJS.Timeout>();

  constructor(onChange: (folderId: number) => void, onError: (folderId: number, error: Error) => void) {
    this.onChange = onChange;
    this.onError = onError;
  }

  /** Starts watching a folder; throws when it can't be watched (missing, no permission). */
  watch(folderId: number, path: string): void {
    this.unwatch(folderId);
    const watcher = watch(path, { recursive: true }, () => this.touched(folderId));
    watcher.on('error', (error) => {
      this.unwatch(folderId);
      this.onError(folderId, error);
    });
    this.watchers.set(folderId, watcher);
  }

  unwatch(folderId: number): void {
    this.watchers.get(folderId)?.close();
    this.watchers.delete(folderId);
    clearTimeout(this.timers.get(folderId));
    this.timers.delete(folderId);
  }

  closeAll(): void {
    for (const folderId of [...this.watchers.keys()]) this.unwatch(folderId);
  }

  private touched(folderId: number): void {
    clearTimeout(this.timers.get(folderId));
    this.timers.set(
      folderId,
      setTimeout(() => {
        this.timers.delete(folderId);
        this.onChange(folderId);
      }, quietPeriod),
    );
  }
}
