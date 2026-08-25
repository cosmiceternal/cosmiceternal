import { OllamaProvider } from './ollama.js';
import { OpenAICompatProvider } from './openai.js';

export { ProviderError } from './http.js';

export function createProvider(config) {
  switch (config.provider) {
    case 'ollama': return new OllamaProvider(config);
    case 'openai': return new OpenAICompatProvider(config);
    default: throw new Error(`unknown provider: ${config.provider}`);
  }
}

/** Ports Apollo probes when looking for a local model server. */
export const KNOWN_BACKENDS = [
  { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', label: 'Ollama' },
  { provider: 'openai', baseUrl: 'http://127.0.0.1:8080', label: 'llama.cpp server' },
  { provider: 'openai', baseUrl: 'http://127.0.0.1:1234', label: 'LM Studio' },
  { provider: 'openai', baseUrl: 'http://127.0.0.1:8000', label: 'vLLM' },
  { provider: 'openai', baseUrl: 'http://127.0.0.1:5000', label: 'text-generation-webui' },
];

/** Probe every known local backend; used by `apollo doctor` and first-run setup. */
export async function detectBackends() {
  const results = await Promise.all(KNOWN_BACKENDS.map(async (backend) => {
    const provider = createProvider({ ...backend, apiKey: '' });
    try {
      await provider.health();
      const models = await provider.listModels().catch(() => []);
      return { ...backend, available: true, models };
    } catch {
      return { ...backend, available: false, models: [] };
    }
  }));
  return results;
}
