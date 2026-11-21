/** LLM через OpenAI-совместимый Chat Completions API в JSON-режиме. */
import { type Llm, LlmUnavailableError } from '../app/llm.ts';

export interface LlmConfig {
  /** <провайдер>/<модель>, например deepseek/deepseek-flash */
  model: string;
  /** Имя переменной окружения с API-ключом */
  apiKeyEnv: string;
  /** Адрес API (…/v1); по умолчанию — по известному провайдеру */
  baseUrl?: string;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const PROVIDERS: Record<string, string> = {
  deepseek: 'https://api.deepseek.com',
  openai: 'https://api.openai.com/v1',
};

const TIMEOUT_MS = 120_000;

/** Статусы, где виноват не запрос, а провайдер: ключ, баланс, доступ, лимит. */
const UNAVAILABLE_STATUSES = new Set([401, 402, 403, 429]);

export function createLlm(config: LlmConfig, env: Record<string, string | undefined>, fetchFn: Fetch = fetch): Llm {
  const slash = config.model.indexOf('/');
  const provider = slash > 0 ? config.model.slice(0, slash) : '';
  const model = config.model.slice(slash + 1);
  const baseUrl = config.baseUrl ?? PROVIDERS[provider];
  if (!baseUrl) throw new Error(`LLM: неизвестный провайдер «${provider}» — задайте llm.baseUrl`);
  const apiKey = env[config.apiKeyEnv];
  if (!apiKey) throw new Error(`LLM: не задан ключ в переменной ${config.apiKeyEnv}`);

  return {
    async completeJson(system, user) {
      const res = await send(fetchFn, `${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        const message = `LLM: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`;
        const unavailable = UNAVAILABLE_STATUSES.has(res.status) || res.status >= 500;
        throw unavailable ? new LlmUnavailableError(message) : new Error(message);
      }

      const content = ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message
        ?.content;
      try {
        return JSON.parse(content ?? '');
      } catch {
        throw new Error(`LLM: ответ не JSON: ${String(content).slice(0, 300)}`);
      }
    },
  };
}

/** Сетевой сбой и таймаут — провайдер недоступен, а не ошибка запроса. */
async function send(fetchFn: Fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchFn(url, init);
  } catch (e) {
    throw new LlmUnavailableError(`LLM: нет ответа: ${e instanceof Error ? e.message : String(e)}`);
  }
}
