/**
 * O bot do Ivan.
 *
 * Duplica a LIGACAO ao grammy e mais nada: o funil, a fila, o ritmo de escrita,
 * o controlo silencioso e a base de dados sao os mesmos do El Pedrito, e entram
 * por `turnoDeCanal`, que recebe a persona.
 *
 * Porque nao parametrizar o bot.ts em vez de ter dois ficheiros: aquele ficheiro
 * tem 1100 linhas e e onde vive o bot que esta a converter com trafego pago. A
 * duplicacao aqui sao trinta linhas de arranque; reescrever aquele era mexer no
 * que esta a dar dinheiro para poupar trinta linhas.
 *
 * O Ivan corre num BOT e nao numa conta de utilizador, por decisao de quem opera.
 * Isso tem uma consequencia que vale a pena saber: um bot nao ve o que o operador
 * escreve a mao na app do Telegram, portanto o controlo silencioso do Ivan
 * funciona pelo painel e pelos comandos, nao por escrever na conversa.
 */
import { Bot } from 'grammy';

import { env } from '../config/env';
import { addMessage, upsertLead } from '../db/database';
import { ivan } from '../personas/ivan';
import { createLogger } from '../utils/logger';
import { registarCanal, type Canal } from './canal';
import { pausarPorMedia } from './controlo';
import { turnoDeCanal } from './bot';
import { claimUpdate } from '../db/database';

const log = createLogger('ivan');

/** Este ficheiro e o bot do Ivan. Fixo, como o do El Pedrito e fixo no dele. */
const PERSONA = 'ivan' as const;

/**
 * O bot, ou nada.
 *
 * Sem IVAN_BOT_TOKEN nao se cria cliente nenhum: e o interruptor. Enquanto a
 * variavel estiver vazia, o Ivan existe no codigo e nao chega a um lead — e o El
 * Pedrito nao da por nada.
 */
export const botIvan = env.IVAN_BOT_TOKEN ? new Bot(env.IVAN_BOT_TOKEN) : null;

/** O canal do Ivan, para o funil nao precisar de saber qual e qual. */
function canalDoIvan(cliente: Bot): Canal {
  return {
    nome: 'bot_ivan',
    async enviar(chatId, texto) {
      const enviada = await cliente.api.sendMessage(chatId, texto, {
        link_preview_options: { is_disabled: true },
      });
      return { messageId: enviada.message_id };
    },
    async aEscrever(chatId) {
      await cliente.api.sendChatAction(chatId, 'typing');
    },
    async apagar() {
      // Numa conversa privada um bot nao apaga mensagens de outra pessoa.
    },
  };
}

/**
 * Liga os handlers e registra o canal. Devolve false quando nao ha token.
 *
 * Nunca lanca: um problema no arranque do Ivan nao pode impedir o El Pedrito de
 * atender, porque e o El Pedrito que esta a converter.
 */
export function iniciarBotIvan(): boolean {
  if (!botIvan) {
    log.info('IVAN_BOT_TOKEN vazio: o Ivan nao vai atender (o El Pedrito segue normal)');
    return false;
  }

  // O mesmo escudo do El Pedrito, com o SEU nome na chave: as duas sequencias de
  // update_id colidem, e sem o nome um update do Ivan era descartado por o
  // numero igual do outro bot ja estar na tabela.
  botIvan.use(async (ctx, next) => {
    const updateId = ctx.update.update_id;

    if (!await claimUpdate(updateId, PERSONA)) {
      log.warn(`update ${updateId} repetido pelo Telegram, ignorado`);
      return;
    }

    await next();
  });

  botIvan.command('start', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId || ctx.chat?.type !== 'private') return;

    await upsertLead({
      chatId,
      persona: PERSONA,
      firstName: ctx.from?.first_name ?? null,
      username: ctx.from?.username ?? null,
      languageCode: ctx.from?.language_code ?? null,
    });

    // O /start nao passa pelo funil: a primeira coisa que o lead vê tem de sair
    // na hora, e nao depois de duas chamadas ao Gemini.
    const nome = ctx.from?.first_name ? ` ${ctx.from.first_name}` : '';
    const saudacao =
      `Ya${nome}, tudo fixe? 🤝🏽\n\n` +
      `Sou o ${ivan.agentName}, sou eu mesmo que te respondo por aqui.\n\n` +
      'Diz-me lá, o que é que andas à procura?';

    const enviada = await ctx.reply(saudacao, { link_preview_options: { is_disabled: true } });
    await addMessage({
      chatId,
      persona: PERSONA,
      role: 'assistant',
      content: saudacao,
      author: 'bot',
    });
    log.info(`/start chat=${chatId} msg=${enviada.message_id}`);
  });

  botIvan.on('message:text', async (ctx) => {
    const chatId = ctx.chat?.id;
    const texto = ctx.message?.text?.trim();
    if (!chatId || ctx.chat?.type !== 'private' || !texto) return;
    if (texto.startsWith('/')) return;

    turnoDeCanal(PERSONA, chatId, texto);
  });

  // Uma imagem pausa o atendimento: pode ser o comprovativo, pode ser o print de
  // um erro, e a IA nao ve imagens. Quem decide e uma pessoa, pelo painel.
  botIvan.on([':photo', ':document'], async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId || ctx.chat?.type !== 'private') return;

    await upsertLead({ chatId, persona: PERSONA, firstName: ctx.from?.first_name ?? null });
    await pausarPorMedia(chatId, PERSONA);
    await ctx.reply('Recebido 👊🏽 Vou ver isso e digo-te já.');
  });

  botIvan.on('message', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId || ctx.chat?.type !== 'private') return;
    await ctx.reply('Manda-me antes por texto mano, assim é mais fácil.');
  });

  botIvan.catch((err) => {
    log.error('erro nao tratado no bot do Ivan', err.error);
  });

  registarCanal(canalDoIvan(botIvan));
  return true;
}

export const BOT_COMMANDS_IVAN = [
  { command: 'start', description: 'Começar' },
];
