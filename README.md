# SoftHalo Usage

**Keeps your Claude Code quota and token usage always on screen.** This plugin records usage numbers to a local folder. The SoftHalo desktop app shows them in its always-on-top overlay, so you can check your 5-hour and weekly limits at a glance instead of typing `/usage`.

## Requirements

- **SoftHalo for Windows**, a version with AI usage. Without it, the plugin only writes small files that nothing reads.
- **macOS and Linux:** the plugin already writes to the right folder on each system, but SoftHalo for macOS does not show AI usage yet, and there is no SoftHalo for Linux yet.

## What it records

After each model request, the plugin adds that request's usage to a running total for the session:

- token counts (uncached input, cache reads, cache writes and output), per day, per model, and whether the request came from the main conversation or a subagent
- the number of requests, and how many reported no usage
- the plan-limit percentages and reset times Claude Code reports (Pro and Max plans)
- Claude Code's own cost estimate (API list prices, not a bill), split by the day it was spent; SoftHalo shows it only when there are no plan limits, as with an API key

It never records prompts, responses, tool output, file contents or account credentials. Session ids are kept so SoftHalo can tell sessions apart; the Claude configuration folder is identified only by a one-way hash, never by its path.

## Files this plugin writes and reads

The hooks module writes **only** these two files per Claude Code session, and nothing else anywhere:

| System | Files written |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Softhalo\usage\claude\claude-<session id>.a.json` and `…\claude-<session id>.b.json` |
| macOS | `~/Library/Application Support/Softhalo/usage/claude/claude-<session id>.a.json` and `….b.json` |
| Linux | `$XDG_STATE_HOME/softhalo/usage/claude/claude-<session id>.a.json` and `….b.json` (or under `~/.local/state/` when `XDG_STATE_HOME` is unset) |

- The path is built at run time from the system's local-data folder (`LOCALAPPDATA`, `HOME`, `XDG_STATE_HOME`) and the session id, which is why it cannot be written as fixed text. There is one write call, in `hooks/register.ts`; the file names come from `slotPath` in `hooks/core.ts`. Session ids that are not plain ids (letters, digits, `-`, `_`) are refused, so a path can never leave that folder.
- The two files alternate, so a crash mid-write never damages the newest copy. Each holds the session's usage in the `softhalo.claude-snapshot/3` format: token counts, plan-limit percentages, Claude Code's cost estimate, the session id and a one-way hash of the configuration folder. They are rewritten at most every 5 to 10 seconds while you work, and once more when the session ends.
- It **never** creates, edits or deletes build files, start-up or autostart entries, shell profiles, settings files (including Claude Code's), instructions files such as `CLAUDE.md`, or any file in your projects.

It reads only: its own two files (to continue after a restart), `…/usage/ack/claude-<session id>.json` (written by SoftHalo to confirm what it has saved, before the plugin trims days older than 35 days), and whether `~/Library/Application Support` exists (to recognise macOS). The macOS and Linux folders are ready for SoftHalo versions that read them.

## What it does not do

- No network requests of any kind. Nothing leaves your machine.
- No commands, panels, notifications or changes to Claude's behaviour.
- No reading of your conversation or your project's files.

## Install

```bash
claude plugin marketplace add ahujat/softhalo-usage
claude plugin install softhalo-usage@softhalo
```

Then install SoftHalo for Windows (a version with AI usage). Uninstalling the plugin stops all writes; you can delete the usage folder at any time.

## Development

- `node --test tests/core.spec.ts` runs the unit tests of the snapshot writer (Node 24 or later).
- `claude plugin test .` runs the hooks module against the engine.
- `claude plugin validate .` checks the manifest and the module.

The file format is `softhalo.claude-snapshot/3`. SoftHalo's collector tests read this plugin's real output (`tests/make-fixture.ts`), so a change to the format fails there first.

## Privacy

See [PRIVACY.md](PRIVACY.md).

## License

MIT. See [LICENSE](LICENSE).
