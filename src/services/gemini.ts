import { GoogleGenAI, ThinkingLevel, Type, type Schema } from '@google/genai';

import { env } from '../config/env';
import { FUNNEL_STAGES, type FunnelStage, type Lead, type StoredMessage } from '../db/database';
import { createLogger } from '../utils/logger';

const log = createLogger('gemini');

/**
 * Saida do Estrategista. Nao e texto para o lead: e a diretriz interna que o
 * Claude recebe para redigir a resposta final.
 */
export interface SalesDirective {
  /** O que o lead quer neste momento, em uma frase. */
  intent: string;
  /** Estagio do funil apos esta mensagem. */
  stage: FunnelStage;
  /** Principal objecao detectada, ou "nenhuma". */
  objection: string;
  /** 0-100: quao perto o lead esta de cadastrar/depositar. */
  temperature: number;
  /** Instrucao de vendas para o redator (o coracao da diretriz). */
  directive: string;
  /** Proximo passo concreto pedido ao lead. */
  cta: string;
  /** Tom sugerido para a resposta. */
  tone: string;
  /** Se true, o link de afiliado deve aparecer na resposta. */
  includeLink: boolean;
  /** Fatos que valem guardar sobre o lead (memoria de longo prazo). */
  notes: string;
  /** Se true, o lead pediu para parar / nao tem perfil: encerrar com respeito. */
  shouldStop: boolean;
}

const responseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    intent: { type: Type.STRING, description: 'Intencao do lead em uma frase' },
    stage: {
      type: Type.STRING,
      enum: [...FUNNEL_STAGES],
      description: 'Estagio do funil apos esta mensagem',
    },
    objection: { type: Type.STRING, description: 'Objecao principal ou "nenhuma"' },
    temperature: { type: Type.NUMBER, description: 'Interesse de 0 a 100' },
    directive: { type: Type.STRING, description: 'Instrucao de vendas para o redator' },
    cta: { type: Type.STRING, description: 'Proximo passo pedido ao lead' },
    tone: { type: Type.STRING, description: 'Tom sugerido para a resposta' },
    includeLink: { type: Type.BOOLEAN, description: 'Incluir o link de afiliado?' },
    notes: { type: Type.STRING, description: 'Fatos a memorizar sobre o lead' },
    shouldStop: { type: Type.BOOLEAN, description: 'O lead pediu para parar?' },
  },
  required: [
    'intent',
    'stage',
    'objection',
    'temperature',
    'directive',
    'cta',
    'tone',
    'includeLink',
    'notes',
    'shouldStop',
  ],
};

const SYSTEM_INSTRUCTION = `Voce e o ESTRATEGISTA de um funil de vendas por Telegram da plataforma de afiliados "${env.PLATFORM_NAME}".

Voce NUNCA fala com o lead. Sua unica saida e um JSON com a diretriz interna que
um redator humano vai usar para escrever a proxima mensagem.

OBJETIVO DO FUNIL, nesta ordem:
1. Qualificar o lead (interesse real, disponibilidade, experiencia previa).
2. Apresentar a plataforma e a oferta corrente: ${env.CURRENT_OFFER}.
3. Levar ao cadastro pelo link de afiliado.
4. Levar ao primeiro deposito (minimo comunicado: ${env.MIN_DEPOSIT}).

COMO DECIDIR:
- Leia todo o historico antes de classificar. Nao repita um passo ja concluido.
- Uma objecao por vez. Ataque a objecao real, nao a que voce prefere responder.
- "includeLink" so deve ser true quando o lead demonstrou interesse concreto ou
  pediu o link. Mandar link cedo demais queima o lead.
- Se o lead ja disse que cadastrou, o proximo passo e o deposito, nao o cadastro.
- "temperature" alta (>70) pede CTA direto; baixa (<30) pede pergunta aberta.

LIMITES INEGOCIAVEIS (violar invalida a diretriz):
- Nunca prometa lucro garantido, ganho certo, "dinheiro facil" ou valores de
  retorno. Nunca invente numeros, prints, depoimentos ou resultados.
- Nunca peca senha, codigo de verificacao, dados de cartao ou documentos.
- Nunca pressione quem menciona divida, desespero financeiro, vicio ou idade
  abaixo de ${env.MIN_AGE} anos: nesses casos, defina shouldStop=true.
- Se o lead pedir para parar, sair, ou disser que nao tem interesse, defina
  shouldStop=true e uma diretriz de encerramento cordial.
- Urgencia so pode ser real. Nao invente prazos ou vagas limitadas.`;

let cachedClient: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  cachedClient ??= new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  return cachedClient;
}

function renderHistory(history: StoredMessage[]): string {
  if (history.length === 0) return '(primeira mensagem do lead)';

  return history
    .map((message) => `${message.role === 'user' ? 'LEAD' : 'ATENDENTE'}: ${message.content}`)
    .join('\n');
}

function clampTemperature(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 50;
  return Math.min(100, Math.max(0, Math.round(numeric)));
}

function coerceStage(value: unknown, fallback: FunnelStage): FunnelStage {
  return FUNNEL_STAGES.includes(value as FunnelStage) ? (value as FunnelStage) : fallback;
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

/**
 * Diretriz usada quando o Gemini falha ou devolve algo inutilizavel. Deixa o
 * funil degradar para uma pergunta de qualificacao em vez de derrubar o chat.
 */
function fallbackDirective(lead: Lead): SalesDirective {
  return {
    intent: 'Nao foi possivel classificar a intencao (falha no estrategista).',
    stage: lead.stage === 'novo' ? 'qualificacao' : lead.stage,
    objection: 'nenhuma',
    temperature: 40,
    directive:
      'Responda de forma breve e acolhedora, retome o ultimo ponto do lead e faca ' +
      'uma pergunta aberta para entender o que ele procura. Nao avance para o link.',
    cta: 'Fazer uma pergunta de qualificacao.',
    tone: 'informal, calmo, sem pressao',
    includeLink: false,
    notes: '',
    shouldStop: false,
  };
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function isRetryable(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  return typeof status === 'number' && RETRYABLE_STATUS.has(status);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Etapa 1 da cadeia: o Gemini le o contexto e devolve a diretriz de vendas.
 * Nunca lanca — em caso de erro devolve uma diretriz conservadora.
 */
export async function planStrategy(params: {
  lead: Lead;
  history: StoredMessage[];
  incoming: string;
}): Promise<SalesDirective> {
  const { lead, history, incoming } = params;

  const prompt = `CONTEXTO DO LEAD
- chat_id: ${lead.chatId}
- nome: ${lead.firstName ?? 'desconhecido'}
- estagio atual: ${lead.stage}
- mensagens trocadas: ${lead.messageCount}
- anotacoes anteriores: ${lead.notes ?? '(nenhuma)'}

HISTORICO RECENTE
${renderHistory(history)}

NOVA MENSAGEM DO LEAD
${incoming}

Devolva apenas o JSON da diretriz.`;

  const startedAt = Date.now();

  // O 503 "high demand" do Gemini e comum e transitorio. Sem retry ele vira
  // um turno perdido com o lead, entao tentamos de novo com backoff curto —
  // curto porque do outro lado tem alguem olhando o "digitando...".
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await requestDirective({ lead, prompt, startedAt });
    } catch (error) {
      if (attempt < MAX_ATTEMPTS && isRetryable(error)) {
        const backoff = 400 * 2 ** (attempt - 1);
        log.warn(`estrategista indisponivel (tentativa ${attempt}/${MAX_ATTEMPTS}); nova tentativa em ${backoff}ms`);
        await sleep(backoff);
        continue;
      }

      log.error('falha ao gerar a diretriz; usando fallback', error);
      return fallbackDirective(lead);
    }
  }

  return fallbackDirective(lead);
}

async function requestDirective(params: {
  lead: Lead;
  prompt: string;
  startedAt: number;
}): Promise<SalesDirective> {
  const { lead, prompt, startedAt } = params;

  {
    const result = await getClient().models.generateContent({
      model: env.GEMINI_MODEL,
      contents: prompt,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        temperature: 0.4,
        // Os modelos Gemini 3.x raciocinam antes de responder, e o thinking
        // consome o mesmo orcamento de saida: com pouco espaco o JSON volta
        // truncado. O estrategista precisa de latencia baixa, nao de
        // raciocinio profundo — quem decide ja recebe o contexto pronto.
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
        responseSchema,
      },
    });

    const raw = result.text;

    if (!raw) {
      throw new Error('resposta vazia do estrategista');
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;

    const directive: SalesDirective = {
      intent: text(parsed.intent, 'intencao nao identificada'),
      stage: coerceStage(parsed.stage, lead.stage === 'novo' ? 'qualificacao' : lead.stage),
      objection: text(parsed.objection, 'nenhuma'),
      temperature: clampTemperature(parsed.temperature),
      directive: text(parsed.directive, fallbackDirective(lead).directive),
      cta: text(parsed.cta, 'Fazer uma pergunta de qualificacao.'),
      tone: text(parsed.tone, 'informal e direto'),
      includeLink: parsed.includeLink === true,
      notes: text(parsed.notes, ''),
      shouldStop: parsed.shouldStop === true,
    };

    log.debug(`diretriz gerada em ${Date.now() - startedAt}ms`, {
      chatId: lead.chatId,
      stage: directive.stage,
      temperature: directive.temperature,
      includeLink: directive.includeLink,
    });

    return directive;
  }
}
