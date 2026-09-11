import { GoogleGenAI, ThinkingLevel } from '@google/genai';

import { env } from '../config/env';
import type { RemarketingAudience } from '../db/database';
import { createLogger } from '../utils/logger';
import { sanitiseDashes } from '../utils/text';
import { persona } from '../personas';
import { withRetry } from './retry';

const log = createLogger('remarketing');

let cachedClient: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  cachedClient ??= new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  return cachedClient;
}

/**
 * Guioes de reserva. Nao sao so um fallback de erro: com o Gemini fora do ar
 * ou a quota esgotada, o remarketing tem de continuar a sair — e uma campanha
 * que falha em silencio parece estar a funcionar.
 *
 * `{nome}` e substituido pelo primeiro nome do lead.
 */
const FALLBACK_SCRIPTS = persona.remarketing.fallbacks;
const BRIEFS = persona.remarketing.briefs;

function buildPrompt(audience: RemarketingAudience): string {
  return `Es o ${persona.agentName}.

Escreve UMA mensagem de acompanhamento para enviar por Telegram.

${BRIEFS[audience]}

REGRAS:
- Portugues de Portugal. Tratamento por tu. Nada de "voce", nada de gerundio
  brasileiro, nada de "cara", "galera", "grana" ou "pra".
- No maximo 2 frases curtas. E uma mensagem de telemovel.
- Usa o marcador {nome} uma vez, onde o primeiro nome do lead deve entrar.
- Nunca prometas lucro garantido nem inventes numeros, percentagens ou valores.
- Sem link, sem markdown, sem assinatura, no maximo um emoji.
- Responde apenas com o texto da mensagem.`;
}

function pickFallback(audience: RemarketingAudience): string {
  const scripts = FALLBACK_SCRIPTS[audience];
  // Roda pelo dia do ano para o mesmo guiao nao sair em slots seguidos.
  const index = Math.floor(Date.now() / 3_600_000) % scripts.length;
  return scripts[index] ?? scripts[0] ?? '';
}

/**
 * Uma mensagem por slot e por publico, personalizada depois com o nome de cada
 * lead. Gerar por lead multiplicaria as chamadas pelo tamanho da base — a
 * campanha esgotaria a quota antes de chegar ao fim da lista.
 */
export async function generateRemarketingMessage(
  audience: RemarketingAudience,
): Promise<{ template: string; generated: boolean }> {
  const result = await withRetry({
    attempts: 2,
    log,
    label: `mensagem de remarketing (${audience})`,
    run: async () => {
      const response = await getClient().models.generateContent({
        model: env.GEMINI_WRITER_MODEL,
        contents: buildPrompt(audience),
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
          temperature: 1,
          maxOutputTokens: 300,
        },
      });

      const clean = sanitiseDashes(response.text ?? '');
      return persona.styleGuard ? persona.styleGuard(clean) : clean;
    },
  });

  if (!result) {
    log.warn(`a usar guiao de reserva para "${audience}"`);
    return { template: pickFallback(audience), generated: false };
  }

  // Sem o marcador nao ha personalizacao; melhor um guiao que a tem.
  if (!result.includes('{nome}')) {
    log.warn(`mensagem gerada sem {nome}; a usar guiao de reserva para "${audience}"`);
    return { template: pickFallback(audience), generated: false };
  }

  return { template: result, generated: true };
}

/** Substitui o marcador pelo nome do lead, ou remove-o quando nao ha nome. */
export function personalise(template: string, firstName: string | null): string {
  if (firstName) return template.replaceAll('{nome}', firstName);

  return template
    .replaceAll(', {nome}', '')
    .replaceAll('{nome}, ', '')
    .replaceAll('{nome}', '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
