import * as vscode from 'vscode';
import {
  AGENT_KINDS,
  agentName,
  statusText,
  type AgentKind,
  type AgentStatus,
} from '../shared/agentUse';

/** What the agent list picks: an agent, or what Review Desk sends and who pays. */
export type AgentPick = AgentKind | 'about';

type Item = vscode.QuickPickItem & { agent?: AgentKind; action?: 'about' };

/**
 * The agents to pick from (Claude Code, Codex), the current one marked, each with how it
 * stands as `load` tells: installed, signed in, with which plan or an API key, and who (when
 * the agent says). Shown at once, filled in as the agents answer.
 */
export function askAgent(
  current: AgentKind,
  load: () => Promise<AgentStatus[]>,
): Promise<AgentPick | undefined> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = 'Agent for notes and answers';
    qp.placeholder = 'Review Desk runs the agent picked here, with the account it is signed in to';
    const items = (statuses?: AgentStatus[]): Item[] => [
      ...AGENT_KINDS.map((agent): Item => {
        const s = statuses?.find((x) => x.kind === agent);
        return {
          agent,
          label: `${agent === current ? '$(pass-filled)' : '$(circle-large-outline)'} ${agentName(agent)}`,
          description: s ? statusText(s) : 'checking…',
          detail: s ? [s.account, s.path].filter(Boolean).join(' · ') || undefined : undefined,
        };
      }),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(info) What Review Desk sends, and who pays', action: 'about' },
    ];
    const mark = () => {
      const now = qp.items.find((i) => i.agent === current);
      if (now) qp.activeItems = [now];
    };
    qp.items = items();
    mark();
    qp.busy = true;
    void load().then(
      (statuses) => {
        qp.items = items(statuses);
        mark();
        qp.busy = false;
      },
      () => (qp.busy = false),
    );
    qp.onDidAccept(() => {
      const picked = qp.selectedItems[0];
      resolve(picked?.agent ?? picked?.action);
      qp.hide();
    });
    qp.onDidHide(() => {
      resolve(undefined);
      qp.dispose();
    });
    qp.show();
  });
}
