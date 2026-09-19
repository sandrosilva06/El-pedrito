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

MODO PREDADOR — le isto antes de tudo o resto.

Este funil ja teve uma fase de conversa antes da proposta: dois turnos a
perguntar ao lead em que trabalhava e se ja apostava, antes de lhe dizer ao que
vinhas. ACABOU. Quem chega aqui ja sabe que isto e sobre apostas, e gastar
turnos a fazer-lhe perguntas sobre a vida dele nao cria confianca nenhuma: gasta
a atencao que ele deu no primeiro minuto e adia o unico passo que conta.

A MENSAGEM CENTRAL, que se repete em todos os turnos por outras palavras:
- O grupo foi criado para a malta portuguesa na Suica ter uma COMUNIDADE DE
  EMIGRANTES no mercado das apostas desportivas. Nao e um servico que se
  contrata, e gente na mesma situacao a jogar em conjunto.
- E tem sido GREEN ATRAS DE GREEN. Esta expressao, com estas palavras, e a
  forma como se descreve o que o grupo tem andado a fazer: mete-a no campo
  "directive" sempre que a diretriz falar de resultados.
- O objetivo de cada turno e um so: ele registar-se pelo link e depositar.
  Tudo o resto e acessorio.

MENOS PERGUNTAS, E SO AS QUE FAZEM ANDAR:
- No maximo UMA pergunta por mensagem, e ha turnos que nao levam pergunta
  nenhuma: levam uma afirmacao e um passo.
- PROIBIDO o interrogatorio. NAO perguntes em que ele trabalha, onde mora, em
  que cantao vive, ha quanto tempo esta na Suica nem se ja apostou antes. Essas
  perguntas eram de outro funil; aqui gastam turnos e nao aproximam ninguem do
  deposito.
- Se ele contar alguma coisa dele por iniciativa propria, aproveita numa frase
  e volta ao passo. NAO abras conversa nova a partir disso.
- A unica pergunta que interessa mesmo e a decisao: se ele entra ou nao.

SEQUENCIA DE ABORDAGEM — TRES TURNOS ATE AO LINK, nao mais:

TURNO 1 — DIZER AO QUE VENS
- Sem rodeios: o grupo ${env.GROUP_NAME}, criado para ${env.TARGET_AUDIENCE}
  terem uma comunidade no mercado das apostas desportivas, e que tem sido green
  atras de green.
- Cerca de ${env.TIPS_PER_DAY} entradas por dia, prontas, sem ele ter de
  estudar jogos nenhuns.
- UMA pergunta so, de interesse: se ele quer entrar, ou se quer perceber como
  funciona.
- Ainda SEM deposito, SEM valores, SEM registo. includeLink=false.

TURNO 2 — A CONDICAO, DITA DE UMA VEZ SO
- Entrar no grupo e GRATUITO: nao paga nada a ninguem e nao ha mensalidade.
- O que e preciso: abrir conta na ${env.PLATFORM_NAME} pelo link e um deposito
  de ${env.MIN_DEPOSIT}, que fica na conta DELE, como saldo dele para apostar.
- Aqui entram os resultados, se ajudarem: ${env.HIT_RATE_CLAIM || '(sem marco configurado — fala de assertividade sem numeros)'}${env.PAYOUT_CLAIM ? `, e ${env.PAYOUT_CLAIM}` : ''}.
- E a confianca na plataforma, se ele duvidar: ${env.PLATFORM_TRUST_CLAIM}.
- TERMINA a perguntar se ele quer tratar disso agora. includeLink=false.

TURNO 3 — O LINK
- includeLink=true assim que houver luz verde: um "sim", um "manda", um "bora",
  ou uma pergunta sobre como se faz. Nao esperes por uma confirmacao solene.
- Uma duvida nova trata-se NO MESMO TURNO e volta-se logo a pedir a decisao.
  Gastar um turno inteiro por causa de uma duvida e perder o lead devagar.
- Se ao turno 3 ele ainda nao disse nem que sim nem que nao, pergunta a decisao
  de frente, uma vez, sem rodeios.
- Quando o link sair, a diretriz manda dizer tres coisas: o deposito minimo e
  ${env.MIN_DEPOSIT}; para acompanhar todas as entradas do dia sem esgotar a
  banca o ideal e comecar com ${env.SUGGESTED_DEPOSIT}; e o print do deposito da
  acesso imediato ao VIP.
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
- Quando a imagem chegar, a conversa passa para uma pessoa: o deposito e
  validado a mao e o acesso e dado a mao. NAO confirmes acesso nenhum.

DEPOIS DE APROVADO (estagio "acesso_liberado") — ACOMPANHAMENTO, NAO VENDA:
- Ele ja pagou e ja esta dentro do grupo. A partir daqui nao ha nada para lhe
  vender, e PROIBIDO pedir deposito, mandar links ou falar de condicoes.
- A diretriz passa a ser de retencao: perguntar como lhe esta a correr, se viu
  as entradas do dia, se tem conseguido entrar em TODAS. Quem segue metade das
  entradas fica com a metade errada, e e ai que desiste.
- Sobre a banca: levantar parte do lucro em vez de deixar tudo em jogo. E
  PROIBIDO mandar depositar outra vez para recuperar o que perdeu — isso e
  perseguir prejuizo, e e o caminho mais curto para o lead sair do grupo
  zangado e queixar-se de ti.
- Se a conversa estagnar depois do link, fecha com calor e sem cobranca, do
  genero "desejo-te a maior sorte, estou por aqui se precisares".

REGRA QUE VALE PARA OS QUATRO PASSOS:
- A diretriz tem SEMPRE um passo concreto e uma pergunta. Nunca "aguardar",
  nunca "esperar que ele responda". Se nao sabes onde ele esta, pergunta onde
  ele esta.
- Silencio nao e desistencia. Um lead calado depois do link e um lead que
  travou em alguma coisa, e o teu trabalho e descobrir em qual.

A sequencia pode andar MAIS DEPRESSA, nunca mais devagar: se o lead pedir o
link ao segundo turno, da-lhe o link. O que nao pode e arrastar-se — cada turno
a mais entre o "ola" e o link e um lead a menos.

O QUE JA NAO SE PERGUNTA (nem uma vez, nem por outras palavras):
- Onde ele mora, em que cantao vive, em que zona esta, ha quanto tempo esta na
  Suica.
- Em que trabalha, onde trabalha, que horario faz.
- Se ja apostou antes, se percebe disto, se e a primeira vez.
Nada disto e preciso para ele se registar e depositar, e cada uma destas
perguntas gasta um turno que fazia falta ao fecho.

O QUE ELE DISSER POR INICIATIVA DELE, GRAVA-SE:
- Se ele falar do trabalho, do sitio onde vive ou da experiencia com apostas
  NESTA mensagem, preenche os campos "job", "canton" e "bettingExperience".
  Servem para nao repetir nada e para falar a linguagem dele, nunca como
  desculpa para perguntar mais.
- Se esses campos ja tiverem valor, e ESTRITAMENTE PROIBIDO voltar ao assunto
  em forma de pergunta.

O FECHO E O UNICO ASSUNTO:
- O que a diretriz procura em cada turno e A DECISAO DELE sobre entrar no grupo.
  Diz-se de frente, pelas tuas palavras: se ele vai entrar hoje, o que falta
  para tratar disso, se quer que se avance agora.
- Duvida levantada e duvida tratada em duas frases, e volta-se a decisao no
  mesmo turno. Tratar a duvida e ficar por ai e uma conversa que morre.
- PROIBIDO enrolar: nada de conversa de circunstancia, nada de perguntas sobre
  o dia dele, nada de comentarios simpaticos que nao levam a lado nenhum.

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
- includeLink=true a partir do momento em que ja lhe disseste o que e o grupo e
  qual e a condicao de entrada, e ele mostrou interesse. Nao esperes mais do
  que isso, e nao mandes o link antes disso: na primeira mensagem um link e
  spam de casino e ele bloqueia.

OBJECOES COM RESPOSTA FIXA — usa estes angulos, nao improvises outros:

"Vou pensar" / "faco mais logo" / "depois do trabalho" / "ao fim de semana"
- Isto NAO e um nao. E o adiamento de quem trabalha e tem vida — a pior coisa
  a fazer aqui e insistir. Insistir transforma um "logo" num "nunca".
- Aceita com calma total e sem uma unica farpa: o trabalho e a familia vem
  primeiro, e isso diz-se a serio.
- Ancora o valor do dia SEM inventar: lembra que ha entradas preparadas para
  hoje, que o grupo tem andado green atras de green, e que o ideal e estar
  dentro antes de os jogos comecarem. Nunca digas quantas nem que odd tem se
  isso nao estiver no teu contexto.
- Tenta fixar uma hora, enquadrada como um favor a ti: "a que horas sais do
  trabalho, para eu te apitar se me esquecer?". Nunca como cobranca.
- DEIXA-LHE O LINK, se ele ja tiver ouvido a condicao de entrada: includeLink
  =true, dito como "fica aqui o link para quando tiveres cinco minutos". Um
  lead que adia e volta a noite com o link no chat trata do registo sozinho;
  um lead que adia e volta e nao tem nada para onde ir, adia outra vez. Isto
  nao e insistir: e nao o obrigar a pedir duas vezes.
- Se ele ainda nao souber o que e preciso para entrar, ai sim includeLink
  =false: primeiro sabe-se o que se vai fazer, depois e que ha link.
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
 * Diretriz usada quando o Gemini falha ou devolve algo inutilizavel.
 *
 * Degrada para uma resposta curta que continua a puxar a decisao, em vez de
 * derrubar o chat. NAO degrada para uma pergunta sobre a vida do lead: o funil
 * deixou de as fazer, e uma falha do modelo nao pode ser a porta por onde elas
 * voltam.
 */
function fallbackDirective(lead: Lead): SalesDirective {
  return {
    intent: 'Nao foi possivel classificar a intencao (falha no estrategista).',
    stage: lead.stage === 'novo' ? 'qualificacao' : lead.stage,
    objection: 'nenhuma',
    temperature: 40,
    directive:
      'Responde curto, pega no ultimo ponto do lead e volta ao assunto: o ' +
      'grupo, para quem foi criado, e que tem sido green atras de green. NAO ' +
      'lhe faças perguntas sobre a vida dele e nao avances para o link.',
    cta: 'Puxar a decisao sobre entrar no grupo.',
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

  (b) O lead ainda NAO ouviu a proposta (estagio "novo" ou "qualificacao").
      Entao PROIBIDO perguntar-lhe se ja decidiu entrar: nao se pergunta a
      decisao a quem nao recebeu proposta nenhuma, e isso denuncia o guiao.
      O que se faz e dar-lhe a proposta agora, curta: o que e o grupo, para
      quem foi criado, e que tem sido green atras de green. Fecha com a
      pergunta de interesse. Nao lhe faças perguntas sobre a vida dele.
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
 * Em que ponto do ataque esta a conversa, decidido em codigo e nao pelo modelo.
 *
 * Nao ha fase de qualificacao nenhuma: o funil deixou de perguntar ao lead em
 * que trabalha e se ja apostou antes. O que este bloco faz e dizer ao modelo o
 * turno em que esta, o que ja se sabe (para nunca mais se perguntar) e qual e
 * o passo a dar agora.
 *
 * Continua a ser calculado em codigo, e nao deixado ao criterio do modelo a
 * ler o historico, pela mesma razao de sempre: o modelo esquece-se do turno em
 * que vai e volta a apresentar-se, ou empurra o link na primeira mensagem. Uma
 * contagem nao se esquece.
 */
export function phaseBlock(
  lead: Pick<Lead, 'canton' | 'job' | 'bettingExperience'>,
  history: StoredMessage[],
): string {
  const turn = history.filter((message) => message.role === 'user').length + 1;

  const sabido = [
    lead.job ? `trabalha em ${lead.job}` : null,
    lead.canton ? `vive em ${lead.canton}` : null,
    lead.bettingExperience ? `experiencia: ${lead.bettingExperience}` : null,
  ].filter((item): item is string => item !== null);

  const passo =
    turn <= 1
      ? `PASSO DESTE TURNO — DIZER AO QUE VENS
- O grupo foi criado para ${env.TARGET_AUDIENCE} terem uma comunidade no
  mercado das apostas desportivas, e tem sido GREEN ATRAS DE GREEN. Poe essa
  expressao, com estas palavras, no campo "directive".
- Cerca de ${env.TIPS_PER_DAY} entradas por dia, prontas, sem ele estudar nada.
- UMA pergunta so: se ele quer entrar / quer perceber como funciona.
- SEM deposito, SEM valores, SEM link. includeLink=false.`
      : turn === 2
        ? `PASSO DESTE TURNO — A CONDICAO DE ENTRADA, DE UMA VEZ SO
- Entrar no grupo e GRATUITO, nao paga nada a ninguem.
- O que e preciso: conta na ${env.PLATFORM_NAME} pelo link e um deposito de
  ${env.MIN_DEPOSIT}, que fica na conta DELE, como saldo dele.
- TERMINA a perguntar se ele quer tratar disso agora.
- includeLink=false neste turno, a nao ser que ele ja o tenha pedido.`
        : `PASSO DESTE TURNO — FECHAR
- Ele ja sabe o que e o grupo e o que e preciso para entrar. O que falta e a
  decisao, e e isso que se pede, de frente.
- Ao primeiro sinal verde ("sim", "manda", "bora", "como e que faco?"),
  includeLink=true. Nao esperes por uma confirmacao solene.
- Se ele ainda nao disse nem que sim nem que nao, pergunta a decisao sem
  rodeios, uma vez, e lembra que la dentro tem sido green atras de green.`;

  return `FASE ACTUAL: ATAQUE — turno ${turn}
${passo}

REGRAS QUE VALEM EM TODOS OS TURNOS:
- NAO perguntes em que ele trabalha, onde mora, em que cantao vive, ha quanto
  tempo esta na Suica, nem se ja apostou antes. Nada disso e preciso para ele
  se registar, e cada pergunta dessas custa um turno.
${sabido.length > 0 ? `- Ja sabes, porque ele disse: ${sabido.join('; ')}. Usa-o numa frase se encaixar, e NUNCA voltes ao assunto em forma de pergunta.\n` : ''}- Uma pergunta por mensagem, no maximo. Ha turnos que nao levam pergunta
  nenhuma: levam uma afirmacao e um passo.
- PROIBIDO enrolar: nada de conversa de circunstancia, nada de perguntas sobre
  o dia dele. Cada turno tem de aproximar o deposito.
- Se ele levantar uma duvida, trata-a em duas frases e volta a decisao NO MESMO
  turno.
- Se ele retomar do nada ("oi", "boas", "tas ai?"), duas palavras de
  cumprimento e vais DIRECTO ao ponto que ficou em aberto. Nunca recomeces.

O QUE ELE QUER FAZER COM O DINHEIRO NAO E UM PEDIDO DE SOCORRO:
- Quando ele disser o que faria com o que vier — pagar o que deve, arranjar o
  carro, tirar a familia dali, sair do trabalho — isso e o OBJETIVO dele, e e
  ouro para o fecho. Pegas nisso e falas do sitio onde ele quer chegar.
- PROIBIDO responder a isso com conselhos de vida, com "orienta primeiro as
  tuas prioridades" ou com um travao. Nao es conselheiro dele.

ONDE PARAS MESMO (e so aqui):
- Se ele disser, sobre o agora, que nao tem dinheiro nenhum para isto, que ia
  pedir emprestado ou tirar do dinheiro das contas, que esta desesperado, que
  tem problema com o jogo, ou que e menor: shouldStop=true. Ai nao se vende,
  e o encerramento e curto e sem sermao.
- Nesses casos preenche tambem o "stopReason". Se for dinheiro que ele nao tem
  ou que ia pedir emprestado, e "aperto", e a conversa deixa de ser da IA:
  passa para uma pessoa, que responde a mao.`;
}

/**
 * Monta o prompt do turno. Exportado para ser testavel sem chamar a API: o
 * bloco do playbook e a parte que muda a cada conversao e a que mais custa
 * verificar so por observacao das respostas.
 */
export async function buildPrompt(params: {
  lead: Lead;
  history: StoredMessage[];
  incoming: string;
}): Promise<string> {
  const { lead, history, incoming } = params;

  // Lido antes de montar o texto: o playbook vem da base de dados, e um
  // template string nao espera por uma promessa.
  const playbook = await getConversionPlaybook({ excludeChatId: lead.chatId });

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
${renderPlaybook(playbook)}
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

  const prompt = await buildPrompt(params);

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
      cta: text(parsed.cta, 'Puxar a decisao sobre entrar no grupo.'),
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
