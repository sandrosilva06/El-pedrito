import type { Logger } from '../utils/logger';

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Teto de espera: acima disso o lead desiste antes da resposta chegar. */
const MAX_DELAY_MS = 20_000;

export function isRetryable(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  return typeof status === 'number' && RETRYABLE_STATUS.has(status);
}

/**
 * O 429 do Gemini traz um RetryInfo dizendo quanto falta para a janela de
 * quota virar ("retryDelay": "14s"). Um backoff exponencial de centenas de
 * milissegundos nunca alcanca esse prazo — reesperar o que o servidor pediu e
 * a unica tentativa com chance real de passar.
 */
function serverRetryDelayMs(error: unknown): number | null {
  const message = (error as { message?: unknown })?.message;
  if (typeof message !== 'string') return null;

  const seconds = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message)?.[1];
  return seconds ? Math.ceil(Number(seconds) * 1000) : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Repete `run` enquanto o erro for transitorio. A espera e a maior entre o
 * backoff exponencial e o prazo pedido pelo servidor, limitada ao teto.
 * Devolve `null` quando todas as tentativas falham — quem chama decide o
 * fallback.
 */
export async function withRetry<T>(params: {
  attempts: number;
  log: Logger;
  label: string;
  run: () => Promise<T>;
}): Promise<T | null> {
  const { attempts, log, label, run } = params;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts || !isRetryable(error)) {
        log.error(`${label}: falhou apos ${attempt} tentativa(s)`, error);
        return null;
      }

      const backoff = 400 * 2 ** (attempt - 1);
      const delay = Math.min(Math.max(backoff, serverRetryDelayMs(error) ?? 0), MAX_DELAY_MS);

      log.warn(`${label}: indisponivel (${attempt}/${attempts}); nova tentativa em ${delay}ms`);
      await sleep(delay);
    }
  }

  return null;
}
