import { GoogleGenAI, ThinkingLevel, type Content } from '@google/genai';

import { env } from '../config/env';
import type { Lead, StoredMessage } from '../db/database';
import { createLogger } from '../utils/logger';
import { persona, resolveHouseLink } from '../personas';
import { sanitiseDashes } from '../utils/text';
import { withRetry } from './retry';
import type { LeadProfile, SalesDirective } from './strategist';

const log = createLogger('writer');

let cachedClient: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  cachedClient ??= new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  return cachedClient;
}

const PERSONA = persona.writerPersona;

const PROFILE_GUIDANCE: Record<LeadProfile, string> = {
  indefinido: 'Ainda nao sabes que tipo de lead e. Pergunta, nao empurres.',
  recetivo: 'Ja quer entrar. Vai direto ao passo seguinte, sem enrolar.',
  cetico:
    'Duvida que seja serio. Transparencia acima de argumento: admite que as ' +
    'entradas falham as vezes. Empatia, zero pressao.',
  sem_dinheiro:
    'A objecao e o dinheiro. Deixa claro que entrar no grupo nao custa nada e ' +
    `que os ${env.MIN_DEPOSIT} ficam na conta dele, como saldo dele. Nunca ` +
    'sugiras que arranje dinheiro que nao tem.',
  dificil:
    'Ja resistiu ou respondeu seco. Paciencia e explicacao calma, uma vez. ' +
    'Nao insistas duas vezes seguidas no mesmo ponto.',
};

/**
 * Adiamento nao e recusa: e alguem com horario de trabalho. Insistir aqui
 * transforma um "logo" num "nunca", por isso a regra e explicita e nao fica
 * ao criterio do modelo.
 */
function postponementRule(directive: SalesDirective): string {
  if (!directive.promisedTime) return '';

  return (
    `O lead adiou para as ${directive.promisedTime}. Aceita com calma total — ` +
    'o trabalho e a familia vem primeiro, e dizes isso a serio. Confirma que ' +
    'lhe apitas a essa hora, como um favor que ele te faz e nao como cobranca. ' +
    'NAO insistas, NAO mandes link e NAO faças a mensagem parecer um aviso de ' +
    'cobranca.'
  );
}

/**
 * Interdicao da fase, calculada aqui e nao pedida ao modelo. A sequencia de
 * abordagem e o unico ponto do funil onde uma classificacao errada do
 * estrategista custa o lead na hora: pedir dinheiro a segunda mensagem queima
 * a conversa e nao ha volta. Por isso a regra e determinista.
 *
 * So se aplica enquanto o lead esta no inicio do funil: quem ja disse que se
 * registou nao pode ser impedido de falar do deposito por causa do turno.
 *
 * Exportada por ser a regra mais dificil de verificar so por observacao das
 * respostas — e a mais cara de errar.
 */
export function phaseRule(turn: number, stage: SalesDirective['stage']): string {
  const early = stage === 'novo' || stage === 'qualificacao';

  if (early && turn <= 2) {
    return (
      'FASE — RAPPORT: esta mensagem e so conversa. PROIBIDO mencionar registo, ' +
      `deposito, link, valores, bonus ou ${env.PLATFORM_NAME}. Se o lead perguntar ` +
      'quanto custa, diz que ja la vais e faz-lhe uma pergunta sobre ele. ' +
      'Descobre o nome, o cantao onde vive ou ha quanto tempo esta na Suica.'
    );
  }

  if (early && turn === 3) {
    return (
      'FASE — COMUNIDADE E RESULTADOS: apresenta o grupo e o que ele ja fez. ' +
      'AINDA NAO fales de condicao de entrada, deposito ou link.'
    );
  }

  if (early && turn === 4) {
    return (
      'FASE — CONDICAO E PRONTIDAO: explica que entrar e gratuito e o que e ' +
      'preciso, e TERMINA a perguntar se ele esta pronto para abrir a conta e ' +
      'garantir a vaga no VIP. NAO mandes o link nesta mensagem.'
    );
  }

  return '';
}

/**
 * O link so sai depois de o lead dizer que sim. A pergunta de prontidao e
 * feita no turno 4, portanto a confirmacao chega no 5 ou depois — e ate la o
 * link fica travado em codigo, mesmo que a diretriz peca o contrario.
 *
 * Mandar o link cedo de mais custa o lead duas vezes: perde-se o
 * micro-compromisso que faz a pessoa avancar, e a conversa passa a parecer o
 * spam de casino que toda a gente ja recebeu.
 */
export function linkAllowed(turn: number, stage: SalesDirective['stage']): boolean {
  const early = stage === 'novo' || stage === 'qualificacao';
  return !early || turn >= 5;
}

function buildDirectiveBlock(directive: SalesDirective, lead: Lead, turn: number): string {
  const sendLink = directive.includeLink && linkAllowed(turn, directive.stage);
  const link = resolveHouseLink(persona, directive.affiliateHouse);

  const linkRule =
    sendLink && link
      ? `Inclui o link de registo exatamente assim: ${link}\n` +
        `Diz tambem: o deposito minimo e ${env.MIN_DEPOSIT}; para acompanhar todas as ` +
        `entradas do dia sem esgotar a banca o ideal e comecar com ${env.SUGGESTED_DEPOSIT} ` +
        `(conselho teu, nao requisito); e que basta mandares o print do deposito para ` +
        'teres acesso imediato ao VIP.'
      : 'NAO incluas nenhum link nesta mensagem.';

  const complianceRule = sendLink
    ? `Ao mandar o link, fecha a mensagem com este aviso, em linha separada: "${env.COMPLIANCE_NOTE}"`
    : 'Nao e preciso repetir o aviso legal nesta mensagem.';

  const stopRule = directive.shouldStop
    ? 'ENCERRAMENTO: agradece, respeita a decisao do lead, diz que ele pode voltar a falar quando quiser e NAO faças nenhuma oferta nem pergunta de vendas.'
    : `PROXIMO PASSO: ${directive.cta}`;

  const phase = phaseRule(turn, directive.stage);
  const postponement = postponementRule(directive);

  const cantonRule = lead.canton
    ? `O lead vive em ${lead.canton}. JA TE DISSE ISTO: e PROIBIDO voltar a ` +
      'perguntar onde mora, mesmo por outras palavras.'
    : '';

  return `[DIRETRIZ INTERNA — NAO MOSTRES AO LEAD]
${phase ? `${phase}\n` : ''}${postponement ? `${postponement}\n` : ''}${cantonRule ? `${cantonRule}\n` : ''}Nome do lead: ${lead.firstName ?? 'desconhecido'}
Estagio do funil: ${directive.stage}
Perfil do lead: ${directive.profile} — ${PROFILE_GUIDANCE[directive.profile]}
Intencao detetada: ${directive.intent}
Objecao a tratar: ${directive.objection}
Interesse (0-100): ${directive.temperature}
Tom pedido: ${directive.tone}
Instrucao: ${directive.directive}
${stopRule}
${linkRule}
${complianceRule}

Escreve agora a proxima mensagem para o lead, em portugues de Portugal.
Apenas o texto da mensagem.`;
}

/**
 * O Gemini exige que a conversa comece com `user`, alterne os papeis e nao
 * tenha turnos vazios; historicos truncados podem comecar pelo atendente.
 * Aqui a janela e normalizada: descarta o prefixo do assistente e funde
 * turnos consecutivos do mesmo lado. O papel do assistente chama-se "model".
 */
function toGeminiContents(history: StoredMessage[]): Content[] {
  const contents: Content[] = [];

  for (const stored of history) {
    const text = stored.content.trim();
    if (text.length === 0) continue;
    if (contents.length === 0 && stored.role !== 'user') continue;

    const role = stored.role === 'assistant' ? 'model' : 'user';
    const last = contents[contents.length - 1];

    if (last && last.role === role && last.parts?.[0]) {
      last.parts[0].text = `${last.parts[0].text ?? ''}\n\n${text}`;
      continue;
    }

    contents.push({ role, parts: [{ text }] });
  }

  return contents;
}



/**
 * Parte um texto em frases sem partir URLs. O link de afiliado tem pontos
 * (dominio, extensao, parametros) e um divisor ingenuo cortava-o ao meio —
 * o lead recebia meia ligacao, que nao abre.
 */
function splitSentences(text: string): string[] {
  const urls: string[] = [];
  const masked = text.replace(/https?:\/\/\S+/g, (url) => {
    urls.push(url);
    return `\u0000${urls.length - 1}\u0000`;
  });

  const restore = (part: string) =>
    part.replace(/\u0000(\d+)\u0000/g, (_, index: string) => urls[Number(index)] ?? '');

  return masked
    .split(/(?<=[.!?])\s+/)
    .map((part) => restore(part).trim())
    .filter((part) => part.length > 0);
}

/** Abaixo disto, um fragmento nao e uma mensagem: e um restinho. */
const MIN_BUBBLE_CHARS = 25;

/**
 * Cola fragmentos curtos de mais a mensagem vizinha.
 *
 * Ao partir por frases, a pontuacao final costuma deixar orfaos: um emoji
 * sozinho, um "Ya." solto. Entregues como mensagem propria, denunciam o bot
 * mais do que o testamento que se estava a evitar — ninguem manda uma
 * mensagem so com um emoji a meio de uma explicacao.
 *
 * So se aplica DENTRO de um bloco que este codigo partiu. Uma linha em branco
 * escrita pelo redator e uma separacao deliberada: tres mensagens curtas
 * seguidas sao uma escolha dele, nao um acidente, e coladas destruiriam o
 * fracionamento que se pediu.
 */
function mergeOrphans(blocks: string[]): string[] {
  const result: string[] = [];

  for (const block of blocks) {
    const previous = result[result.length - 1];

    if (block.length < MIN_BUBBLE_CHARS && previous) {
      result[result.length - 1] = `${previous} ${block}`;
      continue;
    }

    result.push(block);
  }

  // Um primeiro bloco curto nao tinha vizinho anterior; junta-se ao seguinte.
  if (result.length > 1 && (result[0]?.length ?? 0) < MIN_BUBBLE_CHARS) {
    const [first, second, ...rest] = result;
    return [`${first} ${second}`, ...rest];
  }

  return result;
}

/**
 * Converte a resposta do redator nas mensagens que o lead vai receber.
 *
 * A linha em branco e a separacao que o modelo produz naturalmente, e e o que
 * a persona lhe pede. Mas um modelo que devolva um paragrafo unico nao pode
 * resultar num testamento, por isso os blocos compridos sao partidos por
 * frases — a instrucao de prompt e uma preferencia, esta funcao e a garantia.
 */
export function splitIntoBubbles(
  text: string,
  maxBubbles: number,
  maxChars: number = persona.maxBubbleChars,
): string[] {
  const blocks = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  const expanded: string[] = [];

  for (const block of blocks) {
    if (block.length <= maxChars) {
      expanded.push(block);
      continue;
    }

    const sentences = splitSentences(block);
    const pieces: string[] = [];
    let buffer = '';

    for (const sentence of sentences) {
      // Junta frases curtas seguidas: uma mensagem com tres palavras nao
      // parece alguem a escrever, parece uma falha.
      const candidate = buffer ? `${buffer} ${sentence}` : sentence;

      if (candidate.length > maxChars && buffer) {
        pieces.push(buffer);
        buffer = sentence;
      } else {
        buffer = candidate;
      }
    }

    if (buffer) pieces.push(buffer);

    // Orfaos so entre os pedacos deste bloco, nunca entre blocos.
    expanded.push(...mergeOrphans(pieces));
  }

  const merged = expanded;

  if (merged.length === 0) return [text.trim()].filter((part) => part.length > 0);
  if (merged.length <= maxBubbles) return merged;

  // Excedentes vao para a ultima: cortar perderia texto, e o aviso legal e a
  // pergunta final costumam ser as ultimas linhas.
  const kept = merged.slice(0, maxBubbles - 1);
  kept.push(merged.slice(maxBubbles - 1).join('\n\n'));
  return kept;
}

/** Resposta usada quando o redator falha, para o lead nunca ficar no vacuo. */
function fallbackReply(lead: Lead): string {
  return persona.fallbackReply(lead.firstName);
}

/**
 * Etapa 2 da cadeia: o redator recebe a diretriz do estrategista e o
 * historico, e redige a mensagem final que vai para o lead.
 */
export async function writeReply(params: {
  lead: Lead;
  history: StoredMessage[];
  incoming: string;
  directive: SalesDirective;
}): Promise<string> {
  const { lead, history, incoming, directive } = params;

  // Mesma contagem que o estrategista usa, para os dois concordarem sobre em
  // que ponto da sequencia a conversa esta.
  const turn = history.filter((message) => message.role === 'user').length + 1;

  const contents = toGeminiContents([
    ...history,
    {
      id: 0,
      chatId: lead.chatId,
      role: 'user',
      content: incoming,
      directive: null,
      createdAt: new Date().toISOString(),
    },
  ]);

  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: incoming }] });
  }

  const startedAt = Date.now();

  const reply = await withRetry({
    attempts: 3,
    log,
    label: 'redator',
    run: async () => {
      const result = await getClient().models.generateContent({
      model: env.GEMINI_WRITER_MODEL,
      contents,
      config: {
          // A persona e fixa; a diretriz muda a cada turno. As duas juntas na
          // instrucao de sistema mantem o historico livre de texto interno, que
          // o lead nunca deve ver ecoado de volta.
          systemInstruction: `${PERSONA}\n\n${buildDirectiveBlock(directive, lead, turn)}`,
          // O redator nao decide nada: a estrategia ja veio pronta. Pensar aqui
          // so adiciona latencia a uma mensagem de 1-3 frases.
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
          temperature: 0.9,
          maxOutputTokens: env.GEMINI_WRITER_MAX_TOKENS,
        },
      });

      const usage = result.usageMetadata;

      log.debug(`resposta redigida em ${Date.now() - startedAt}ms`, {
        chatId: lead.chatId,
        inputTokens: usage?.promptTokenCount,
        outputTokens: usage?.candidatesTokenCount,
        finishReason: result.candidates?.[0]?.finishReason,
      });

      // Limpa aqui, e nao so no envio: a resposta tambem vai para o
      // historico, e um travessao gravado ensina o modelo a repeti-lo no
      // turno seguinte.
      return sanitiseDashes(result.text ?? '');
    },
  });

  return reply && reply.length > 0 ? reply : fallbackReply(lead);
}
