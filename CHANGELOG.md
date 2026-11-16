# Changelog

## Unreleased (1.1.1)

- In WSL, when the plugin can't find Soft Halo's folder (the C: drive isn't mounted, Soft Halo isn't installed on Windows, or several Windows users have it), it adds one dim line to the transcript saying why and what to do first, instead of staying silent.
- It looks for the folder again at most once a minute while the session runs, so mounting the drive or installing Soft Halo starts recording without restarting Claude Code.
- When the usage folder can't be written, one transcript line says so, once.

## 1.1.0 (12 November 2026)

- Plan-limit readings carry a one-way hash of the signed-in Claude account, so Soft Halo shows one set of 5-hour and weekly limits per account, across configuration folders and across Windows and WSL. The email itself is never recorded.
- Inside WSL, writes to Soft Halo's folder on the Windows side through `/mnt/c`; `SOFTHALO_USAGE_DIR` overrides the folder.
- Needs Soft Halo for Windows 2.0.5.20 or later.

## 1.0.0 (9 November 2026)

- First release: records each Claude Code session's token usage, plan-limit percentages and cost estimate to Soft Halo's local folder.
