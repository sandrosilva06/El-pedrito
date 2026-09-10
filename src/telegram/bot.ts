import { Bot, GrammyError, HttpError, type Context } from 'grammy';

import { env } from '../config/env';
import {
  addMessage,
  advanceStage,
  clearHistory,
  forgetLead,
  getRecentMessages,
  getStats,
  recordDepositProof,
  setNotes,
  upsertLead,
  type Lead,
} from '../db/database';
import { planStrategy } from '../services/strategist';
import { writeReply } from '../services/writer';
import { createLogger } from '../utils/logger';

const log = createLogger('telegram');

export const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

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

  advanceStage(lead.chatId, 'qualificacao');

  const name = lead.firstName ? ` ${lead.firstName}` : '';
  const greeting =
    `Olá${name}, tudo bem? Sou o ${env.AGENT_NAME}, do grupo ${env.GROUP_NAME}.\n\n` +
    `Este grupo foi lançado para ${env.TARGET_AUDIENCE}. Diz-me só uma coisa: ` +
    'já costumas acompanhar apostas desportivas ou seria a primeira vez?';

  addMessage({ chatId: lead.chatId, role: 'assistant', content: greeting });
  await reply(ctx, greeting);
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

  const incoming = incomingRaw.slice(0, MAX_INCOMING_LENGTH);

  await enqueue(lead.chatId, async () => {
    const stopTyping = keepTyping(ctx);

    try {
      // Historico lido ANTES de gravar a mensagem nova: as duas IAs recebem o
      // passado como contexto e a mensagem atual separadamente.
      const history = getRecentMessages(lead.chatId);
      const current = upsertLead({ chatId: lead.chatId });

      const directive = await planStrategy({ lead: current, history, incoming });
      const answer = await writeReply({ lead: current, history, incoming, directive });

      addMessage({ chatId: lead.chatId, role: 'user', content: incoming });
      addMessage({
        chatId: lead.chatId,
        role: 'assistant',
        content: answer,
        directive: JSON.stringify(directive),
      });

      advanceStage(lead.chatId, directive.shouldStop ? 'perdido' : directive.stage);

      if (directive.notes.trim().length > 0) {
        const merged = [current.notes, directive.notes.trim()]
          .filter((part): part is string => Boolean(part && part.length > 0))
          .join(' | ');
        setNotes(lead.chatId, merged.slice(-2000));
      }

      stopTyping();
      await reply(ctx, answer);

      log.info(`respondido chat=${lead.chatId} estagio=${directive.stage}`);
    } finally {
      stopTyping();
    }
  });
});

/**
 * Comprovativo de deposito. O bot NUNCA aprova sozinho: guarda o ficheiro,
 * avisa quem valida e responde ao lead que a validacao esta em curso. Libertar
 * o acesso automaticamente daria grupo a quem mandasse qualquer imagem.
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

  advanceStage(lead.chatId, 'comprovativo_recebido');

  // Fica no historico para o estrategista nao voltar a pedir o comprovativo.
  addMessage({
    chatId: lead.chatId,
    role: 'user',
    content: '[o lead enviou um comprovativo de deposito]',
  });

  const name = lead.firstName ? `, ${lead.firstName}` : '';
  const answer =
    `Obrigado pelo print${name}! Vou validar a tua conta e o teu depósito ` +
    'e já te liberto o acesso ao grupo VIP.';

  addMessage({ chatId: lead.chatId, role: 'assistant', content: answer });
  await ctx.reply(answer);

  log.info(
    `comprovativo #${proof.id} recebido — chat=${lead.chatId} nome=${lead.firstName ?? '?'} ` +
      `username=${lead.username ? '@' + lead.username : '?'} aguarda validacao manual`,
  );

  await notifyAdmins(proof.id, lead, fileId);
});

/**
 * Encaminha o comprovativo a quem valida. Sem isto o registo ficaria so na base
 * de dados e o lead esperaria por alguem que nao sabe que ele existe.
 */
async function notifyAdmins(proofId: number, lead: Lead, fileId: string): Promise<void> {
  if (adminChatIds.size === 0) {
    log.warn('ADMIN_CHAT_IDS vazio: comprovativo guardado, mas ninguem foi avisado');
    return;
  }

  const caption =
    `Comprovativo #${proofId} para validar\n` +
    `Lead: ${lead.firstName ?? '(sem nome)'}${lead.username ? ` (@${lead.username})` : ''}\n` +
    `chat_id: ${lead.chatId}\n` +
    `Estagio: comprovativo_recebido`;

  for (const adminId of adminChatIds) {
    try {
      // Reenvia por file_id: nao ha download nem reupload do ficheiro.
      await bot.api.sendPhoto(adminId, fileId, { caption });
    } catch (error) {
      // Pode nao ser uma foto (PDF), ou o admin pode nunca ter falado com o bot.
      try {
        await bot.api.sendMessage(adminId, caption);
      } catch (fallbackError) {
        log.error(`falha ao avisar o admin ${adminId} do comprovativo #${proofId}`, fallbackError);
      }
    }
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
