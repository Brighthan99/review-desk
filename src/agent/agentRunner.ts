import type { AgentKind } from '../shared/agentUse';
import type { AgentRunner, RunRequest } from './runner';

/**
 * Runs each request with the agent chosen now (reviewDesk.agent): Claude Code or Codex. The
 * model setting is the agent's own (reviewDesk.model, reviewDesk.codexModel): their names
 * differ.
 */
export function agentRunner(
  agent: () => AgentKind,
  runners: Record<AgentKind, AgentRunner>,
  codexModel: () => string | undefined,
): AgentRunner {
  return {
    run: (request: RunRequest, onText) => {
      const kind = request.agent ?? agent();
      const r = kind === 'codex' ? { ...request, model: codexModel() } : request;
      return runners[kind].run(r, onText);
    },
  };
}
