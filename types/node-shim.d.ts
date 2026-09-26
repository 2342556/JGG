// Offline type-check shim: @types/node is not installable here (no npm registry). Node built-ins are typed `any`;
// all JGG code (domain, API, worker, tests) is still checked strictly. Replace with @types/node when online.
declare module 'node:*';
declare var process: any;
declare var Buffer: any;
type Buffer = any;
declare module 'node:http' {
  export type IncomingMessage = any; export type ServerResponse = any;
  export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => void): any;
}
declare module 'node:sqlite' { export type DatabaseSync = any; export const DatabaseSync: any; }
