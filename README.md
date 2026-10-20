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
its executable bit set. `--from-default-profile acp` boots a fresh copy of the shipped `acp`
profile into `$DSH_HOME/profiles` if you do not have one yet.

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
  `~/.local/state/dsh-paseo/transcripts/` and injects it back as timeline items when the session
  reopens;
- **stream correctness**: DSH tags reasoning and text blocks of one message with the same
  `messageId`; the bridge splits them so reasoning and answer render as separate items.

- ACP session persistence: DSH sessions restore natively when Paseo reopens them, including DSH-side
  agent context (verified: words remembered before a reload or ACP process kill are recalled after).
- The plugin has no client-side code; Paseo's standard ACP timeline renderer covers everything.

