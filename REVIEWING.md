# Trying Soft Halo Usage (for reviewers and beta testers)

The plugin writes token usage and plan-limit readings to a local folder; the Soft Halo desktop app for Windows shows them in its always-on-top overlay. The Soft Halo version that displays them (2.0.5) is in beta, so this page links to the beta build.

## What you need

- Windows 10 (build 17763 or later) or Windows 11
- Claude Code, signed in. A Pro or Max plan shows the quota bars; an API key shows the estimated cost line instead.
- Soft Halo beta 2.0.5.28, signed by Azonic International (75,496,040 bytes). Plugin 1.1.0 needs 2.0.5.22 or later, the first build that shows one Claude account used from two folders (for example Windows and WSL) as one set of limits in every case:
  https://softhalo.app/downloads/windows/beta-2.0.5.28-9afbdaef9ce076b6/SoftHalo-Setup-2.0.5.28-win-x64.exe
  - SHA-256: `9AFBDAEF9CE076B6ED1525FF7E6D93D61C0B4A4F5F9152ED59A446B0F0389C59` (also in [SHA256SUMS.txt](https://softhalo.app/downloads/windows/beta-2.0.5.28-9afbdaef9ce076b6/SHA256SUMS.txt)). To check it in PowerShell: `Get-FileHash .\SoftHalo-Setup-2.0.5.28-win-x64.exe`
  - VirusTotal, 13 November 2026: [0 of 67 engines](https://www.virustotal.com/gui/file/9afbdaef9ce076b6ed1525ff7e6d93d61c0b4a4f5f9152ed59a446b0f0389c59) flagged it.
  - Beta page with release notes: https://softhalo.app/download/beta-20528-c17d7d2ef502eea9
  - Upgrading from an earlier beta that showed two sets of Claude bars: the first view after the upgrade can show the older reading until your next Claude Code message.

## Steps (about 10 minutes)

1. Run the Soft Halo installer and choose **Personal** mode. No administrator rights are needed.
2. When Soft Halo opens, choose **Start my free trial** (no payment needed).
3. In a terminal, install the plugin:
   ```bash
   claude plugin marketplace add ahujat/softhalo-usage
   claude plugin install softhalo-usage@softhalo
   ```
4. Start a new Claude Code session and send a few messages.
5. Within about 15 seconds, the Soft Halo overlay grows an AI usage section:
   - one bar per plan-limit window (for example "Claude 5h", "Claude Week") with the percentage left and the exact reset time;
   - "AI today … tokens";
   - with an API key instead of a plan: "Claude API cost today $… (estimate)".

## What the plugin does and does not do

- Writes only to `%LOCALAPPDATA%\Softhalo\usage\` (token counts, plan-limit percentages, Claude Code's cost estimate, session ids, a one-way hash of the configuration folder and, with plan limits, a one-way hash of the account email). See [Files this plugin writes and reads](README.md#files-this-plugin-writes-and-reads).
- Never reads or stores prompts, responses, tool output or project files.
- Reads one field, `oauthAccount.emailAddress`, from Claude Code's login record `.claude.json`, and only when `$.session.identity()` refuses (it answers only org-managed plugins). Only its SHA-256 hash is written, as `quota_key`, so one account used from Windows and WSL shows one set of limits. See [Which account the limits belong to](README.md#which-account-the-limits-belong-to).
- Makes no network requests: its hooks module calls only file, environment, clock and session functions (see `claude plugin validate` output), and its test suite fails if it ever calls `http.fetch`.
- No commands, panes or notifications inside Claude Code.

## Removing it

Uninstall the plugin with `claude plugin uninstall softhalo-usage`, and Soft Halo from Windows Settings > Apps. The usage folder can be deleted at any time.

Contact: hello@softhalo.app
