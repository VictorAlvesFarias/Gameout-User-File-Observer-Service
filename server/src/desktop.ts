/**
 * What only the Electron shell can do, plugged in by desktop/main.ts. In the plain web mode
 * (npm run dev) these stay null and the UI hides them.
 */
export interface AutoStart {
  get(): boolean;
  set(enabled: boolean): void;
}

export const desktop: { autoStart: AutoStart | null } = {
  autoStart: null,
};

export function configureDesktop(patch: Partial<typeof desktop>): void {
  Object.assign(desktop, patch);
}
