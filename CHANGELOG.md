# Changelog

## 0.1.1 (preview)

- The README opens with a short demo: a line picked and explained, a follow-up question answered, and a PR comment drafted.

## 0.1.0 (preview)

The first public preview.

- **Reviews**: review a branch, a range of commits, uncommitted work or a GitHub pull request from the Review list, with Viewed checkboxes, a comparison you can change on either side, saved reviews per branch, and git worktrees for other branches.
- **Notes on demand**: pick lines or click Explain above a changed block, and Claude Code writes a note beside the code (Why, How, Risk, Context, Question, Overview). Ask follow-up questions on a note or about any code.
- **Summary of the change**: what changed across the files, a suggested reading order and a diagram of the flow it adds or alters.
- **Pull requests**: open one from a list or by its address, bring its review threads in, draft PR comments with Claude and post them, post notes as a review, and see new replies and resolved threads. Replies can be summarized or drafted by Claude.
- **Any language** for notes and answers, with one-click translation.
- **Claude Code chat connection**: your Claude Code chat can read the notes and save its answers as notes.
- **Your own Claude Code, or Codex (ChatGPT)**: Review Desk runs the `claude` (or, with `reviewDesk.agent` set to `codex`, the `codex`) you installed and signed in to. It asks once before an agent's first run, and the notes panel shows which agent and whether runs use your plan (Claude or ChatGPT) or an API key. **Choose Agent…** lists both agents with how each stands (installed, signed in, plan, account) and offers to sign in.
- **Safe with untrusted code**:
  - Claude Code runs with your own settings only and read-only tools; Codex in its read-only sandbox, without web search or the MCP servers of your Codex config.
  - Settings that run a program or spend usage are read from your user settings only.
  - GitHub tokens go to GitHub only.
  - Git commands never take the index lock your own commits need.
