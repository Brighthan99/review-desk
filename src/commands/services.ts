import type { AgentUse } from '../agent/agentUse';
import type { AgentKind, AgentStatus } from '../shared/agentUse';
import type { ReviewController, StartOptions } from '../controller';
import type { PullRequestService } from '../github/prService';
import type { ChangeHandles } from '../ui/changeHandles';
import type { ChatConnection } from '../ui/chatConnection';
import type { PanelController } from '../ui/panelController';
import type { Prompts } from '../ui/prompts';
import type { SavedReviewsTree } from '../ui/reviewsTree';
import type { ReviewTree } from '../ui/tree';
import type { WorktreesTree } from '../ui/worktreesTree';

/** What the commands work with, made once by `activate`. */
export interface Services {
  controller: ReviewController;
  panel: PanelController;
  tree: ReviewTree;
  handles: ChangeHandles;
  saved: SavedReviewsTree;
  github: PullRequestService;
  chat: ChatConnection;
  prompts: Prompts;
  worktrees: WorktreesTree;
  /** The agents that write the notes: the notice and account (use), and how each stands. */
  agents: { use: AgentUse; status(kind: AgentKind): Promise<AgentStatus> };
  /** Starts a review, then opens the panel if the setting says so. */
  start(options?: StartOptions): Promise<boolean>;
}

/** Registers a command for as long as the extension is active. */
export type Command = (id: string, fn: (...args: never[]) => unknown) => void;
