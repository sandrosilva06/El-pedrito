/**
 * Por onde e que as mensagens saem.
 *
 * O funil falava directamente com a Bot API. Passa a falar com um "canal", que
 * hoje pode ser a Bot API de sempre ou a conta de utilizador (o userbot). A
 * diferenca importa por uma razao so, e nao e arquitectura bonita: a Bot API
 * NAO consegue ver as mensagens que uma pessoa escreve a mao na app do
 * Telegram. Um bot so recebe o que lhe e dirigido. Para o backend dar por uma
 * intervencao manual, a conversa tem de viver na CONTA, nao no bot.
 *
 * A interface e minuscula de proposito: e exactamente o que o funil ja usava
 * do Context do grammy (responder, mostrar "a escrever...", apagar). Nada mais
 * do funil precisa de saber onde e que a conversa mora.
 */
import { createLogger } from '../utils/logger';

const log = createLogger('canal');

/** Por onde a conversa de um lead entra e sai. */
export type NomeCanal = 'bot' | 'userbot';

export interface Canal {
  readonly nome: NomeCanal;
  /** Envia uma mensagem e devolve o id com que ficou no Telegram. */
  enviar(chatId: number, texto: string): Promise<{ messageId: number }>;
  /** Mostra "a escrever..." durante alguns segundos. */
  aEscrever(chatId: number): Promise<void>;
  /**
   * Apaga uma mensagem do chat, para os dois lados.
   *
   * So o userbot o faz a serio; na Bot API um bot nao apaga mensagens de
   * outra pessoa numa conversa privada, e a implementacao dela nao faz nada.
   */
  apagar(chatId: number, messageId: number): Promise<void>;
}

const canais = new Map<NomeCanal, Canal>();

export function registarCanal(canal: Canal): void {
  canais.set(canal.nome, canal);
  log.info(`canal "${canal.nome}" registado`);
}

/**
 * O canal pedido, ou o do bot quando o outro nao esta ligado.
 *
 * O recuo e deliberado: um lead marcado como "userbot" numa altura em que o
 * userbot esteja desligado continua a ser atendido pela Bot API, em vez de
 * ficar sem resposta nenhuma. Atender pelo sitio errado e mau; nao atender e
 * pior.
 */
export function canalDe(nome: NomeCanal): Canal {
  const escolhido = canais.get(nome);
  if (escolhido) return escolhido;

  const recuo = canais.get('bot');

  if (!recuo) {
    throw new Error(`canal "${nome}" pedido e nenhum canal registado`);
  }

  if (nome !== 'bot') {
    log.warn(`canal "${nome}" nao esta ligado; a responder pela Bot API`);
  }

  return recuo;
}

/** Ha userbot ligado? */
export function temUserbot(): boolean {
  return canais.has('userbot');
}

/**
 * Por onde e que se fala com este lead.
 *
 * Em memoria porque isto e consultado uma vez por BOLHA, e uma resposta sao
 * tres ou quatro bolhas: ir a base de dados a cada uma seria uma consulta por
 * mensagem enviada para responder sempre o mesmo. O valor so muda quando o
 * lead aparece pela primeira vez.
 */
const transportes = new Map<number, NomeCanal>();

export function lembrarTransporte(chatId: number, nome: NomeCanal): void {
  transportes.set(chatId, nome);
}

export function esquecerTransporte(chatId: number): void {
  transportes.delete(chatId);
}

export async function canalParaChat(chatId: number): Promise<Canal> {
  const lembrado = transportes.get(chatId);
  if (lembrado) return canalDe(lembrado);

  // Importado aqui e nao no topo: a base de dados importa o logger, o logger
  // importa a config, e um ciclo de imports entre a camada de dados e a de
  // transporte resolve-se com undefined em silencio.
  const { getLead } = await import('../db/database');
  const lead = await getLead(chatId);
  const nome: NomeCanal = lead?.transporte === 'userbot' ? 'userbot' : 'bot';

  transportes.set(chatId, nome);
  return canalDe(nome);
}
