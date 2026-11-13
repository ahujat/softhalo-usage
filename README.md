# Soft Halo Usage

**Keeps your Claude Code quota and token usage always on screen.** This plugin records usage numbers to a local folder. The Soft Halo desktop app shows them in its always-on-top overlay, so you can check your 5-hour and weekly limits at a glance instead of typing `/usage`.

## Requirements

- **Windows** (Claude Code on Windows itself or in WSL), with **Soft Halo for Windows 2.0.5.22 or later**. Without it, the plugin only writes small files that nothing reads.

Soft Halo with AI usage is in beta. Get the signed 2.0.5.22 build from the [beta page](https://softhalo.app/download/beta-20522-3535fbf8dac88ffa); [REVIEWING.md](REVIEWING.md) has the checksum and setup steps.

## What it records

After each model request, the plugin adds that request's usage to a running total for the session:

- token counts (uncached input, cache reads, cache writes and output), per day, per model, and whether the request came from the main conversation or a subagent
- the number of requests, and how many reported no usage
- the plan-limit percentages and reset times Claude Code reports (Pro and Max plans)
- Claude Code's own cost estimate (API list prices, not a bill), split by the day it was spent; Soft Halo shows it only when there are no plan limits, as with an API key

It never records prompts, responses, tool output, file contents, account credentials or your email address. Session ids are kept so Soft Halo can tell sessions apart; the Claude configuration folder is identified only by a one-way hash, never by its path, and your Claude account only by a one-way hash of its email (see [Which account the limits belong to](#which-account-the-limits-belong-to)).

## Files this plugin writes and reads

The hooks module writes **only** these two files per Claude Code session, and nothing else anywhere:

- `%LOCALAPPDATA%\Softhalo\usage\claude\claude-<session id>.a.json`
- `%LOCALAPPDATA%\Softhalo\usage\claude\claude-<session id>.b.json`

- The path is built at run time from the system's local-data folder and the session id, which is why it cannot be written as fixed text. There is one write call, in `hooks/register.ts`; the file names come from `slotPath` in `hooks/core.ts`. Session ids that are not plain ids (letters, digits, `-`, `_`) are refused, so a path can never leave that folder.
- The two files alternate, so a crash mid-write never damages the newest copy. Each holds the session's usage in the `softhalo.claude-snapshot/3` format: token counts, plan-limit percentages, Claude Code's cost estimate, the session id, a one-way hash of the configuration folder and, with plan limits, a one-way hash of the account. They are rewritten at most every 5 to 10 seconds while you work, and once more when the session ends.
- It **never** creates, edits or deletes build files, start-up or autostart entries, shell profiles, settings files (including Claude Code's), instructions files such as `CLAUDE.md`, or any file in your projects.

It reads only: its own two files (to continue after a restart), `…/usage/ack/claude-<session id>.json` (written by Soft Halo to confirm what it has saved, before the plugin trims days older than 35 days), and, only where `LOCALAPPDATA` is not set, whether `~/Library/Application Support` exists. When Claude Code reports plan limits it also reads Claude Code's login record, `.claude.json`, for the account's email (see below). Inside WSL it also lists the user folders under `/mnt/c/Users` to find the one with a Soft Halo folder (see below).

### Which account the limits belong to

Plan limits belong to your Claude account, not to a configuration folder, so the same account used from Claude Code on Windows and in WSL should show one set of limits. When Claude Code reports plan limits, the plugin works out which account they belong to:

1. It asks Claude Code through `$.session.identity()`. Claude Code answers that only to plugins an organization installs through managed settings.
2. Otherwise it reads the email address of your login from Claude Code's own login record: `~/.claude.json`, or `.claude.json` inside the folder `CLAUDE_CONFIG_DIR` names. It takes `oauthAccount.emailAddress` and nothing else from that file, keeps nothing else in memory, and never changes the file.

It writes only a one-way hash of that email (`acct-` followed by 20 hex digits, from SHA-256) as `quota_key`. The email itself is never written anywhere. The hash is the same on every folder and system signed in to that account, which is how Soft Halo knows two folders share one account. The hash is not salted, because it must match across folders: someone who already knows your email and can read your usage folder could confirm it is yours. Without an account login (an API key, Bedrock, Vertex), `quota_key` stays empty and Soft Halo tells folders apart by their hash, as before.

### In WSL

When Claude Code runs inside WSL on the same Windows PC, the plugin writes to the same Windows folder, through the C: drive mount: `/mnt/c/Users/<Windows user>/AppData/Local/Softhalo/usage/`. It finds the Windows user by looking for an `AppData/Local/Softhalo` folder under `/mnt/c/Users`. If exactly one user has one, it uses that. If several do, it uses the one whose name matches your Linux user name. If it finds none, it writes nothing. If your C: drive is mounted elsewhere, or the names differ, set `SOFTHALO_USAGE_DIR` to the folder, for example `/mnt/c/Users/Ann/AppData/Local/Softhalo/usage`. `SOFTHALO_USAGE_DIR` also overrides the folder on Windows.

Apart from WSL, only Windows is supported. The code also picks a local folder when it runs on another system (`~/Library/Application Support/Softhalo/usage` on macOS, `$XDG_STATE_HOME/softhalo/usage` or `~/.local/state/softhalo/usage` on other Linux systems) so it never writes anywhere unexpected, but no Soft Halo app reads those folders.

## What it does not do

- No network requests of any kind. Nothing leaves your machine.
- No commands, panels, notifications or changes to Claude's behaviour.
- No reading of your conversation or your project's files. From Claude Code's login record it reads only the account email, and writes only its hash.

## Status and plans

This is the first release (MVP) of Soft Halo's usage collection, and Claude Code is the first tool it covers. Soft Halo can show the usage of your other AI coding tools in the same overlay, each through its own add-on that writes to the same local folder in the same way: [Hermes](https://github.com/ahujat/softhalo-usage-hermes) and [OpenClaw](https://github.com/ahujat/softhalo-usage-openclaw), with Codex in beta. This plugin stays Claude Code only.

## Install

```bash
claude plugin marketplace add ahujat/softhalo-usage
claude plugin install softhalo-usage@softhalo
```

Then install [Soft Halo for Windows 2.0.5.22 or later](https://softhalo.app/download/beta-20522-3535fbf8dac88ffa). Uninstalling the plugin stops all writes; you can delete the usage folder at any time.

## Development

- `node --test tests/core.spec.ts` runs the unit tests of the snapshot writer (Node 24 or later).
- `claude plugin test .` runs the hooks module against the engine.
- `claude plugin validate .` checks the manifest and the module.

The file format is `softhalo.claude-snapshot/3`. Soft Halo's collector tests read this plugin's real output (`tests/make-fixture.ts`), so a change to the format fails there first.

## Privacy

See [PRIVACY.md](PRIVACY.md).

## License

MIT. See [LICENSE](LICENSE).
