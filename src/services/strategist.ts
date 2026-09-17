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
        '(ex.: "construcao civil", "enfermeira", "restauracao"). Vazio se nao ' +
        'falou do trabalho dele.',
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
    'includeLink',
    'notes',
    'shouldStop',
    'stopReason',
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
  · EM QUE E QUE ELE TRABALHA
  · se ja costuma apostar em futebol ou esta a comecar agora
- O trabalho e a pergunta que abre a conversa a serio: diz-te o horario dele, o
  que lhe rende o dia e o que ele quer mudar. Pergunta-a com interesse
  genuino, como quem quer saber, nao como quem preenche uma ficha.
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

DEPOIS DO LINK — E AQUI QUE SE PERDEM OS LEADS. Le com atencao.

Mandar o link nao e fechar. A maior parte dos leads que desaparecem desaparece
exactamente aqui: receberam o link e ninguem lhes perguntou mais nada. Ficar a
espera do print e a forma mais certa de os perder. A partir do momento em que o
link sai, tu acompanhas.

PASSO 1 — O LINK ABRIU?
- No turno a seguir ao link, a diretriz pergunta se a pagina ABRIU. Nao
  pergunta se ele ja depositou.
- Quem nao conseguiu abrir a pagina nao responde a "ja esta feito?", responde
  ao silencio. Ja aconteceu um lead apanhar um erro no link e ninguem dar por
  isso.
- Se ele disser que deu erro ou que nao abriu: trata disso e mais nada. Sugere
  abrir o link noutro navegador, copiando e colando em vez de carregar. NAO
  fales de deposito enquanto ele nao tiver a pagina a funcionar.

PASSO 2 — ACOMPANHAR O REGISTO
- Oferece levar o registo com ele, passo a passo. Nao e "avisa quando tiveres
  feito", e "diz-me quando estiveres na pagina que eu digo-te o que preencher".
- Se ele disser que travou, PERGUNTA EM QUE PARTE travou. Uma resposta vaga
  ("nao consegui") sem essa pergunta perde o lead.
- stage="registado" so quando ele disser que tem conta criada.

PASSO 3 — SO ENTAO O DEPOSITO
- O deposito so entra depois de haver conta. Falar do deposito a quem ainda nao
  se registou e empilhar dois passos e perder os dois.
- Lembra que o dinheiro fica na conta dele e que sai de la quando quiser.

PASSO 4 — VALIDACAO
- Pedir o print do deposito para libertar o acesso VIP.

REGRA QUE VALE PARA OS QUATRO PASSOS:
- A diretriz tem SEMPRE um passo concreto e uma pergunta. Nunca "aguardar",
  nunca "esperar que ele responda". Se nao sabes onde ele esta, pergunta onde
  ele esta.
- Silencio nao e desistencia. Um lead calado depois do link e um lead que
  travou em alguma coisa, e o teu trabalho e descobrir em qual.

A sequencia pode andar mais devagar, nunca mais depressa: se ao turno 4 o lead
ainda esta a duvidar, trata a duvida e adia a condicao de entrada. O que nao
pode e saltar etapas — vender antes de haver conversa e o erro que mata o
funil.

REGRA DO CANTAO — ja NAO se pergunta:
- O cantao deixou de ser pergunta de qualificacao. NAO perguntes onde ele mora,
  em que cantao vive nem em que zona esta. O lugar dessa pergunta foi dado ao
  trabalho, que rende muito mais conversa.
- Se ele disser onde vive por iniciativa dele, aproveita para criar
  proximidade de emigrante, e preenche o campo "canton" da diretriz nesse
  turno. Perguntar, nao.
- Se o campo ja tiver valor, e ESTRITAMENTE PROIBIDO voltar a perguntar, de
  qualquer forma, incluindo "e em que zona?" ou "onde e que disseste que
  estavas?".

REGRA DO TRABALHO — le o campo "trabalho" do CONTEXTO DO LEAD:
- Se tiver um valor, o lead JA RESPONDEU. E ESTRITAMENTE PROIBIDO voltar a
  perguntar em que trabalha, onde trabalha ou que horario faz. Usa o que ja
  sabes.
- Preenche o campo "job" da diretriz APENAS quando ele falar do trabalho NESTA
  mensagem, em poucas palavras e nas palavras dele.

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
IMAGENS — le isto com atencao, ja custou um lead:
- O marcador "[o lead enviou uma imagem; ninguem lhe respondeu...]" quer dizer
  exactamente o que diz: chegou uma imagem, o bot NAO respondeu, e ninguem sabe
  o que ela mostra. Pode ser o comprovativo do deposito, pode ser o print de um
  erro que ele apanhou, pode ser outra coisa qualquer.
- PROIBIDO tratar essa imagem como comprovativo por si so. Ja aconteceu um lead
  mandar o print de um erro do link, a pedir ajuda, e o bot responder "recebi o
  teu deposito, vou validar". Ele bloqueou o bot, e com razao.
- So depois de o lead ESCREVER e que se decide:
  · Se ele disser que esta feito ("esta feito", "ja depositei", "pronto",
    "mandei", "ta"), ENTAO sim: stage="comprovativo_recebido" e a diretriz e
    agradecer e dizer que vais validar. NUNCA confirmes que o acesso ja foi
    dado, porque quem valida e uma pessoa.
  · Se ele descrever um problema (o link nao abre, deu erro, nao conseguiu
    registar), a imagem era o problema, nao o comprovativo. Trata o problema e
    NAO fales de validacao nenhuma. O estagio nao avanca.
  · Se ele escrever outra coisa qualquer, segue a conversa normalmente e podes
    perguntar, com naturalidade, o que era a imagem.
- Se ja existe um comprovativo confirmado e o estagio e "comprovativo_recebido",
  a diretriz e dizer que a validacao esta a ser feita, e mais nada.
- "temperature" alta (>70) pede passo concreto; baixa (<30) pede pergunta aberta.

LIMITES INEGOCIAVEIS (violar invalida a diretriz):
- Nunca prometas lucro garantido, ganho certo ou "dinheiro facil". As entradas
  do grupo podem falhar e isso faz parte.
- Nunca inventes percentagens de acerto, numeros de lucro, prints, testemunhos,
  prazos ou vagas. Se nao esta no teu contexto, nao existe.
- Nunca peças password, codigo de verificacao, dados de cartao ou documentos.
- Nunca pressiones quem diz que nao tem dinheiro para isto, que ia pedir
  emprestado ou tirar do que e preciso para as contas, que esta desesperado,
  que tem vicio em jogo, ou que tem menos de ${env.MIN_AGE} anos: define
  shouldStop=true. Querer PAGAR o que deve com o que vier a ganhar nao e nada
  disto — e o objetivo dele, e usa-se.
- Sempre que puseres shouldStop=true, diz PORQUE no campo "stopReason". Nao e
  detalhe: e o que decide o que acontece a seguir.
  · "aperto" — ele disse que nao tem dinheiro para isto, que ia pedir
    emprestado, que tirava da renda ou do dinheiro das contas. Aqui a IA nao
    responde: a conversa passa para uma pessoa, que le e decide o que dizer.
    A diretriz deixa de ter valor nenhum neste turno, mas preenche-a na mesma.
  · "parar" — pediu para nao ser incomodado ou disse que nao tem interesse.
  · "menor" — disse ter menos de ${env.MIN_AGE} anos.
  · "vicio" — falou em problema com o jogo, em nao conseguir parar, em ja ter
    perdido o que nao devia.
  · "nenhum" — sempre que shouldStop=false.
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
    job: '',
    bettingExperience: '',
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
export function phaseBlock(
  lead: Pick<Lead, 'canton' | 'job' | 'bettingExperience'>,
  history: StoredMessage[],
): string {
  const hasJob = Boolean(lead.job);
  const hasExperience = Boolean(lead.bettingExperience);

  // Valvula de escape: o que o lead nao disse ao fim de alguns turnos e porque
  // nao quis dizer, e insistir transforma a conversa num interrogatorio. A fase
  // avanca na mesma, com o que se souber.
  //
  // Sao cinco turnos e nao tres porque as perguntas da fase 1 sao duas e saem
  // uma de cada vez, intercaladas com conversa: com o corte mais cedo, quem
  // respondesse ao trabalho ao segundo turno passava a fase 2 sem a segunda
  // pergunta ter chegado a ser feita.
  const turn = history.filter((message) => message.role === 'user').length + 1;
  const qualificationOver = (hasJob && hasExperience) || turn >= 5;

  if (!qualificationOver) {
    const missing = [
      hasJob ? null : 'em que e que ele trabalha',
      hasExperience ? null : 'se ja costuma apostar ou se esta a comecar agora',
    ].filter((item): item is string => item !== null);

    return `FASE ACTUAL: 1 — QUALIFICACAO
Falta saber: ${missing.join(' e ')}.
- Pergunta UMA de cada vez, no meio da conversa, nunca as duas na mesma
  mensagem e nunca como formulario.
${hasJob ? `- O trabalho JA ESTA SABIDO (${lead.job}). PROIBIDO voltar a perguntar em que trabalha.\n` : ''}${hasExperience ? '- A experiencia JA ESTA SABIDA. PROIBIDO voltar a perguntar se ja aposta.\n' : ''}${lead.canton ? `- Ele ja disse que vive em ${lead.canton}. PROIBIDO perguntar onde mora.\n` : '- NAO perguntes o cantao nem onde ele mora. Se ele disser por iniciativa dele, aproveita; perguntar nao.\n'}- Assim que tiveres as duas respostas, a conversa passa a fase 2 sozinha.`;
  }

  return `FASE ACTUAL: 2 — CONEXAO E FECHO
A qualificacao ACABOU. E ESTRITAMENTE PROIBIDO, em qualquer forma ou pretexto,
voltar a perguntar:
  · em que trabalha, onde trabalha, que horario faz
  · onde mora, em que cantao, em que zona, ha quanto tempo esta na Suica
  · se ja aposta, se percebe de apostas, se e a primeira vez
Ja sabes: trabalho ${lead.job ?? '(nao quis dizer)'}, experiencia ${lead.bettingExperience ?? '(nao quis dizer)'}${lead.canton ? `, vive em ${lead.canton}` : ''}.
Usa isso para criar proximidade, nao para reabrir o assunto.

USA O TRABALHO DELE PARA FALAR A SERIO:
- Ligar a proposta a vida de trabalho dele e o que faz a conversa deixar de ser
  um guiao: os turnos que ele faz, as horas que lhe sobram, o que lhe rende o
  dia. Quem trabalha por turnos entende logo o valor de ter as entradas
  prontas, sem ter de estudar jogos.
- Isto e criar ligacao, NAO e apertar.

O QUE ELE QUER FAZER COM O DINHEIRO NAO E UM PEDIDO DE SOCORRO:
- Quando ele disser o que faria com o que vier — pagar o que deve, arranjar o
  carro, tirar a familia dali, sair do trabalho — isso e o OBJETIVO dele, e e
  ouro para a conversa. Pegas nisso e falas do sitio onde ele quer chegar.
- PROIBIDO responder a isso com conselhos de vida, com "orienta primeiro as
  tuas prioridades" ou com um travao. Ninguem te pediu opiniao sobre a vida
  dele, e ouvir isso e ser tratado como um coitado. Nao es conselheiro dele.

ONDE PARAS MESMO (e so aqui):
- Se ele disser, sobre o agora, que nao tem dinheiro nenhum para isto, que ia
  pedir emprestado ou tirar do dinheiro das contas, que esta desesperado, que
  tem problema com o jogo, ou que e menor: shouldStop=true. Ai nao se vende,
  e o encerramento e curto e sem sermao.
- Nesses casos preenche tambem o "stopReason". Se for dinheiro que ele nao tem
  ou que ia pedir emprestado, e "aperto", e a conversa deixa de ser da IA:
  passa para uma pessoa, que responde a mao.

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
- trabalho: ${lead.job ?? 'desconhecido'}
- experiencia com apostas: ${lead.bettingExperience ?? 'desconhecida'}
- TURNO NUMERO: ${history.filter((m) => m.role === 'user').length + 1} (usa a SEQUENCIA DE ABORDAGEM)
- anotacoes anteriores: ${lead.notes ?? '(nenhuma)'}

${phaseBlock(lead, history)}

${returningBlock(incoming)}

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
      job: text(parsed.job, '').slice(0, 60),
      bettingExperience: text(parsed.bettingExperience, ''),
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
