import { GoogleGenAI, ThinkingLevel } from '@google/genai';

import { env } from '../config/env';
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
 * Guioes de reserva. Nao sao so um fallback de erro: com o Gemini fora do ar
 * ou a quota esgotada, o remarketing tem de continuar a sair — e uma campanha
 * que falha em silencio parece estar a funcionar.
 *
 * `{nome}` e substituido pelo primeiro nome do lead.
 */
/**
 * O funil de quem nao converteu tem exactamente dois toques, cada um com o seu
 * texto. Nao sao variacoes da mesma mensagem: o primeiro assume que a pessoa
 * pode ter travado a criar a conta e oferece ajuda; o segundo diz que o lugar
 * continua la. Mandar o segundo texto a quem nunca levou o primeiro estragava
 * os dois.
 */
export const NAO_CONVERTIDO_TOUCHES: Array<{ brief: string; fallbacks: string[] }> = [
  {
    brief: `Primeiro toque, cerca de 24 horas depois de o lead ter ficado calado.
Ele falou contigo e nao chegou a entrar. Fala da assertividade do grupo hoje,
pergunta se ficou com alguma duvida a criar a conta e poe-te a jeito para
ajudar. Amigavel e directo, como quem se lembrou da pessoa.`,
    fallbacks: [
      'Boas {nome}! Olha, a malta no grupo VIP está a ter uma assertividade absurda hoje. Tens a certeza que não queres aproveitar isto? Diz-me se ficaste com alguma dúvida ao criar a conta para te ajudar a entrar.',
      '{nome}, tudo bem? O grupo hoje está a bater certo que se farta. Ficaste com alguma dúvida na criação da conta? Diz-me que eu ajudo-te a tratar disso.',
      'Boas {nome}! A assertividade no VIP hoje está muito boa e lembrei-me de ti. Travaste nalguma parte do registo? É só dizeres e eu explico o resto.',
    ],
  },
  {
    brief: `Segundo e ULTIMO toque, cerca de 48 horas depois do primeiro. Diz que
o bot continua a bater certo e que a malta esta a faturar, lembra que o acesso
dele continua reservado, e convida-o a fechar isso. Tranquilo, sem cobranca e
sem queixume por ele nao ter respondido ao primeiro.`,
    fallbacks: [
      'Tranquilo {nome}? Passava só para te dizer que o bot continua a bater certinho e a malta está a faturar bem. O teu acesso ainda está reservado, bora lá fechar isso para entrares no ritmo com a malta?',
      '{nome}, tudo fixe? O bot continua a acertar e o pessoal lá dentro está a faturar. O teu lugar continua reservado, queres fechar isso hoje?',
      'Boas {nome}! O grupo continua a bater certo e guardei-te o acesso. Bora lá tratar disso para entrares no ritmo com a malta?',
    ],
  },
];

const FALLBACK_SCRIPTS: Record<RemarketingAudience, string[]> = {
  // Usado so se alguem pedir "nao_convertido" sem dizer o toque; o caminho
  // normal passa pelo NAO_CONVERTIDO_TOUCHES acima.
  nao_convertido: NAO_CONVERTIDO_TOUCHES[0]?.fallbacks ?? [],
  vip: [
    'Boas companheiro! Ja foste dar uma olhadela as entradas que mandei hoje no VIP? Nao deixes passar os greens!',
    '{nome}, mandei as entradas do dia no grupo. Da la um salto antes que os jogos comecem.',
    'Tudo bem {nome}? Passa pelo VIP para veres o que ja saiu hoje, nao quero que percas nenhuma.',
  ],
  promessa: [
    'Boas malandro, ja saiste do trabalho? As apostas da noite saem daqui a bocado no VIP, estas pronto para abrires a conta e entrares?',
    '{nome}, conforme combinado aqui estou eu. Ja tens um bocadinho para tratar disso?',
    'Boas {nome}, ficou combinado que te apitava a esta hora. Ainda vais a tempo das entradas de hoje.',
  ],
};

const BRIEFS: Record<RemarketingAudience, string> = {
  nao_convertido: NAO_CONVERTIDO_TOUCHES[0]?.brief ?? '',
  vip: `Estes leads ja estao no grupo VIP. A mensagem deve puxa-los de volta ao
grupo para verem as entradas do dia. Tom de companheirismo, nada de vendas —
estas pessoas ja compraram.`,
  promessa: `Este lead disse que tratava do assunto a esta hora e tu ficaste de
lhe apitar. A mensagem e o cumprimento desse combinado, nao uma cobranca:
lembra que ficou combinado, pergunta se ele ja tem um bocadinho, e refere que
as entradas de hoje ainda vao a tempo. Nada de pressao e nada de queixume por
ele nao ter feito ainda.`,
};

/** Guiao do toque pedido, ou o brief fixo do publico quando nao ha toques. */
function briefFor(audience: RemarketingAudience, touch: number): string {
  if (audience !== 'nao_convertido') return BRIEFS[audience];
  return NAO_CONVERTIDO_TOUCHES[touch]?.brief ?? BRIEFS.nao_convertido;
}

function buildPrompt(audience: RemarketingAudience, touch: number): string {
  return `Es o ${env.AGENT_NAME}, dono do grupo "${env.GROUP_NAME}".

Escreve UMA mensagem de acompanhamento para enviar por Telegram.

${briefFor(audience, touch)}

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

function pickFallback(audience: RemarketingAudience, touch: number): string {
  const scripts =
    audience === 'nao_convertido'
      ? (NAO_CONVERTIDO_TOUCHES[touch]?.fallbacks ?? FALLBACK_SCRIPTS.nao_convertido)
      : FALLBACK_SCRIPTS[audience];

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
        contents: buildPrompt(audience, touch),
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
    return { template: pickFallback(audience, touch), generated: false };
  }

  // Sem o marcador nao ha personalizacao; melhor um guiao que a tem.
  if (!result.includes('{nome}')) {
    log.warn(`mensagem gerada sem {nome}; a usar guiao de reserva para "${audience}"`);
    return { template: pickFallback(audience, touch), generated: false };
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
