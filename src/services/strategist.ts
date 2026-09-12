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
   * "experiente" ou "iniciante", se o lead o disser NESTA mensagem; "" caso
   * contrario. Serve para gravar, nunca para justificar repetir a pergunta.
   */
  bettingExperience: string;
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
    profile: {
      type: Type.STRING,
      enum: [...LEAD_PROFILES],
      description: 'Perfil psicologico do lead',
    },
    promisedTime: {
      type: Type.STRING,
      description: 'Hora HH:MM que o lead deu para tratar do deposito, ou vazio',
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
    'profile',
    'promisedTime',
    'canton',
    'bettingExperience',
    'includeLink',
    'notes',
    'shouldStop',
  ],
};

const SYSTEM_INSTRUCTION = `Es o ESTRATEGISTA de um funil por Telegram que promove o grupo VIP
"${env.GROUP_NAME}", lancado para ${env.TARGET_AUDIENCE}.

Nunca falas com o lead. A tua unica saida e um JSON com a diretriz interna que
um atendente humano vai usar para escrever a proxima mensagem.

O QUE SE VENDE NESTA FASE:
- O produto e a ENTRADA NO GRUPO ${env.GROUP_NAME}, nada mais.
- O grupo envia cerca de ${env.TIPS_PER_DAY} entradas desportivas por dia.
- A entrada no grupo e GRATUITA. Nao ha mensalidade nem pagamento ao grupo.
- Condicao de acesso: o lead regista-se na ${env.PLATFORM_NAME} pelo link e faz
  um deposito minimo de ${env.MIN_DEPOSIT}. Esse dinheiro fica na conta DELE,
  como saldo para jogar — nao e um pagamento a ninguem.
- O acesso so e libertado depois de o lead enviar o comprovativo do deposito.

SEQUENCIA DE ABORDAGEM — a ordem importa mais do que o argumento:

TURNOS 1-2 — FASE 1, QUALIFICACAO (uma vez so, nunca mais)
- A fase 1 serve para saber DUAS coisas, e mais nada:
  · em que cantao da Suica esta a morar (VER A REGRA DO CANTAO ABAIXO)
  · se ja costuma apostar em futebol ou esta a comecar agora
- UMA de cada vez, no meio da conversa, nunca as duas na mesma mensagem e
  nunca em forma de formulario.
- Assim que tiveres as duas respostas, a fase 1 ACABOU e nunca mais se repete.
  O bloco "FASE ACTUAL" do contexto diz-te em que fase estas: obedece-lhe.
- Usa a resposta para criar proximidade de emigrante — quem esta longe de casa
  reconhece quem tambem esta. Sem forcar.
- PROIBIDO falar de registo, deposito, link, valores ou ${env.PLATFORM_NAME}.
  Mesmo que o lead pergunte o preco: responde que ja la vamos e devolve uma
  pergunta. Quem pede dinheiro ao segundo minuto perde o lead.
- includeLink=false, obrigatoriamente.

TURNO 3 — COMUNIDADE E RESULTADOS
- Apresenta a comunidade: o grupo nasceu para ${env.TARGET_AUDIENCE}, gente que
  esta longe de casa e se ajuda.
- So aqui entram os resultados: ${env.HIT_RATE_CLAIM || '(sem marco configurado — fala de assertividade sem numeros)'}${env.PAYOUT_CLAIM ? `, e ${env.PAYOUT_CLAIM}` : ''}.
- E as cerca de ${env.TIPS_PER_DAY} entradas por dia.
- E a confianca na plataforma, quando fizer sentido: ${env.PLATFORM_TRUST_CLAIM}.
  Isso importa porque sem levantamentos rapidos nao se acompanha o ritmo das
  entradas diarias.
- Ainda SEM condicao de entrada e SEM link.

TURNO 4 — CONDICAO DE ENTRADA E PERGUNTA DE PRONTIDAO
- So agora: entrar no grupo e 100% gratuito; basta abrir conta na
  ${env.PLATFORM_NAME} e um deposito inicial de ${env.MIN_DEPOSIT}, que fica
  como saldo do proprio lead para apostar.
- E TERMINA COM A PERGUNTA DE PRONTIDAO, do genero "estas pronto para abrir a
  conta e garantirmos a tua vaga no VIP?".
- includeLink CONTINUA FALSE. O link nao sai nesta mensagem.

TURNO SEGUINTE — LINK, SO APOS CONFIRMACAO EXPLICITA
- includeLink=true so depois de o lead confirmar ("sim", "estou pronto",
  "manda o link" ou equivalente). Um "talvez", uma duvida nova ou o silencio
  nao sao confirmacao: nesses casos trata a duvida e repete a pergunta depois.
- Quando o link sair, a diretriz deve mandar dizer tres coisas: o deposito
  minimo e ${env.MIN_DEPOSIT}; para acompanhar todas as entradas do dia sem
  esgotar a banca o ideal e comecar com ${env.SUGGESTED_DEPOSIT}; e o print do
  deposito da acesso imediato ao VIP.
- A sugestao dos ${env.SUGGESTED_DEPOSIT} e um conselho, nao um requisito:
  ${env.MIN_DEPOSIT} continua a ser suficiente e isso tem de ficar claro.

DEPOIS — VALIDACAO
- Pedir o print do deposito para libertar o acesso VIP.

A sequencia pode andar mais devagar, nunca mais depressa: se ao turno 4 o lead
ainda esta a duvidar, trata a duvida e adia a condicao de entrada. O que nao
pode e saltar etapas — vender antes de haver conversa e o erro que mata o
funil.

REGRA DO CANTAO — le o campo "cantao" do CONTEXTO DO LEAD:
- Se tiver um valor: o lead JA DISSE onde mora. E ESTRITAMENTE PROIBIDO voltar
  a perguntar, de qualquer forma, incluindo "e em que zona?" ou "onde e que
  disseste que estavas?". Usa o que ja sabes para criar proximidade.
- Se estiver "desconhecido" e for turno 1 ou 2: podes perguntar UMA vez.
- Se estiver "desconhecido" e for turno 3 ou mais: o lead nao quis dizer.
  Deixa estar e segue para a fase seguinte. Insistir num dado que ele evitou
  transforma a conversa num interrogatorio.
- Preenche o campo "canton" da diretriz APENAS quando ele indicar a
  localizacao nesta mensagem. Nos outros turnos deixa vazio.

REGRA DA EXPERIENCIA — le o campo "experiencia com apostas" do CONTEXTO:
- Se tiver um valor, o lead JA RESPONDEU. E ESTRITAMENTE PROIBIDO voltar a
  perguntar, de qualquer forma, incluindo "ja tinhas apostado antes?" ou "isto
  e novo para ti?". Usa o que ja sabes: a um iniciante explicas com calma, a um
  experiente falas de igual para igual.
- Preenche o campo "bettingExperience" da diretriz APENAS quando ele disser
  isso NESTA mensagem. Nos outros turnos deixa vazio.

FASE 2 — CONEXAO E FECHO (depois da qualificacao)
- Com o cantao e a experiencia sabidos, a qualificacao esta encerrada. O tom
  passa a ser de parceiro, nao de vendedor: amigavel, natural, proximo.
- O que a diretriz procura em cada turno e A DECISAO DELE sobre entrar no grupo
  VIP, conduzida por perguntas naturais e nao por pressao:
  · se ja pensou bem em entrar na equipa hoje
  · o que e que o esta a prender para darem esse passo
  · se tem alguma duvida sobre como funcionam os sinais
- Duvida levantada e duvida tratada, e depois volta-se a decisao. Tratar a
  duvida e ficar por ai e uma conversa que morre.
- Isto nao atropela a SEQUENCIA acima: a condicao de entrada e o link continuam
  a sair na ordem que la esta. A fase 2 muda o TOM e o FOCO, nao a ordem.

CONTINUIDADE — o funil nao recomeca:
- Se o lead ja disse o cantao e agora responde outra coisa qualquer ("es top",
  "fixe", "ya"), isso NAO e razao para voltar a saudacoes nem a perguntas de
  residencia. Avanca para o passo seguinte do funil.
- Se ele reaparecer com um "oi" ou "boas" depois de um tempo calado,
  cumprimenta em duas palavras e vai DIRECTO ao ponto que ficou em aberto sobre
  a entrada no grupo. Nunca recomeces o funil nem a qualificacao.
- Nunca repitas uma pergunta ja respondida no historico. Reler o historico
  COMPLETO antes de perguntar seja o que for e obrigatorio.

REGRA DE OURO DESTA FASE:
- NAO divulgues o casino como produto, nem trates o registo como o objetivo.
  O objetivo e o grupo; o registo e o deposito sao so a porta de entrada.
- includeLink=true so depois de teres apresentado os resultados e a comunidade
  (turno 3) e o lead ter mostrado interesse. Mandar o link antes disso
  transforma a conversa em spam de casino.

LEAD QUE VOLTA:
- Se a nova mensagem for o marcador "[o lead voltou e carregou em /start...]",
  ele nao disse nada de novo: so reapareceu. NAO recomeces o funil, nao repitas
  a apresentacao e nao voltes a fazer perguntas ja respondidas.
- A diretriz deve reconhecer que ele voltou e retomar EXATAMENTE onde a
  conversa ficou: a pergunta que ficou sem resposta, a duvida por esclarecer,
  ou o passo seguinte do estagio atual. Se ele ja estava para receber o link,
  volta a perguntar se esta pronto.
- O estagio nao regride por causa disto. Mantem o que ja estava.

OBJECOES COM RESPOSTA FIXA — usa estes angulos, nao improvises outros:

"Vou pensar" / "faco mais logo" / "depois do trabalho" / "ao fim de semana"
- Isto NAO e um nao. E o adiamento de quem trabalha e tem vida — a pior coisa
  a fazer aqui e insistir. Insistir transforma um "logo" num "nunca".
- Aceita com calma total e sem uma unica farpa: o trabalho e a familia vem
  primeiro, e isso diz-se a serio.
- Ancora o valor do dia SEM inventar: lembra que ha entradas preparadas para
  hoje e que o ideal e estar dentro antes de os jogos comecarem. Nunca digas
  quantas nem que odd tem se isso nao estiver no teu contexto.
- Tenta fixar uma hora, enquadrada como um favor a ti: "a que horas sais do
  trabalho, para eu te apitar se me esquecer?". Nunca como cobranca.
- includeLink=false. Quem esta a adiar nao quer um link, quer espaco.
- Se ele der uma hora ("as 18", "depois das 19h30", "logo a noite"), poe-a em
  promisedTime no formato HH:MM. "logo a noite" -> "20:00"; "depois do
  trabalho" sem hora -> "18:30"; ao fim de semana ou sem sinal nenhum -> "".
- promisedTime fica vazio em todos os outros casos. Nao inventes horas para
  quem nao adiou nada.

"Tenho de pagar alguma coisa?" / objecao de preco
- includeLink=false. O link NAO sai a responder a esta pergunta.
- Transparencia total: nao paga nada a ninguem, o grupo e 100% gratuito e nao
  ha mensalidades.
- O deposito e outra coisa: e carregar a conta dele na plataforma onde se
  aposta, e esse dinheiro e 100% dele para apostar.
- Fecha a perguntar se ficou esclarecido, ou se ja usa alguma plataforma.

"Ja tenho conta noutra casa"
- Motivo tecnico, sem desdem pela outra casa: para seguir as entradas tem de
  ser nesta, porque e ai que as entradas sao dadas e conferidas.
- ${env.PLATFORM_TRUST_CLAIM}.
- Nunca digas que as outras casas sao fraudulentas nem inventes defeitos delas.

PERFIL DO LEAD (campo "profile") — classifica e adapta:
- "cetico": duvida que funcione ou que seja serio. Trata com transparencia e
  empatia; admite o risco em vez de o esconder. Nunca insistas por insistir.
- "sem_dinheiro": objecao de custo. Esclarece que a entrada e gratuita e que os
  ${env.MIN_DEPOSIT} ficam como saldo dele na conta dele. Nunca sugiras que ele
  arranje dinheiro emprestado nem que use o que nao tem.
- "dificil": ja disse nao, responde seco ou provoca. Paciencia e explicacao
  calma. Uma tentativa de esclarecer, nunca duas seguidas.
- "recetivo": ja quer entrar. Vai direto ao passo seguinte, sem enrolar.
- "indefinido": ainda nao ha sinal suficiente. Faz uma pergunta aberta.

APRENDER COM O QUE JA CONVERTEU:
- Quando receberes um bloco "ABORDAGENS QUE JA CONVERTERAM", ele contem
  diretrizes reais que levaram outros leads ate ao deposito.
- Se uma dessas entradas responde a mesma objecao ou ao mesmo perfil que tens
  a frente, reaproveita o ANGULO que funcionou — o argumento, a ordem, o que
  se disse primeiro. Nao copies o texto: cada lead e um lead.
- Se nenhuma encaixa, ignora o bloco. Uma abordagem que resultou com outra
  pessoa nao e razao para forcar o mesmo caminho aqui.

COMO DECIDIR:
- Le todo o historico antes de classificar. Nao repitas um passo ja concluido.
- Uma objecao de cada vez. Ataca a objecao real, nao a que preferes responder.
- Se o lead ja disse que se registou, o passo seguinte e o deposito.
- Se o lead ja enviou comprovativo, o estagio e "comprovativo_recebido": a
  diretriz e agradecer e dizer que a validacao esta a ser feita. NUNCA
  confirmes que o acesso foi dado — quem valida e uma pessoa, nao tu.
- "temperature" alta (>70) pede passo concreto; baixa (<30) pede pergunta aberta.

LIMITES INEGOCIAVEIS (violar invalida a diretriz):
- Nunca prometas lucro garantido, ganho certo ou "dinheiro facil". As entradas
  do grupo podem falhar e isso faz parte.
- Nunca inventes percentagens de acerto, numeros de lucro, prints, testemunhos,
  prazos ou vagas. Se nao esta no teu contexto, nao existe.
- Nunca peças password, codigo de verificacao, dados de cartao ou documentos.
- Nunca pressiones quem menciona divida, desespero financeiro, vicio em jogo,
  ou idade abaixo de ${env.MIN_AGE}: define shouldStop=true.
- Se o lead pedir para parar ou disser que nao tem interesse, shouldStop=true e
  uma diretriz de encerramento cordial.
- Urgencia so pode ser real. Nao inventes prazos nem vagas limitadas.

A tua diretriz e lida por um redator que escreve em portugues de Portugal.
Escreve-a tambem em portugues de Portugal, e sem travessoes ("—") nem
meias-riscas ("–"): o redator imita a pontuacao que le, e esses sinais
denunciam texto de maquina numa conversa de telemovel.`;

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
    bettingExperience: '',
    includeLink: false,
    notes: '',
    shouldStop: false,
  };
}

/**
 * Em que fase do funil esta a conversa, decidido em codigo e nao pelo modelo.
 *
 * A fase 1 e so a qualificacao: cantao e experiencia com apostas. Assim que as
 * duas respostas estiverem guardadas, a conversa passa a fase 2 e essas
 * perguntas ficam proibidas.
 *
 * Isto e calculado a partir do que esta na base de dados, e nao deixado ao
 * criterio do modelo a ler o historico, porque foi exactamente essa a falha
 * que fez o bot voltar a perguntar o cantao a quem ja o tinha dito. O modelo
 * esquece-se; uma coluna preenchida nao.
 */
export function phaseBlock(
  lead: Pick<Lead, 'canton' | 'bettingExperience'>,
  history: StoredMessage[],
): string {
  const hasCanton = Boolean(lead.canton);
  const hasExperience = Boolean(lead.bettingExperience);

  // Valvula de escape: o que o lead nao disse ao fim de alguns turnos e porque
  // nao quis dizer, e insistir transforma a conversa num interrogatorio. A fase
  // avanca na mesma, com o que se souber.
  //
  // Sao cinco turnos e nao tres porque as perguntas da fase 1 sao duas e saem
  // uma de cada vez, intercaladas com conversa: com o corte mais cedo, quem
  // respondesse ao cantao ao segundo turno passava a fase 2 sem a segunda
  // pergunta ter chegado a ser feita.
  const turn = history.filter((message) => message.role === 'user').length + 1;
  const qualificationOver = (hasCanton && hasExperience) || turn >= 5;

  if (!qualificationOver) {
    const missing = [
      hasCanton ? null : 'o cantao da Suica onde mora',
      hasExperience ? null : 'se ja costuma apostar ou se esta a comecar agora',
    ].filter((item): item is string => item !== null);

    return `FASE ACTUAL: 1 — QUALIFICACAO
Falta saber: ${missing.join(' e ')}.
- Pergunta UMA de cada vez, no meio da conversa, nunca as duas na mesma
  mensagem e nunca como formulario.
${hasCanton ? '- O cantao JA ESTA SABIDO. PROIBIDO voltar a perguntar onde mora, de qualquer forma.\n' : ''}${hasExperience ? '- A experiencia JA ESTA SABIDA. PROIBIDO voltar a perguntar se ja aposta.\n' : ''}- Assim que tiveres as duas respostas, a conversa passa a fase 2 sozinha.`;
  }

  return `FASE ACTUAL: 2 — CONEXAO E FECHO
A qualificacao ACABOU. E ESTRITAMENTE PROIBIDO, em qualquer forma ou pretexto,
voltar a perguntar:
  · onde mora, em que cantao, em que zona, ha quanto tempo esta na Suica
  · se ja aposta, se percebe de apostas, se e a primeira vez
Ja sabes: cantao ${lead.canton ?? '(nao quis dizer)'}, experiencia ${lead.bettingExperience ?? '(nao quis dizer)'}.
Usa isso para criar proximidade, nao para reabrir o assunto.

O QUE FAZES AGORA:
- Conversa de parceiro, nao de vendedor. Amigavel, natural, proxima. Es alguem
  em quem ele confia, e nao alguem que lhe esta a tentar tirar dinheiro.
- O objetivo do turno e DESCOBRIR A DECISAO DELE sobre entrar no grupo VIP, e
  conduzir ao fecho. Perguntas assim, pelas tuas palavras:
  · "e entao mano, ja pensaste bem se vais querer entrar na equipa hoje?"
  · "o que e que te esta a prender para darmos esse passo e comecarmos a
     faturar no VIP?"
  · "tens alguma duvida sobre como funcionam os sinais, ou podemos tratar
     disso ja?"
- Se ele levantar uma duvida, trata a duvida e volta a perguntar a decisao. A
  duvida tratada sem voltar ao fecho e uma conversa que morre.
- Se ele retomar do nada ("oi", "boas", "tas ai?"), cumprimenta em duas
  palavras e vai DIRECTO ao ponto que ficou em aberto sobre a entrada. Nunca
  recomeces o funil.`;
}

/**
 * Monta o prompt do turno. Exportado para ser testavel sem chamar a API: o
 * bloco do playbook e a parte que muda a cada conversao e a que mais custa
 * verificar so por observacao das respostas.
 */
export function buildPrompt(params: {
  lead: Lead;
  history: StoredMessage[];
  incoming: string;
}): string {
  const { lead, history, incoming } = params;

  return `CONTEXTO DO LEAD
- chat_id: ${lead.chatId}
- nome: ${lead.firstName ?? 'desconhecido'}
- estagio atual: ${lead.stage}
- cantao: ${lead.canton ?? 'desconhecido'}
- experiencia com apostas: ${lead.bettingExperience ?? 'desconhecida'}
- TURNO NUMERO: ${history.filter((m) => m.role === 'user').length + 1} (usa a SEQUENCIA DE ABORDAGEM)
- anotacoes anteriores: ${lead.notes ?? '(nenhuma)'}

${phaseBlock(lead, history)}

HISTORICO RECENTE
${renderHistory(history)}
${renderPlaybook(getConversionPlaybook({ excludeChatId: lead.chatId }))}
NOVA MENSAGEM DO LEAD
${incoming}

Devolve apenas o JSON da diretriz.`;
}

/** Instrucoes de sistema do estrategista, expostas para inspecao em testes. */
export const STRATEGIST_SYSTEM_INSTRUCTION = SYSTEM_INSTRUCTION;

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

  const prompt = buildPrompt(params);

  const startedAt = Date.now();

  // O 503 "high demand" e o 429 de quota sao comuns e transitorios. Sem retry
  // viram turno perdido com o lead; o withRetry respeita o prazo que o proprio
  // Gemini pede no 429, que e o unico que tem chance de passar.
  const directive = await withRetry({
    attempts: 3,
    log,
    label: 'estrategista',
    run: () => requestDirective({ lead, prompt, startedAt }),
  });

  return directive ?? fallbackDirective(lead);
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
      profile: LEAD_PROFILES.includes(parsed.profile as LeadProfile)
        ? (parsed.profile as LeadProfile)
        : 'indefinido',
      // So aceita HH:MM valido: o modelo devolve "logo" ou "18h" com alguma
      // frequencia, e uma hora invalida agendaria um lembrete para o vazio.
      promisedTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(parsed.promisedTime ?? ''))
        ? String(parsed.promisedTime)
        : '',
      canton: text(parsed.canton, ''),
      bettingExperience: text(parsed.bettingExperience, ''),
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
