import { Bot, GrammyError, HttpError, type Context } from 'grammy';

import { env } from '../config/env';
import {
  addMessage,
  advanceStage,
  claimUpdate,
  cancelRemarketing,
  clearHistory,
  forgetLead,
  getRecentMessages,
  clearDepositPromise,
  getStats,
  recordDepositProof,
  setBettingExperience,
  setCanton,
  setDepositPromise,
  setNotes,
  upsertLead,
  type Lead,
} from '../db/database';
import { planStrategy, type SalesDirective } from '../services/strategist';
import { splitIntoBubbles } from '../services/writer';
import { writeReply } from '../services/writer';
import { createLogger } from '../utils/logger';
import { sanitiseDashes } from '../utils/text';
import { detectCanton } from '../utils/canton';
import { detectBettingExperience } from '../utils/experience';
import { nextOccurrenceUtc } from '../utils/timezone';

const log = createLogger('telegram');

export const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

/**
 * Primeira barreira de todas: um update so e processado uma vez.
 *
 * O Telegram reenvia o update quando nao recebe o 200 a tempo, e no Render
 * isso acontece sempre que o servico acorda de hibernacao — a primeira
 * entrega apanha o arranque a frio e esgota o prazo. Sem isto, o mesmo /start
 * corria duas vezes: ou saiam duas saudacoes, ou saia a saudacao e logo a
 * seguir a resposta de quem volta, porque a segunda passagem ja encontrava a
 * primeira gravada. Visto do telemovel, o bot parecia recomecar sozinho.
 *
 * Tem de ser o primeiro middleware: a partir daqui nenhum handler corre para
 * um update repetido.
 */
bot.use(async (ctx, next) => {
  const updateId = ctx.update.update_id;

  if (!claimUpdate(updateId)) {
    log.warn(`update ${updateId} repetido pelo Telegram, ignorado`);
    return;
  }

  await next();
});

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const MAX_INCOMING_LENGTH = 2000;

const adminChatIds = new Set(env.ADMIN_CHAT_IDS);

/**
 * Uma fila por chat. O Telegram entrega updates em paralelo e o lead costuma
 * mandar tres mensagens seguidas; sem isso, duas cadeias estrategista->redator
 * ao mesmo tempo sobre o mesmo historico e as respostas se contradizem.
 */
const chatQueues = new Map<number, Promise<void>>();

function enqueue(chatId: number, task: () => Promise<void>): Promise<void> {
  const previous = chatQueues.get(chatId) ?? Promise.resolve();
  const next = previous.then(task, task);

  chatQueues.set(
    chatId,
    next.catch(() => undefined),
  );

  void next.finally(() => {
    if (chatQueues.get(chatId) === next) chatQueues.delete(chatId);
  });

  return next;
}

/**
 * Geracao da conversa de cada chat.
 *
 * O /parar e o /reset apagam a conversa no instante em que chegam, mas um
 * turno que ja esteja em curso ou a espera na fila so termina depois. Ao
 * terminar, voltava a criar o lead, gravava a resposta e enviava-a, por cima
 * de quem tinha acabado de pedir para nao ser incomodado. O lead ficava
 * ressuscitado, e o /start seguinte tratava-o como conhecido em vez de lhe dar
 * as boas-vindas.
 *
 * Cada turno guarda a geracao com que entrou e desiste se ela mudar pelo
 * caminho. So aqui ficam os chats que alguma vez pararam, por isso o mapa nao
 * cresce com o numero de leads.
 */
const chatGenerations = new Map<number, number>();

function currentGeneration(chatId: number): number {
  return chatGenerations.get(chatId) ?? 0;
}

/** Invalida o que estiver em curso ou em fila para este chat. */
function invalidateChat(chatId: number): void {
  chatGenerations.set(chatId, currentGeneration(chatId) + 1);
}

/** Rate limit simples em memoria, por chat. */
const rateBuckets = new Map<number, number[]>();

function isRateLimited(chatId: number): boolean {
  const windowMs = env.RATE_LIMIT_WINDOW_SECONDS * 1000;
  const now = Date.now();
  const hits = (rateBuckets.get(chatId) ?? []).filter((at) => now - at < windowMs);

  hits.push(now);
  rateBuckets.set(chatId, hits);

  return hits.length > env.RATE_LIMIT_MAX;
}

// Evita que buckets de leads inativos cresçam para sempre no processo.
const rateCleanup = setInterval(
  () => {
    const windowMs = env.RATE_LIMIT_WINDOW_SECONDS * 1000;
    const now = Date.now();

    for (const [chatId, hits] of rateBuckets) {
      const fresh = hits.filter((at) => now - at < windowMs);
      if (fresh.length === 0) rateBuckets.delete(chatId);
      else rateBuckets.set(chatId, fresh);
    }
  },
  5 * 60 * 1000,
);

rateCleanup.unref();

function leadFromContext(ctx: Context): Lead | null {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return null;

  const lead = upsertLead({
    chatId,
    firstName: ctx.from?.first_name ?? null,
    username: ctx.from?.username ?? null,
    languageCode: ctx.from?.language_code ?? null,
  });

  // Qualquer sinal de vida de quem ja levou um toque encerra a campanha para
  // ele. Fica aqui, e nao no handler de texto, porque uma foto ou um sticker
  // sao resposta na mesma: a pessoa voltou, e quem voltou passa a ter uma
  // conversa a serio em vez de guioes automaticos por cima.
  cancelRemarketing(chatId);

  return lead;
}

/** O Telegram rejeita mensagens acima de 4096 caracteres. */
function splitMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let rest = text;

  while (rest.length > TELEGRAM_MAX_MESSAGE_LENGTH) {
    const slice = rest.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH);
    const cut = slice.lastIndexOf('\n') > 0 ? slice.lastIndexOf('\n') : TELEGRAM_MAX_MESSAGE_LENGTH;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest.length > 0) chunks.push(rest);

  return chunks;
}

async function reply(ctx: Context, text: string): Promise<void> {
  for (const chunk of splitMessage(text)) {
    await ctx.reply(chunk, { link_preview_options: { is_disabled: true } });
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const randomBetween = (min: number, max: number) =>
  min + Math.floor(Math.random() * Math.max(1, max - min + 1));

/**
 * O "a escrever..." do Telegram expira ao fim de ~5s. Para o mostrar durante
 * os 7-8s de uma mensagem e preciso reenvia-lo pelo caminho, senao o lead ve
 * o estado desaparecer e a mensagem chegar do nada.
 */
async function typeFor(ctx: Context, totalMs: number): Promise<void> {
  const REFRESH_MS = 4_500;
  let elapsed = 0;

  while (elapsed < totalMs) {
    await ctx.replyWithChatAction('typing').catch(() => undefined);
    const step = Math.min(REFRESH_MS, totalMs - elapsed);
    await sleep(step);
    elapsed += step;
  }
}

/**
 * Entrega a resposta ao ritmo de quem escreve no telemovel: uma mensagem de
 * cada vez, com o "a escrever..." antes de cada uma e uma pausa entre elas.
 *
 * Um bloco unico entregue de golpe denuncia o bot mais depressa do que
 * qualquer erro de portugues — ninguem escreve quatro frases num instante.
 */
async function sendHumanPaced(
  ctx: Context,
  text: string,
  /**
   * Verificado antes de cada balao. A entrega demora dezenas de segundos, e
   * sem isto um /parar a meio ainda deixava sair as bolhas seguintes: o lead
   * pedia para parar e continuava a receber mensagens.
   */
  shouldAbort?: () => boolean,
): Promise<void> {
  // Ultima barreira antes do Telegram. O redator ja limpa o que gera, mas por
  // aqui passa tambem texto que ele nao escreveu — o aviso legal, o link e as
  // mensagens fixas vindas do ambiente.
  const bubbles = splitIntoBubbles(sanitiseDashes(text), env.MAX_BUBBLES);

  for (const [index, bubble] of bubbles.entries()) {
    if (shouldAbort?.()) {
      log.info(`entrega ao chat ${ctx.chat?.id} interrompida: a conversa foi apagada`);
      return;
    }

    await typeFor(ctx, randomBetween(env.TYPING_MS_MIN, env.TYPING_MS_MAX));

    for (const chunk of splitMessage(bubble)) {
      await ctx.reply(chunk, { link_preview_options: { is_disabled: true } });
    }

    // Pausa entre mensagens, menos depois da ultima: nada se segue.
    if (index < bubbles.length - 1) {
      await sleep(randomBetween(env.BUBBLE_PAUSE_MS_MIN, env.BUBBLE_PAUSE_MS_MAX));
    }
  }
}

/**
 * Mantem o "digitando..." vivo enquanto a cadeia de IA roda. O status expira em
 * ~5s no Telegram, e a cadeia costuma levar mais que isso.
 */
function keepTyping(ctx: Context): () => void {
  const send = () => {
    void ctx.replyWithChatAction('typing').catch(() => undefined);
  };

  send();
  const timer = setInterval(send, 4500);

  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------

bot.command('start', async (ctx) => {
  const lead = leadFromContext(ctx);
  if (!lead) return;

  const history = getRecentMessages(lead.chatId, 20);

  /**
   * Tres situacoes diferentes, e nao duas.
   *
   * Receber a saudacao nao e ter conversado. Quem carrega em /start duas vezes
   * seguidas, ou carrega no botao START do Telegram e volta a carregar porque
   * a resposta demora, tem a saudacao ja gravada mas nunca disse nada. Tratar
   * isso como "lead que volta" fazia o bot perguntar-lhe se ja tinha decidido
   * entrar, a alguem a quem ainda nao foi proposto nada.
   *
   * O que marca uma conversa a serio e o lead ter FALADO, ou ter passado da
   * qualificacao (um comprovativo enviado adianta o estagio sem passar por
   * texto, e o historico pode ter sido apagado por retencao).
   */
  const hasHistory = history.length > 0;
  const hasSpoken = history.some((message) => message.role === 'user');

  /**
   * Saudado ha pouco e ainda calado: e o mesmo /start outra vez, nao um
   * regresso. A resposta ja vai a caminho (a entrega ritmada leva dezenas de
   * segundos e o lead carrega outra vez porque acha que falhou), por isso o
   * melhor e nao fazer nada. Repetir a saudacao dava conversa a dobrar, e
   * tratar como regresso perguntava a decisao a quem acabou de chegar.
   *
   * O historico vem por ordem crescente, portanto a ultima entrada e a mais
   * recente.
   */
  const lastMessage = history[history.length - 1];

  if (
    hasHistory &&
    !hasSpoken &&
    lastMessage !== undefined &&
    Date.now() - Date.parse(`${lastMessage.createdAt.replace(' ', 'T')}Z`) < DOUBLE_START_WINDOW_MS
  ) {
    log.info(`/start repetido chat=${lead.chatId} — saudacao ja a caminho, ignorado`);
    return;
  }

  /**
   * Fora esse caso, quem tem historico nunca volta ao inicio, tenha falado ou
   * nao. O estagio entra como rede para quem nao tem historico legivel: um
   * comprovativo enviado adianta o estagio sem passar por texto, e o historico
   * pode ter sido apagado por retencao.
   */
  const pastQualification = lead.stage !== 'novo' && lead.stage !== 'qualificacao';
  const isReturning = hasHistory || pastQualification;

  // Quem ja falou connosco nao volta ao inicio. Repetir a apresentacao a quem
  // ja passou pela qualificacao trata-o como um desconhecido e deita fora o
  // trabalho todo da conversa anterior — alem de soar a robo, que e
  // exatamente o que este funil evita.
  if (isReturning) {
    if (isRateLimited(lead.chatId)) {
      log.warn(`rate limit atingido pelo chat ${lead.chatId} (/start)`);
      return;
    }

    log.info(
      `/start de lead recorrente chat=${lead.chatId} estagio=${lead.stage} ` +
        `(historico=${history.length > 0 ? 'sim' : 'nao'}) — sem boas-vindas, retoma o fecho`,
    );
    dispatchFunnelTurn(ctx, lead.chatId, RETURNING_MARKER, { storeIncoming: false });
    return;
  }

  log.info(`/start de lead novo chat=${lead.chatId} — inicia a fase 1`);

  advanceStage(lead.chatId, 'qualificacao');

  const name = lead.firstName ? ` ${lead.firstName}` : '';
  const greeting =
    `Olá${name}, tudo bem? Sou o ${env.AGENT_NAME}, do grupo ${env.GROUP_NAME}.\n\n` +
    `Este grupo foi lançado para ${env.TARGET_AUDIENCE}. Diz-me só uma coisa: ` +
    'já costumas acompanhar apostas desportivas ou seria a primeira vez?';

  addMessage({ chatId: lead.chatId, role: 'assistant', content: greeting });
  dispatchMessage(ctx, lead.chatId, greeting);
});

bot.command('reset', async (ctx) => {
  const lead = leadFromContext(ctx);
  if (!lead) return;

  invalidateChat(lead.chatId);
  clearHistory(lead.chatId);
  setNotes(lead.chatId, null);
  await ctx.reply('Pronto, limpei a nossa conversa. Diz-me o que queres saber.');
});

bot.command('parar', async (ctx) => {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  // Antes de apagar: o que estiver em fila fica invalido e nao volta a gravar
  // nada nem a falar com quem pediu para parar.
  invalidateChat(chatId);
  forgetLead(chatId);
  await ctx.reply(
    'Sem problema, não te volto a incomodar. Apaguei a nossa conversa. ' +
      'Se mudares de ideias, é só mandares /start.',
  );
});

bot.command('stats', async (ctx) => {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  if (adminChatIds.size === 0 || !adminChatIds.has(chatId)) {
    log.warn(`/stats negado para o chat ${chatId}`);
    return;
  }

  const stats = getStats();
  const stages = Object.entries(stats.byStage)
    .map(([stage, total]) => `  ${stage}: ${total}`)
    .join('\n');

  await ctx.reply(
    `Leads: ${stats.totalLeads}\nMensagens: ${stats.totalMessages}\n` +
      `Comprovativos por validar: ${stats.pendingProofs}\n\nPor estágio:\n${stages || '  (vazio)'}`,
  );
});

// ---------------------------------------------------------------------------
// Fluxo principal: mensagem de texto -> estrategista -> redator
// ---------------------------------------------------------------------------

/**
 * Grava o cantao assim que o lead o disser.
 *
 * Duas fontes: o que o estrategista extraiu e uma leitura em codigo da propria
 * mensagem. A segunda existe porque a primeira falha de vez em quando, e o
 * resultado dessa falha e o bot voltar a perguntar onde a pessoa mora — que e
 * a queixa que motivou isto. A tabela nao falha.
 *
 * A escrita e ignorada se o lead ja tiver cantao: a primeira resposta e a boa.
 */
function recordCanton(
  chatId: number,
  known: string | null,
  incoming: string,
  directive: SalesDirective,
): void {
  if (known) return;

  // A leitura em codigo tem prioridade: devolve o nome canonico do cantao,
  // enquanto o modelo tanto pode devolver "Zurique" como "zurich" ou "ZH".
  const detected = detectCanton(incoming) ?? detectCanton(directive.canton);
  if (!detected) return;

  setCanton(chatId, detected);
  log.info(`cantao registado chat=${chatId} -> ${detected}`);
}

/**
 * Guarda se o lead ja aposta ou esta a comecar, pelas mesmas razoes do cantao:
 * e o campo guardado, e nao a memoria do modelo, que trava a repeticao da
 * pergunta na fase 2.
 *
 * A escrita e ignorada se ja houver resposta: a primeira e a boa.
 */
function recordExperience(
  chatId: number,
  known: string | null,
  incoming: string,
  directive: SalesDirective,
): void {
  if (known) return;

  // A leitura em codigo tem prioridade sobre a do modelo, que tanto pode
  // devolver "iniciante" como "nunca apostou" ou uma frase inteira.
  const detected =
    detectBettingExperience(incoming) ?? detectBettingExperience(directive.bettingExperience);
  if (!detected) return;

  setBettingExperience(chatId, detected);
  log.info(`experiencia registada chat=${chatId} -> ${detected}`);
}

/**
 * Guarda a hora combinada com o lead, convertida do fuso dele para UTC. Uma
 * hora ja passada e do dia seguinte: quem diz "as 18h" as 19h esta a falar de
 * amanha, nao de ha uma hora.
 */
function recordPromise(chatId: number, directive: SalesDirective): void {
  if (!directive.promisedTime) return;
  if (directive.shouldStop) return;

  const when = nextOccurrenceUtc(directive.promisedTime, env.REMARKETING_TIMEZONE);
  setDepositPromise(chatId, when, directive.promisedTime);
  log.info(`promessa registada chat=${chatId} para ${directive.promisedTime} (UTC ${when})`);
}

/**
 * Marcador de retorno. Nao e texto do lead: e o registo de que ele reapareceu
 * sem dizer nada. Vai para as IAs como contexto, mas nao e gravado no
 * historico — contar /start como turno faria a sequencia de abordagem saltar
 * fases a cada clique, e um lead que carregasse cinco vezes chegaria ao link
 * sem nunca ter falado.
 */
const RETURNING_MARKER = '[o lead voltou e carregou em /start; nao escreveu nada de novo]';

/**
 * Dentro desta janela, um /start a seguir a saudacao e a mesma pessoa a
 * carregar outra vez porque a resposta demora, e nao alguem que voltou. Larga
 * o suficiente para cobrir a entrega ritmada de varias bolhas, curta o
 * suficiente para quem volta mais tarde ser atendido.
 */
const DOUBLE_START_WINDOW_MS = 10 * 60 * 1000;

/**
 * Um turno do funil: le o historico, corre a cadeia estrategista -> redator,
 * grava o resultado e responde. Partilhado entre as mensagens de texto e o
 * /start de quem volta, para os dois caminhos nao divergirem.
 */
/**
 * Entrega uma mensagem ja escrita, ao ritmo humano e sem prender o pedido
 * HTTP. Passa pela fila do chat para nao se cruzar com um turno em curso.
 */
function dispatchMessage(ctx: Context, chatId: number, text: string): void {
  const generation = currentGeneration(chatId);

  void enqueue(chatId, async () => {
    if (currentGeneration(chatId) !== generation) {
      log.info(`mensagem ao chat ${chatId} descartada: a conversa foi apagada entretanto`);
      return;
    }

    await sendHumanPaced(ctx, text, () => currentGeneration(chatId) !== generation);
  }).catch((error: unknown) => {
    log.error(`falha ao entregar mensagem ao chat ${chatId}`, error);
  });
}

/**
 * Despacha o turno sem prender o pedido HTTP.
 *
 * A entrega ritmada leva dezenas de segundos e o webhook do Telegram tem de
 * responder depressa: segurando a resposta, o Telegram considera a entrega
 * falhada e reenvia o mesmo update — o lead receberia a conversa em
 * duplicado. A fila por chat continua a serializar, portanto a ordem das
 * mensagens mantem-se.
 */
function dispatchFunnelTurn(
  ctx: Context,
  chatId: number,
  incoming: string,
  options: { storeIncoming: boolean },
): void {
  void runFunnelTurn(ctx, chatId, incoming, options).catch((error: unknown) => {
    log.error(`falha no turno do chat ${chatId}`, error);
  });
}

async function runFunnelTurn(
  ctx: Context,
  chatId: number,
  incoming: string,
  options: { storeIncoming: boolean },
): Promise<void> {
  // Lida ANTES de entrar na fila: e a geracao do momento em que o lead falou,
  // e nao a de quando o turno chegar a sua vez.
  const generation = currentGeneration(chatId);

  await enqueue(chatId, async () => {
    // A conversa foi apagada enquanto este turno esperava na fila.
    if (currentGeneration(chatId) !== generation) {
      log.info(`turno do chat ${chatId} descartado: a conversa foi apagada entretanto`);
      return;
    }

    const stopTyping = keepTyping(ctx);

    try {
      // Historico lido ANTES de gravar a mensagem nova: as duas IAs recebem o
      // passado como contexto e a mensagem atual separadamente.
      const history = getRecentMessages(chatId);
      const current = upsertLead({ chatId });

      const directive = await planStrategy({ lead: current, history, incoming });
      const answer = await writeReply({ lead: current, history, incoming, directive });

      // As duas chamadas acima levam segundos, e o /parar pode ter chegado no
      // meio delas. Verifica-se outra vez antes de gravar seja o que for: a
      // partir daqui e que se escreve na base de dados e se fala com o lead.
      if (currentGeneration(chatId) !== generation) {
        log.info(`resposta ao chat ${chatId} descartada: a conversa foi apagada entretanto`);
        return;
      }

      if (options.storeIncoming) {
        addMessage({ chatId, role: 'user', content: incoming });
      }

      addMessage({
        chatId,
        role: 'assistant',
        content: answer,
        directive: JSON.stringify(directive),
      });

      advanceStage(chatId, directive.shouldStop ? 'perdido' : directive.stage);
      recordPromise(chatId, directive);
      recordCanton(chatId, current.canton, incoming, directive);
      recordExperience(chatId, current.bettingExperience, incoming, directive);

      if (directive.notes.trim().length > 0) {
        const merged = [current.notes, directive.notes.trim()]
          .filter((part): part is string => Boolean(part && part.length > 0))
          .join(' | ');
        setNotes(chatId, merged.slice(-2000));
      }

      stopTyping();
      await sendHumanPaced(ctx, answer, () => currentGeneration(chatId) !== generation);

      log.info(`respondido chat=${chatId} estagio=${directive.stage}`);
    } finally {
      stopTyping();
    }
  });
}

bot.on('message:text', async (ctx) => {
  const incomingRaw = ctx.message.text.trim();

  // Comandos desconhecidos nao devem entrar na cadeia de IA.
  if (incomingRaw.startsWith('/')) return;

  const lead = leadFromContext(ctx);
  if (!lead || incomingRaw.length === 0) return;

  if (isRateLimited(lead.chatId)) {
    log.warn(`rate limit atingido pelo chat ${lead.chatId}`);
    return;
  }

  dispatchFunnelTurn(ctx, lead.chatId, incomingRaw.slice(0, MAX_INCOMING_LENGTH), {
    storeIncoming: true,
  });
});

/**
 * Imagem recebida do lead. Guarda, reencaminha a quem valida, E NAO RESPONDE.
 *
 * O bot nao sabe o que esta na imagem. Ja aconteceu um lead mandar o print de
 * um erro do link, a pedir ajuda, e receber de volta "recebi o teu deposito,
 * vou validar": do lado dele, ou o bot nao percebeu nada ou aquilo e burla. Ele
 * bloqueou, e tinha razao.
 *
 * Por isso a imagem so faz duas coisas: fica registada e vai para o canal de
 * validacao, onde uma pessoa olha. A conversa segue quando o lead ESCREVER —
 * e se ele disser que esta feito, ai sim o funil confirma que vai validar.
 *
 * Pela mesma razao o estagio nao avanca: uma imagem sozinha nao prova deposito
 * nenhum, e marca-lo como comprovativo_recebido dava-o por convertido e
 * tirava-o do remarketing.
 */
bot.on([':photo', ':document'], async (ctx) => {
  const lead = leadFromContext(ctx);
  if (!lead) return;

  const message = ctx.message;
  if (!message) return;

  // A foto vem em varios tamanhos; o ultimo e o de maior resolucao, que e o
  // unico em que se consegue ler o valor do comprovativo.
  const photo = message.photo?.[message.photo.length - 1];
  const document = message.document;

  // Um PDF ou uma imagem enviada como ficheiro tambem servem de comprovativo;
  // outros anexos, nao.
  const isImageDocument = document?.mime_type?.startsWith('image/') === true;
  const isPdfDocument = document?.mime_type === 'application/pdf';

  const fileId = photo?.file_id ?? (isImageDocument || isPdfDocument ? document?.file_id : undefined);
  const fileKind: 'photo' | 'document' = photo ? 'photo' : 'document';

  if (!fileId) {
    await ctx.reply('Manda antes um print ou uma foto do comprovativo, se faz favor.');
    return;
  }

  const proof = recordDepositProof({
    chatId: lead.chatId,
    leadName: lead.firstName,
    username: lead.username,
    fileId,
    messageId: message.message_id,
  });

  // Ele mexeu-se: nao faz sentido apitar-lhe o lembrete de deposito a seguir.
  clearDepositPromise(lead.chatId);

  // Fica no historico para o estrategista saber que a imagem chegou e que
  // ficou sem resposta. E ele que decide o que fazer quando o lead escrever.
  addMessage({
    chatId: lead.chatId,
    role: 'user',
    content: '[o lead enviou uma imagem; ninguem lhe respondeu e ainda nao se sabe o que ela mostra]',
  });

  // Nenhuma resposta ao lead, de proposito. Ver o comentario no topo.
  log.info(
    `imagem #${proof.id} recebida — chat=${lead.chatId} nome=${lead.firstName ?? '?'} ` +
      `username=${lead.username ? '@' + lead.username : '?'} ` +
      'reencaminhada para validacao, sem resposta ao lead',
  );

  await notifyAdmins(proof.id, lead, fileId, fileKind);
});

/**
 * Encaminha o comprovativo a quem valida. Sem isto o registo ficaria so na base
 * de dados e o lead esperaria por alguem que nao sabe que ele existe.
 */
async function notifyAdmins(
  proofId: number,
  lead: Lead,
  fileId: string,
  fileKind: 'photo' | 'document',
): Promise<void> {
  if (adminChatIds.size === 0) {
    log.error('sem destino de administracao: comprovativo guardado, mas ninguem foi avisado');
    return;
  }

  const caption =
    `Imagem #${proofId} — por validar\n\n` +
    `Nome: ${lead.firstName ?? '(sem nome)'}\n` +
    `Username: ${lead.username ? `@${lead.username}` : '(sem username)'}\n` +
    `ID: ${lead.chatId}`;

  let delivered = 0;

  for (const adminId of adminChatIds) {
    try {
      // Reenvia por file_id: sem download nem reupload do ficheiro. Um PDF
      // enviado por sendPhoto seria recusado, dai distinguir o tipo.
      if (fileKind === 'photo') {
        await bot.api.sendPhoto(adminId, fileId, { caption });
      } else {
        await bot.api.sendDocument(adminId, fileId, { caption });
      }

      delivered += 1;
    } catch (error) {
      log.error(`falha ao enviar o comprovativo #${proofId} para ${adminId}`, error);

      // Sem o ficheiro, pelo menos os dados do lead chegam — dao para o
      // encontrar a mao pelo ID.
      try {
        await bot.api.sendMessage(adminId, `${caption}\n\n(o ficheiro nao pode ser reenviado)`);
        delivered += 1;
      } catch (fallbackError) {
        log.error(`nem o aviso de texto chegou a ${adminId}`, fallbackError);
      }
    }
  }

  if (delivered === 0) {
    // O lead ficou a espera de uma validacao que nao foi pedida a ninguem.
    log.error(
      `comprovativo #${proofId} nao chegou a nenhum destino de administracao. ` +
        'Confirma que o bot pertence ao grupo/canal e tem permissao para publicar.',
    );
  }
}

bot.on('message', async (ctx) => {
  // Texto e comprovativos ja foram tratados acima. Aqui sobram audio,
  // sticker, localizacao: o funil e por texto.
  if ('text' in ctx.message) return;

  const lead = leadFromContext(ctx);
  if (!lead) return;

  await ctx.reply('Escreve-me antes por texto, que assim consigo ajudar-te melhor.');
});

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

bot.catch((err) => {
  const context = `update ${err.ctx.update.update_id}`;

  if (err.error instanceof GrammyError) {
    log.error(`${context}: erro na API do Telegram`, err.error.description);
  } else if (err.error instanceof HttpError) {
    log.error(`${context}: falha de rede com o Telegram`, err.error);
  } else {
    log.error(`${context}: erro nao tratado`, err.error);
  }
});

export const BOT_COMMANDS = [
  { command: 'start', description: 'Começar a conversa' },
  { command: 'reset', description: 'Limpar o histórico da conversa' },
  { command: 'parar', description: 'Terminar e apagar os meus dados' },
];
