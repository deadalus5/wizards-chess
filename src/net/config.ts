// Where the online relay (server/) lives. In development it is `wrangler dev` on this machine;
// a build uses the deployed Worker. Empty: online play is not offered.
// VITE_ONLINE_URL overrides both (e.g. `VITE_ONLINE_URL=http://192.168.1.5:8787 npm run dev`).
const DEPLOYED = 'https://stonewake-online.rbwcontent.workers.dev';

export const ONLINE_URL: string = (import.meta.env.VITE_ONLINE_URL as string | undefined) ?? (import.meta.env.DEV ? `http://${location.hostname}:8787` : DEPLOYED);

export function socketUrl(id: string): string {
  return `${ONLINE_URL.replace(/^http/, 'ws')}/games/${id}/ws`;
}
