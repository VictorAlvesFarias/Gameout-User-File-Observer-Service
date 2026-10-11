/**
 * What only the Electron shell can do, plugged in by desktop/main.ts. In the plain web mode
 * (npm run dev) these stay null and the UI hides them (the folder is typed instead).
 */
export interface AutoStart {
  get(): boolean;
  set(enabled: boolean): void;
}

/** Native "choose folder" dialog; null when cancelled. */
export type PickFolder = (title: string) => Promise<string | null>;

export const desktop: { autoStart: AutoStart | null; pickFolder: PickFolder | null } = {
  autoStart: null,
  pickFolder: null,
};

export function configureDesktop(patch: Partial<typeof desktop>): void {
  Object.assign(desktop, patch);
}
