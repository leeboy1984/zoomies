# `record` mode (discovering real payloads)

`record` mode stores the payloads Claude Code sends to the hooks **exactly as
they are**, to check event and field names against real data.

> **Warning.** A recording contains paths, commands, prompts, the contents of
> written files and tool responses. Use it only with personal projects. It is
> stored in `recordings/` (git-ignored, readable only by your user). Delete it
> when you are done.

## 1. Start the server in record mode

```sh
npm install                 # builds dist/ in the same step
npm run record              # = node bin/zoomies.mjs serve --record
```

It listens only on `http://127.0.0.1:3737` and prints the file it records to
(`recordings/<date>.jsonl`). Each line is:

```json
{ "v": 1, "receivedAt": 1790000000123, "sentAt": 1790000000100, "payload": { "...": "raw payload" } }
```

`sentAt` is set by the forwarder when it starts and `receivedAt` by the server:
they are used to measure latency and to spot events arriving out of order.

## 2. Hook up a personal project

From the zoomies root:

```sh
node bin/zoomies.mjs hooks-snippet
```

It prints a `"hooks"` block with the 18 events worth observing, all pointing
to this checkout's forwarder (`node "<path>/bin/zoomies-hook.cjs"`).

In your personal project, paste that block into `.claude/settings.local.json`
(create it if needed; if it already has `"hooks"`, add the entries by hand
without deleting yours). Check that `settings.local.json` is git-ignored in
that project. Restart Claude Code there and check with `/hooks` that they
show up.

The forwarder writes nothing, always exits with 0 and takes ~30 ms per event.
If the server is not running, nothing happens.

## 3. What is worth trying

The more of these cases show up in the recordings, the less has to be guessed:

- [ ] A new session and a resumed one (`claude --resume`).
- [ ] Tools: `Read`, `Grep`, `Glob`, `Edit`, `Write`, `Bash`, `WebFetch`,
      `WebSearch`.
- [ ] A failing command (e.g. `cat does-not-exist.txt`) → does
      `PostToolUseFailure` arrive?
- [ ] Interrupting Claude with Esc in the middle of a tool.
- [ ] Subagents: explicitly ask for `Explore`, `Plan` and `general-purpose`,
      and two subagents in parallel → do their `PreToolUse` events carry
      `agent_id`?
- [ ] Permissions in normal mode: accept one and deny another.
- [ ] `/compact`.
- [ ] Leaving it alone for more than 60 s after it finishes (`Notification`
      `idle_prompt`).
- [ ] Task list: a session with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1 claude`
      (`TaskCreate`/`TaskUpdate` tools) and, optionally, another with
      `CLAUDE_CODE_ENABLE_TODO_TOOLS=1 CLAUDE_CODE_ENABLE_TASKS=0 claude`
      (`TodoWrite`).
- [ ] Two sessions at once in different projects.
- [ ] Exiting with `/exit` or Ctrl+D (`SessionEnd`).

## 4. Reviewing without exposing data

Stop the server with Ctrl+C and summarise the recording:

```sh
node bin/zoomies.mjs inspect recordings/<file>.jsonl
```

The output only contains event names, field names, "catalogue" values
(`tool_name`, `agent_type`, `notification_type`, `source`, `reason`,
`trigger`), latencies, how many events arrived out of order and how many
subagent tool events can be attributed to a `SubagentStart`. **That output is
safe to share.** If you want to share a raw recording, review it first.

## 5. Turning it off

- Remove the `"hooks"` block from the project's `.claude/settings.local.json`.
- Delete `recordings/` once you no longer need it.
