# Privacy policy: Soft Halo Usage plugin

Effective 12 November 2026.

## What the plugin collects

From Claude Code's own usage events and, for plan limits, its login record:

- token counts per model request: uncached input, cache reads, cache writes and output
- the model that answered, the day, and whether the request came from the main conversation or a subagent
- plan-limit percentages and their reset times, when Claude Code reports them
- Claude Code's own cost estimate for the session
- the session id, and a one-way hash of the Claude configuration folder's path
- with plan limits, a one-way hash of the signed-in account's email address, so the same account used from several folders shows one set of limits

To make that hash, the plugin reads the email address from Claude Code's login record (`.claude.json`) on your computer, only when Claude Code doesn't provide it through its plugin API. It reads no other field of that file and never writes the email itself anywhere.

It does not collect prompts, responses, tool output, file contents, project names, account names or credentials, and it does not store email addresses.

## How it is used

The data is written to a folder on your own computer (see the README for the path on each system) so the Soft Halo desktop app can show your usage and limits. The plugin makes no network requests. Nothing is sent to the developer, to Anthropic or to anyone else.

## How long it is kept

Each session's file keeps up to 35 days of daily totals that Soft Halo has confirmed it saved, and longer only while Soft Halo has not yet read them. The Soft Halo app keeps its own history under its own settings. Uninstalling the plugin stops all writes, and you can delete the usage folder at any time.

## Children

The plugin is not directed at children under 18.

## Contact

Questions about privacy: email privacy@softhalo.app.
