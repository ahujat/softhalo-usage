# SoftHalo Usage

**Keeps your Claude Code quota and token usage always on screen.** This plugin records usage numbers to a local folder. The SoftHalo desktop app shows them on its HaloClock overlay, so you can check your 5-hour and weekly limits at a glance instead of typing `/usage`.

The SoftHalo desktop app is required to see the display. Without it, the plugin only writes small files that nothing reads.

## What it records

After each model request, the plugin adds that request's usage to a running total for the session:

- token counts (uncached input, cache reads, cache writes and output), per day, per model, and whether the request came from the main conversation or a subagent
- the number of requests, and how many reported no usage
- the plan-limit percentages and reset times Claude Code reports (Pro and Max plans)
- Claude Code's own cost estimate for the session

It never records prompts, responses, tool output, file contents or account credentials. Session ids are kept so SoftHalo can tell sessions apart; the Claude configuration folder is identified only by a one-way hash, never by its path.

## Where it writes

One folder, on your own machine:

| System | Folder |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Softhalo\usage\` |
| macOS | `~/Library/Application Support/Softhalo/usage/` |
| Linux | `$XDG_STATE_HOME/softhalo/usage/`, or `~/.local/state/softhalo/usage/` |

Each session is written to two files, `claude/claude-<session id>.a.json` and `.b.json`, alternately, at most every 5 to 10 seconds while you work and once more when the session ends. The plugin also reads `ack/claude-<session id>.json`, which SoftHalo writes to confirm what it has saved, before trimming days older than 35 days from its files.

## What it does not do

- No network requests of any kind. Nothing leaves your machine.
- No commands, panels, notifications or changes to Claude's behaviour.
- No reading of your conversation or your project's files.

## Install

```bash
claude plugin marketplace add ahujat/softhalo-usage
claude plugin install softhalo-usage@softhalo
```

Then install the SoftHalo desktop app. Uninstalling the plugin stops all writes; you can delete the usage folder at any time.

## Development

- `node --test tests/core.spec.ts` runs the unit tests of the snapshot writer (Node 24 or later).
- `claude plugin test .` runs the hooks module against the engine.
- `claude plugin validate .` checks the manifest and the module.

The file format is `softhalo.claude-snapshot/3`. SoftHalo's collector tests read this plugin's real output (`tests/make-fixture.ts`), so a change to the format fails there first.

## Privacy

See [PRIVACY.md](PRIVACY.md).

## License

MIT. See [LICENSE](LICENSE).
