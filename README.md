# Temperature Override Extension

A pi extension that provides fine-grained control over LLM temperature via CLI flag, slash command, and skill frontmatter.

## Features

### 1. CLI Flag: `--temperature`

Set a global temperature override for the session:

```bash
pi -e ./pi-extension-of-temperature --temperature 0.3
```

Invalid values cause a hard error (stderr + exit 1 in print mode, notification in interactive):

```bash
# Exits with error: out of range [0, 2]
pi -e ./pi-extension-of-temperature --temperature 3.0 -p 'hello'
```

### 2. Slash Command: `/temperature`

Control temperature mid-session:

```
/temperature 0.7      # Set temperature
/temperature           # Show current temperature
/temperature off       # Clear override (use provider default)
```

Validates against the current model's API range immediately.

### 3. Skill Frontmatter: `model` with inline temperature

Skills can specify a model with temperature in their YAML frontmatter:

```yaml
---
name: creative-writer
description: Creative writing with high temperature for more varied output
model: gemini-3-pro-preview(temperature=1.5)
---
```

When you run `/skill:creative-writer`, the extension:
1. Parses the `model` field from frontmatter
2. Validates the model is in the allowed list (blocks execution if not)
3. Validates the temperature is within range for that model's API
4. Switches to the model and sets the temperature
5. Returns `{ action: "continue" }` so pi still does normal skill expansion

## Allowed Models

Only these models support skill-based temperature override. Configuration lives in [`models.json`](models.json).

| Model | Provider | API | Temperature Range |
|-------|----------|-----|-------------------|
| `claude-sonnet-4-6` | Anthropic | `anthropic-messages` | 0 - 1 |
| `claude-opus-4-6` | Anthropic | `anthropic-messages` | 0 - 1 |
| `claude-haiku-4-5` | Anthropic | `anthropic-messages` | 0 - 1 |
| `claude-sonnet-4-6@default` | Anthropic Vertex | `anthropic-vertex` | 0 - 1 |
| `claude-opus-4-6@default` | Anthropic Vertex | `anthropic-vertex` | 0 - 1 |
| `claude-haiku-4-5@20251001` | Anthropic Vertex | `anthropic-vertex` | 0 - 1 |
| `gemini-3-pro-preview` | Google | `google-generative-ai` | 0 - 2 |
| `gemini-3.1-pro-preview` | Google | `google-generative-ai` | 0 - 2 |
| `gemini-3-flash-preview` | Google | `google-generative-ai` | 0 - 2 |
| `gemini-2.5-pro` | Google | `google-generative-ai` | 0 - 2 |
| `gemini-2.5-flash` | Google | `google-generative-ai` | 0 - 2 |
| `gemini-2.5-flash-lite` | Google | `google-generative-ai` | 0 - 2 |

The `--temperature` CLI flag and `/temperature` command work with any model using a supported API (`anthropic-messages`, `anthropic-vertex`, `google-generative-ai`, `google-vertex`).

To add new models or adjust temperature ranges, edit `models.json`.

## How It Works

### `pi.setTemperature()` / `pi.getTemperature()`

The extension uses pi's built-in `pi.setTemperature()` API to inject temperature into LLM calls. When set, the agent passes the temperature through `SimpleStreamOptions.temperature` to whatever provider stream function handles the request. This works universally for all registered providers (Anthropic, Google, Anthropic Vertex, etc.) without needing per-provider wrappers.

### Configuration: `models.json`

All model and temperature range data is stored in `models.json`:

```json
{
  "apiTemperatureRanges": {
    "anthropic-messages": { "min": 0, "max": 1 },
    "anthropic-vertex": { "min": 0, "max": 1 },
    "google-generative-ai": { "min": 0, "max": 2 },
    "google-vertex": { "min": 0, "max": 2 }
  },
  "allowedModels": [
    { "id": "claude-sonnet-4-6", "api": "anthropic-messages" },
    ...
  ]
}
```

- **`apiTemperatureRanges`**: Maps API type to valid temperature range. Used for validation.
- **`allowedModels`**: Models that can be switched to via skill frontmatter. Each entry maps a model ID to its API type.

### Validation

- CLI flag: Validated on `session_start`. Out of `[0, 2]` or non-numeric causes a hard error (stderr + exit 1 in print mode)
- `/temperature` command: Validated against the current model's API range
- Skill frontmatter: Validated against the requested model's API range
- Model switch (`model_select` event): Warns if current temperature is out of range for the new model

## Anthropic Vertex Support

To use temperature with Anthropic Vertex models, install [pi-anthropic-vertex](https://github.com/basnijholt/pi-anthropic-vertex) alongside this extension:

```bash
pi install git:github.com/basnijholt/pi-anthropic-vertex
```

Then use Vertex model IDs in skill frontmatter:

```yaml
---
name: vertex-writer
description: Creative writing via Anthropic Vertex
model: claude-sonnet-4-6@default(temperature=0.8)
---
```

Or set temperature globally when using a Vertex model:

```bash
pi -e ./pi-extension-of-temperature --provider anthropic-vertex --model claude-sonnet-4-6@default --temperature 0.5
```

## Installation

### Quick test

```bash
pi -e ./pi-extension-of-temperature
```

### Global installation

```bash
cp -r pi-extension-of-temperature ~/.pi/agent/extensions/temperature
```

### Project-local

```bash
cp -r pi-extension-of-temperature .pi/extensions/temperature
```

## Status Indicator

When a temperature override is active, the footer shows `temp:0.5` (or whatever value). Clears on `/temperature off`.

## State Persistence

Temperature state is persisted via `pi.appendEntry("temperature-state", ...)` on each turn start, and restored from session entries on `session_start`. The CLI flag always takes precedence over persisted state.

## Example Skills

See `examples/creative-writer/SKILL.md` (Gemini, temp=1.5) and `examples/precise-reviewer/SKILL.md` (Claude, temp=0.1).
