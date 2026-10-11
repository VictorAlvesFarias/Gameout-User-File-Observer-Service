import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const here = import.meta.dirname;

/** Read at call time so the desktop app (and the tests) can point them somewhere else. */
export const paths = {
  dataDir: process.env.GAMEOUT_DRIVER_HOME ?? join(homedir(), '.gameout-driver'),
  clientDistDir: resolve(here, '..', '..', 'client', 'dist'),
};

export function configurePaths(overrides: Partial<typeof paths>): void {
  Object.assign(paths, overrides);
}

export const dataFile = () => join(paths.dataDir, 'data.json');
