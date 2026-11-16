import {
  authOf,
  notAllowed,
  noticeDetail,
  noticeTitle,
  type AgentInfo,
  type AgentKind,
} from '../shared/agentUse';
import type { AgentRunner, RunHandle, RunResult } from './runner';

/** Where it keeps what it knows across sessions (VS Code's globalState). */
export interface Store {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/** The notice as accepted: asked again when its wording changes in a way that matters. */
const NOTICE_VERSION = 1;
/** Kept per agent: allowing Claude Code is not allowing Codex. (Claude's keys predate Codex.) */
const ACCEPTED: Record<AgentKind, string> = {
  claude: 'reviewDesk.claudeNotice',
  codex: 'reviewDesk.codexNotice',
};
const SOURCE: Record<AgentKind, string> = {
  claude: 'reviewDesk.claudeAuthSource',
  codex: 'reviewDesk.codexAuthSource',
};
const CONTINUE = 'Continue';

/**
 * The agent runs (Claude Code or Codex) as the reviewer knows them: asked once per agent
 * before its first run (whose account and limits they use), and which account they run
 * with, as the agent reports it.
 */
export class AgentUse {
  private readonly asking = new Map<AgentKind, Promise<boolean>>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly store: Store,
    /** The agent runs go to now (reviewDesk.agent). */
    private readonly agent: () => AgentKind,
    /** Its executable, '' when none is found. */
    private readonly pathOf: (kind: AgentKind) => string,
    /** A modal with buttons: the one pressed (Prompts.choose). */
    private readonly choose: (
      message: string,
      buttons: string[],
      detail?: string,
    ) => Promise<string | undefined>,
  ) {}

  /** Whether the notice of the agent (the current one by default) was accepted. */
  accepted(kind: AgentKind = this.agent()): boolean {
    return this.store.get<number>(ACCEPTED[kind]) === NOTICE_VERSION;
  }

  async accept(kind: AgentKind = this.agent()): Promise<void> {
    await this.store.update(ACCEPTED[kind], NOTICE_VERSION);
  }

  /** Forgets the answer, so the notice is asked again (tests). */
  async reset(kind: AgentKind = this.agent()): Promise<void> {
    await this.store.update(ACCEPTED[kind], undefined);
  }

  /**
   * Whether the agent may run: asks the first time, once for the runs that start together,
   * and again later when the notice was dismissed.
   */
  allowed(kind: AgentKind = this.agent()): Promise<boolean> {
    if (this.accepted(kind)) return Promise.resolve(true);
    let asking = this.asking.get(kind);
    if (!asking) {
      asking = this.choose(noticeTitle(kind), [CONTINUE], noticeDetail(kind, this.pathOf(kind)))
        .then(async (picked) => {
          if (picked !== CONTINUE) return false;
          await this.accept(kind);
          return true;
        })
        .finally(() => this.asking.delete(kind));
      this.asking.set(kind, asking);
    }
    return asking;
  }

  info(): AgentInfo {
    const agent = this.agent();
    const source = this.store.get<string>(SOURCE[agent]);
    return {
      agent,
      path: this.pathOf(agent),
      source,
      auth: source ? authOf(agent, source) : undefined,
    };
  }

  /** Called when what info() says may have changed. */
  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Tells the listeners: the agent was switched, or its account became known. */
  changed(): void {
    this.listeners.forEach((l) => l());
  }

  /** Keeps how the agent signs in, as it said in a run or when asked (agentStatus). */
  record(kind: AgentKind, source: string | undefined): void {
    if (!source || source === this.store.get<string>(SOURCE[kind])) return;
    void this.store.update(SOURCE[kind], source).then(() => this.changed());
  }

  /** `runner` as Review Desk uses it: asks first (allowed), and keeps how its runs sign in. */
  gate(runner: AgentRunner): AgentRunner {
    return {
      run: (request, onText): RunHandle => {
        const kind = this.agent();
        let inner: RunHandle | undefined;
        let cancelled = false;
        const done = this.allowed(kind).then((ok): RunResult | Promise<RunResult> => {
          if (!ok) return { text: '', error: notAllowed(kind) };
          if (cancelled) return { text: '', error: 'Cancelled.' };
          // Run by the agent allowed here, whatever the setting says by now.
          inner = runner.run({ ...request, agent: kind }, onText);
          return inner.done.then((r) => {
            this.record(kind, r.authSource);
            return r;
          });
        });
        return {
          cancel: () => {
            cancelled = true;
            inner?.cancel();
          },
          done,
        };
      },
    };
  }
}
