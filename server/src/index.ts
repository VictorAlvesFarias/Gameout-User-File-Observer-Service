import { startServer } from './app.ts';
import { paths } from './paths.ts';

const { port } = await startServer(Number(process.env.PORT ?? 4314));
console.log(`Gameout Driver API on http://localhost:${port} (data: ${paths.dataDir})`);
