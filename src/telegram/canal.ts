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
import { type IdPersona } from '../personas/ids';
import { createLogger } from '../utils/logger';

const log = createLogger('canal');

/**
 * Por onde a conversa de um lead entra e sai.
 *
 * "bot" e "userbot" sao as duas portas do El Pedrito: o bot para o /start e os
 * prints, a conta de utilizador para a conversa. "bot_ivan" e a porta unica do
 * Ivan, que corre num bot e nao numa conta.
 */
export type NomeCanal = 'bot' | 'userbot' | 'bot_ivan';

/**
 * De quem e cada porta.
 *
 * E isto que faz a persona ser decidida pelo TRANSPORTE e nunca pelo conteudo
 * da mensagem: uma mensagem que entra pelo bot do Ivan e do Ivan, ponto.
 */
const PERSONA_DO_CANAL: Record<NomeCanal, IdPersona> = {
  bot: 'el_pedrito',
  userbot: 'el_pedrito',
  bot_ivan: 'ivan',
};

export function personaDoCanal(nome: NomeCanal): IdPersona {
  return PERSONA_DO_CANAL[nome];
}

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
 * Para onde recuar quando o canal pedido nao esta ligado.
 *
 * O userbot recua para a Bot API: sao as duas portas do MESMO influencer, e um
 * lead marcado como "userbot" com o userbot desligado continua a ser atendido
 * em vez de ficar sem resposta. Atender pela porta errada e mau, nao atender e
 * pior.
 *
 * O Ivan NAO tem recuo, e isso e a decisao mais importante deste ficheiro.
 * Recuar para o canal do El Pedrito faria a mensagem do Ivan sair pela CONTA do
 * El Pedrito: o lead veria outra pessoa, com outro nome e outra foto, a
 * responder-lhe a meio de uma conversa. Aqui a regra inverte-se — nao atender e
 * mau, atender como o influencer errado e pior.
 */
const RECUO: Partial<Record<NomeCanal, NomeCanal>> = { userbot: 'bot' };

export function canalDe(nome: NomeCanal): Canal {
  const escolhido = canais.get(nome);
  if (escolhido) return escolhido;

  const alternativa = RECUO[nome];
  const recuo = alternativa ? canais.get(alternativa) : undefined;

  if (!recuo) {
    throw new Error(
      `canal "${nome}" nao esta ligado e nao ha recuo da mesma persona para ele`,
    );
  }

  log.warn(`canal "${nome}" nao esta ligado; a responder por "${alternativa}"`);
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
const transportes = new Map<string, NomeCanal>();

export function lembrarTransporte(chatId: number, persona: IdPersona, nome: NomeCanal): void {
  transportes.set(`${persona}:${chatId}`, nome);
}

export function esquecerTransporte(chatId: number, persona: IdPersona): void {
  transportes.delete(`${persona}:${chatId}`);
}

/**
 * Por onde se fala com este lead.
 *
 * A persona e obrigatoria porque a mesma pessoa pode ter uma conversa com cada
 * influencer, e o transporte de uma nao e o da outra. Sem ela, uma resposta ao
 * lead do Ivan podia sair pela conta do El Pedrito.
 */
export async function canalParaChat(chatId: number, persona: IdPersona): Promise<Canal> {
  const chave = `${persona}:${chatId}`;
  const lembrado = transportes.get(chave);
  if (lembrado) return canalDe(lembrado);

  // Importado aqui e nao no topo: a base de dados importa o logger, o logger
  // importa a config, e um ciclo de imports entre a camada de dados e a de
  // transporte resolve-se com undefined em silencio.
  const { getLead } = await import('../db/database');
  const lead = await getLead(chatId, persona);
  const nome = transporteValido(lead?.transporte) ?? canalPorOmissao(persona);

  transportes.set(chave, nome);
  return canalDe(nome);
}

/** A coluna e texto livre; isto recusa o que nao e um canal conhecido. */
function transporteValido(valor: string | null | undefined): NomeCanal | null {
  if (valor === 'bot' || valor === 'userbot' || valor === 'bot_ivan') return valor;
  return null;
}

/** A porta de entrada de cada influencer, quando o lead ainda nao tem uma. */
function canalPorOmissao(persona: IdPersona): NomeCanal {
  return persona === 'ivan' ? 'bot_ivan' : 'bot';
}
