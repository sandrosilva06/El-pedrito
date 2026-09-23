/**
 * A conta de utilizador do El Pedrito (MTProto).
 *
 * PORQUE E QUE ISTO EXISTE
 * Um bot da Bot API so ve o que lhe e dirigido. Quando eu abro o Telegram no
 * telemovel e respondo a um lead a mao, o bot nao faz a minima ideia — nao ha
 * update nenhum para ele. E por isso que ele continuava a responder por cima
 * de mim, com o lead a receber duas vozes.
 *
 * Uma sessao de CONTA ve tudo o que se passa na conta, incluindo o que a
 * propria conta envia. E isso que torna o controlo silencioso possivel: eu
 * escrevo, o backend ve, o bot cala-se. Sem botoes, sem dashboard aberto.
 *
 * O PRECO, DITO COM TODAS AS LETRAS
 * Isto e uma conta de pessoa a ser conduzida por codigo. O Telegram tolera
 * clientes de terceiros — e o que o MTProto e — mas bane contas por
 * comportamento de spam, e uma conta banida leva as conversas todas com ela.
 * Ritmo humano e nao mandar para quem nao escreveu primeiro nao sao delicadeza
 * aqui: sao o que mantem a conta viva.
 *
 * DESLIGADO POR OMISSAO
 * Sem USERBOT_ENABLED e sem sessao, nada disto arranca e o funil corre como
 * sempre correu pela Bot API. Ligar e uma decisao explicita, tomada depois do
 * login (ver src/scripts/login-userbot.ts).
 */
import { env } from '../config/env';
import { addMessage, setTransporte, upsertLead } from '../db/database';
import { createLogger } from '../utils/logger';
import { registarCanal, type Canal } from './canal';
import {
  aoComandoParar,
  aoComandoRetomar,
  aoOperadorEscrever,
  ehComandoParar,
  ehComandoRetomar,
  pausarPorMedia,
} from './controlo';

const log = createLogger('userbot');

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * As mensagens que fomos NOS a enviar.
 *
 * Sem isto o sistema desliga-se a si proprio: a resposta que a IA envia sai
 * pela conta, volta como mensagem de saida, e o codigo la em cima le-a como
 * "o operador escreveu a mao" e cala o bot. O bot responderia uma vez a cada
 * lead e nunca mais.
 *
 * Guardam-se os ids com a hora, e limpa-se o que for velho: um Set a crescer
 * para sempre num processo que nao reinicia e uma fuga de memoria lenta.
 */
const nossas = new Map<string, number>();
const MEMORIA_MS = 10 * 60 * 1000;

function marcarComoNossa(chatId: number, messageId: number): void {
  nossas.set(`${chatId}:${messageId}`, Date.now());

  if (nossas.size > 500) {
    const limite = Date.now() - MEMORIA_MS;
    for (const [chave, quando] of nossas) {
      if (quando < limite) nossas.delete(chave);
    }
  }
}

function fomosNos(chatId: number, messageId: number): boolean {
  const chave = `${chatId}:${messageId}`;
  const quando = nossas.get(chave);

  if (quando === undefined) return false;
  if (Date.now() - quando > MEMORIA_MS) {
    nossas.delete(chave);
    return false;
  }

  return true;
}

let cliente: any = null;

/** O cliente ligado, para quem precise de falar com a conta directamente. */
export function userbotCliente(): any {
  return cliente;
}

/**
 * O que o userbot precisa para sequer tentar arrancar.
 *
 * A sessao pode vir da variavel de ambiente ou do login feito pela pagina —
 * por isso isto e assincrono, e nao uma leitura de configuracao.
 */
export async function userbotConfigurado(): Promise<boolean> {
  if (!env.USERBOT_ENABLED) return false;
  if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH) return false;

  const { sessaoGuardada } = await import('./userbot-login');
  return (await sessaoGuardada()).length > 0;
}

/** Canal de saida pela conta. */
function criarCanal(): Canal {
  return {
    nome: 'userbot',

    async enviar(chatId, texto) {
      const enviada: any = await cliente.sendMessage(chatId, {
        message: texto,
        // A pre-visualizacao do link de afiliado ocupa meio ecra e mostra o
        // dominio da casa antes de o lead sequer carregar. O funil ja diz o
        // que e preciso dizer.
        linkPreview: false,
      });

      const messageId = Number(enviada?.id ?? 0);

      // Marcada ANTES de qualquer await seguinte: o update de saida pode
      // chegar no mesmo tick em que o envio devolve.
      if (messageId > 0) marcarComoNossa(chatId, messageId);

      return { messageId };
    },

    async aEscrever(chatId) {
      const { Api } = await import('teleproto');
      await cliente.invoke(
        new Api.messages.SetTyping({
          peer: chatId as never,
          action: new Api.SendMessageTypingAction(),
        }),
      );
    },

    async apagar(chatId, messageId) {
      // revoke: apaga dos DOIS lados. Sem isto o comando desaparecia do meu
      // Telegram e continuava no do lead, que e exactamente o que nao se quer.
      await cliente.deleteMessages(chatId, [messageId], { revoke: true });
    },
  };
}

/**
 * Trata uma mensagem que a conta viu.
 *
 * Exportada e sem dependencias do MTProto para poder ser exercida por testes:
 * e aqui que esta a logica que decide calar ou falar, e e a parte que nao pode
 * estar errada.
 */
export async function tratarMensagem(params: {
  chatId: number;
  messageId: number;
  texto: string;
  /** Foi a conta a enviar (eu, ou a IA), em vez de a receber. */
  saida: boolean;
  mediaKind?: string | null;
  mediaFileId?: string | null;
  /** Nome do lead, quando o Telegram o der. */
  firstName?: string | null;
  username?: string | null;
  jaFoiNossa?: (chatId: number, messageId: number) => boolean;
  apagar: (chatId: number, messageId: number) => Promise<void>;
  retomar: (chatId: number) => Promise<boolean>;
  aoLeadEscrever: (chatId: number, texto: string) => void;
}): Promise<
  'nossa' | 'comando-retomar' | 'comando-parar' | 'manual' | 'lead' | 'lead-media'
> {
  const {
    chatId,
    messageId,
    texto,
    saida,
    mediaKind = null,
    mediaFileId = null,
    firstName = null,
    username = null,
    jaFoiNossa = fomosNos,
    apagar,
    retomar,
    aoLeadEscrever,
  } = params;

  if (saida) {
    // 1. Fomos nos a enviar: nao e intervencao nenhuma.
    if (jaFoiNossa(chatId, messageId)) return 'nossa';

    // 2. Comando de controlo. Testado ANTES da regra do silencio, senao o
    //    proprio "/bot on" calava o bot que ele vem ligar.
    if (ehComandoRetomar(texto)) {
      await aoComandoRetomar({ chatId, messageId, apagar, retomar });
      return 'comando-retomar';
    }

    if (ehComandoParar(texto)) {
      await aoComandoParar({ chatId, messageId, apagar });
      return 'comando-parar';
    }

    // 3. Escrevi a mao: o bot cala-se.
    await aoOperadorEscrever({ chatId, texto, mediaKind, mediaFileId });
    return 'manual';
  }

  // --- Mensagem do lead ---------------------------------------------------
  const lead = await upsertLead({ chatId, firstName, username });

  if (lead.transporte !== 'userbot') {
    await setTransporte(chatId, 'userbot');
  }

  // Uma imagem pausa o atendimento: pode ser o comprovativo, pode ser o print
  // de um erro, e a IA nao ve imagens. Ja era assim pela Bot API.
  if (mediaKind) {
    await addMessage({
      chatId,
      role: 'user',
      content: texto.trim(),
      mediaFileId,
      mediaKind,
    });

    await pausarPorMedia(chatId);
    return 'lead-media';
  }

  if (texto.trim().length === 0) return 'lead';

  // O funil trata do resto: grava a mensagem, corre a cadeia e responde — mas
  // so se o bot estiver activo, que e verificado la dentro.
  aoLeadEscrever(chatId, texto);
  return 'lead';
}


/**
 * Liga a conta e fica a ouvir.
 *
 * Nunca lanca: um userbot que nao arranca nao pode levar o funil atras dele. O
 * servico continua a atender pela Bot API e o log diz o que falhou.
 */
export async function iniciarUserbot(params: {
  aoLeadEscrever: (chatId: number, texto: string) => void;
  retomar: (chatId: number) => Promise<boolean>;
}): Promise<boolean> {
  if (!env.USERBOT_ENABLED) return false;

  if (!(await userbotConfigurado())) {
    log.warn(
      'USERBOT_ENABLED esta ligado mas ainda nao ha sessao. ' +
        'Entra em /admin e faz o login da conta por la, ou define ' +
        'TELEGRAM_API_ID, TELEGRAM_API_HASH e USERBOT_SESSION.',
    );
    return false;
  }

  try {
    const { TelegramClient, Api } = await import('teleproto');
    const { StringSession } = await import('teleproto/sessions');
    const { NewMessage } = await import('teleproto/events');

    const { sessaoGuardada } = await import('./userbot-login');

    cliente = new TelegramClient(
      new StringSession(await sessaoGuardada()),
      env.TELEGRAM_API_ID,
      env.TELEGRAM_API_HASH,
      { connectionRetries: 5, autoReconnect: true },
    );

    await cliente.connect();

    const eu = await cliente.getMe();
    log.info(`userbot ligado como ${eu?.username ? '@' + eu.username : eu?.firstName ?? '?'}`);

    const canal = criarCanal();
    registarCanal(canal);

    cliente.addEventHandler(async (evento: any) => {
      try {
        const msg = evento?.message;
        if (!msg) return;

        // So conversas privadas. Grupos e canais nao sao leads, e um comando
        // de controlo escrito num grupo nao pode calar ninguem.
        if (!evento.isPrivate) return;

        const chatId = Number(evento.chatId ?? msg.chatId ?? 0);
        if (!chatId) return;

        const remetente = await msg.getSender?.().catch(() => null);

        await tratarMensagem({
          chatId,
          messageId: Number(msg.id ?? 0),
          texto: String(msg.message ?? ''),
          saida: Boolean(msg.out),
          mediaKind: tipoDeMedia(msg, Api),
          mediaFileId: null,
          firstName: remetente?.firstName ?? null,
          username: remetente?.username ?? null,
          apagar: canal.apagar,
          retomar: params.retomar,
          aoLeadEscrever: params.aoLeadEscrever,
        });
      } catch (error) {
        log.error('falha a tratar uma mensagem do userbot', error);
      }
    }, new NewMessage({}));

    return true;
  } catch (error) {
    log.error('o userbot nao arrancou; o funil continua pela Bot API', error);
    cliente = null;
    return false;
  }
}

function tipoDeMedia(msg: any, Api: any): string | null {
  if (!msg?.media) return null;
  if (msg.photo) return 'photo';
  if (msg.voice) return 'voice';
  if (msg.video) return 'video';
  if (msg.media instanceof Api.MessageMediaPhoto) return 'photo';
  return 'document';
}

/** Fecha a ligacao no encerramento, para o Telegram nao ficar com ela pendurada. */
export async function pararUserbot(): Promise<void> {
  if (!cliente) return;

  try {
    await cliente.disconnect();
    log.info('userbot desligado');
  } catch (error) {
    log.warn('falha a desligar o userbot', error);
  } finally {
    cliente = null;
  }
}
