/** Порт LLM: ответ строго JSON-объектом. Реализация — infra/openai-llm.ts. */
export interface Llm {
  completeJson(system: string, user: string): Promise<unknown>;
}

/**
 * Провайдер недоступен (баланс, ключ, лимит, сбой сервера или сети): вина не
 * запроса, а окружения. Курирование прерывает проход и не засчитывает попытку.
 */
export class LlmUnavailableError extends Error {
  override readonly name = 'LlmUnavailableError';
}
