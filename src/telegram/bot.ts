import { Bot, GrammyError, HttpError, type Context } from 'grammy';

import { env } from '../config/env';
import {
  addMessage,
  advanceStage,
  clearHistory,
  forgetLead,
  getRecentMessages,
  clearDepositPromise,
  getStats,
  recordDepositProof,
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
import { persona } from '../personas';
import { sanitiseDashes } from '../utils/text';
import { detectCanton } from '../utils/canton';
import { formatInstant, nextOccurrenceUtc } from '../utils/timezone';

const log = createLogger('telegram');

export const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const MAX_INCOMING_LENGTH = 2000;

// Quem pode correr /stats. Continua a ser o ADMIN_CHAT_IDS: e uma permissao
// de comando, nao um destino de entrega, e nao acompanha o canal de midias.
const adminChatIds = new Set(env.ADMIN_CHAT_IDS);

// Para onde vao as copias das imagens recebidas, ja resolvido no env a partir
// do TELEGRAM_LOG_CHANNEL_ID, do TELEGRAM_ADMIN_CHAT_ID ou do ADMIN_CHAT_IDS.
const mediaLogChatIds = env.mediaLogChatIds;

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

  return upsertLead({
    chatId,
    firstName: ctx.from?.first_name ?? null,
    username: ctx.from?.username ?? null,
    languageCode: ctx.from?.language_code ?? null,
  });
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
async function sendHumanPaced(ctx: Context, text: string): Promise<void> {
  // Ultima barreira antes do Telegram. O redator ja limpa o que gera, mas por
  // aqui passa tambem texto que ele nao escreveu — o aviso legal, o link e as
  // mensagens fixas vindas do ambiente.
  const clean = sanitiseDashes(text);
  const polished = persona.styleGuard ? persona.styleGuard(clean) : clean;
  const bubbles = splitIntoBubbles(polished, env.MAX_BUBBLES);

  for (const [index, bubble] of bubbles.entries()) {
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

  const history = getRecentMessages(lead.chatId, 1);

  // Quem ja falou connosco nao volta ao inicio. Repetir a apresentacao a quem
  // ja passou pela qualificacao trata-o como um desconhecido e deita fora o
  // trabalho todo da conversa anterior — alem de soar a robo, que e
  // exatamente o que este funil evita.
  if (history.length > 0) {
    if (isRateLimited(lead.chatId)) {
      log.warn(`rate limit atingido pelo chat ${lead.chatId} (/start)`);
      return;
    }

    log.info(`/start de lead recorrente chat=${lead.chatId} estagio=${lead.stage}`);
    dispatchFunnelTurn(ctx, lead.chatId, RETURNING_MARKER, { storeIncoming: false });
    return;
  }

  advanceStage(lead.chatId, 'qualificacao');

  const greeting = persona.greeting(lead.firstName);

  addMessage({ chatId: lead.chatId, role: 'assistant', content: greeting });
  dispatchMessage(ctx, lead.chatId, greeting);
});

bot.command('reset', async (ctx) => {
  const lead = leadFromContext(ctx);
  if (!lead) return;

  clearHistory(lead.chatId);
  setNotes(lead.chatId, null);
  await ctx.reply('Pronto, limpei a nossa conversa. Diz-me o que queres saber.');
});

bot.command('parar', async (ctx) => {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

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
 * Um turno do funil: le o historico, corre a cadeia estrategista -> redator,
 * grava o resultado e responde. Partilhado entre as mensagens de texto e o
 * /start de quem volta, para os dois caminhos nao divergirem.
 */
/**
 * Entrega uma mensagem ja escrita, ao ritmo humano e sem prender o pedido
 * HTTP. Passa pela fila do chat para nao se cruzar com um turno em curso.
 */
function dispatchMessage(ctx: Context, chatId: number, text: string): void {
  void enqueue(chatId, () => sendHumanPaced(ctx, text)).catch((error: unknown) => {
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
  await enqueue(chatId, async () => {
    const stopTyping = keepTyping(ctx);

    try {
      // Historico lido ANTES de gravar a mensagem nova: as duas IAs recebem o
      // passado como contexto e a mensagem atual separadamente.
      const history = getRecentMessages(chatId);
      const current = upsertLead({ chatId });

      const directive = await planStrategy({ lead: current, history, incoming });
      const answer = await writeReply({ lead: current, history, incoming, directive });

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

      if (directive.notes.trim().length > 0) {
        const merged = [current.notes, directive.notes.trim()]
          .filter((part): part is string => Boolean(part && part.length > 0))
          .join(' | ');
        setNotes(chatId, merged.slice(-2000));
      }

      stopTyping();
      await sendHumanPaced(ctx, answer);

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
 * Midia recebida no privado.
 *
 * Faz duas coisas que se mantem separadas de proposito. A primeira e copiar a
 * imagem para o canal de controlo, e essa acontece SEMPRE: qualquer foto que
 * entre e reencaminhada, sirva ou nao de comprovativo, e mesmo que o registo
 * na base de dados falhe. A segunda e tratar o anexo como comprovativo de
 * deposito, e essa so acontece se o anexo tiver forma de o ser.
 *
 * O bot NUNCA aprova sozinho: guarda o ficheiro, avisa quem valida e diz ao
 * lead que a validacao esta em curso. Libertar o acesso automaticamente daria
 * grupo a quem mandasse qualquer imagem.
 */
bot.on([':photo', ':document'], async (ctx) => {
  // So o privado. O funil e um para um, e sem esta guarda uma foto qualquer
  // publicada num grupo onde o bot esteja viraria comprovativo de deposito.
  // O allowed_updates ja limita a updates de "message", mas isso e uma linha
  // no arranque e esta regra tem de valer por si.
  if (ctx.chat?.type !== 'private') return;

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
  const servesAsProof = Boolean(photo) || isImageDocument || isPdfDocument;

  // Para a copia serve qualquer ficheiro; para comprovativo, so os de cima.
  const fileId = photo?.file_id ?? document?.file_id;
  const fileKind: 'photo' | 'document' = photo ? 'photo' : 'document';

  let proofId: number | null = null;

  if (servesAsProof && fileId) {
    try {
      proofId = recordDepositProof({
        chatId: lead.chatId,
        leadName: lead.firstName,
        username: lead.username,
        fileId,
        messageId: message.message_id,
      }).id;

      advanceStage(lead.chatId, 'comprovativo_recebido');
      // Cumpriu: nao faz sentido continuar a lembra-lo de depositar.
      clearDepositPromise(lead.chatId);

      // Fica no historico para o estrategista nao voltar a pedir o comprovativo.
      addMessage({
        chatId: lead.chatId,
        role: 'user',
        content: '[o lead enviou um comprovativo de deposito]',
      });
    } catch (error) {
      // O registo falhou, mas a imagem existe e alguem tem de a ver. A copia
      // abaixo segue na mesma, com a nota de que nao ficou registada.
      log.error(`falha a registar o comprovativo do chat ${lead.chatId}`, error);
    }
  }

  if (fileId) {
    await forwardMedia({
      lead,
      fileId,
      fileKind,
      proofId,
      servesAsProof,
      sentAt: new Date(message.date * 1000),
      leadCaption: message.caption ?? null,
    });
  }

  if (!servesAsProof) {
    await ctx.reply('Manda antes um print ou uma foto do comprovativo, se faz favor.');
    return;
  }

  const answer = persona.proofAcknowledgement(lead.firstName);

  addMessage({ chatId: lead.chatId, role: 'assistant', content: answer });
  dispatchMessage(ctx, lead.chatId, answer);

  log.info(
    `midia recebida${proofId === null ? '' : ` (comprovativo #${proofId})`} — ` +
      `chat=${lead.chatId} nome=${lead.firstName ?? '?'} ` +
      `username=${lead.username ? '@' + lead.username : '?'}`,
  );
});

/** Limite de legenda do Telegram em midias. Acima disto o envio e recusado. */
const TELEGRAM_MAX_CAPTION_LENGTH = 1024;

interface ForwardedMedia {
  lead: Lead;
  fileId: string;
  fileKind: 'photo' | 'document';
  /** Numero do comprovativo, ou null se o anexo nao foi registado como tal. */
  proofId: number | null;
  servesAsProof: boolean;
  /** Hora a que o lead enviou, nao a que o servidor processou. */
  sentAt: Date;
  /** Legenda que o proprio lead escreveu, se escreveu alguma. */
  leadCaption: string | null;
}

/** Identificacao do lead que vai na legenda da copia. */
function buildCaption(media: ForwardedMedia): string {
  const { lead, proofId, servesAsProof, sentAt, leadCaption } = media;

  const header = servesAsProof
    ? proofId === null
      ? 'Print recebido (FALHOU o registo na base de dados)'
      : `Comprovativo #${proofId} — validacao manual`
    : 'Midia recebida — nao serve de comprovativo';

  const lines = [
    header,
    '',
    // `||` e nao `??`: o Telegram entrega first_name vazio em contas apagadas,
    // e uma linha "Nome:" em branco nao diz a quem valida que nao ha nome.
    `Nome: ${lead.firstName || '(sem nome)'}`,
    `Username: ${lead.username ? `@${lead.username}` : '(sem username)'}`,
    `ID: ${lead.chatId}`,
    `Data: ${formatInstant(sentAt, env.REMARKETING_TIMEZONE)} (${env.REMARKETING_TIMEZONE})`,
  ];

  if (leadCaption) lines.push('', `Legenda do lead: ${leadCaption}`);

  const caption = lines.join('\n');

  // Uma legenda comprida demais faz o Telegram recusar o envio inteiro, e
  // perder a imagem por causa do texto do lead seria o pior dos dois mundos.
  return caption.length <= TELEGRAM_MAX_CAPTION_LENGTH
    ? caption
    : `${caption.slice(0, TELEGRAM_MAX_CAPTION_LENGTH - 1)}\u2026`;
}

/**
 * Copia a midia para o canal de controlo. Sem isto o registo ficaria so na
 * base de dados e o lead esperaria por alguem que nao sabe que ele existe.
 */
async function forwardMedia(media: ForwardedMedia): Promise<void> {
  if (mediaLogChatIds.length === 0) {
    log.error(
      `sem destino de controlo (${env.mediaLogSource} nao tem nenhum id valido): ` +
        'a midia foi guardada, mas ninguem foi avisado',
    );
    return;
  }

  const caption = buildCaption(media);
  let delivered = 0;

  for (const destination of mediaLogChatIds) {
    try {
      // Reenvia por file_id: sem download nem reupload do ficheiro. Um PDF
      // enviado por sendPhoto seria recusado, dai distinguir o tipo.
      if (media.fileKind === 'photo') {
        await bot.api.sendPhoto(destination, media.fileId, { caption });
      } else {
        await bot.api.sendDocument(destination, media.fileId, { caption });
      }

      delivered += 1;
    } catch (error) {
      log.error(`falha ao enviar a midia do chat ${media.lead.chatId} para ${destination}`, error);

      // Sem o ficheiro, pelo menos os dados do lead chegam — dao para o
      // encontrar a mao pelo ID.
      try {
        await bot.api.sendMessage(destination, `${caption}\n\n(o ficheiro nao pode ser reenviado)`);
        delivered += 1;
      } catch (fallbackError) {
        log.error(`nem o aviso de texto chegou a ${destination}`, fallbackError);
      }
    }
  }

  if (delivered === 0) {
    // O lead ficou a espera de uma validacao que nao foi pedida a ninguem.
    log.error(
      `a midia do chat ${media.lead.chatId} nao chegou a nenhum destino de controlo. ` +
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

  await ctx.reply(persona.nonTextNudge);
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
