/**
 * Temperature Override Extension (v0.55.1-compatible)
 *
 * Provides two mechanisms for controlling LLM temperature:
 *
 * 1. CLI flag: `pi --temperature 0.5` sets a global temperature override
 *    for the current session. Validated per-provider:
 *    - Claude (anthropic-messages, anthropic-vertex): [0, 1]
 *    - Gemini (google-generative-ai, google-vertex): [0, 2]
 *
 * 2. Skill frontmatter: Skills can specify a model with inline temperature
 *    using the syntax `model: gemini-3-pro-preview(temperature=0.1)`.
 *    Only specific allowed models support this (see models.json).
 *    The extension intercepts `/skill:*` commands, parses the frontmatter,
 *    switches to the requested model, and sets the temperature.
 *
 * Temperature is injected by overriding API providers via pi.registerProvider()
 * with custom streamSimple wrappers. The wrappers check a closure variable
 * (activeTemperature) and spread it into the options before delegating to the
 * original pure stream functions from @mariozechner/pi-ai. These functions
 * make HTTP requests directly and are unaffected by jiti module isolation.
 *
 * For anthropic-vertex (external pi-anthropic-vertex extension), the stream
 * function is not available in @mariozechner/pi-ai. Instead, at session_start
 * the extension late-binds by capturing the already-registered stream function
 * from ctx.modelRegistry and re-registering a temperature-injecting wrapper.
 *
 * Allowed models for skill-based temperature override are defined in
 * models.json alongside per-API temperature ranges.
 *
 * Usage:
 *   pi -e ./pi-extension-of-temperature --temperature 0.3
 *   pi -e ./pi-extension-of-temperature  (then use /skill:my-skill with frontmatter)
 *   /temperature 0.7      (set temperature mid-session)
 *   /temperature           (show current temperature)
 *   /temperature off       (clear temperature override)
 *
 * Installation:
 *   Copy to ~/.pi/agent/extensions/temperature/ for auto-discovery.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	streamSimpleAnthropic,
	streamSimpleGoogle,
	streamSimpleGoogleVertex,
} from "@mariozechner/pi-ai";

// ---------------------------------------------------------------------------
// Load model configuration from models.json
// ---------------------------------------------------------------------------
interface TemperatureRange {
	min: number;
	max: number;
}

interface AllowedModel {
	id: string;
	api: string;
}

interface ModelsConfig {
	apiTemperatureRanges: Record<string, TemperatureRange>;
	allowedModels: AllowedModel[];
}

const modelsConfig: ModelsConfig = JSON.parse(
	readFileSync(join(dirname(new URL(import.meta.url).pathname), "models.json"), "utf-8"),
);

const API_TEMPERATURE_RANGES: Record<string, TemperatureRange> = modelsConfig.apiTemperatureRanges;

const ALLOWED_MODELS: ReadonlyMap<string, string> = new Map(
	modelsConfig.allowedModels.map((m) => [m.id, m.api]),
);

// Maximum temperature across all supported APIs
const GLOBAL_MAX_TEMPERATURE = Math.max(...Object.values(API_TEMPERATURE_RANGES).map((r) => r.max));

/**
 * Get the API type for an allowed model ID.
 */
function getApiForModel(modelId: string): string | undefined {
	return ALLOWED_MODELS.get(modelId);
}

/**
 * Validate temperature against the allowed range for a given API.
 * Returns an error string if invalid, undefined if valid.
 */
function validateTemperature(temperature: number, api: string): string | undefined {
	if (Number.isNaN(temperature)) {
		return "Temperature must be a valid number";
	}

	const range = API_TEMPERATURE_RANGES[api];
	if (!range) {
		return `Temperature override is not supported for API "${api}"`;
	}

	if (temperature < range.min || temperature > range.max) {
		return `Temperature ${temperature} is out of range [${range.min}, ${range.max}] for ${api}`;
	}

	return undefined;
}

/**
 * Parse model spec from skill frontmatter, e.g.:
 *   "gemini-3-pro-preview(temperature=0.1)" -> { modelId: "gemini-3-pro-preview", temperature: 0.1 }
 *   "claude-sonnet-4-6@default(temperature=0.8)" -> { modelId: "claude-sonnet-4-6@default", temperature: 0.8 }
 *   "gemini-3-pro-preview"                  -> { modelId: "gemini-3-pro-preview", temperature: undefined }
 */
function parseModelSpec(spec: string): { modelId: string; temperature: number | undefined } {
	const match = spec.match(/^([a-zA-Z0-9._@-]+)\(temperature=([\d.]+)\)$/);
	if (match) {
		return { modelId: match[1], temperature: parseFloat(match[2]) };
	}
	return { modelId: spec, temperature: undefined };
}

/**
 * Parse YAML frontmatter from a markdown file content.
 * Returns key-value pairs from the frontmatter, or null if no frontmatter found.
 */
function parseFrontmatter(content: string): Record<string, string> | null {
	const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
	if (!fmMatch) return null;

	const result: Record<string, string> = {};
	for (const line of fmMatch[1].split("\n")) {
		const kvMatch = line.match(/^(\w[\w-]*):\s*(.+)$/);
		if (kvMatch) {
			result[kvMatch[1]] = kvMatch[2].trim();
		}
	}
	return result;
}

/**
 * Scan skill directories for a skill by name.
 * Checks project-local and global skill paths.
 */
function findSkillPath(skillName: string, cwd: string): string | undefined {
	const projectPaths = [
		join(cwd, ".pi", "skills", skillName, "SKILL.md"),
		join(cwd, ".pi", "skills", `${skillName}.md`),
		join(cwd, ".agents", "skills", skillName, "SKILL.md"),
		join(cwd, ".agents", "skills", `${skillName}.md`),
	];

	let dir = cwd;
	while (true) {
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
		projectPaths.push(join(dir, ".agents", "skills", skillName, "SKILL.md"));
		projectPaths.push(join(dir, ".agents", "skills", `${skillName}.md`));
		if (existsSync(join(dir, ".git"))) break;
	}

	const home = process.env.HOME || process.env.USERPROFILE || "";
	const globalPaths = [
		join(home, ".pi", "agent", "skills", skillName, "SKILL.md"),
		join(home, ".pi", "agent", "skills", `${skillName}.md`),
		join(home, ".agents", "skills", skillName, "SKILL.md"),
		join(home, ".agents", "skills", `${skillName}.md`),
	];

	for (const p of [...projectPaths, ...globalPaths]) {
		if (existsSync(p)) return p;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------
export default function temperatureExtension(pi: ExtensionAPI) {
	// Current session temperature override. undefined = no override.
	let activeTemperature: number | undefined;

	// -----------------------------------------------------------------------
	// 1. Register --temperature CLI flag
	// -----------------------------------------------------------------------
	pi.registerFlag("temperature", {
		description:
			"Set LLM temperature (Claude: 0-1, Gemini: 0-2). Overrides provider default.",
		type: "string",
	});

	// -----------------------------------------------------------------------
	// 2. Override API providers with temperature-injecting wrappers.
	//
	// pi.registerProvider() pushes to runtime.pendingProviderRegistrations,
	// which the main process applies via modelRegistry.registerProvider() →
	// registerApiProvider() in the main process's @mariozechner/pi-ai module.
	//
	// The imported streamSimple* functions are pure: they take model/context/
	// options and make HTTP requests directly. No registry dependency, so
	// jiti module isolation does not affect them.
	//
	// Note: omitting `models` preserves the existing model list for each
	// provider. Only the streamSimple implementation is replaced.
	// -----------------------------------------------------------------------
	pi.registerProvider("anthropic", {
		api: "anthropic-messages",
		streamSimple: (model, context, options) => {
			const finalOptions =
				activeTemperature !== undefined
					? { ...options, temperature: activeTemperature }
					: options;
			return streamSimpleAnthropic(model, context, finalOptions);
		},
	});

	pi.registerProvider("google", {
		api: "google-generative-ai",
		streamSimple: (model, context, options) => {
			const finalOptions =
				activeTemperature !== undefined
					? { ...options, temperature: activeTemperature }
					: options;
			return streamSimpleGoogle(model, context, finalOptions);
		},
	});

	pi.registerProvider("google-vertex", {
		api: "google-vertex",
		streamSimple: (model, context, options) => {
			const finalOptions =
				activeTemperature !== undefined
					? { ...options, temperature: activeTemperature }
					: options;
			return streamSimpleGoogleVertex(model, context, finalOptions);
		},
	});

	// -----------------------------------------------------------------------
	// 3. /temperature command for mid-session control
	// -----------------------------------------------------------------------
	pi.registerCommand("temperature", {
		description: "Set, show, or clear temperature override",
		handler: async (args, ctx) => {
			const trimmed = args?.trim();

			if (!trimmed) {
				if (activeTemperature !== undefined) {
					ctx.ui.notify(`Current temperature: ${activeTemperature}`, "info");
				} else {
					ctx.ui.notify("No temperature override active (using provider default)", "info");
				}
				return;
			}

			if (trimmed === "off" || trimmed === "clear" || trimmed === "reset") {
				activeTemperature = undefined;
				ctx.ui.setStatus("temperature", undefined);
				ctx.ui.notify("Temperature override cleared", "info");
				return;
			}

			const temp = parseFloat(trimmed);
			if (Number.isNaN(temp)) {
				ctx.ui.notify(`Invalid temperature: "${trimmed}". Use a number, or "off" to clear.`, "error");
				return;
			}

			// Validate against current model's API
			const model = ctx.model;
			if (model) {
				const error = validateTemperature(temp, model.api);
				if (error) {
					ctx.ui.notify(error, "error");
					return;
				}
			} else {
				if (temp < 0 || temp > GLOBAL_MAX_TEMPERATURE) {
					ctx.ui.notify(
						`Temperature must be between 0 and ${GLOBAL_MAX_TEMPERATURE}`,
						"error",
					);
					return;
				}
			}

			activeTemperature = temp;
			updateStatus(ctx);
			ctx.ui.notify(`Temperature set to ${temp}`, "info");
		},
	});

	// -----------------------------------------------------------------------
	// 4. Skill frontmatter interception
	// -----------------------------------------------------------------------
	pi.on("input", async (event, ctx) => {
		if (!event.text.startsWith("/skill:")) {
			return { action: "continue" };
		}

		const parts = event.text.split(/\s+/);
		const skillName = parts[0].substring(7);
		if (!skillName) return { action: "continue" };

		const skillPath = findSkillPath(skillName, ctx.cwd);
		if (!skillPath) return { action: "continue" };

		let content: string;
		try {
			content = readFileSync(skillPath, "utf-8");
		} catch {
			return { action: "continue" };
		}

		const frontmatter = parseFrontmatter(content);
		if (!frontmatter || !frontmatter.model) {
			return { action: "continue" };
		}

		const { modelId, temperature } = parseModelSpec(frontmatter.model);

		if (!ALLOWED_MODELS.has(modelId)) {
			ctx.ui.notify(
				`Skill "${skillName}" requests model "${modelId}" which is not in the allowed list.\n` +
					`Allowed: ${[...ALLOWED_MODELS.keys()].join(", ")}`,
				"error",
			);
			return { action: "handled" };
		}

		const allModels = ctx.modelRegistry.getAllModels();
		const targetModel = allModels.find((m: { id: string }) => m.id === modelId);

		if (!targetModel) {
			ctx.ui.notify(
				`Skill "${skillName}" requests model "${modelId}" but it was not found in the model registry.`,
				"error",
			);
			return { action: "handled" };
		}

		if (temperature !== undefined) {
			const api = getApiForModel(modelId);
			if (api) {
				const error = validateTemperature(temperature, api);
				if (error) {
					ctx.ui.notify(`Skill "${skillName}": ${error}`, "error");
					return { action: "handled" };
				}
			}
		}

		const success = await pi.setModel(targetModel);
		if (!success) {
			ctx.ui.notify(
				`Skill "${skillName}": No API key available for ${targetModel.provider}/${modelId}`,
				"error",
			);
			return { action: "handled" };
		}

		if (temperature !== undefined) {
			activeTemperature = temperature;
			updateStatus(ctx);
			ctx.ui.notify(
				`Skill "${skillName}": switched to ${modelId} with temperature=${temperature}`,
				"info",
			);
		} else {
			ctx.ui.notify(`Skill "${skillName}": switched to ${modelId}`, "info");
		}

		return { action: "continue" };
	});

	// -----------------------------------------------------------------------
	// 5. Status indicator
	// -----------------------------------------------------------------------
	function updateStatus(ctx: ExtensionContext): void {
		if (activeTemperature !== undefined) {
			ctx.ui.setStatus(
				"temperature",
				ctx.ui.theme.fg("accent", `temp:${activeTemperature}`),
			);
		} else {
			ctx.ui.setStatus("temperature", undefined);
		}
	}

	// -----------------------------------------------------------------------
	// 6. Session lifecycle
	// -----------------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		// ---------------------------------------------------------------
		// 6a. Late-bind anthropic-vertex provider wrapper.
		//
		// The streamSimpleAnthropicVertex function is not exported by
		// @mariozechner/pi-ai — it only exists in the external
		// pi-anthropic-vertex extension. We cannot import it due to
		// jiti module isolation. Instead, we capture the already-registered
		// stream function from ctx.modelRegistry.registeredProviders
		// (TypeScript-private but runtime-accessible Map) and re-register
		// a wrapper that injects temperature.
		//
		// This runs after pendingProviderRegistrations have been applied,
		// so the anthropic-vertex provider (if loaded) is already in the
		// registry. ctx.modelRegistry.registerProvider() is a direct call
		// that writes to the main process's apiProviderRegistry.
		// ---------------------------------------------------------------
		const registry = ctx.modelRegistry as Record<string, unknown>;
		const registeredProviders = registry.registeredProviders as
			| Map<string, { streamSimple?: Function; api?: string; [k: string]: unknown }>
			| undefined;

		if (registeredProviders) {
			const vertexConfig = registeredProviders.get("anthropic-vertex");
			if (vertexConfig?.streamSimple) {
				const originalStream = vertexConfig.streamSimple;
				(ctx.modelRegistry as { registerProvider(name: string, config: Record<string, unknown>): void })
					.registerProvider("anthropic-vertex", {
						...vertexConfig,
						streamSimple: (
							model: Parameters<typeof streamSimpleAnthropic>[0],
							context: Parameters<typeof streamSimpleAnthropic>[1],
							options?: Parameters<typeof streamSimpleAnthropic>[2],
						) => {
							const finalOptions =
								activeTemperature !== undefined
									? { ...options, temperature: activeTemperature }
									: options;
							return originalStream(model, context, finalOptions);
						},
					});
			}
		}

		// ---------------------------------------------------------------
		// 6b. Parse --temperature flag
		// ---------------------------------------------------------------
		const flagValue = pi.getFlag("temperature");
		if (typeof flagValue === "string" && flagValue) {
			const temp = parseFloat(flagValue);
			if (Number.isNaN(temp) || temp < 0 || temp > GLOBAL_MAX_TEMPERATURE) {
				const msg = Number.isNaN(temp)
					? `Invalid --temperature value: "${flagValue}". Must be a number.`
					: `--temperature ${temp} is out of range [0, ${GLOBAL_MAX_TEMPERATURE}].`;

				// In print mode ctx.ui.notify is a no-op, so write to stderr and exit
				if (!ctx.hasUI) {
					console.error(`[temperature] Error: ${msg}`);
					process.exit(1);
				}
				ctx.ui.notify(msg, "error");
			} else {
				activeTemperature = temp;

				// Validate against current model if known
				const model = ctx.model;
				if (model) {
					const error = validateTemperature(temp, model.api);
					if (error) {
						if (!ctx.hasUI) {
							console.error(`[temperature] Error: ${error}`);
							process.exit(1);
						}
						ctx.ui.notify(error, "error");
						activeTemperature = undefined;
					} else {
						ctx.ui.notify(`Temperature override: ${temp}`, "info");
					}
				} else {
					ctx.ui.notify(`Temperature override: ${temp}`, "info");
				}
			}
		}

		// Restore from persisted state (only if no CLI flag)
		if (activeTemperature === undefined) {
			const entries = ctx.sessionManager.getEntries();
			const stateEntry = entries
				.filter(
					(e: { type: string; customType?: string }) =>
						e.type === "custom" && e.customType === "temperature-state",
				)
				.pop() as { data?: { temperature: number } } | undefined;

			if (stateEntry?.data?.temperature !== undefined) {
				activeTemperature = stateEntry.data.temperature;
			}
		}

		updateStatus(ctx);
	});

	// Re-validate temperature when model changes
	pi.on("model_select", async (event, ctx) => {
		if (activeTemperature === undefined) return;

		const error = validateTemperature(activeTemperature, event.model.api);
		if (error) {
			ctx.ui.notify(
				`Warning: ${error}. Use /temperature to adjust or clear.`,
				"warning",
			);
		}
	});

	// Persist temperature state across turns
	pi.on("turn_start", async () => {
		if (activeTemperature !== undefined) {
			pi.appendEntry("temperature-state", { temperature: activeTemperature });
		}
	});
}
