import type { FromPanel } from '../src/shared/protocol';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

export function post(msg: FromPanel): void {
  api.postMessage(msg);
}

/**
 * What the panel remembers across reloads: the filter, resolved threads hidden, unsent drafts,
 * a folded summary.
 */
export interface SavedState {
  filter?: string;
  hideResolved?: boolean;
  drafts?: Record<string, string>;
  summaryOpen?: boolean;
}

export function loadState(): SavedState {
  return (api.getState() as SavedState | undefined) ?? {};
}

export function saveState(state: SavedState): void {
  api.setState(state);
}
