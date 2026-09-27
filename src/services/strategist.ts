import { GoogleGenAI, ThinkingLevel, Type, type Schema } from '@google/genai';

import { env } from '../config/env';
import {
  FUNNEL_STAGES,
  getConversionPlaybook,
  type FunnelStage,
  type Lead,
  type PlaybookEntry,
  type StoredMessage,
} from '../db/database';
import { createLogger } from '../utils/logger';
import { proximaPerguntaDe } from '../personas/types';
import type { LeadComFactos, Persona } from '../personas/types';
import { deveCumprimentar, saudacaoAgora } from '../utils/saudacao';
import { withRetry } from './retry';

const log = createLogger('estrategista');

/**
 * Saida do Estrategista. Nao e texto para o lead: e a diretriz interna que o
 * redator recebe para redigir a resposta final.
 */
export const LEAD_PROFILES = [
  'indefinido',
  'recetivo',
  'cetico',
  'sem_dinheiro',
  'dificil',
] as const;

export type LeadProfile = (typeof LEAD_PROFILES)[number];

/**
 * Porque e que a venda para.
 *
 * - "aperto": ele disse que nao tem dinheiro para isto, que ia pedir
 *   emprestado ou tirar do que e preciso para as contas. A IA cala-se e a
 *   conversa passa para uma pessoa, que decide o que dizer.
 * - "parar": pediu para nao ser incomodado. Encerra-se e fica assim.
 * - "menor" / "vicio": nao ha venda nem conversa a mao. Encerra-se.
 */
export const STOP_REASONS = ['nenhum', 'aperto', 'parar', 'menor', 'vicio'] as const;

export type StopReason = (typeof STOP_REASONS)[number];

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
  /** Perfil psicologico do lead; decide como o redator o aborda. */
  profile: LeadProfile;
  /**
   * Hora "HH:MM" que o lead deu para tratar do deposito, ou "" se nao deu
   * nenhuma. E o que agenda o lembrete individual.
   */
  promisedTime: string;
  /**
   * Cantao que o lead indicou NESTA mensagem, ou "" se nao indicou nada.
   * Serve para gravar, nunca para justificar repetir a pergunta.
   */
  canton: string;
  /**
   * Em que o lead trabalha, nas palavras dele, se o disser NESTA mensagem; ""
   * caso contrario. Serve para gravar, nunca para justificar repetir a pergunta.
   */
  job: string;
  /**
   * "experiente" ou "iniciante", se o lead o disser NESTA mensagem; "" caso
   * contrario. Serve para gravar, nunca para justificar repetir a pergunta.
   */
  bettingExperience: string;
  /** O nome dele, se o DISSER nesta mensagem. Vazio caso contrario. */
  nome: string;
  /** O que lhe chamou a atencao, se o disser NESTA mensagem. */
  atencao: string;
  /** Ha quanto tempo vive na Suica, se o disser NESTA mensagem. */
  tempoSuica: string;
  /** Se true, o link de afiliado deve aparecer na resposta. */
  includeLink: boolean;
  /** Fatos que valem guardar sobre o lead (memoria de longo prazo). */
  notes: string;
  /** Se true, o lead pediu para parar / nao tem perfil: encerrar com respeito. */
  shouldStop: boolean;
  /**
   * Porque e que se para. Decide o que acontece a seguir, e nao e a mesma
   * coisa em todos os casos: "aperto" passa a conversa para uma pessoa, os
   * outros encerram-na.
   */
  stopReason: StopReason;
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
    profile: {
      type: Type.STRING,
      enum: [...LEAD_PROFILES],
      description: 'Perfil psicologico do lead',
    },
    promisedTime: {
      type: Type.STRING,
      description: 'Hora HH:MM que o lead deu para tratar do deposito, ou vazio',
    },
    job: {
      type: Type.STRING,
      description:
        'Em que o lead disse trabalhar NESTA mensagem, em poucas palavras ' +
        '(ex.: "construcao civil", "enfermeira", "restauracao"). Se ele disser ' +
        'que NAO trabalha, que esta desempregado ou que estuda, isso TAMBEM e ' +
        'uma resposta: poe "nao trabalha", "desempregado" ou "estudante". So ' +
        'fica vazio se ele nao falar do assunto de todo.',
    },
    bettingExperience: {
      type: Type.STRING,
      description:
        'Se o lead disse NESTA mensagem que ja aposta ou que esta a comecar: ' +
        '"experiente" ou "iniciante". Vazio se nao disse nada sobre isso.',
    },
    canton: {
      type: Type.STRING,
      description: 'Cantao ou cidade da Suica que o lead indicou nesta mensagem, ou vazio',
    },
    nome: {
      type: Type.STRING,
      description:
        'O primeiro nome do lead, se ele o disser NESTA mensagem (ex.: "sou o ' +
        'Mario" -> "Mario"). Vazio se nao disse o nome.',
    },
    atencao: {
      type: Type.STRING,
      description:
        'O que o lead disse que lhe chamou a atencao ou o trouxe aqui, NESTA ' +
        'mensagem, em poucas palavras. Vazio se nao falou disso.',
    },
    tempoSuica: {
      type: Type.STRING,
      description:
        'Ha quanto tempo o lead disse viver na Suica, NESTA mensagem (ex.: ' +
        '"3 anos", "desde 2019", "nasci ca"). Vazio se nao falou disso.',
    },
    includeLink: { type: Type.BOOLEAN, description: 'Incluir o link de afiliado?' },
    notes: { type: Type.STRING, description: 'Fatos a memorizar sobre o lead' },
    shouldStop: { type: Type.BOOLEAN, description: 'O lead pediu para parar?' },
    stopReason: {
      type: Type.STRING,
      enum: [...STOP_REASONS],
      description:
        'Se shouldStop=true, PORQUE: "aperto" (disse que nao tem dinheiro ' +
        'para isto, que ia pedir emprestado ou tirar do dinheiro das contas), ' +
        '"parar" (pediu para nao ser incomodado), "menor", "vicio". ' +
        '"nenhum" quando shouldStop=false.',
    },
  },
  required: [
    'intent',
    'stage',
    'objection',
    'temperature',
    'directive',
    'cta',
    'tone',
    'profile',
    'promisedTime',
    'canton',
    'job',
    'bettingExperience',
    'nome',
    'atencao',
    'tempoSuica',
    'includeLink',
    'notes',
    'shouldStop',
    'stopReason',
  ],
};


let cachedClient: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  cachedClient ??= new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  return cachedClient;
}

/**
 * Diretrizes que ja levaram leads ao deposito, formatadas para o prompt. Com
 * o funil vazio devolve string vazia e a seccao nem chega a existir — nao ha
 * nada a ensinar e um bloco vazio so confundiria o modelo.
 */
function renderPlaybook(entries: PlaybookEntry[]): string {
  if (entries.length === 0) return '';

  const lines = entries
    .map(
      (entry, index) =>
        `${index + 1}. [perfil: ${entry.profile} | objecao: ${entry.objection}]\n` +
        `   Abordagem: ${entry.directive}\n` +
        `   Passo pedido: ${entry.cta}`,
    )
    .join('\n');

  return `\nABORDAGENS QUE JA CONVERTERAM (leads que chegaram ao deposito)\n${lines}\n`;
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
      'Responde de forma breve e proxima, pega no ultimo ponto do lead e faz ' +
      'uma pergunta aberta para perceber o que ele procura. Nao avances para o link.',
    cta: 'Fazer uma pergunta de qualificacao.',
    tone: 'informal, calmo, sem pressao',
    profile: 'indefinido',
    promisedTime: '',
    canton: '',
    job: '',
    bettingExperience: '',
    nome: '',
    atencao: '',
    tempoSuica: '',
    includeLink: false,
    notes: '',
    shouldStop: false,
    stopReason: 'nenhum',
  };
}

/** Marcador que o /start de um lead recorrente injecta como mensagem. */
export function isReturningTurn(incoming: string): boolean {
  return incoming.startsWith('[o lead voltou e carregou em /start');
}

/**
 * Instrucoes de regresso, so no turno em que ha mesmo um regresso.
 *
 * Isto vivia no system instruction, que vai em todos os turnos, e vazava: o
 * modelo dizia "vi que voltaste" a quem estava a meio da primeira conversa e
 * nunca tinha saido. Um bloco insistente que nao se aplica ao turno e pior do
 * que nao existir, porque tinge tudo o resto.
 */
function returningBlock(incoming: string): string {
  if (!isReturningTurn(incoming)) {
    return `ESTE TURNO NAO E UM REGRESSO. O lead esta a conversar contigo agora.
E PROIBIDO dizer ou dar a entender que ele voltou, que reapareceu, que tinha
desaparecido ou que ficou sem responder a alguma coisa. Trata isto como a
conversa que e.`;
  }

  return `LEAD QUE VOLTA — quem carrega outra vez em /start ja te conhece:
- Se a nova mensagem for o marcador "[o lead voltou e carregou em /start...]",
  ele nao disse nada de novo: so reapareceu. NAO recomeces o funil, NAO repitas
  a apresentacao, NAO te voltes a apresentar e NAO faças perguntas ja
  respondidas. Ele nao e um desconhecido.
- Reconhece o regresso de forma descontraida, como quem ve entrar um conhecido
  ("outra vez por aqui?"), e passa logo ao assunto que ficou em aberto.
- ANTES DE MAIS, olha para o estagio. Ha dois tipos de regresso:

  (a) O lead JA PASSOU DA QUALIFICACAO (ja lhe falaste do grupo, da condicao
      de entrada ou do link). Entao a diretriz faz duas coisas, nesta ordem:
      1. PERGUNTAR A DECISAO, sem rodeios e sem ser antipatico: se ele ja
         decidiu entrar no grupo ou se vai continuar a adiar.
      2. PUXAR A PROVA SOCIAL DOS RESULTADOS RECENTES, e aqui a expressao
         "green atras de green" e OBRIGATORIA. E a forma como se descreve o
         que o grupo tem andado a fazer, e e o que faz o lead sentir que esta
         a ficar de fora enquanto os outros faturam.

  (b) O lead ainda esta na QUALIFICACAO e nunca chegou a ouvir a proposta.
      Entao PROIBIDO perguntar-lhe se ja decidiu entrar: nao se pergunta a
      decisao a quem nao recebeu proposta nenhuma, e isso denuncia o guiao.
      Aqui o que se faz e retomar a conversa onde ficou, com a pergunta da
      fase 1 que ficou por responder, de forma leve. Os resultados do grupo
      podem entrar de passagem, mas sem cobranca de decisao.
- Poe a expressao no campo "directive", com as palavras exactas, para o redator
  a usar.
- Retoma o passo onde a conversa ficou: a pergunta sem resposta, a duvida por
  esclarecer, ou o passo seguinte do estagio. Se ele ja estava para receber o
  link, volta a perguntar se esta pronto.
- Nada disto autoriza inventar numeros. "Green atras de green" descreve a
  sequencia, nao promete resultado nenhum, e nao se acrescentam percentagens
  nem valores que nao estejam no teu contexto.
- O estagio nao regride por causa disto. Mantem o que ja estava.`;
}

/**
 * Em que fase do funil esta a conversa, decidido em codigo e nao pelo modelo.
 *
 * A fase 1 e so a qualificacao: o trabalho dele e a experiencia com apostas.
 * Assim que as duas respostas estiverem guardadas, a conversa passa a fase 2 e
 * essas perguntas ficam proibidas.
 *
 * Isto e calculado a partir do que esta na base de dados, e nao deixado ao
 * criterio do modelo a ler o historico, porque foi exactamente essa a falha
 * que fez o bot voltar a perguntar o cantao a quem ja o tinha dito. O modelo
 * esquece-se; uma coluna preenchida nao.
 */
/** O que o funil precisa de saber do lead, para decidir o que perguntar. */
/**
 * A proxima pergunta a fazer a este lead, deste influencer.
 *
 * A lista de perguntas e da persona — o El Pedrito quer saber o trabalho e o
 * tempo na Suica, o Ivan quer saber outras coisas — e a regra de qual sai a
 * seguir e comum, por isso vive no types.ts das personas.
 */
export function proximaPergunta(
  persona: Persona,
  lead: LeadComFactos,
): { chave: string; pergunta: string } | null {
  return proximaPerguntaDe(persona.perguntas(lead), lead);
}

/**
 * Monta o prompt do turno. Exportado para ser testavel sem chamar a API: o
 * bloco do playbook e a parte que muda a cada conversao e a que mais custa
 * verificar so por observacao das respostas.
 */
export async function buildPrompt(params: {
  /** Quem esta a falar. Vem do transporte, nunca de uma constante de modulo. */
  persona: Persona;
  lead: Lead;
  history: StoredMessage[];
  incoming: string;
}): Promise<string> {
  const { persona, lead, history, incoming } = params;

  // Lido antes de montar o texto: o playbook vem da base de dados, e um
  // template string nao espera por uma promessa.
  // A persona vem do proprio lead e nao de fora: o que se aprende de quem
  // converteu tem de ser do MESMO influencer.
  const playbook = await getConversionPlaybook({
    persona: lead.persona,
    excludeChatId: lead.chatId,
  });

  return `CONTEXTO DO LEAD
- chat_id: ${lead.chatId}
- como o tratas: ${lead.tratamento ?? '(ainda nao ha nome de pessoa)'}
- nome no perfil do Telegram: ${lead.firstName ?? 'desconhecido'}
${persona.contextoDoLead(lead)}
${deveCumprimentar(history[history.length - 1]?.createdAt)
  ? `- CUMPRIMENTA: esta e a primeira mensagem da conversa (ou do dia). O
  cumprimento certo para a hora da Suica agora e "${saudacaoAgora()}". Usa esse
  e nao outro: tu nao sabes que horas sao, este valor e que sabe.`
  : `- NAO CUMPRIMENTES. A conversa ja vai a meio e ja houve mensagens hoje.
  PROIBIDO comecar com "bom dia", "boa tarde" ou "boa noite" — ninguem
  cumprimenta a mesma pessoa cinco vezes seguidas, e ver isso denuncia a
  maquina. Responde directamente ao que ele disse.`}
- estagio atual: ${lead.stage}
- TURNO NUMERO: ${history.filter((m) => m.role === 'user').length + 1} (usa a SEQUENCIA DE ABORDAGEM)
- anotacoes anteriores: ${lead.notes ?? '(nenhuma)'}

${persona.blocoDeFase(lead, history)}

${returningBlock(incoming)}

HISTORICO RECENTE
${renderHistory(history)}
${renderPlaybook(playbook)}
NOVA MENSAGEM DO LEAD
${incoming}

Devolve apenas o JSON da diretriz.`;
}

/**
 * Etapa 1 da cadeia: o Gemini le o contexto e devolve a diretriz de vendas.
 * Nunca lanca — em caso de erro devolve uma diretriz conservadora.
 */
export async function planStrategy(params: {
  persona: Persona;
  lead: Lead;
  history: StoredMessage[];
  incoming: string;
}): Promise<SalesDirective> {
  const { persona, lead, history, incoming } = params;

  const prompt = await buildPrompt(params);

  const startedAt = Date.now();

  // O 503 "high demand" e o 429 de quota sao comuns e transitorios. Sem retry
  // viram turno perdido com o lead; o withRetry respeita o prazo que o proprio
  // Gemini pede no 429, que e o unico que tem chance de passar.
  const directive = await withRetry({
    attempts: 3,
    log,
    label: 'estrategista',
    run: () => requestDirective({ persona, lead, prompt, startedAt }),
  });

  return directive ?? fallbackDirective(lead);
}

async function requestDirective(params: {
  persona: Persona;
  lead: Lead;
  prompt: string;
  startedAt: number;
}): Promise<SalesDirective> {
  const { persona, lead, prompt, startedAt } = params;

  {
    const result = await getClient().models.generateContent({
      model: env.GEMINI_MODEL,
      contents: prompt,
      config: {
        systemInstruction: persona.strategistSystem,
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
      profile: LEAD_PROFILES.includes(parsed.profile as LeadProfile)
        ? (parsed.profile as LeadProfile)
        : 'indefinido',
      // So aceita HH:MM valido: o modelo devolve "logo" ou "18h" com alguma
      // frequencia, e uma hora invalida agendaria um lembrete para o vazio.
      promisedTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(parsed.promisedTime ?? ''))
        ? String(parsed.promisedTime)
        : '',
      canton: text(parsed.canton, ''),
      job: text(parsed.job, '').slice(0, 60),
      bettingExperience: text(parsed.bettingExperience, ''),
      nome: text(parsed.nome, '').slice(0, 40),
      atencao: text(parsed.atencao, '').slice(0, 200),
      tempoSuica: text(parsed.tempoSuica, '').slice(0, 60),
      includeLink: parsed.includeLink === true,
      notes: text(parsed.notes, ''),
      shouldStop: parsed.shouldStop === true,
      stopReason: STOP_REASONS.includes(parsed.stopReason as StopReason)
        ? (parsed.stopReason as StopReason)
        : 'nenhum',
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
