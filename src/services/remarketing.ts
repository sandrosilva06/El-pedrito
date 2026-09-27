import { GoogleGenAI, ThinkingLevel } from '@google/genai';

import { env } from '../config/env';
import type { Persona } from '../personas/types';
import type { RemarketingAudience } from '../db/database';
import { createLogger } from '../utils/logger';
import { sanitiseDashes } from '../utils/text';
import { withRetry } from './retry';

const log = createLogger('remarketing');

let cachedClient: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  cachedClient ??= new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  return cachedClient;
}

/**
 * Guiao do toque pedido, ou o brief fixo do publico quando a persona nao tem
 * guioes por toque.
 *
 * Tudo isto vem da persona e nao de constantes deste ficheiro: o agendador corre
 * a campanha de cada influencer separadamente, e com um conjunto unico de guioes
 * os leads do Ivan levavam as mensagens do El Pedrito.
 */
function briefFor(persona: Persona, audience: RemarketingAudience, touch: number): string {
  const { briefs, toques } = persona.remarketing;
  if (audience !== 'nao_convertido') return briefs[audience];
  return toques?.[touch]?.brief ?? briefs.nao_convertido;
}

function buildPrompt(persona: Persona, audience: RemarketingAudience, touch: number): string {
  return `Es o ${persona.agentName}, dono do grupo "${persona.groupName}".

Escreve UMA mensagem de acompanhamento para enviar por Telegram.

${briefFor(persona, audience, touch)}

REGRAS:
- Portugues de Portugal. Tratamento por tu. Nada de "voce", nada de gerundio
  brasileiro, nada de "cara", "galera", "grana" ou "pra".
- Natural, amigavel e directo, como quem manda uma mensagem a um conhecido.
- PROIBIDO discursar sobre custo de vida, economia, precos, inflacao, o quanto
  esta dificil, ou a situacao financeira do lead. Isso nao e um lembrete, e um
  sermao, e nao e assim que se puxa alguem de volta.
- O assunto e o grupo: a assertividade que esta a sair e a vontade de o trazer
  de volta a accao. Nada de queixume por ele nao ter respondido.
- No maximo 2 frases curtas. E uma mensagem de telemovel.
- Usa o marcador {nome} uma vez, onde o primeiro nome do lead deve entrar.
- Nunca prometas lucro garantido nem inventes numeros, percentagens ou valores.
- Sem link, sem markdown, sem assinatura, no maximo um emoji.
- Responde apenas com o texto da mensagem.`;
}

function pickFallback(persona: Persona, audience: RemarketingAudience, touch: number): string {
  const { fallbacks, toques } = persona.remarketing;
  const scripts =
    audience === 'nao_convertido'
      ? (toques?.[touch]?.fallbacks ?? fallbacks.nao_convertido)
      : fallbacks[audience];

  // Roda pela hora para o mesmo guiao nao sair em slots seguidos.
  const index = Math.floor(Date.now() / 3_600_000) % scripts.length;
  return scripts[index] ?? scripts[0] ?? '';
}

/**
 * Uma mensagem por slot e por publico, personalizada depois com o nome de cada
 * lead. Gerar por lead multiplicaria as chamadas pelo tamanho da base — a
 * campanha esgotaria a quota antes de chegar ao fim da lista.
 */
export async function generateRemarketingMessage(
  persona: Persona,
  audience: RemarketingAudience,
  touch = 0,
): Promise<{ template: string; generated: boolean }> {
  const result = await withRetry({
    attempts: 2,
    log,
    label: `mensagem de remarketing (${audience}, toque ${touch + 1})`,
    run: async () => {
      const response = await getClient().models.generateContent({
        model: env.GEMINI_WRITER_MODEL,
        contents: buildPrompt(persona, audience, touch),
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
          temperature: 1,
          maxOutputTokens: 300,
        },
      });

      return sanitiseDashes(response.text ?? '');
    },
  });

  if (!result) {
    log.warn(`a usar guiao de reserva para "${audience}" (toque ${touch + 1})`);
    return { template: pickFallback(persona, audience, touch), generated: false };
  }

  // Sem o marcador nao ha personalizacao; melhor um guiao que a tem.
  if (!result.includes('{nome}')) {
    log.warn(`mensagem gerada sem {nome}; a usar guiao de reserva para "${audience}"`);
    return { template: pickFallback(persona, audience, touch), generated: false };
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

/**
 * O ultimo toque com guiao proprio desta persona.
 *
 * A partir dele repete-se o mesmo angulo: os toques seguintes sao insistencia, e
 * escrever um guiao diferente para o decimo toque seria inventar trabalho.
 */
export function toquePersistente(persona: Persona): number {
  return Math.max(0, (persona.remarketing.toques?.length ?? 1) - 1);
}

export type TipoDisparo = 'nao_qualificado' | 'qualificado';

/** Escolhe um guiao do botao do painel, ja com o nome do lead colocado. */
export function guiaoDisparoManual(
  persona: Persona,
  tipo: TipoDisparo,
  firstName: string | null,
): string {
  const opcoes = persona.remarketing.disparos[tipo];
  const escolhido = opcoes[Math.floor(Math.random() * opcoes.length)] ?? opcoes[0] ?? '';
  return personalise(escolhido, firstName);
}
