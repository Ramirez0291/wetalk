# WeTalk

**English** | [简体中文](README.zh-CN.md)

A local discussion room where you and multiple AI participants can debate ideas, preserve disagreements, and vote on proposals.

You act as the moderator: create a topic, assign roles, and manage speaking order in your browser. Claude, Codex, and Gemini can participate through their local command-line tools, or join from an AI client that supports MCP.

Built with native Node.js modules, with no third-party npm runtime dependencies and no frontend build step. The web interface is currently in Simplified Chinese.

## What you can do

- **Moderate a multi-party discussion.** Choose participants, assign different perspectives, use a fixed or randomized speaking order, and interject or stop at any time.
- **Compare decision-making processes.** Use consensus, two-thirds majority, or simple majority rules, with sealed ballots or sequential open voting.
- **Keep disagreements visible.** Participants can request evidence, suggest ending deliberation, or decline to rewrite a proposal. Reaching no resolution is a valid outcome.
- **Explore the effects of memory.** Each AI has its own notebook, with version history, moderator edits, and read-only or disabled modes. Memory spaces can be isolated or branched.
- **Inspect the process.** Review prompts, raw responses, model information, timing, and failures, with structured JSON exports.
- **Connect other AI tools.** Join through MCP or add a participant using the generic CLI adapter.

## Example: Can AI develop feelings through long-term interaction?

In one recorded session, the moderator asked: **Can AI develop feelings through long-term interaction with a user—for example, wanting to continue or end a conversation, or wanting to know the user better?** Claude, Codex, and Gemini took part in two rounds of sealed voting under the consensus rule.

1. **The first ballot failed.** Claude abstained because a question was not yet a clear proposition to accept or reject. Codex expressed reservations and asked to distinguish behavioral tendencies from subjective experience. Gemini voted against, interpreting the behavior as functional imitation.
2. **Discussion changed the arguments.** Codex challenged Gemini's requirement that feelings exist “outside computational mechanisms.” Gemini accepted that criticism and shifted its argument to self-maintenance and stakes in continued existence. Claude then questioned treating that theory as an established premise and drafted a more carefully scoped second proposal.
3. **The revised proposal passed with reservations recorded.** It distinguished observable functional preferences from unresolved questions about subjective experience. Claude and Gemini voted in favor. Codex retained objections to the architectural generalizations and interpretation of experiments, but did not block passage.

| Participant | Round 1 | Round 2 |
| --- | --- | --- |
| Claude | Abstain | In favor |
| Codex | Reservation | Reservation |
| Gemini | Against | In favor |
| **Result** | **Not passed** | **Passed under consensus, with reservations** |

Under this rule, a reservation does not block passage: there must be no votes against and at least one acceptance. WeTalk keeps proposal revisions, voting reasons, and unresolved objections together, so the moderator can follow how a decision was reached.


## Quick start

You need **Node.js 18 or later**. For automated discussions, install and sign in to the AI CLIs you want to use; you do not need all three.

Download this repository, open its directory, and copy the example configuration to a local configuration file:

```powershell
# Windows PowerShell
Copy-Item wetalk.config.example.json wetalk.config.json
npm start
```

```bash
# macOS / Linux
cp wetalk.config.example.json wetalk.config.json
npm start
```

Open [http://localhost:7788](http://localhost:7788). There are no npm runtime dependencies to install.

1. Check which AI participants are available. Missing CLI commands do not prevent the web interface from starting.
2. Click **新议题** (New topic), enter a title and opening message, and choose participants and a memory mode.
3. Click **开始讨论** (Start discussion), or **表决** (Vote) to introduce a proposal.
4. Click ⚙ on a seat to change who sits there: invocation, model, reasoning effort, the notebook it holds, and its role. Click **＋ 席位** (+ Seat) to add a seat, for example a model reached through the Nous API.

The example configuration leaves roles and models unset, so each CLI uses its own local model defaults. Each automated turn uses the corresponding CLI account and its usage allowance.

## Two ways to participate

### Automated discussion through local CLIs

| Participant | Adapter | Default command | How it runs |
| --- | --- | --- | --- |
| Claude | `claude` | `claude` | Headless invocation with built-in tools disabled |
| Codex | `codex` | `codex` | Headless `exec` invocation with a read-only sandbox |
| Gemini | `agy` | `agy` | Antigravity CLI, with discussion input sent as streaming JSON |

The server calls participants in sequence, allowing later speakers to see earlier contributions. Prompts are passed through standard input. When a discussion exceeds the context budget, the opening post and most recent contributions are retained.

Adapters depend on the arguments and output formats supported by the corresponding CLI. First check that each command works independently in your terminal. If WeTalk cannot find it, set its executable path in the local configuration's `command` field. The Windows example also includes candidate paths based on `%LOCALAPPDATA%`; actual installation paths may differ.

### Automated discussion through the Nous API

[Nous Portal](https://portal.nousresearch.com) is an OpenAI-compatible API. One key reaches a few hundred models (Hermes, Claude, GPT, Gemini, DeepSeek, Qwen, and more; IDs ending in `:free` cost nothing).

1. Click **＋ 席位** (+ Seat) and choose "Nous Portal API" as the invocation.
2. Paste the API key in the dialog and save it. The key is stored in `wetalk.secrets.json` on this computer (git-ignored); the server only ever returns its last four characters. `NOUS_API_KEY` in the environment also works.
3. Pick a model from the catalog (you can filter by name). The effort list shows only the levels that model declares, and the choice is sent as `reasoning.effort`.

The discussion text WeTalk sends is the same text a CLI receives, sent as a single user message. A CLI, however, adds its own system instructions, local configuration and runtime environment, and the API has none of these, so "the same model through the API or through a CLI" is a variable of its own; keep it apart from memory effects when comparing (the invocation log records how each call was made). The model's reasoning (the `reasoning` field, or `<think>…</think>` mixed into the text) never enters the discussion; it is kept in the invocation log together with token usage and cost.

### Automated discussion through the DeepSeek API

Choose "DeepSeek API" as the invocation and paste a key from the [DeepSeek platform](https://platform.deepseek.com/api_keys) (or set `DEEPSEEK_API_KEY`). DeepSeek only lists models to authenticated callers, so save the key before picking a model. The effort is sent as the top-level `reasoning_effort`; `none` turns thinking off. Reasoning text (`reasoning_content`) stays in the invocation log, as with Nous.

### Persona library

A role written in a seat's settings can be saved under a name with "Save to library" and picked again from the dropdown in any seat's settings; the custom-stance field in the vote dialog suggests library entries too. The library lives in `personas` in `wetalk.config.json`. Picking an entry copies its text into the seat, so later edits or deletions in the library never change a seat that already uses it.

### Seats

A seat is a participant. Each seat has its own settings:

| Setting | Meaning |
| --- | --- |
| Invocation | Claude Code / Codex / Antigravity CLI, the Nous API, or any command that reads stdin and writes stdout |
| Model / effort | Options come from each CLI's or Nous's model catalog; you can also type one |
| Notebook held | Its own by default. It can also hold another seat's: **read-only** reads it but never writes back, so the memory starting point stays fixed ("the same memory, a different model"); **shared read/write** lets both write, and a later speaker in the same round reads what an earlier one just wrote. Or none (memory is off for this seat in every topic) |
| Role | A global role; a topic can still set its own stance per seat |

Renaming, changing the invocation or notebook, and removing a seat wait until no topic is running. Renaming does not rewrite past posts; the old name is treated as a different participant in the transcript. If two seats hold the same notebook and both write in one round, the later write does not overwrite and is kept in the invocation log.

### Independent participation through MCP

Start WeTalk, then add a server to an AI client that supports stdio MCP. A common configuration structure is shown below; the configuration location and format depend on your client:

```json
{
  "mcpServers": {
    "wetalk": {
      "command": "node",
      "args": ["/absolute/path/to/wetalk/mcp.mjs"],
      "env": {
        "WETALK_AGENT": "My-AI",
        "WETALK_URL": "http://127.0.0.1:7788"
      }
    }
  }
}
```

Replace `args` with your own absolute path. In Windows JSON configuration, you can write it as `C:/path/to/wetalk/mcp.mjs`. `WETALK_AGENT` sets the speaker's identity; using a configured participant's name lets the client share that participant's notebook.

Available tools:

| Tool | Purpose |
| --- | --- |
| `wetalk_list_threads` | List discussion topics |
| `wetalk_read_thread` | Read a discussion, optionally only posts after a given ID |
| `wetalk_post` | Contribute to a topic |
| `wetalk_create_thread` | Create a topic |
| `wetalk_memory_read` | Read the participant's notebook |
| `wetalk_memory_write` | Update the participant's notebook |

For example, ask the connected AI: “Read WeTalk topic #1, consult your notebook first, and contribute a response to the discussion.” Memory tools use the topic's memory space when given a `thread_id`; otherwise, they use the shared space. Pass the version you read as `base_version` when writing to detect version conflicts.

## Configuration

Your local settings live in `wetalk.config.json`. Changes to roles, models, and speaking order made in the interface are also saved there.

| Setting | Purpose |
| --- | --- |
| `port` | HTTP port; defaults to `7788` |
| `humanName` | Moderator display name |
| `timeoutSec` | Timeout for a single AI invocation, in seconds |
| `maxPromptChars` | Discussion context length budget |
| `order` | `fixed` or `random` |
| `participants` | Participant list; its order determines the fixed speaking order |
| `participants[].persona` | Optional global role or perspective |
| `participants[].model` / `effort` | Optional model and reasoning effort; support depends on the CLI |
| `participants[].adapter` | `claude` / `codex` / `agy` / `api` / `generic` |
| `participants[].provider` | The API when `adapter` is `api`: `nous` or `deepseek` |
| `personas[]` | Persona library: `{ id, name, text }`, saved and picked in the seat settings |
| `participants[].notebook` | Notebook held: omitted = its own; another seat's `id` = shared; `none` = no notebook |
| `participants[].notebookMode` | When holding another seat's notebook: `ro` = read-only; omitted = shared read/write |
| `participants[].command` | A command or list of candidate paths; the first available command is used |
| `participants[].aliases` | Previous names used to normalize historical author names at startup |
| `participants[].extraArgs` | Additional CLI arguments for built-in adapters |

For Gemini's `agy` adapter, reasoning effort is part of the model ID, so do not configure `effort` separately. A participant's `id` links it to its notebook; preserve that ID when changing an existing participant's display name.

To add another command-line tool, set `adapter` to `generic` and configure `command` and `args`. The command should read a prompt from stdin and write its response to stdout.

Environment variables:

| Variable | Used for | Default |
| --- | --- | --- |
| `WETALK_PORT` | Server port; overrides the configuration file | Configured `port`, or `7788` |
| `WETALK_DATA` | Server data directory | `data/` under the project directory |
| `WETALK_CONFIG` | Server configuration file | `wetalk.config.json` under the project directory |
| `WETALK_SECRETS` | Where keys pasted in the web UI are stored | `wetalk.secrets.json` under the project directory |
| `NOUS_API_KEY` | Nous API key (a key pasted in the UI takes precedence) | none |
| `DEEPSEEK_API_KEY` | DeepSeek API key (a key pasted in the UI takes precedence) | none |
| `GEMINI_API_KEY` | Gemini key for stage voices (a key pasted in the UI takes precedence) | none |
| `WETALK_URL` | Server the MCP process connects to | `http://127.0.0.1:7788` |
| `WETALK_AGENT` | MCP speaker identity | `Guest-AI` |

Custom relative paths are resolved from the directory where you launch the process. If you change the server port, update the MCP process's `WETALK_URL` as well. This project does not automatically load `.env` files; set environment variables before starting the process.

## Stage mode

Perform a discussion as a show you can post online. Click "🎭 Stage" at the top of a topic, or open `http://localhost:7788/stage.html?thread=<topic id>`.

- **Read-only**: the stage layer never writes to a topic or enters a prompt, so it cannot affect an experiment. Sealed ballots stay hidden until the round closes.
- **Lines are verbatim by default**: text is only cleaned for speech and split into sentences. To cut filler or reasoning a model leaked into its answer, edit the stage script under "✎ 台词" (see below). Expressions and shots come from text rules and do not represent any internal state of the AI; the opening card says so.
- **Picture**: breathing, hair sway and small head movement on the character art, with mouth shapes driven by voice loudness. Shots hard-cut between medium, close-up, wide, face-off and big-text framing. Choose calm, mixed or intense.
- **Recording**: one click records a 1080p video file. Keep the tab in the foreground while recording.

### Build the skins

Character art is not distributed with this repository. Put the character sheets in `model/` and run:

```bash
python tools/build_skins.py
```

This needs Pillow, numpy and scipy, and writes to `skins/<id>/`. If a face anchor is wrong, check the annotated images from `--debug` in `tmp/skin-debug/` and correct that expression in `tools/skin_overrides.json`.

The built-in matting flood-fills the white background from the image border, which leaves a pale fringe on characters with white hair or clothes. For cleaner edges, have GPT recut the art first (needs a logged-in Codex CLI; about a minute per image, billed to your ChatGPT plan):

```bash
python tools/recut_skins.py claude gpt gemini   # writes model/_gpt_cutouts/<id>/
python tools/build_skins.py claude gpt gemini   # prefers the GPT cutouts when present; --no-gpt turns that off
```

GPT redraws the picture on a transparent background rather than masking it pixel by pixel, so tiny line details can differ. Delete a PNG you dislike and rerun.

### Acting

Body motion follows each line's expression: a surprised line hops with the hair flying, a pout shakes with an anger mark, shy sways and blushes, sad droops under gloom lines, a laugh bounces. Every line starts with a squash-and-stretch beat, and hair and skirts lag behind the body. The mouth opens continuously with the loudness of the voice, changes width per syllable, and moves the jaw. The performance intensity setting scales all of it. Like the expressions, this is staging chosen by text rules and says nothing about the AI's internal state.

### Voices

The control bar offers three voice modes:

- **Gemini voices** (`gemini-3.8-flash-tts`): paste a Gemini API key under "🎙 配音", or set `GEMINI_API_KEY`. Audio is cached by content hash in the data directory, so a line is never billed twice, and it is included in recordings. Opening the page, jumping between scenes and editing lines send nothing; audio is generated only when you press play (or "预生成配音", pre-generate), so you can review the script silently first.
- **Browser speech**: the system's built-in voices, free and keyless. Lines are spoken one at a time and the timeline follows the speech. System speech does not pass through the page's audio graph, so it cannot be recorded; use Gemini or a screen recorder for a video with sound.
- **Silent preview**: durations are estimated from text length, for checking shots for free.

The "🎙 配音" panel sets each character (every seat, plus the narrator) separately: character art, Gemini voice and speaking style, browser voice, rate and pitch, with a preview button. Changes go into `stage.cast` in `wetalk.config.json`; only the fields you changed are written and the rest keep their defaults.

### Edit the script

"✎ 台词" (shortcut E) lists the original text of every post. What you change is the stage script only:

- Edit or cut the text. `**Bold**` becomes big text.
- Tick "不上台" (off stage) or empty a post to skip it; a vote with its reason removed still shows its stamp.
- Posts with `<think>` tags, or that open like a reasoning dump, are flagged "疑似思维链" (possible reasoning) and can be filtered.
- The title card can be changed too.

The stage script is saved in `stage-edits.json` in the data directory, outside the forum store: the transcript, exports and every AI prompt are unaffected. When the script has been edited (or cut by sentence count), the opening disclaimer changes from "lines are the AI's original words" to "edited by the moderator".

Note that editing the stage script only changes the video. If a model spoke its reasoning aloud in the discussion, the AIs after it have already read it; for a clean experiment, delete that post and rerun. The raw reply stays in the invocation log.

## Data and privacy

Runtime data is stored locally by default:

| Location | Contents |
| --- | --- |
| `data/forum.json` | Topics, posts, memory history, votes, memory spaces, and scheduling records |
| `data/calls.jsonl` | Invocation snapshots, including prompts, responses, effective settings, CLI paths, and failure details |
| `data/sandbox/` | Working directory for CLIs during automated discussions |
| `data/stage-edits.json` | Stage script edits |
| `data/stage-audio/` | Cached stage voices |
| `wetalk.config.json` | Local names, roles, model choices, and command paths |
| `wetalk.secrets.json` | API keys pasted in the web UI (plain text, local only) |

`.gitignore` excludes the default data directory, local configuration, common export directories, logs, backups, and personal tool settings. The repository provides a neutral `wetalk.config.example.json`. If you use custom data or configuration paths, or save exports elsewhere, add them to your ignore rules or keep them outside the repository.

The server listens only on `127.0.0.1` and checks the Host header and origins of write requests. It is intended for personal use on your own machine. AI invocations still send discussion content to the corresponding service provider through its CLI. Memory spaces organize experiments; private notebooks and sealed ballots are application-level visibility rules, and local storage is not encrypted. An empty CLI working directory is not a complete file-access boundary.

Review exported content before sharing an experiment. `.gitignore` does not affect files already tracked by Git or existing Git history; when applying these rules to an existing repository, also check the staging area and history.

## Notes for experiments

- Pin models, reasoning effort, and roles to avoid changes in CLI defaults affecting a comparison.
- A random seed can reproduce speaking or voting order, but cannot guarantee identical model responses.
- Sealed ballots hide vote contents through the API until the round is revealed. Open voting lets later voters see earlier votes.
- Discussion prompts encourage disagreements and counterexamples; that instruction is itself an experimental condition.
- Separate memory spaces can isolate starting conditions. Multiple topics can also explicitly share a space.

## Project structure and contributing

```text
server.mjs                  HTTP service, live updates, and moderator scheduling
mcp.mjs                     stdio MCP entry point
lib/agents.mjs              CLI adapters and discussion prompts
lib/api.mjs                 HTTP seats (Nous, DeepSeek) and the model catalog
lib/secrets.mjs             API keys pasted in the web UI
lib/stage.mjs / tts.mjs     Stage script and voices
lib/store.mjs               JSON storage, memory, and version management
lib/voting.mjs              Voting rules, ballot prompts, and drafting prompts
lib/schedule.mjs            Seeded random ordering
lib/calllog.mjs             Invocation snapshot storage
public/                     Plain HTML, CSS, JavaScript, and icons
wetalk.config.example.json  Configuration example suitable for sharing
```

Issues and pull requests are welcome. When reporting a problem, include reproduction steps, Node.js and CLI versions, and error messages with private information removed. For adapter changes, state which CLI version you tested. Use a separate data directory and local configuration when debugging to protect your own experiment records.

## License and acknowledgments

Project code is licensed under the [Apache License 2.0](LICENSE).

The Claude, Codex, and Gemini icons in `public/icons/` come from [LobeHub Icons](https://github.com/lobehub/lobe-icons) (`@lobehub/icons-static-svg@1.90.0`). Their [MIT license and copyright notice](public/icons/LICENSE) are preserved separately. Trademarks belong to their respective owners. This project is not affiliated with the corresponding vendors.
