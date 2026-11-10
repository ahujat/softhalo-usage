# Privacy policy: Soft Halo Usage plugin

Effective 9 November 2026.

## What the plugin collects

From Claude Code's own usage events, and nothing else:

- token counts per model request: uncached input, cache reads, cache writes and output
- the model that answered, the day, and whether the request came from the main conversation or a subagent
- plan-limit percentages and their reset times, when Claude Code reports them
- Claude Code's own cost estimate for the session
- the session id, and a one-way hash of the Claude configuration folder's path

It does not collect prompts, responses, tool output, file contents, project names, account names, email addresses or credentials.

## How it is used

The data is written to a folder on your own computer (see the README for the path on each system) so the Soft Halo desktop app can show your usage and limits. The plugin makes no network requests. Nothing is sent to the developer, to Anthropic or to anyone else.

## How long it is kept

Each session's file keeps up to 35 days of daily totals that Soft Halo has confirmed it saved, and longer only while Soft Halo has not yet read them. The Soft Halo app keeps its own history under its own settings. Uninstalling the plugin stops all writes, and you can delete the usage folder at any time.

## Children

The plugin is not directed at children under 18.

## Contact

Questions about privacy: email privacy@softhalo.app.
