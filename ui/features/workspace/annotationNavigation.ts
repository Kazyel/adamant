import type { NavigationState } from '../navigation/navigationTypes';

/** Update only references to the document explicitly adopted by this operation. */
export function adoptAnnotationIdentity(
  state: NavigationState,
  path: string,
  previous: string,
  identity: string,
): NavigationState {
  return {
    ...state,
    identities: { ...state.identities, [path]: identity },
    favoriteIdentities:
      state.favoriteIdentities[path] === previous
        ? { ...state.favoriteIdentities, [path]: identity }
        : state.favoriteIdentities,
    history: state.history.map((item) =>
      item.path === path && item.identity === previous ? { ...item, identity } : item,
    ),
  };
}
