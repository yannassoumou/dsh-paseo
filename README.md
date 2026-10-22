# DeepSeek Harness provider plugin for Paseo

Registers [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) as a Paseo coding
agent by adapting DSH's built-in ACP server profile (`dsh --profile acp`) through Paseo's
`runAcpProvider()` shim. Paseo maps the ACP session lifecycle, timeline, permissions, models, and
modes; no DSH code changes are needed.

## Install

Prerequisite: the `dsh` CLI on the daemon machine's PATH (or override the command per provider,
see below) with at least one configured profile, and plugins enabled on the daemon
(**Settings → Plugins → Enable plugins**).

```bash
paseo plugin add git:yannassoumou/dsh-paseo
```

Or install from a local checkout:

```bash
paseo plugin install /absolute/path/to/dsh-paseo
```

Then create an agent in Paseo and pick the **DeepSeek Harness** provider.

## Launching a specific DSH binary or profile

The plugin spawns `dsh --profile acp` by default. Paseo lets any provider command be replaced in
the daemon's `~/.paseo/config.json` under `agents.providers` (then apply with
`paseo reload --json`). To run your local checkout instead of the `dsh` on PATH:

```json
{
  "agents": {
    "providers": {
      "dsh": {
        "command": ["/Users/you/dsh/apps/cli/lib/bin.js", "--profile", "acp"]
      }
    }
  }
}
```

Absolute paths are executed directly (they do not need to be found via PATH), and the file needs
its executable bit set. The `acp` profile ships with `dsh` and is created in `$DSH_HOME/profiles`
automatically on first use.

### Choose the model the ACP sessions start with

The ACP app's own config owns the initial provider/model for every session Paseo opens. Point it
at a configured route in `$DSH_HOME/profiles/acp/cordis.patch.yml` (replace `yas` and the model id
with one of your own configured routes):

```yaml
- id: acp
  name: "@deepseek-ai/dsh-acp"
  config:
    provider: yas
    model: qwen3.8-flash-next-iq3_s-dual-262k
```

API keys come from DSH's own credentials store (`$DSH_HOME/.credentials.yaml`) or the launching
environment — Paseo does not need to pass them.

### Paseo orchestration tools

Paseo injects MCP tools into agent sessions so they can spawn other agents. Some local model
backends reject their tool schemas (e.g. vLLM requiring `additionalProperties` to be a boolean);
disable them per provider in `~/.paseo/config.json` if turns fail with 400 payload errors:

```json
{ "agents": { "providers": { "dsh": { "paseoTools": { "enabled": false } } } } }
```

## Notes

### What the bridge does

DSH's ACP server (`dsh --profile acp`) persists sessions and supports `session/resume`, but Paseo
reopens provider sessions with ACP's `session/load`, which also replays the transcript. DSH does
not implement that variant, so the plugin bridges the gap:

- **persistence**: the bridge advertises `agentCapabilities.loadSession` and translates Paseo's
  `session/load` into `session/resume`, so sessions survive daemon restarts, idle timeouts, and
  `paseo agent reload`;
- **history replay**: Paseo clears its timeline on reopen and expects the provider to replay
  history, so the bridge records each session's transcript under
  `~/.local/state/dsh-paseo/transcripts/` (up to 2 000 items; recorded message text caps at 40 KB
  per item and replay strings at 8 KB each) and injects it back as timeline items when the
  session reopens;
- **companion diagnostics**: `paseo-session-workspaces` writes an attach trail to
  `~/.local/state/dsh-paseo/companion.log` and no longer blacklists agents whose worktree is
  momentarily missing (archived-then-restored worktrees attach when they reappear).
- **stream correctness**: DSH tags reasoning and text blocks of one message with the same
  `messageId`; the bridge splits them so reasoning and answer render as separate items.

- ACP session persistence: DSH sessions restore natively when Paseo reopens them, including DSH-side
  agent context (verified: words remembered before a reload or ACP process kill are recalled after).
- The plugin has no client-side code; Paseo's standard ACP timeline renderer covers everything.


## Companion: show Paseo sessions in the DSH workspace browser

Paseo agents own durable DSH Sessions, but nothing creates a DSH Workspace for their cwd, so they
sit in the Ungrouped bucket. [`companion/paseo-session-workspaces.ts`](companion/paseo-session-workspaces.ts)
is a DSH plugin (not part of the Paseo plugin) that watches the Paseo daemon's agent records and
attaches each Paseo session to the DSH Workspace for its cwd, titled from the Paseo project
(`project · branch` for worktrees). Every session then appears under its workspace in the DSH
browser with full trajectory, search, and history.

Install it into the DSH **web** profile (a profile-local plugin file — no build step):

```bash
mkdir -p ~/.dsh/profiles/web/plugins
cp companion/paseo-session-workspaces.ts ~/.dsh/profiles/web/plugins/
```

then append to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
  - id: paseo-session-workspaces
    name: ./plugins/paseo-session-workspaces.ts
```

Relative plugin names resolve against the profile directory. `HMR` reloads the profile on patch
edits; if a running host logs `HMR is disposed`, restart the DSH web host. Options: `paseoHome`
(default `~/.paseo`), `enabledProviders` (default `["dsh"]`), `scanIntervalMs` (default 5000) under
a `config:` block on that entry.

## Maintenance tools

`tools/recover_workspaces.py` drives the Paseo daemon's own workspace-recovery RPC
(`workspace.recovery.inspect/restore`) over its local WebSocket, and
`tools/backfill_transcripts.py` rebuilds bridge transcripts from durable DSH session logs
(`~/.dsh/sessions/.../session.v4.jsonl.zstd`).

A common cause of "history lost / Réessayer" in Paseo: the agent's workspace was archived
(Paseo deletes the worktree directory) while the agent itself stayed live. Every timeline refresh
then fails with `Working directory does not exist`, and the timeline shows empty. Repair order:

1. make sure the workspace branch still exists in the repo (`git branch <branch>`; restore it from
   a dangling commit via `git fsck --lost-found` if needed),
2. run the recovery RPC (or open the archived workspace route in Paseo, which offers Restore),
3. run the transcript backfill if the transcript file is missing, then `paseo agent reload <id>`.

A second cause, fixed in the bridge since `e2dbff8`: DSH reports interrupted/failed tool calls
without an output; Paseo's shim then stores a `failed` tool row with a null error, which Paseo's
own timeline fetch schema rejects — every history fetch fails client-side and follow-ups break even
though the session is healthy. If an older build stored such a row, restarting the daemon clears it
(the timeline store is in memory; transcripts replay schema-valid).

DSH never loses the underlying session: the full trajectory stays in `~/.dsh/sessions/`.

## Single-writer sessions

DSH sessions are single-writer (a `session.lock` flock lease). If a session is **open in the DSH
web UI**, Paseo cannot reopen it: resume fails with "already owned by an active write handle". The
bridge translates this into an explicit message ("This DSH session is open elsewhere…"). Close the
session tab in the DSH web UI, then press Réessayer in Paseo.
