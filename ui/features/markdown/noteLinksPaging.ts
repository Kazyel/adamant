export const initialNoteLinkLimits = { incoming: 100, outgoing: 100, targets: 50 };
export type NoteLinkList = keyof typeof initialNoteLinkLimits;

export function growNoteLinkLimit(limits: typeof initialNoteLinkLimits, list: NoteLinkList) {
  const maximum = list === 'targets' ? 50_000 : 25_000;
  const next = Math.min(maximum, limits[list] + initialNoteLinkLimits[list]);
  return next === limits[list] ? limits : { ...limits, [list]: next };
}

export function noteLinksIdentity(source: {
  vaultKey: string;
  path: string;
  expectedIdentity: string | null;
  query?: string;
}) {
  return JSON.stringify([
    source.vaultKey,
    source.path,
    source.expectedIdentity,
    source.query ?? '',
  ]);
}
