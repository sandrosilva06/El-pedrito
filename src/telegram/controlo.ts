/**
 * Quem manda na conversa: eu ou a IA.
 *
 * Isto e o coracao do controlo silencioso, e esta separado do Telegram de
 * proposito: aqui nao ha sockets, nao ha MTProto e nao ha grammy. Sao decisoes
 * sobre estado, e decisoes sobre estado testam-se em milissegundos — o que
 * importa, porque o unico sitio onde isto corre a serio e uma conta de
 * Telegram a que nao se pode chamar duas vezes para experimentar.
 *
 * AS TRES REGRAS
 *
 * 1. Eu escrevo a mao -> o bot cala-se.
 *    Nao ha botao para carregar. O acto de responder JA E a ordem. Se eu tiver
 *    de me lembrar de desligar alguma coisa antes de falar, um dia esqueco-me
 *    e o lead leva duas respostas ao mesmo tempo, uma minha e uma da IA.
 *
 * 2. Eu escrevo "/bot on" -> o comando desaparece e a IA volta.
 *    O comando e apagado do Telegram antes de mais nada e nunca e gravado. O
 *    lead nao pode ver a mecanica por tras da conversa: ver "/bot on" e
 *    perceber, de uma vez so, que do outro lado esta um sistema.
 *
 * 3. O lead manda uma foto -> o bot cala-se.
 *    Ja era assim antes de isto existir. Uma imagem pode ser o comprovativo
 *    ou o print de um erro, e a IA nao ve imagens: quem decide sou eu.
 *
 * O ESTADO
 * "is_bot_active" nao existe como coluna, e de propósito. Ja havia
 * "human_handover", que e exactamente o mesmo facto ao contrario:
 *     is_bot_active === !human_handover
 * Guardar a mesma verdade em duas colunas e garantir que um dia discordam.
 */
import {
  addMessage,
  getLead,
  setHumanHandover,
  upsertLead,
  type MessageAuthor,
} from '../db/database';
import { createLogger } from '../utils/logger';

const log = createLogger('controlo');

/**
 * O que o operador escreveu para devolver a conversa a IA.
 *
 * Duas formas porque sao as duas que se escrevem sem pensar: uma explicita e
 * uma curta. Aceita maiusculas, espacos a mais e o ponto final que o teclado
 * do telemovel mete sozinho — um comando que falha por causa de um espaco e um
 * comando que o lead acaba por ver.
 */
const COMANDOS_RETOMAR = ['/bot on', '/bot ligar', '/play'];

export function ehComandoRetomar(texto: string): boolean {
  const limpo = texto
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '')
    .replace(/\s+/g, ' ');

  return COMANDOS_RETOMAR.includes(limpo);
}

/**
 * Tambem ha o caminho contrario, para quem quer calar o bot sem dizer nada ao
 * lead. Sem isto, a unica forma de assumir a conversa era escrever-lhe — e as
 * vezes quer-se so o silencio, para pensar.
 */
const COMANDOS_PARAR = ['/bot off', '/bot parar', '/pause', '/stop'];

export function ehComandoParar(texto: string): boolean {
  const limpo = texto
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '')
    .replace(/\s+/g, ' ');

  return COMANDOS_PARAR.includes(limpo);
}

/**
 * Marcar o lead como qualificado (ja depositou) ou nao.
 *
 * Sao a origem das duas campanhas de remarketing: quem tem tag "qualificado"
 * recebe avisos das entradas do grupo, quem tem "nao_qualificado" continua a
 * ser trabalhado para depositar.
 */
const COMANDOS_TAG: Record<string, string> = {
  '/aprovado': 'qualificado',
  '/qualificado': 'qualificado',
  '/naoaprovado': 'nao_qualificado',
  '/nao aprovado': 'nao_qualificado',
  '/naoqualificado': 'nao_qualificado',
};

export function tagDoComando(texto: string): string | null {
  const limpo = texto
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '')
    .replace(/\s+/g, ' ');

  return COMANDOS_TAG[limpo] ?? null;
}

/** Um comando de controlo nunca vai para o lead nem para o historico. */
export function ehComandoDeControlo(texto: string): boolean {
  return ehComandoRetomar(texto) || ehComandoParar(texto) || tagDoComando(texto) !== null;
}

/**
 * Escrevi "/aprovado" ou "/naoaprovado" na conversa.
 *
 * Mesma mecanica dos outros comandos: apagado do Telegram "no segundo a
 * seguir", nunca gravado, e o lead nunca ve nada. O que muda e a etiqueta, que
 * decide qual das campanhas lhe toca a partir de agora.
 *
 * O "/aprovado" tambem poe o estagio em acesso_liberado: quem depositou ja nao
 * e alvo de campanhas de venda, e o remarketing le o estagio.
 */
export async function aoComandoTag(params: {
  chatId: number;
  messageId: number;
  tag: string;
  apagar: (chatId: number, messageId: number) => Promise<void>;
}): Promise<{ apagado: boolean; tag: string }> {
  const { chatId, messageId, tag, apagar } = params;

  let apagado = false;

  try {
    await apagar(chatId, messageId);
    apagado = true;
  } catch (error) {
    log.warn(`chat ${chatId}: nao consegui apagar o comando; sigo na mesma`, error);
  }

  const { setTag, advanceStage } = await import('../db/database');

  await upsertLead({ chatId });
  await setTag(chatId, tag);

  if (tag === 'qualificado') {
    // Ja depositou: sai das campanhas de venda e entra nas de acompanhamento.
    await advanceStage(chatId, 'acesso_liberado');
  }

  log.info(`chat ${chatId}: marcado como ${tag}`);

  return { apagado, tag };
}

export interface MensagemDoOperador {
  chatId: number;
  texto: string;
  /** "photo", "voice", "video"... quando a mensagem leva ficheiro. */
  mediaKind?: string | null;
  mediaFileId?: string | null;
}

/**
 * Eu escrevi a mao para um lead: a IA cala-se e o que escrevi fica no
 * historico.
 *
 * Gravar e tao importante como calar. As duas IAs leem o historico a cada
 * turno: se o que eu escrevi nao estiver la, quando a conversa voltar para a
 * IA ela retoma como se os meus minutos nao tivessem existido e repete o que
 * eu ja disse.
 *
 * Devolve true se isto mudou alguma coisa (estava activa e passou a manual).
 */
export async function aoOperadorEscrever(
  mensagem: MensagemDoOperador,
): Promise<{ pausou: boolean }> {
  const { chatId, texto, mediaKind = null, mediaFileId = null } = mensagem;

  // upsert e nao get: eu posso escrever primeiro a alguem que o funil ainda
  // nao conhece, e nesse caso o lead nasce aqui.
  const lead = await upsertLead({ chatId });
  const estavaActiva = !lead.humanHandover;

  if (estavaActiva) {
    await setHumanHandover(chatId, true);
    log.info(`chat ${chatId}: respondi a mao, o bot fica em silencio`);
  }

  const conteudo = texto.trim();

  // Uma mensagem so com ficheiro nao tem texto nenhum, e uma linha vazia no
  // historico nao diz nada a ninguem: fica a dizer o que era.
  const paraGravar =
    conteudo.length > 0 ? conteudo : `[enviei ${descreverMedia(mediaKind)} a mao]`;

  await addMessage({
    chatId,
    role: 'assistant',
    content: paraGravar,
    author: 'humano' satisfies MessageAuthor,
    mediaFileId,
    mediaKind,
  });

  return { pausou: estavaActiva };
}

function descreverMedia(kind: string | null): string {
  if (kind === 'photo') return 'uma imagem';
  if (kind === 'voice' || kind === 'audio') return 'um audio';
  if (kind === 'video') return 'um video';
  return 'um ficheiro';
}

/**
 * Eu escrevi "/bot on": a IA volta a mandar.
 *
 * A ORDEM IMPORTA e nao e arbitraria:
 *   1. apagar o comando do Telegram
 *   2. so depois mexer no estado
 *   3. so depois deixar a IA falar
 *
 * Se a IA respondesse primeiro, a resposta dela aparecia no chat por baixo de
 * um "/bot on" ainda visivel, e o lead via as duas coisas juntas. Apagar
 * primeiro custa uma chamada e fecha essa janela.
 *
 * O comando NAO e gravado no historico, em lado nenhum. Se fosse, as duas IAs
 * liam-no no turno seguinte e podiam responder-lhe.
 */
export async function aoComandoRetomar(params: {
  chatId: number;
  messageId: number;
  apagar: (chatId: number, messageId: number) => Promise<void>;
  retomar: (chatId: number) => Promise<boolean>;
}): Promise<{ apagado: boolean; respondeu: boolean }> {
  const { chatId, messageId, apagar, retomar } = params;

  let apagado = false;

  try {
    await apagar(chatId, messageId);
    apagado = true;
  } catch (error) {
    // Apagar pode falhar (mensagem velha de mais, rede em baixo). Nao pode
    // impedir a IA de voltar: o pior caso aqui e um "/bot on" a ficar visivel,
    // e o melhor nao e deixar a conversa abandonada por causa disso.
    log.warn(`chat ${chatId}: nao consegui apagar o comando; sigo na mesma`, error);
  }

  await setHumanHandover(chatId, false);
  log.info(`chat ${chatId}: devolvido a IA pelo Telegram`);

  const respondeu = await retomar(chatId);

  return { apagado, respondeu };
}

/**
 * Eu escrevi "/bot off": o bot cala-se sem o lead receber nada.
 *
 * Mesma mecanica do retomar, sem a parte de fazer a IA falar.
 */
export async function aoComandoParar(params: {
  chatId: number;
  messageId: number;
  apagar: (chatId: number, messageId: number) => Promise<void>;
}): Promise<{ apagado: boolean }> {
  const { chatId, messageId, apagar } = params;

  let apagado = false;

  try {
    await apagar(chatId, messageId);
    apagado = true;
  } catch (error) {
    log.warn(`chat ${chatId}: nao consegui apagar o comando; sigo na mesma`, error);
  }

  await upsertLead({ chatId });
  await setHumanHandover(chatId, true);
  log.info(`chat ${chatId}: assumido a mao pelo Telegram, sem mensagem para o lead`);

  return { apagado };
}

/**
 * O lead mandou um ficheiro: o atendimento pausa para eu validar.
 *
 * Nao e o mesmo que o operador escrever — aqui nao ha mensagem minha para
 * gravar, so o silencio. A imagem em si e gravada por quem a recebeu, que
 * sabe o file_id.
 */
export async function pausarPorMedia(chatId: number): Promise<void> {
  await setHumanHandover(chatId, true);
  log.info(`chat ${chatId}: o lead mandou um ficheiro, atendimento pausado para validacao`);
}

/** O bot esta a responder a este lead? (o "is_bot_active" do pedido) */
export async function botActivo(chatId: number): Promise<boolean> {
  const lead = await getLead(chatId);
  return lead ? !lead.humanHandover : true;
}
