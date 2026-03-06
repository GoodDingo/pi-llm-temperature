/**
 * Fetch interceptor for verifying temperature injection in outgoing LLM requests.
 *
 * Wraps globalThis.fetch to log the full HTTP request payload for all supported
 * provider endpoints. This lets you confirm that the temperature value is actually
 * being sent in the wire-level request, not just set in extension state.
 *
 * Supported endpoint patterns:
 *   - googleapis.com      (Google Generative AI, Google Vertex, Gemini CLI)
 *   - api.anthropic.com   (Anthropic Messages API)
 *   - api.openai.com      (OpenAI Responses & Completions)
 *   - api.mistral.ai      (Mistral Conversations)
 *   - bedrock-runtime      (AWS Bedrock Converse Stream)
 *   - openai.azure.com    (Azure OpenAI Responses)
 *   - api.x.ai            (xAI / Grok via OpenAI Completions)
 *   - api.groq.com        (Groq via OpenAI Completions)
 *   - api.cerebras.ai     (Cerebras via OpenAI Completions)
 *   - api.together.xyz    (Together AI via OpenAI Completions)
 *   - openrouter.ai       (OpenRouter via OpenAI Completions)
 *
 * Usage:
 *   # Method 1: Node.js --import flag (ESM)
 *   NODE_OPTIONS="--import ./test-interceptor.js" pi -e . --temperature 0.5 -p 'hello'
 *
 *   # Method 2: Node.js --require flag (CJS)
 *   NODE_OPTIONS="--require ./test-interceptor.js" pi -e . --temperature 0.5 -p 'hello'
 *
 *   # Method 3: Temporarily import in index.ts (development only)
 *   import './test-interceptor.js';  // Add at top of index.ts
 *
 * Output example:
 *   === OUTGOING LLM REQUEST ===
 *   Provider: google
 *   URL: https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:streamGenerateContent
 *   PAYLOAD: {
 *     "contents": [...],
 *     "generationConfig": {
 *       "temperature": 0.5,       <-- confirms injection
 *       ...
 *     }
 *   }
 */

const PROVIDER_PATTERNS = [
	{ pattern: 'googleapis.com', name: 'google' },
	{ pattern: 'api.anthropic.com', name: 'anthropic' },
	{ pattern: 'api.openai.com', name: 'openai' },
	{ pattern: 'api.mistral.ai', name: 'mistral' },
	{ pattern: 'bedrock-runtime', name: 'bedrock' },
	{ pattern: 'openai.azure.com', name: 'azure-openai' },
	{ pattern: 'api.x.ai', name: 'xai' },
	{ pattern: 'api.groq.com', name: 'groq' },
	{ pattern: 'api.cerebras.ai', name: 'cerebras' },
	{ pattern: 'api.together.xyz', name: 'together' },
	{ pattern: 'openrouter.ai', name: 'openrouter' },
	{ pattern: 'huggingface.co', name: 'huggingface' },
	{ pattern: 'api.minimax.chat', name: 'minimax' },
];

const originalFetch = globalThis.fetch;

globalThis.fetch = async function (...args) {
	const url = (args[0] || '').toString();

	const matched = PROVIDER_PATTERNS.find(p => url.includes(p.pattern));
	if (matched) {
		console.log('\n=== OUTGOING LLM REQUEST ===');
		console.log('Provider:', matched.name);
		console.log('URL:', url);

		if (args[1] && args[1].body) {
			try {
				const body = typeof args[1].body === 'string'
					? args[1].body
					: args[1].body.toString();
				const parsed = JSON.parse(body);
				console.log('PAYLOAD:', JSON.stringify(parsed, null, 2));

				// Highlight temperature if present at any level
				const tempValue = findTemperature(parsed);
				if (tempValue !== undefined) {
					console.log(`\n>>> TEMPERATURE FOUND: ${tempValue} <<<\n`);
				} else {
					console.log('\n>>> NO TEMPERATURE IN PAYLOAD <<<\n');
				}
			} catch {
				console.log('PAYLOAD: (could not parse as JSON)');
			}
		}
	}

	return originalFetch.apply(this, args);
};

/**
 * Recursively search for a "temperature" key in a nested object.
 */
function findTemperature(obj) {
	if (obj == null || typeof obj !== 'object') return undefined;

	if ('temperature' in obj) return obj.temperature;

	for (const key of Object.keys(obj)) {
		const result = findTemperature(obj[key]);
		if (result !== undefined) return result;
	}

	return undefined;
}
