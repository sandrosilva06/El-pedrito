import { GoogleGenAI, ThinkingLevel } from '@google/genai';

import { env } from '../config/env';
import type { RemarketingAudience } from '../db/database';
import { createLogger } from '../utils/logger';
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
const FALLBACK_SCRIPTS: Record<RemarketingAudience, string[]> = {
  nao_convertido: [
    'Malandro, perdeste os greens de hoje... a malta no VIP esta a somar green atras de green! Ainda vais a tempo de entrar hoje, {nome}?',
    '{nome}, o pessoal la dentro ja fechou o dia com lucro. Queres que te explique como entras, ou preferes que te deixe em paz?',
    'Boas {nome}! O grupo hoje voltou a puxar forte. Se ainda tiveres interesse, e so dizeres que eu explico o resto.',
  ],
  vip: [
    'Boas companheiro! Ja foste dar uma olhadela as entradas que mandei hoje no VIP? Nao deixes passar os greens!',
    '{nome}, mandei as entradas do dia no grupo. Da la um salto antes que os jogos comecem.',
    'Tudo bem {nome}? Passa pelo VIP para veres o que ja saiu hoje — nao quero que percas nenhuma.',
  ],
  promessa: [
    'Boas malandro, ja saiste do trabalho? As apostas da noite saem daqui a bocado no VIP, estas pronto para abrires a conta e entrares?',
    '{nome}, conforme combinado aqui estou eu. Ja tens um bocadinho para tratar disso?',
    'Boas {nome}, ficou combinado que te apitava a esta hora. Ainda vais a tempo das entradas de hoje.',
  ],
};

const BRIEFS: Record<RemarketingAudience, string> = {
  nao_convertido: `Estes leads falaram contigo e nao avancaram para o grupo.
A mensagem deve criar a sensacao de estarem a perder algo real que esta a
acontecer agora no grupo, e terminar com uma pergunta facil de responder.
Nao repitas condicoes de entrada nem mandes o link: o objetivo e so reabrir a
conversa.`,
  vip: `Estes leads ja estao no grupo VIP. A mensagem deve puxa-los de volta ao
grupo para verem as entradas do dia. Tom de companheirismo, nada de vendas —
estas pessoas ja compraram.`,
  promessa: `Este lead disse que tratava do assunto a esta hora e tu ficaste de
lhe apitar. A mensagem e o cumprimento desse combinado, nao uma cobranca:
lembra que ficou combinado, pergunta se ele ja tem um bocadinho, e refere que
as entradas de hoje ainda vao a tempo. Nada de pressao e nada de queixume por
ele nao ter feito ainda.`,
};

function buildPrompt(audience: RemarketingAudience): string {
  return `Es o ${env.AGENT_NAME}, dono do grupo "${env.GROUP_NAME}".

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

      return (response.text ?? '').trim();
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
